// remoteRelayClient 的接缝测试。
//
// 覆盖「Main ↔ Host 的 MessagePort 桥」这条最容易出错的边界：
//   - WS 侧用 SocketProtocol（13 字节帧头），Host 侧用 MessagePortProtocol（裸 payload）
//   - 两侧帧格式不同，必须由两个协议实例各自成帧，不能搬字节
// 这里用假 channel + 真 WS 服务器驱动**真实的** remoteRelayClient，
// 不依赖 Electron（模块本身已通过 createChannel 注入解耦）。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { SocketProtocol, VSBuffer } from "@zcode/rpc";
import { WebSocketServer } from "ws";
import { createRemoteRelayClient } from "../src/main/remoteRelayClient.ts";

const HOST_SECRET = "test-secret";
const WORKSPACE_PATH = "/tmp/relay-test-workspace";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** 轮询等待条件成立，避免依赖固定 sleep 时长。 */
async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return false;
}

/** 两个互连的假端口：port1.postMessage → port2 的 message 监听器，反之亦然。 */
function createLinkedPorts() {
  const bus = { a: new Set(), b: new Set() };
  const make = (self, other) => ({
    on(event, cb) {
      if (event === "message") bus[self].add(cb);
      return this;
    },
    off(event, cb) {
      if (event === "message") bus[self].delete(cb);
      return this;
    },
    postMessage(message) {
      for (const cb of bus[other]) queueMicrotask(() => cb({ data: message }));
    },
    start() {},
    close() {
      bus[self].clear();
    },
  });
  return { port1: make("a", "b"), port2: make("b", "a") };
}

/** 把 ws 包成 @zcode/rpc 的 ISocket（与 packages/server 的同名私有函数同构）。 */
function wrapWs(ws) {
  const dataHandlers = new Set();
  const closeHandlers = new Set();
  ws.on("message", (raw) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    for (const cb of dataHandlers) cb(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    for (const cb of closeHandlers) cb();
  });
  ws.on("error", () => {
    for (const cb of closeHandlers) cb();
  });
  return {
    onData: (cb) => (dataHandlers.add(cb), { dispose: () => dataHandlers.delete(cb) }),
    onClose: (cb) => (closeHandlers.add(cb), { dispose: () => closeHandlers.delete(cb) }),
    onEnd: (cb) => (closeHandlers.add(cb), { dispose: () => closeHandlers.delete(cb) }),
    write: (buffer) => {
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
    },
    end: () => ws.close(),
    drain: () => Promise.resolve(),
    dispose: () => ws.close(),
  };
}

/** 起一个「假 relay」：HTTP + WS 同端口，行为与 deploy/vps-relay/relay.mjs 的最小交集。 */
async function startFakeRelay() {
  const state = { hostReports: [], hostSocket: null, relayProtocol: null, received: [], hostConnections: 0, upgradeUrls: [] };

  const httpServer = createServer((req, res) => {
    if (req.url === "/api/host-report" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          state.hostReports.push(JSON.parse(body));
        } catch {
          state.hostReports.push(null);
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    state.upgradeUrls.push(req.url ?? "");
    if (!req.url?.startsWith("/host")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      state.hostSocket = ws;
      state.hostConnections += 1;
      // relay 侧也用 SocketProtocol —— 与桌面侧同一套帧格式。
      const protocol = new SocketProtocol(wrapWs(ws));
      protocol.onMessage((buf) => state.received.push(Buffer.from(buf.buffer)));
      state.relayProtocol = protocol;
    });
  });

  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = httpServer.address().port;
  return {
    state,
    url: `ws://127.0.0.1:${port}`,
    close: async () => {
      // httpServer.close() 会等待所有连接（含已升级的 WS）关闭，必须先强制断开，
      // 否则 after 钩子会永久挂住。
      for (const socket of [state.hostSocket, ...wss.clients]) {
        try {
          socket?.terminate();
        } catch {
          /* 已关闭 */
        }
      }
      wss.close();
      httpServer.closeAllConnections?.();
      await new Promise((r) => httpServer.close(r));
    },
  };
}

