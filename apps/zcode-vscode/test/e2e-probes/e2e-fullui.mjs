/**
 * E2E 自动化测试（对 live server）：
 * 注册项目 → prepareSession → createSession → sendText → 轮询 conversation rows 收回复。
 * 成功判据：assistant 行出现非空文本回复。
 */
import { spawn } from "node:child_process";
import { execSync } from "node:child_process";
import { ChannelClient, SocketProtocol, VSBuffer, Emitter } from "@zcode/rpc";
import { RemoteServiceAccess } from "@zcode/client";

// ── 定位 live server 端口（entry-http 进程的 LISTEN 端口）──
const serverPid = execSync("pgrep -f 'entry-http.js' | head -1").toString().trim();
if (!serverPid) {
  console.log("E2E-RESULT: FAIL（live server 未运行——请先打开侧栏）");
  process.exit(1);
}
const listenLine = execSync(`lsof -nP -iTCP -sTCP:LISTEN -a -p ${serverPid}`).toString();
const portMatch = listenLine.match(/127\.0\.0\.1:(\d+)/);
if (!portMatch) {
  console.log("E2E-RESULT: FAIL（server 未监听）\n" + listenLine);
  process.exit(1);
}
const PORT = portMatch[1];
console.log(`live server: pid=${serverPid} port=${PORT}`);

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

// v4 会话连接握手（hello → clientHello）：send/subscribe 的前置条件。
await accessor.zcodeAgentService.helloConversationV4();
await accessor.zcodeAgentService.initializeConversationV4({
  kind: "clientHello",
  protocolVersion: 3,
  clientId: "zcode-e2e-probe",
  clientKind: "web",
  appVersion: "0.2.0",
  capabilities: { historyFirst: true },
});
console.log("v4 握手完成");

const WS_PATH = "/tmp/zcode-antigravity-test";
try {
  // 1. 项目注册（幂等：已有同 root 项目则复用）。
  const projects = await accessor.projectService.readProjects();
  let proj = projects.find((p) => p.roots?.some((r) => r.rootPath === WS_PATH));
  if (!proj) {
    proj = await accessor.projectService.saveProject({ name: "zcode-vscode-e2e", roots: [WS_PATH], primaryRoot: WS_PATH });
    console.log("项目已注册:", proj.id);
  } else {
    console.log("复用项目:", proj.id, proj.name);
  }

  // 2. 准备会话目录 + 创建会话。
  const dirs = await accessor.projectService.prepareSession({ projectId: proj.id });
  console.log("会话目录:", dirs.workspacePath);

  // 3. v4 createSession 命令（web UI 的真实创建路径）：建会话 + 首发消息一条命令完成。
  const createAck = await accessor.zcodeAgentService.sendConversationCommandV4({
    workspacePath: dirs.workspacePath,
    projectId: proj.id,
    envelope: {
      commandId: crypto.randomUUID(), clientId: "zcode-e2e-probe", sessionId: null,
      type: "createSession",
      payload: {
        workspaceId: dirs.workspacePath,
        firstInput: { text: "自动化端到端测试：请只回复四个字符 OK-OK，不要执行任何操作。" },
      },
      issuedAt: Date.now(),
    },
  });
  console.log("createSession ack:", JSON.stringify(createAck).slice(0, 400));
  const sessionId =
    createAck.result?.sessionId ?? createAck.sessionId ?? createAck.createdSessionId;
  if (!sessionId) {
    console.log("E2E-RESULT: FAIL（createSession 未返回 sessionId）");
    process.exit(0);
  }
  console.log("会话已创建:", sessionId);

  // 4. 订阅新会话。
  const sub = await accessor.zcodeAgentService.subscribeConversationV4({
    workspacePath: dirs.workspacePath, sessionId,
  });
  const subscriptionId = sub.subscriptionId ?? sub.subscription?.subscriptionId;
  console.log("订阅 OK:", subscriptionId ?? JSON.stringify(sub).slice(0, 120));

  // 5. 轮询 rows 收回复（最长 90s）。
  const deadline = Date.now() + 90_000;
  let reply = null;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const page = await accessor.zcodeAgentService.conversationRowsRangeV4({
      workspacePath: dirs.workspacePath, sessionId, limit: 50,
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
    if (reply) break;
    process.stdout.write(".");
  }
  try {
    await accessor.zcodeAgentService.unsubscribeConversationV4({
      workspacePath: dirs.workspacePath, subscriptionId,
    });
  } catch { /* 收尾失败不影响判定 */ }
  if (reply) {
    console.log(`\nE2E-RESULT: PASS\nassistant 回复: ${reply}`);
  } else {
    console.log("\nE2E-RESULT: FAIL（90s 内未收到 assistant 回复）");
  }
} catch (e) {
  console.log("E2E-RESULT: FAIL —", e instanceof Error ? e.message : String(e));
}
process.exit(0);
