import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildServerEnvOverrides } from "./serverEnv";
import { log } from "../features/logger";

/**
 * fullui server 落盘日志文件名（teeServerLog 写入、container exportLogs 尾部读取
 * 共用；单一字面量来源，防两处漂移——架构 §7.10「exportLogs 聚合口径」）。
 */
export const SERVER_LOG_FILE_NAME = "fullui-server.log";

/** server 进程 stdout/stderr 落盘（OutputChannel 之外的可持久诊断面；排障用）。 */
function teeServerLog(logDir: string | undefined, line: string): void {
  if (!logDir) return;
  try {
    mkdirSync(logDir, { recursive: true });
    appendFileSync(
      join(logDir, SERVER_LOG_FILE_NAME),
      `[${new Date().toISOString()}] ${line}\n`,
    );
  } catch {
    // 日志失败不影响服务。
  }
}

export interface ServerHostOptions {
  /** 仓库根目录，用于按默认路径定位 server 与前端产物。 */
  readonly repoRoot: string;
  /** 显式指定的 server 入口（`entry-http.js`）。 */
  readonly configuredEntry: string;
  /** 显式指定的前端产物目录（`packages/web/dist`）。 */
  readonly configuredStaticRoot: string;
  /** 运行 server 的 Node 可执行文件（扩展宿主内是 Electron 二进制，env 已带 RUN_AS_NODE）。 */
  readonly nodePath: string;
  /**
   * 数据基目录（`ZCODE_DATA_BASE_DIR`）。
   *
   * 最终口径（docs/architecture.md §7.9「数据根」）：生产装配**不传**——完整界面
   * server 与侧边栏进程内服务栈同回落 services 默认数据根 `$HOME/.zcodium`
   * （paths.ts：root = join(getDataBaseDir(), ".zcodium")，无 env/override 时
   * base = $HOME），与桌面端三方共享同一份会话/模型/凭据存储。该选项仅供
   * dev/测试隔离场景显式注入，与 `PluginServiceAssemblyOptions.dataRootDir` 对应。
   */
  readonly dataBaseDir?: string;
  /**
   * 拉起 Agent 的命令（可选）。
   *
   * server 自己有一套 CLI 定位链（env → monorepo → Electron bundle → 已部署二进制），
   * 但**安装态下这套链会全部落空**，首次需要 Agent 时抛
   * `ZCode agent server command is not configured`。所以插件必须显式注入。
   */
  readonly agentCommand?: string;
  /** 与 `agentCommand` 配套的参数（如 `["<zcode.cjs>", "app-server", "--stdio"]`）。 */
  readonly agentArgs?: readonly string[];
  /** server 进程日志落盘目录（globalStorage/logs；缺省不落盘）。 */
  readonly logDir?: string;
}

const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 400;

export interface ServerInfo {
  readonly serverId: string;
  readonly version: string;
  readonly authRequired: boolean;
  readonly workspaces?: readonly { path: string; label?: string }[];
}

/**
 * 插件级共享的 `@zcode/server` HTTP 服务进程（PRD §8.1/§8.2）。
 *
 * 侧边栏与完整界面**共用同一个实例**：懒启动（首次 `ensureStarted` 才拉起）、
 * 随机端口、停用时回收。共用进程避免了两条链路各自 spawn `app-server`
 * 在 CLI 存储锁（`agents-state.json.lock`）上互相等待（§8.4）。
 *
 * 它跑的是仓库里**现成的** `@zcode/server`（`entry-http`）：同一份服务集合、
 * 同一份前端产物（`packages/web/dist`）。插件不在前端重写任何东西，
 * 只负责进程生命周期与端口。
 */
export class ServerHost {
  private child: ChildProcess | undefined;
  private starting: Promise<string> | undefined;
  private url: string | undefined;
  private disposed = false;
  private readonly startedListeners = new Set<(url: string) => void>();

  constructor(private readonly options: ServerHostOptions) {}

  get currentUrl(): string | undefined {
    return this.url;
  }

  /**
   * 订阅「服务就绪」事件（含进程重启后的再次就绪）。只是观察，**不会触发启动**——
   * 懒启动语义仍由 `ensureStarted` 的调用方决定。M2-10 偏好下发（FR-A17）据此在
   * 服务每次就绪后同步一次快照：重启后新进程的偏好缓存为空，必须重新下发。
   */
  readonly onStarted = (
    listener: (url: string) => void,
  ): { dispose(): void } => {
    this.startedListeners.add(listener);
    return { dispose: () => this.startedListeners.delete(listener) };
  };