test("remoteRelayClient：上报工作区 + 挂载 Host + 帧格式转码 + 重连复用 attachmentId", async (t) => {
  const relay = await startFakeRelay();
  t.after(relay.close);

  const logs = [];
  const hostPosts = [];
  let hostPort = null;

  const client = createRemoteRelayClient({
    url: relay.url,
    hostSecret: HOST_SECRET,
    hostLabel: "test-host",
    appVersion: "0.0.0-test",
    logger: { info: (m) => logs.push(["info", m]), warn: (m) => logs.push(["warn", m]) },
    resolveTargetWindow: () => ({ windowId: 1, hostProcess: { postMessage: (msg, transfer) => hostPosts.push({ msg, transfer }) } }),
    resolveWorkspace: () => ({ workspacePath: WORKSPACE_PATH }),
    createChannel: () => {
      const ports = createLinkedPorts();
      hostPort = ports.port2; // 相当于转交给 Host 的那一端
      return ports;
    },
    heartbeatIntervalMs: 60_000,
  });

  client.start();
  t.after(() => client.stop());

  // 1) 桌面拨出并连上 relay
  assert.ok(await until(() => relay.state.hostSocket?.readyState === 1), "桌面应连上 relay 的 /host");

  // 2) 上报工作区（走独立 HTTP，不污染数据面帧流）
  assert.ok(await until(() => relay.state.hostReports.length > 0), "应上报工作区");
  assert.equal(relay.state.hostReports[0].workspacePath, WORKSPACE_PATH);
  assert.equal(relay.state.hostReports[0].hostLabel, "test-host");

  // 3) 向窗口 Host 挂载：clientMode 与 scope 必须精确（local scope 是 .strict() 的）
  assert.ok(await until(() => hostPosts.length > 0), "应向 Host 投递 AttachServicePort");
  const attach = hostPosts[0].msg;
  assert.equal(attach.type, "attach-service-port");
  assert.equal(attach.clientMode, "web-remote-replayable");
  assert.deepEqual(attach.scope, { kind: "local" });
  assert.ok(attach.attachmentId, "应带 attachmentId");
  assert.equal(hostPosts[0].transfer?.length, 1, "应把 port2 转移给 Host");

  // 4) ★ 转码：relay 发一个 SocketProtocol 帧 → Host 侧应收到**裸 payload**
  const payloadA = Buffer.from("hello-from-relay");
  relay.state.relayProtocol.send(VSBuffer.wrap(new Uint8Array(payloadA)));

  const gotByHost = [];
  hostPort.on("message", (e) => gotByHost.push(e.data));
  assert.ok(await until(() => gotByHost.length > 0), "Host 侧应收到 payload");
  assert.ok(gotByHost[0] instanceof Uint8Array, `应是裸 Uint8Array，实际 ${gotByHost[0]?.constructor?.name}`);
  assert.deepEqual(Buffer.from(gotByHost[0]), payloadA, "payload 应逐字节一致（帧头已被剥掉）");

  // 5) ★ 反向转码：Host 侧发裸 payload → relay 应收到一个合法的 SocketProtocol 帧
  const payloadB = Buffer.from("hello-from-host");
  relay.state.received.length = 0;
  hostPort.postMessage(payloadB);
  assert.ok(await until(() => relay.state.received.length > 0), "relay 侧应收到 payload");
  assert.deepEqual(relay.state.received[0], payloadB, "payload 应逐字节一致（已加上帧头）");

  // 6) 重连必须复用同一个 attachmentId（Host registry 靠它做原子替换）
  const firstAttachmentId = attach.attachmentId;
  relay.state.hostSocket.close();
  assert.ok(await until(() => hostPosts.length > 1, 6000), "断开后应重连并重新挂载");
  assert.equal(hostPosts[1].msg.attachmentId, firstAttachmentId, "重连应复用同一 attachmentId");
});

test("remoteRelayClient：没有窗口时进入退避重试，且日志带原因", async (t) => {
  const relay = await startFakeRelay();
  t.after(relay.close);

  const warns = [];
  let windowAvailable = false;

  const client = createRemoteRelayClient({
    url: relay.url,
    hostSecret: HOST_SECRET,
    logger: { info: () => {}, warn: (m) => warns.push(m) },
    resolveTargetWindow: () =>
      windowAvailable ? { windowId: 1, hostProcess: { postMessage: () => {} } } : null,
    resolveWorkspace: () => null,
    createChannel: () => createLinkedPorts(),
    heartbeatIntervalMs: 60_000,
  });

  client.start();
  t.after(() => client.stop());

  // 窗口未就绪 → 不建连接，但日志必须说明原因（不能只说「断开」误导排查）
  assert.ok(await until(() => warns.length > 0), "应记录重试日志");
  assert.match(warns[0], /尚无可用窗口/, `日志应说明原因，实际: ${warns[0]}`);
  assert.equal(relay.state.hostSocket, null, "没有窗口时不应建立连接");

  // 窗口出现后应自动接上
  windowAvailable = true;
  assert.ok(await until(() => relay.state.hostSocket?.readyState === 1, 6000), "窗口出现后应连上");
});

