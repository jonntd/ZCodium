/**
 * E2E 探针（自动关联修复验证）：
 * 自起隔离数据根的全新 server（新产物）→ saveProject（server 作用域）→
 * createSession **不带 projectId**（此前必报 project.remote-project-required 的路径）→
 * 订阅 → 轮询 rows。
 * 成功判据：createSession 返回 sessionId（gate 修复生效）；assistant 回复作为附加观察。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { ChannelClient, SocketProtocol, VSBuffer, Emitter } from "@zcode/rpc";
import { RemoteServiceAccess } from "@zcode/client";

const REPO = "/Users/jonntd/Gode";
const ENTRY = join(REPO, "packages/server/dist/entry-http.js");
const NODE = process.execPath;
const WS_PATH = "/tmp/zcode-antigravity-test";
const DATA_ROOT = mkdtempSync(join(tmpdir(), "zcode-autolink-e2e-"));

// 隔离根复用真实凭据（只读拷贝；tasks-index 由新 server 自建，不碰真实数据）。
mkdirSync(join(DATA_ROOT, "v2"), { recursive: true });
for (const name of [
  "credentials.json",
  "provider_config.json",
  "config.json",
  "setting.json",
  "onboarding-record.json",
]) {
  try {
    copyFileSync(join(homedir(), ".zcodium/v2", name), join(DATA_ROOT, "v2", name));
  } catch { /* 可选文件缺失不阻塞 */ }
}

// 随机可用端口
const PORT = 41000 + Math.floor(Math.random() * 20000);

console.log(`启动隔离 server: port=${PORT} dataRoot=${DATA_ROOT}`);
const server = spawn(NODE, [ENTRY], {
  cwd: REPO,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(PORT),
    ZCODE_DATA_BASE_DIR: DATA_ROOT,
    ZCODE_AGENT_SERVER_COMMAND: NODE,
    ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([
      join(REPO, "apps/zcode-vscode/cli-bundle/zcode.cjs"),
      "app-server",
      "--stdio",
    ]),
    // Provider 目录：内置目录 + 真实个人配置（只读引用）。
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: join(
      REPO, "apps/zcode-vscode/cli-bundle/provider/zcode-builtin.json",
    ),
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(homedir(), ".zcodium/v2/provider_config.json"),
  },
});
let serverLog = "";
server.stdout.on("data", (c) => { serverLog += c; });
server.stderr.on("data", (c) => { serverLog += c; });

