/**
 * E2E（本地 Mock 模型全链路）：不依赖任何真实模型 API。
 *
 * 启动拓扑：
 *   mock-model-server.mjs (127.0.0.1:18101)   ← 假 Anthropic Messages API
 *   entry-http.js          (127.0.0.1:18777)  ← Gode server（隔离数据根）
 *     └─ app-server（cli-bundle zcode.cjs）   ← agent 子进程（真 Node）
 *
 * 隔离手段：
 *   ZCODE_DATA_BASE_DIR               → 临时数据根
 *   ZCODE_PERSONAL_PROVIDER_CONFIG_FILE → e2e/fixtures/mock-provider-config.json
 *   ZCODE_BUILTIN_PROVIDER_CONFIG_FILE  → e2e/fixtures/mock-builtin-catalog.json
 *
 * 验证面（全部经扩展真实 HostServices 通道）：
 *   1. saveProject/readProjects       —— 工作区注册
 *   2. createSession + 订阅 + assistant 回复 —— 聊天主链路（Mock 回复 OK-OK）
 *   3. generateWorkspaceText          —— Quick Edit 等一次性生成（档位补全）
 *   4. listSessions                   —— 会话历史
 *   5. stopGeneration                 —— 停止生成
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostServices } from "../src/fullui/hostServices";
import { uuidv7 } from "@zcode/shared";

const REPO = "/Users/jonntd/Gode";
const ENTRY = join(REPO, "packages/server/dist/entry-http.js");
// 必须用真实系统 Node：WorkBuddy 内置 node 带 fs broker shim，子进程间文件视图
// 会被虚拟化隔离（实测 server 物化的 builtin 文件对 agent 不可见 → 启动崩溃）。
const NODE = process.env.MOCK_E2E_NODE?.trim() ||
  (existsSync("/opt/homebrew/bin/node") ? "/opt/homebrew/bin/node" : process.execPath);
const CLI_BUNDLE = join(REPO, "apps/zcode-vscode/cli-bundle/zcode.cjs");
const MOCK_PORT = 18101;
const SERVER_PORT = 18777;
const WS_PATH = mkdtempSync(join(tmpdir(), "zcode-mock-ws-"));
const DATA_ROOT = mkdtempSync(join(tmpdir(), "zcode-mock-data-"));
const FIXTURES = join(REPO, "apps/zcode-vscode/e2e/fixtures");
const CLIENT = "zcode-vscode-host";

const children = [];
let failed = false;

function waitPort(port, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = new NodeRequire_net().connect(port, "127.0.0.1");
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
import net from "node:net";
function NodeRequire_net() { return net; }

const results = [];
const record = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`${ok ? "✅" : "❌"} ${name}: ${detail}`);
};

try {
  // ── 启动 Mock 模型服务器 ──
  const mock = spawn(NODE, [join(REPO, "apps/zcode-vscode/scripts/mock-model-server.mjs")], {
    env: { ...process.env, MOCK_MODEL_PORT: String(MOCK_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(mock);
  mock.stdout.on("data", (d) => process.stdout.write(`  [mock] ${d}`));
  mock.stderr.on("data", (d) => process.stdout.write(`  [mock-err] ${d}`));
  await waitPort(MOCK_PORT, 10_000, "mock-model");
  console.log(`mock model: http://127.0.0.1:${MOCK_PORT}`);

  // ── 启动隔离 server ──
  // Provider 配置注入口径与桌面 E2E 一致：写进数据根 v2/provider_config.json
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
  // 关键：隔离根没有 credentials/onboarding 标记时，agent 启动会按"全新 profile"
  // 重置 v2（实测会删掉 provider_config.json）。拷入真实 profile 标记防重置；
  // 测试流量全部指向本地 Mock，真实凭据不会被使用。
  const realV2 = join(process.env.HOME ?? "", ".zcodium", "v2");
  for (const marker of ["credentials.json", "onboarding-record.json"]) {
    try { copyFileSync(join(realV2, marker), join(v2Dir, marker)); } catch { /* 缺文件容错 */ }
  }
  const server = spawn(NODE, [ENTRY], {
    env: {
      ...process.env,
      PORT: String(SERVER_PORT),
      ZCODE_DATA_BASE_DIR: DATA_ROOT,
      // agent（CLI app-server）的 storageRoot 不读 ZCODE_DATA_BASE_DIR，默认硬编码
      // ~/.zcodium（contracts DefaultRuntimeConfig.storage.dir）。不显式指到隔离根，
      // agent 会在真实数据根上抢 agents-state.json.lock（与正在运行的 IDE agent 冲突
      // → ZCODE_FILE_LOCK_TIMEOUT），也读不到隔离的 v2/provider_config.json。
      ZCODE_STORAGE_DIR: join(DATA_ROOT, ".zcodium"),
      // agent（CLI app-server）经这两个变量定位 Built-in/Personal Provider Config；
      // server 会把 env 原样透传给 agent 子进程。Built-in 用真实完整目录（含
      // modelRules 通配默认档位），Personal 用 mock fixture。
      ZCODE_AGENT_SERVER_COMMAND: NODE,
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([CLI_BUNDLE, "app-server", "--stdio"]),
      ZCODE_SERVER_WORKSPACE: WS_PATH,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(server);
  server.stdout.on("data", (d) => process.stdout.write(`  [server] ${d}`));
  server.stderr.on("data", (d) => process.stdout.write(`  [server-err] ${d}`));
  await waitPort(SERVER_PORT, 30_000, "zcode-server");
  console.log(`zcode server: http://127.0.0.1:${SERVER_PORT}（数据根 ${DATA_ROOT}，node ${NODE}）`);

  const hostServices = new HostServices({ getWsUrl: async () => `ws://127.0.0.1:${SERVER_PORT}/ws` });

  // 1) 工作区注册
  const saved = await hostServices.use(async (accessor) => {
    const projects = await accessor.projectService.readProjects();
    const existing = projects.find((p) => p.roots?.some((r) => r.rootPath === WS_PATH));
    if (existing) return { id: existing.id, reused: true };
    return accessor.projectService.saveProject({ name: "mock-ws", roots: [WS_PATH], primaryRoot: WS_PATH });
  });
  record("saveProject/readProjects", Boolean(saved?.id), `项目 ${saved.id}${saved.reused ? "（复用）" : "（新建）"}`);

  // 2) 聊天主链路：createSession（Mock 模型回复 OK-OK）→ 订阅 → 等 assistant 行
  const createAck = await hostServices.use((a) =>
    a.zcodeAgentService.sendConversationCommandV4({
      workspacePath: WS_PATH,
      envelope: {
        commandId: uuidv7(), clientId: CLIENT, sessionId: null,
        type: "createSession",
        payload: { workspaceId: WS_PATH, firstInput: { text: "自动化端到端测试：请只回复四个字符 OK-OK，不要执行任何操作。" } },
        issuedAt: Date.now(),
      },
    }),
  );
  let sessionId = createAck?.sessionId ?? createAck?.payload?.sessionId ?? null;
  // ack 只回执受理（status=accepted），可能不带 sessionId；从会话历史兜底取。
  if (!sessionId) {
    try {
      const list = await hostServices.use((a) => a.zcodeAgentService.listSessions({ workspacePath: WS_PATH, limit: 5 }));
      const arr = Array.isArray(list) ? list : (list?.sessions ?? []);
      sessionId = arr[0]?.id ?? arr[0]?.sessionId ?? null;
      console.log(`  [debug] createSession ack=${JSON.stringify(createAck).slice(0, 400)}；listSessions 兜底 sessionId=${sessionId}`);
    } catch { /* 容错 */ }
  }
  record("createSession（无 projectId 自动关联）", Boolean(sessionId), `sessionId=${sessionId ?? JSON.stringify(createAck).slice(0, 120)}`);

  if (sessionId) {
    const sub = await hostServices.use((a) =>
      a.zcodeAgentService.subscribeConversationV4({ sessionId, workspacePath: WS_PATH }),
    );
    record("subscribeConversationV4", Boolean(sub), `订阅 OK`);

    let assistantText = "";
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !assistantText) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const rows = await hostServices.use((a) =>
          a.zcodeAgentService.conversationRowsRangeV4({ sessionId, workspacePath: WS_PATH, start: 0, end: 200, limit: 200 }),
        );
        const list = Array.isArray(rows) ? rows : (rows?.rows ?? []);
        for (const row of list) {
          const role = row.role ?? row.kind ?? "";
          const text = row.text ?? row.content ?? "";
          if (String(role).includes("assistant") && String(text).trim()) assistantText = String(text).trim();
        }
      } catch { /* 轮询容错 */ }
    }
    record("assistant 回复（Mock 模型）", assistantText === "OK-OK", `回复：${assistantText || "（60s 内未收到）"}`);
  }

  // 3) generateWorkspaceText（冷/热装配 + 档位补全）
  try {
    const r = await hostServices.use((a) =>
      a.zcodeAgentService.generateWorkspaceText({
        workspacePath: WS_PATH,
        selection: { providerId: "mock:local-e2e", modelId: "mock-flash", options: { reasoningLevel: "enabled" } },
        prompt: "回复两个字：收到",
        querySource: "vscode-extension",
        // 主生成路径不补默认 maxOutputTokens（auxiliary 查询路径才有默认），必须显式传
        maxOutputTokens: 4096,
        requestTimeoutMs: 60_000,
      }),
    );
    record("generateWorkspaceText（一次性生成）", String(r?.text).trim() === "收到", `回复：${String(r?.text).slice(0, 40)} | finish=${r?.finishReason}`);
  } catch (e) {
    record("generateWorkspaceText（一次性生成）", false, String(e?.message ?? e).slice(0, 160));
  }

  // 4) listSessions
  const sessions = await hostServices.use((a) => a.zcodeAgentService.listSessions({ workspacePath: WS_PATH, limit: 10 }));
  const count = (Array.isArray(sessions) ? sessions : (sessions?.sessions ?? [])).length;
  record("listSessions（会话历史）", count > 0, `${count} 个会话`);

  // 5) stopGeneration
  if (sessionId) {
    try {
      await hostServices.use((a) => a.zcodeTaskService.stopGeneration({ taskId: sessionId, workspacePath: WS_PATH }));
      record("stopGeneration（停止生成）", true, "停止指令已接受");
    } catch (e) {
      record("stopGeneration（停止生成）", false, String(e?.message ?? e).slice(0, 120));
    }
  }

  hostServices.dispose();
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