test("remoteRelayClient：工作区晚于 WS 连接就绪时会补报", async (t) => {
  const relay = await startFakeRelay();
  t.after(relay.close);

  // 真实场景：WS 连上时渲染器往往还没把工作区报给 Main（实测晚约 7 秒），
  // 若上报只做一次，手机端 /api/server-info 的 workspaces 会永远是空的。
  let workspaceReady = false;

  const client = createRemoteRelayClient({
    url: relay.url,
    hostSecret: HOST_SECRET,
    logger: { info: () => {}, warn: () => {} },
    resolveTargetWindow: () => ({ windowId: 1, hostProcess: { postMessage: () => {} } }),
    resolveWorkspace: () => (workspaceReady ? { workspacePath: WORKSPACE_PATH } : null),
    createChannel: () => createLinkedPorts(),
    heartbeatIntervalMs: 120, // 缩短心跳，便于观察补报
  });

  client.start();
  t.after(() => client.stop());

  assert.ok(await until(() => relay.state.hostSocket?.readyState === 1), "应先连上 relay");
  await wait(300);
  assert.equal(relay.state.hostReports.length, 0, "工作区未就绪时不应上报");

  workspaceReady = true;
  assert.ok(await until(() => relay.state.hostReports.length > 0, 3000), "工作区就绪后心跳应补报");
  assert.equal(relay.state.hostReports[0].workspacePath, WORKSPACE_PATH);

  // 路径没变就不该重复上报（避免每 30s 打一次无意义的 POST）
  const afterFirst = relay.state.hostReports.length;
  await wait(400);
  assert.equal(relay.state.hostReports.length, afterFirst, "同一路径不应重复上报");
});

test("remoteRelayClient：手机离线连坐（close 4003）走快速补位，不进指数退避", async (t) => {
  const relay = await startFakeRelay();
  t.after(relay.close);

  const warns = [];
  const client = createRemoteRelayClient({
    url: relay.url,
    hostSecret: HOST_SECRET,
    logger: { info: () => {}, warn: (m) => warns.push(m) },
    resolveTargetWindow: () => ({ windowId: 1, hostProcess: { postMessage: () => {} } }),
    resolveWorkspace: () => ({ workspacePath: WORKSPACE_PATH }),
    createChannel: () => createLinkedPorts(),
    heartbeatIntervalMs: 60_000,
  });

  client.start();
  t.after(() => client.stop());

  assert.ok(await until(() => relay.state.hostSocket?.readyState === 1), "桌面应连上 relay");
  const connectionsAfterFirst = relay.state.hostConnections;

  // relay 以 4003 关闭（手机离线连坐，手机刷新的常规后果）：
  // 应在 ~100ms 快速补位。若误走 1s 指数退避，700ms 内不会出现第二条连接。
  relay.state.hostSocket.close(4003, "client-offline");
  assert.ok(
    await until(() => relay.state.hostConnections >= connectionsAfterFirst + 1, 700),
    "4003 连坐应在快速延迟内重连",
  );
  assert.ok(
    warns.some((m) => /快速补位/.test(m)),
    `重连日志应说明快速补位原因，实际: ${JSON.stringify(warns)}`,
  );
});

test("remoteRelayClient：slot 参数 → 拨出 /host?slot=<k>（多槽位 spec §17）", async (t) => {
  const relay = await startFakeRelay();
  t.after(relay.close);

  const client = createRemoteRelayClient({
    url: relay.url,
    hostSecret: HOST_SECRET,
    slot: 1,
    logger: { info: () => {}, warn: () => {} },
    resolveTargetWindow: () => ({ windowId: 1, hostProcess: { postMessage: () => {} } }),
    resolveWorkspace: () => ({ workspacePath: WORKSPACE_PATH }),
    createChannel: () => createLinkedPorts(),
    heartbeatIntervalMs: 60_000,
  });
  client.start();
  t.after(() => client.stop());

  assert.ok(
    await until(() => relay.state.hostSocket?.readyState === 1),
    "桌面应连上 relay",
  );
  assert.ok(
    relay.state.upgradeUrls.some((u) => u === "/host?slot=1"),
    `升级 URL 应带 ?slot=1，实际: ${JSON.stringify(relay.state.upgradeUrls)}`,
  );
  // 拨出成功后照常上报工作区（槽位不影响控制面行为）。
  assert.ok(await until(() => relay.state.hostReports.length > 0), "应上报工作区");
});
