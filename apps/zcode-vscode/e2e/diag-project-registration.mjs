/** 诊断探针：连活 server，核实项目注册状态与 remote-project-required 复现条件。 */
import { ChannelClient, SocketProtocol, VSBuffer, Emitter } from "@zcode/rpc";
import { RemoteServiceAccess } from "@zcode/client";
import { uuidv7 } from "@zcode/shared";
import { homedir } from "node:os";
import { join } from "node:path";
const PORT = process.argv[2] ?? "59628";
const WS_PATH = process.argv[3] ?? join(homedir(), ".zcodium", "workspace", "default");
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const onData = new Emitter(); const onClose = new Emitter(); const onEnd = new Emitter();
ws.addEventListener("message", async (ev) => {
  const raw = ev.data;
  let buf;
  if (typeof raw === "string") buf = Buffer.from(raw, "utf8");
  else if (typeof Blob !== "undefined" && raw instanceof Blob) buf = Buffer.from(await raw.arrayBuffer());
  else buf = Buffer.from(raw);
  onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
});
ws.addEventListener("close", () => { onClose.fire(); onEnd.fire(); });
ws.addEventListener("error", () => { onClose.fire(); onEnd.fire(); });
const protocol = new SocketProtocol({ onData: onData.event, onClose: onClose.event, onEnd: onEnd.event,
  write(b) { if (ws.readyState === 1) ws.send(Buffer.from(b.buffer)); },
  end() { ws.close(); }, drain() { return Promise.resolve(); }, dispose() { ws.close(); } });
const client = new ChannelClient(protocol);
const accessor = await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error("init timeout")), 15000);
  client.onDidInitialize(() => { clearTimeout(t); res(new RemoteServiceAccess(client)); });
});
await accessor.zcodeAgentService.helloConversationV4();
await accessor.zcodeAgentService.initializeConversationV4({ kind: "clientHello", protocolVersion: 3, clientId: "uchg-probe", clientKind: "web", appVersion: "0.2.0", capabilities: { historyFirst: true } });
console.log("handshake ok");

// 1) 项目清单（含 hostId）
let projects = [];
try {
  projects = await accessor.projectService.readProjects();
  for (const p of projects) {
    console.log(`project ${p.id} hostId=${p.hostId} name=${p.name} roots=${JSON.stringify((p.roots ?? []).map((r) => r.rootPath))}`);
  }
} catch (e) { console.log("readProjects 失败:", String(e?.message ?? e).slice(0, 160)); }

// 2) 复现：在该工作区 createSession
const tryCreate = async (label) => {
  try {
    const ack = await accessor.zcodeAgentService.sendConversationCommandV4({
      workspacePath: WS_PATH,
      envelope: { commandId: uuidv7(), clientId: "uchg-probe", sessionId: null, type: "createSession",
        payload: { workspaceId: WS_PATH, firstInput: { text: "自动化端到端测试：请只回复四个字符 OK-OK，不要执行任何操作。" } }, issuedAt: Date.now() },
    });
    console.log(`${label} createSession OK:`, JSON.stringify(ack).slice(0, 160));
    return true;
  } catch (e) { console.log(`${label} createSession 失败:`, String(e?.message ?? e).slice(0, 160)); return false; }
};
const before = await tryCreate("注册前");
if (!before) {
  // 3) server 作用域 saveProject 后重试
  try {
    const saved = await accessor.projectService.saveProject({ name: "默认对话", roots: [WS_PATH], primaryRoot: WS_PATH });
    console.log("saveProject OK:", JSON.stringify(saved).slice(0, 200));
  } catch (e) { console.log("saveProject 失败:", String(e?.message ?? e).slice(0, 160)); }
  await tryCreate("注册后");
}
process.exit(0);
