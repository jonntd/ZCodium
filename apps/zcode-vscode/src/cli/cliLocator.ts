/**
 * CLI 探测（P0-1）：settings `zcodium.cliPath` 优先 → PATH 探测 `zcodium` → 内置 bundle
 * （`cli-bundle/zcode.cjs`，随 vsix 分发、与 monorepo 同 commit 构建的对齐版 CLI）→ null。
 * 找到后额外读取 `--version` 输出用于诊断展示（读取失败不影响可用性）。
 *
 * 内置 bundle 是 esbuild 单文件 JS 入口（非可执行位语义），spawn 须经宿主自带 Node：
 * 见 hostSettingsBridge.resolveZcodeAgentSpawnCommand 的 nodeScript 分支（桌面端同款形态）。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CliInfo {
  path: string;
  version: string | undefined;
  /**
   * true = JS 入口（内置 bundle）：spawn 需 `process.execPath` + `ELECTRON_RUN_AS_NODE=1`；
   * false/undefined = 独立可执行（PATH / cliPath 安装的 zcodium），直接 spawn。
   */
  nodeScript?: boolean;
}

export class CliLocator {
  constructor(
    private readonly pathEnv: string = process.env["PATH"] ?? "",
    /** 内置 bundle 绝对路径（扩展安装目录 cli-bundle/zcode.cjs）；缺省不启用该兜底。 */
    private readonly bundledCliPath?: string,
  ) {}

  async locate(customPath?: string): Promise<CliInfo | null> {
    const fromSettings = await this.probePath(customPath);
    if (fromSettings) return fromSettings;
    const fromPathEnv = await this.probePath("zcodium");
    if (fromPathEnv) return fromPathEnv;
    return this.probeBundled();
  }

  /** 探测单个候选：绝对路径直接查存在性，否则在 PATH 各目录下找。 */
  private async probePath(candidate: string | undefined): Promise<CliInfo | null> {
    if (!candidate) return null;
    let resolved: string | null = null;
    if (isAbsolute(candidate)) {
      resolved = existsSync(candidate) ? candidate : null;
    } else {
      for (const dir of this.pathEnv.split(delimiter)) {
        if (!dir) continue;
        const full = `${dir}/${candidate}`;
        if (existsSync(full)) {
          resolved = full;
          break;
        }
      }
    }
    if (!resolved) return null;
    return { path: resolved, version: await this.readVersion(resolved) };
  }

  /** 内置 bundle 兜底：文件在即视为可用（版本经宿主 Node 读取，失败不影响可用性）。 */
  private async probeBundled(): Promise<CliInfo | null> {
    if (!this.bundledCliPath || !existsSync(this.bundledCliPath)) return null;
    return {
      path: this.bundledCliPath,
      version: await this.readNodeScriptVersion(this.bundledCliPath),
      nodeScript: true,
    };
  }

  /** 读 CLI 版本；失败返回 undefined（探测本身仍算成功）。 */
  private async readVersion(path: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(path, ["--version"], { timeout: 5_000 });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  /** JS 入口版本读取：经宿主 Node 执行（Electron 下 ELECTRON_RUN_AS_NODE=1，桌面端同款）。 */
  private async readNodeScriptVersion(path: string): Promise<string | undefined> {
    try {
      const { stdout } = await execFileAsync(process.execPath, [path, "--version"], {
        timeout: 15_000,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      });
      return stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }
}