  /** 幂等：并发调用共享同一次启动，返回可访问的 base URL。 */
  async ensureStarted(): Promise<string> {
    if (this.url) return this.url;
    if (!this.starting) {
      this.starting = this.startOnce().finally(() => {
        this.starting = undefined;
      });
    }
    return this.starting;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.startedListeners.clear();
    const child = this.child;
    this.child = undefined;
    this.url = undefined;
    if (!child || child.exitCode !== null) return;

    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveExit();
      }, 2_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
      child.kill("SIGTERM");
    });
  }

  private async startOnce(): Promise<string> {
    const entry = this.resolveEntry();
    const staticRoot = this.resolveStaticRoot();
    const port = await findFreePort();
    // findFreePort 是异步窗口：dispose 可能先行，此时绝不能再 spawn（否则进程
    // 在插件停用后残留）。
    if (this.disposed) throw new Error("插件已停用，取消启动完整界面服务");
    const url = `http://127.0.0.1:${port}`;

    log.info("full-ui", `启动共享服务进程：${entry}（端口 ${port}）`);
    teeServerLog(this.options.logDir, `spawn: ${entry} port=${port}`);
    const child = spawn(this.options.nodePath, [entry], {
      cwd: this.options.repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // 确定性覆盖段（含数据根口径：缺省不注入 ZCODE_DATA_BASE_DIR）见 serverEnv.ts。
        ...buildServerEnvOverrides({
          port,
          staticRoot,
          dataBaseDir: this.options.dataBaseDir,
          agentCommand: this.options.agentCommand,
          agentArgs: this.options.agentArgs,
        }),
      },
      windowsHide: true,
    });
    this.child = child;

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      teeServerLog(this.options.logDir, chunk.trim());
      log.debug("full-ui-server", chunk.trim());
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      teeServerLog(this.options.logDir, `[stderr] ${chunk.trim()}`);
      log.debug("full-ui-server", chunk.trim());
    });
    child.once("exit", (code) => {
      if (this.disposed) return;
      teeServerLog(this.options.logDir, `exit code=${code ?? "null"}`);
      log.warn("full-ui", `服务进程退出（code=${code ?? "null"}）`);
      this.child = undefined;
      this.url = undefined;
    });

    const info = await waitForReady(url);
    // waitForReady 最长等 60s：期间停用的话，不能把 url 复活到已停用的实例上。
    if (this.disposed) {
      child.kill("SIGKILL");
      throw new Error("插件已停用，取消启动完整界面服务");
    }
    if (!info) {
      child.kill("SIGKILL");
      throw new Error(
        `完整界面服务在 ${READY_TIMEOUT_MS / 1000}s 内没有就绪。` +
          `请确认已执行 \`pnpm --filter @zcode/server build\` 与 \`pnpm --filter @zcode/web build\`。`,
      );
    }

    log.info("full-ui", `服务就绪：${info.serverId} v${info.version}`);
    this.url = url;
    for (const listener of this.startedListeners) {
      try {
        listener(url);
      } catch (error) {
        log.warn("full-ui", `服务就绪监听器失败：${String(error)}`);
      }
    }
    return url;
  }

  private resolveEntry(): string {
    const configured = this.options.configuredEntry.trim();
    if (configured) return resolve(this.options.repoRoot, configured);
    const fallback = join(
      this.options.repoRoot,
      "packages/server/dist/entry-http.js",
    );
    if (!existsSync(fallback)) {
      throw new Error(
        `找不到 server 产物：${fallback}。请执行 \`pnpm --filter @zcode/server build\`。`,
      );
    }
    return fallback;
  }

  private resolveStaticRoot(): string {
    const configured = this.options.configuredStaticRoot.trim();
    if (configured) return resolve(this.options.repoRoot, configured);
    const fallback = join(this.options.repoRoot, "packages/web/dist");
    if (!existsSync(fallback)) {
      throw new Error(
        `找不到前端产物：${fallback}。请执行 \`pnpm --filter @zcode/web build\`。`,
      );
    }
    return fallback;
  }
}

/** 让操作系统分配一个空闲端口，避免固定 3030 与其他实例冲突。 */
function findFreePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.unref();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() =>
        port > 0 ? resolvePort(port) : rejectPort(new Error("端口分配失败")),
      );
    });
  });
}

/** 轮询 `/api/server-info` 判断服务是否已可用。 */
async function waitForReady(url: string): Promise<ServerInfo | undefined> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/server-info`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return (await response.json()) as ServerInfo;
    } catch {
      // 服务还没监听，继续等。
    }
    await new Promise((resolveWait) =>
      setTimeout(resolveWait, READY_POLL_INTERVAL_MS),
    );
  }
  return undefined;
}
