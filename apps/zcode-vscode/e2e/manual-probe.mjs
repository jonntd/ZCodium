/** 手动探针：连指定端口的隔离 server，握手后 createSession 触发 agent spawn。 */
import { ChannelClient, SocketProtocol, VSBuffer, Emitter } from "@zcode/rpc";
import { RemoteServiceAccess } from "@zcode/client";
import { uuidv7 } from "@zcode/shared";
import { homedir } from "node:os";
import { join } from "node:path";
const PORT = process.argv[2] ?? "18896";
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
try {
  const ack = await accessor.zcodeAgentService.sendConversationCommandV4({
    workspacePath: WS_PATH,
    envelope: { commandId: uuidv7(), clientId: "uchg-probe", sessionId: null, type: "createSession",
      payload: { workspaceId: WS_PATH, firstInput: { text: "自动化端到端测试：请只回复四个字符 OK-OK，不要执行任何操作。" } }, issuedAt: Date.now() },
  });
  console.log("createSession:", JSON.stringify(ack).slice(0, 200));
} catch (e) { console.log("createSession 失败:", String(e?.message ?? e).slice(0, 160)); }
process.exit(0);
