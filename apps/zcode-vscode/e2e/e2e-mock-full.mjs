/**
 * E2E（Mock 模型全链路）：不依赖任何真实模型 API，可全自动重复运行。
 *
 * 启动拓扑：
 *   mock-model-server.mjs (127.0.0.1:18101)   ← 假 Anthropic Messages API
 *   entry-http.js          (127.0.0.1:<随机>)  ← Gode server（隔离数据根）
 *     └─ app-server（cli-bundle zcode.cjs）   ← agent 子进程（真 Node）
 *
 * 隔离手段（不触碰真实 ~/.zcodium）：
 *   ZCODE_DATA_BASE_DIR                 → 临时数据根（.zcodium 归属标记 + v2 provider 配置）
 *   ZCODE_STORAGE_DIR                   → agent storage 指向隔离根（不抢真实 agents-state 锁）
 *   e2e/fixtures/mock-provider-config.json → provider 指向本地 Mock
 *
 * 运行：`pnpm --filter gode test:e2e`（需先 `pnpm --filter @zcode/server build`；
 * 仓库根可经 ZCODE_REPO_ROOT 覆盖）。退出码：0=全过、1=有失败、2=前置产物缺失。
 *
 * 验证面（经 @zcode/client RemoteServiceAccess——与扩展 webview 同一消费栈）：
 *   1. saveProject/readProjects       —— 工作区注册
 *   2. createSession + 订阅 + assistant 回复 —— 聊天主链路（Mock 回复 OK-OK）
 *   3. generateWorkspaceText          —— Quick Edit 等一次性生成
 *   4. listSessions                   —— 会话历史
 *   5. stopGeneration                 —— 停止生成
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { ChannelClient, SocketProtocol, VSBuffer, Emitter } from "@zcode/rpc";
import { RemoteServiceAccess } from "@zcode/client";
import { uuidv7 } from "@zcode/shared";

// 仓库根：脚本所在目录向上三级（apps/zcode-vscode/e2e/ → 仓库根），检出路径无关；
// ZCODE_REPO_ROOT 可覆盖（CI 与本地同一入口）。
const REPO = process.env.ZCODE_REPO_ROOT?.trim() ||
  fileURLToPath(new URL("../../..", import.meta.url));
const ENTRY = join(REPO, "packages/server/dist/entry-http.js");
const CLI_BUNDLE = join(REPO, "apps/zcode-vscode/cli-bundle/zcode.cjs");
const FIXTURES = join(REPO, "apps/zcode-vscode/e2e/fixtures");
const MOCK_SERVER = join(REPO, "apps/zcode-vscode/scripts/mock-model-server.mjs");

// 必须用真实系统 Node：WorkBuddy 内置 node 带 fs broker shim，子进程间文件视图
// 会被虚拟化隔离（实测 server 物化的 builtin 文件对 agent 不可见 → 启动崩溃）。
const NODE = process.env.MOCK_E2E_NODE?.trim() ||
  (existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : process.execPath);

// 产物前置检查：缺什么、怎么补，一次说清（否则 server spawn 后挂在端口等待上）。
for (const [label, path] of [
  ["server 产物（先 pnpm --filter @zcode/server build）", ENTRY],
  ["CLI bundle（cli-bundle/zcode.cjs 入库）", CLI_BUNDLE],
  ["mock fixtures（e2e/fixtures 入库）", join(FIXTURES, "mock-provider-config.json")],
  ["mock 模型服务器（scripts/mock-model-server.mjs 入库）", MOCK_SERVER],
]) {
  if (!existsSync(path)) {
    console.error(`E2E-RESULT: FAIL（前置缺失：${label} → ${path}）`);
    process.exit(2);
  }
}

const MOCK_PORT = 18101;
const SERVER_PORT = 41000 + Math.floor(Math.random() * 20000);
const CLIENT = "zcode-vscode-mock-e2e";
const WS_PATH = mkdtempSync(join(tmpdir(), "zcode-mock-ws-"));
const DATA_ROOT = mkdtempSync(join(tmpdir(), "zcode-mock-data-"));

const children = [];
const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}: ${detail}`);
};

function waitPort(port, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => { socket.destroy(); resolve(); });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) reject(new Error(`${label} 端口 ${port} 等待超时`));
        else setTimeout(attempt, 200);
      });
    };
    attempt();
  });
}

let failed = false;
try {
  // ── 启动 Mock 模型服务器 ──
  const mock = spawn(NODE, [MOCK_SERVER], {
    env: { ...process.env, MOCK_MODEL_PORT: String(MOCK_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(mock);
  mock.stdout.on("data", (d) => process.stdout.write(`  [mock] ${d}`));
  mock.stderr.on("data", (d) => process.stdout.write(`  [mock-err] ${d}`));
  await waitPort(MOCK_PORT, 10_000, "mock-model");
  console.log(`mock model: http://127.0.0.1:${MOCK_PORT}`);

  // ── 启动隔离 server ──
  // Provider 配置注入口径：写进数据根 .zcodium/v2/provider_config.json
  //（数据根 = <ZCODE_DATA_BASE_DIR>/.zcodium，见 services/src/paths.ts getAppConfigDir）。
  const v2Dir = join(DATA_ROOT, ".zcodium", "v2");
  mkdirSync(v2Dir, { recursive: true });
  // 归属文件：数据根必须带 .zcodium/.zcodium-root.json（product=dev.zcodium.app），
  // 否则 server 的数据根初始化判为 unowned，会把整个 .zcodium 原子改名备份为
  // .zcodium.unowned-<ts>（shared/data-root.ts + services/data-root/ownership.ts），
  // provider_config.json 随之"消失"，agent 启动即崩。
  writeFileSync(join(DATA_ROOT, ".zcodium", ".zcodium-root.json"), JSON.stringify({
    product: "dev.zcodium.app",
    schemaVersion: 1,
    createdBy: "server",
    createdAt: new Date().toISOString(),
    firstSeenVersion: "0.2.0",
  }, null, 2) + "\n");
  copyFileSync(join(FIXTURES, "mock-provider-config.json"), join(v2Dir, "provider_config.json"));

  const server = spawn(NODE, [ENTRY], {
    cwd: REPO,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(SERVER_PORT),
      ZCODE_DATA_BASE_DIR: DATA_ROOT,
      // agent（CLI app-server）的 storageRoot 不读 ZCODE_DATA_BASE_DIR，默认硬编码
      // ~/.zcodium（contracts DefaultRuntimeConfig.storage.dir）。不显式指到隔离根，
      // agent 会在真实数据根上抢 agents-state.json.lock（与正在运行的 IDE agent 冲突
      // → ZCODE_FILE_LOCK_TIMEOUT），也读不到隔离的 v2/provider_config.json。
      ZCODE_STORAGE_DIR: join(DATA_ROOT, ".zcodium"),
      // agent（CLI app-server）经这两个变量定位 Built-in/Personal Provider Config；
      // server 会把 env 原样透传给 agent 子进程。Built-in 用仓库完整目录（含
      // modelRules 通配默认档位），Personal 用 mock fixture。
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(REPO, "apps/zcode-vscode/cli-bundle/provider/zcode-builtin.json"),
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(FIXTURES, "mock-provider-config.json"),
      ZCODE_AGENT_SERVER_COMMAND: NODE,
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([CLI_BUNDLE, "app-server", "--stdio"]),
      ZCODE_SERVER_WORKSPACE: WS_PATH,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(server);
  let serverLog = "";
  server.stdout.on("data", (d) => { serverLog += String(d); process.stdout.write(`  [server] ${d}`); });
  server.stderr.on("data", (d) => { serverLog += String(d); process.stdout.write(`  [server-err] ${d}`); });
  await waitPort(SERVER_PORT, 30_000, "zcode-server");
  console.log(`zcode server: http://127.0.0.1:${SERVER_PORT}（数据根 ${DATA_ROOT}）`);

  // ── 客户端：与扩展 webview 同一消费栈（SocketProtocol → ChannelClient → RemoteServiceAccess）──
  const ws = new WebSocket(`ws://127.0.0.1:${SERVER_PORT}/ws`);
  const onData = new Emitter();
  const onClose = new Emitter();
  const onEnd = new Emitter();
  ws.addEventListener("message", async (e) => {
    const raw = e.data;
    const buf = typeof raw === "string" ? Buffer.from(raw, "utf8")
      : (raw instanceof Blob ? Buffer.from(await raw.arrayBuffer()) : Buffer.from(raw));
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.addEventListener("close", () => { onClose.fire(); onEnd.fire(); });
  ws.addEventListener("error", () => { onClose.fire(); onEnd.fire(); });
  const protocol = new SocketProtocol({
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(b) { if (ws.readyState === 1) ws.send(Buffer.from(b.buffer)); },
    end() { ws.close(); },
    drain() { return Promise.resolve(); },
    dispose() { ws.close(); },
  });
  const client = new ChannelClient(protocol);
  const accessor = await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error("Initialize 超时")), 15_000);
    client.onDidInitialize(() => { clearTimeout(timer); res(new RemoteServiceAccess(client)); });
  });
  console.log("WS accessor 就绪");

  await accessor.zcodeAgentService.helloConversationV4();
  await accessor.zcodeAgentService.initializeConversationV4({
    kind: "clientHello",
    protocolVersion: 3,
    clientId: CLIENT,
    clientKind: "web",
    appVersion: "0.2.0",
    capabilities: { historyFirst: true },
  });
  console.log("v4 握手完成");

  // 1) 工作区注册
  const saved = await accessor.projectService.saveProject({
    name: "mock-ws", roots: [WS_PATH], primaryRoot: WS_PATH,
  });
  record("saveProject（工作区注册）", Boolean(saved?.id), `项目 ${saved?.id}`);

  // 2) 聊天主链路：createSession（Mock 模型回复 OK-OK）→ 订阅 → 等 assistant 行
  const createAck = await accessor.zcodeAgentService.sendConversationCommandV4({
    workspacePath: WS_PATH,
    envelope: {
      commandId: uuidv7(), clientId: CLIENT, sessionId: null,
      type: "createSession",
      payload: {
        workspaceId: WS_PATH,
        firstInput: { text: "自动化端到端测试：请只回复四个字符 OK-OK，不要执行任何操作。" },
      },
      issuedAt: Date.now(),
    },
  });
  let sessionId =
    createAck?.result?.sessionId ?? createAck?.sessionId ?? createAck?.createdSessionId ?? null;
  // ack 只回执受理，可能不带 sessionId；从会话历史兜底取。
  if (!sessionId) {
    const list = await accessor.zcodeAgentService.listSessions({ workspacePath: WS_PATH, limit: 5 });
    const arr = Array.isArray(list) ? list : (list?.sessions ?? []);
    sessionId = arr[0]?.id ?? arr[0]?.sessionId ?? null;
  }
  record("createSession（Mock 模型）", Boolean(sessionId), `sessionId=${sessionId ?? "未返回"}`);

  if (sessionId) {
    let subscriptionId = null;
    try {
      const sub = await accessor.zcodeAgentService.subscribeConversationV4({
        workspacePath: WS_PATH, sessionId,
      });
      subscriptionId = sub?.subscriptionId ?? sub?.subscription?.subscriptionId ?? null;
      record("subscribeConversationV4", Boolean(sub), "订阅 OK");
    } catch (e) {
      record("subscribeConversationV4", false, String(e?.message ?? e).slice(0, 120));
    }

    // 轮询 rows（最长 60s）：assistant 文本必须精确等于 OK-OK（Mock 回复口径）
    let assistantText = "";
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !assistantText) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const page = await accessor.zcodeAgentService.conversationRowsRangeV4({
          workspacePath: WS_PATH, sessionId, start: 0, end: 200, limit: 200,
        });
        const rows = Array.isArray(page) ? page : (page?.rows ?? []);
        for (const row of rows) {
          const role = row.role ?? row.kind ?? "";
          const text = row.text ?? row.content ?? "";
          if (String(role).includes("assistant") && String(text).trim()) {
            assistantText = String(text).trim();
            break;
          }
        }
      } catch { /* 轮询容错 */ }
    }
    record("assistant 回复（Mock 模型）", assistantText === "OK-OK", `回复：${assistantText || "（60s 内未收到）"}`);

    if (subscriptionId) {
      try {
        await accessor.zcodeAgentService.unsubscribeConversationV4({
          workspacePath: WS_PATH, sessionId, subscriptionId,
        });
      } catch { /* 收尾失败不影响判定 */ }
    }
  }

  // 3) generateWorkspaceText（一次性生成，Quick Edit 同通道）
  try {
    const r = await accessor.zcodeAgentService.generateWorkspaceText({
      workspacePath: WS_PATH,
      selection: { providerId: "mock:local-e2e", modelId: "mock-flash", options: { reasoningLevel: "enabled" } },
      prompt: "回复两个字：收到",
      querySource: "vscode-extension",
      // 主生成路径不补默认 maxOutputTokens（auxiliary 查询路径才有默认），必须显式传
      maxOutputTokens: 4096,
      requestTimeoutMs: 60_000,
    });
    record("generateWorkspaceText（一次性生成）", String(r?.text).trim() === "收到", `回复：${String(r?.text).slice(0, 40)}`);
  } catch (e) {
    record("generateWorkspaceText（一次性生成）", false, String(e?.message ?? e).slice(0, 160));
  }

  // 4) listSessions
  const sessions = await accessor.zcodeAgentService.listSessions({ workspacePath: WS_PATH, limit: 10 });
  const count = (Array.isArray(sessions) ? sessions : (sessions?.sessions ?? [])).length;
  record("listSessions（会话历史）", count > 0, `${count} 个会话`);

  // 5) stopGeneration
  if (sessionId) {
    try {
      await accessor.zcodeTaskService.stopGeneration({ taskId: sessionId, workspacePath: WS_PATH });
      record("stopGeneration（停止生成）", true, "停止指令已接受");
    } catch (e) {
      record("stopGeneration（停止生成）", false, String(e?.message ?? e).slice(0, 120));
    }
  }

  const failedCount = results.filter((r) => !r.ok).length;
  console.log(failedCount === 0
    ? `E2E-RESULT: PASS（${results.length}/${results.length} 项功能全部通过，全程本地 Mock 模型）`
    : `E2E-RESULT: FAIL（${failedCount}/${results.length} 项失败）`);
  failed = failedCount > 0;
} catch (error) {
  console.log(`❌ 异常：${error instanceof Error ? error.message : String(error)}`);
  console.log("E2E-RESULT: FAIL（异常中断）");
  failed = true;
} finally {
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* 已退出 */ }
  }
  setTimeout(() => {
    if (!process.env.MOCK_E2E_KEEP_DATA) {
      try { rmSync(DATA_ROOT, { recursive: true, force: true }); } catch { /* 容错 */ }
      try { rmSync(WS_PATH, { recursive: true, force: true }); } catch { /* 容错 */ }
    } else {
      console.log(`KEEP: DATA_ROOT=${DATA_ROOT} WS=${WS_PATH}`);
    }
    process.exit(failed ? 1 : 0);
  }, 500);
}