const httpReady = await new Promise((resolve) => {
  const deadline = Date.now() + 30_000;
  const tick = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/server-info`, { cache: "no-store" });
      if (r.ok || r.status === 401 || r.status === 403) return resolve(true);
    } catch { /* 未就绪 */ }
    if (Date.now() > deadline) return resolve(false);
    setTimeout(tick, 500);
  };
  tick();
});
if (!httpReady) {
  console.log("E2E-RESULT: FAIL（server 30s 未就绪）\n" + serverLog.slice(-1500));
  server.kill("SIGKILL");
  process.exit(1);
}
console.log("server 就绪");

const cleanup = () => { try { server.kill("SIGKILL"); } catch { /* ignore */ } };

try {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const onData = new Emitter(); const onClose = new Emitter(); const onEnd = new Emitter();
  ws.addEventListener("message", async (e) => {
    const raw = e.data;
    const buf = typeof raw === "string" ? Buffer.from(raw, "utf8")
      : (raw instanceof Blob ? Buffer.from(await raw.arrayBuffer()) : Buffer.from(raw));
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.addEventListener("close", () => { onClose.fire(); onEnd.fire(); });
  ws.addEventListener("error", () => { onClose.fire(); onEnd.fire(); });
  const protocol = new SocketProtocol({
    onData: onData.event, onClose: onClose.event, onEnd: onEnd.event,
    write(b) { if (ws.readyState === 1) ws.send(Buffer.from(b.buffer)); },
    end() { ws.close(); }, drain() { return Promise.resolve(); }, dispose() { ws.close(); },
  });
  const client = new ChannelClient(protocol);
  const accessor = await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("Initialize 超时")), 15000);
    client.onDidInitialize(() => { clearTimeout(t); res(new RemoteServiceAccess(client)); });
  });
  console.log("WS accessor 就绪");

  await accessor.zcodeAgentService.helloConversationV4();
  await accessor.zcodeAgentService.initializeConversationV4({
    kind: "clientHello",
    protocolVersion: 3,
    clientId: "zcode-autolink-probe",
    clientKind: "web",
    appVersion: "0.2.0",
    capabilities: { historyFirst: true },
  });
  console.log("v4 握手完成");

  // 1. 注册项目（server 作用域）。
  const proj = await accessor.projectService.saveProject({
    name: "autolink-e2e", roots: [WS_PATH], primaryRoot: WS_PATH,
  });
  console.log("项目已注册:", proj.id, "host:", proj.hostId);

  // 2. createSession **不带 projectId** —— 修复前此处必抛 project.remote-project-required。
  const createAck = await accessor.zcodeAgentService.sendConversationCommandV4({
    workspacePath: WS_PATH,
    // 注意：没有 projectId 字段
    envelope: {
      commandId: crypto.randomUUID(), clientId: "zcode-autolink-probe", sessionId: null,
      type: "createSession",
      payload: {
        workspaceId: WS_PATH,
        firstInput: { text: "自动化端到端测试：请只回复四个字符 OK-OK，不要执行任何操作。" },
      },
      issuedAt: Date.now(),
    },
  });
  const sessionId =
    createAck.result?.sessionId ?? createAck.sessionId ?? createAck.createdSessionId;
  console.log("createSession ack:", JSON.stringify(createAck).slice(0, 300));
  if (!sessionId) {
    console.log("E2E-RESULT: FAIL（createSession 未返回 sessionId——自动关联未生效）");
    process.exit(0);
  }
  console.log("✅ gate 修复生效：无 projectId 的 createSession 成功，会话:", sessionId);

  // 3. 验证任务行已归属到自动关联的项目。
  const tree = await accessor.projectService.readTree({ hostId: proj.hostId });
  const taskRow = (tree.tasks ?? []).find((t) => t.taskId === sessionId);
  console.log("任务归属项目:", taskRow?.projectId ?? "(未找到任务行)");

  // 4. 订阅 + 轮询 rows（最长 90s，assistant 回复作为附加观察）。
  let sub = null;
  try {
    sub = await accessor.zcodeAgentService.subscribeConversationV4({
      workspacePath: WS_PATH, sessionId,
    });
    console.log("订阅 OK");
  } catch (e) {
    console.log("订阅失败（不影响 gate 判定）:", e instanceof Error ? e.message : String(e));
  }
  const deadline = Date.now() + 90_000;
  let reply = null;
  let lastState = "";
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const page = await accessor.zcodeAgentService.conversationRowsRangeV4({
        workspacePath: WS_PATH, sessionId, limit: 50,
      });
      const rows = page.rows ?? [];
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i];
        const role = row.role ?? row.kind ?? "";
        if (String(role).includes("assistant")) {
          const text = JSON.stringify(row).match(/"text":"((?:[^"\\]|\\.)*)"/);
          if (text && text[1] && text[1].length > 0) { reply = text[1].slice(0, 200); break; }
        }
      }
      if (rows.length) lastState = `${rows.length} 行`;
      if (reply) break;
      process.stdout.write(".");
    } catch { /* 轮询错误忽略 */ }
  }
  try {
    if (sub) {
      await accessor.zcodeAgentService.unsubscribeConversationV4({
        workspacePath: WS_PATH, sessionId,
        subscriptionId: sub.subscriptionId ?? sub.subscription?.subscriptionId,
      });
    }
  } catch { /* 收尾失败不影响判定 */ }
  if (reply) {
    console.log(`\nE2E-RESULT: PASS（gate 修复生效 + assistant 回复: ${reply}）`);
  } else {
    console.log(`\nE2E-RESULT: PASS（gate 修复生效；90s 内未见 assistant 回复，rows=${lastState || "0"}）`);
  }
} catch (e) {
  console.log("E2E-RESULT: FAIL —", e instanceof Error ? e.message : String(e));
  console.log(serverLog.slice(-1200));
} finally {
  cleanup();
}
process.exit(0);
