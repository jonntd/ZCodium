// remoteRelayClient 的 E2EE 集成测试（spec vps-relay-bridge.md §16）。
//
// 与 remote-relay-client.test.mjs 的差别：relay 是**哑管道**（按字节转发，不在
// relay 侧解帧），测试在这侧扮演手机——用同一 channelKey 构造真实的
// RelayE2eeChannel + SocketProtocol + ChannelServer（与真手机同构）。
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { SocketProtocol, VSBuffer } from "@zcode/rpc";
import { generateRelayChannelKey, RelayE2eeChannel } from "@zcode/shared";
import { WebSocketServer } from "ws";
import { createRemoteRelayClient } from "../src/main/remoteRelayClient.ts";

const HOST_SECRET = "test-secret";
const WORKSPACE_PATH = "/tmp/relay-test-workspace";
const E2EE_KEY = generateRelayChannelKey();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await wait(25);
  }
  return false;
}

/** 两个互连的假端口（与主测试文件同构）。 */
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

/**
 * E2EE 集成用的「哑 relay + 模拟手机」：relay 只按字节转发（与 deploy/vps-relay/relay.mjs
 * 同构），测试在这侧扮演手机——用同一 channelKey 构造真实的 RelayE2eeChannel（spec §16）。
 * 与 startFakeRelay 的差别：这里**不**在 relay 侧解帧（密文对 relay 必须不透明）。
 */
async function startE2eeFakeRelay(phoneChannelKey) {
  const state = {
    hostSocket: null,
    hostConnections: 0,
    phoneChannel: null,
    phoneProtocol: null,
    phonePlaintext: [],
    phoneFatal: null,
    wireFromHost: [],
  };

  const httpServer = createServer((req, res) => {
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/host")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      state.hostSocket = ws;
      state.hostConnections += 1;
      // 与真实手机同构：SocketProtocol 架在 E2EE 通道之上。
      // E2EE 解出的明文是完整 SocketProtocol 帧（13B 帧头 + payload），由这里解帧。
      const dataHandlers = new Set();
      const phone = new RelayE2eeChannel({
        role: "phone",
        channelKey: phoneChannelKey,
        send: (data) => {
          if (ws.readyState === ws.OPEN) ws.send(data);
        },
        onPlaintext: (data) => {
          for (const cb of dataHandlers) cb(VSBuffer.wrap(new Uint8Array(data)));
        },
        onFatal: (error) => {
          state.phoneFatal = error;
        },
      });
      state.phoneChannel = phone;
      const phoneProtocol = new SocketProtocol({
        onData: (cb) => (dataHandlers.add(cb), { dispose: () => dataHandlers.delete(cb) }),
        onClose: () => ({ dispose: () => {} }),
        onEnd: () => ({ dispose: () => {} }),
        write: (buffer) => phone.write(buffer.buffer),
        end: () => {},
        drain: () => Promise.resolve(),
        dispose: () => {},
      });
      state.phoneProtocol = phoneProtocol;
      phoneProtocol.onMessage((buf) => state.phonePlaintext.push(Buffer.from(buf.buffer)));
      ws.on("message", (raw) => {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        state.wireFromHost.push(buf);
        phone.accept(new Uint8Array(buf));
      });
    });
  });

  await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
  const port = httpServer.address().port;
  return {
    state,
    url: `ws://127.0.0.1:${port}`,
    close: async () => {
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

test("remoteRelayClient E2EE：线上只有握手与密文，握手后帧内容正确到达对端", async (t) => {
  const relay = await startE2eeFakeRelay(E2EE_KEY);
  t.after(relay.close);

  let hostPort = null;
  const client = createRemoteRelayClient({
    url: relay.url,
    hostSecret: HOST_SECRET,
    e2eeChannelKey: E2EE_KEY,
    logger: { info: () => {}, warn: () => {} },
    resolveTargetWindow: () => ({ windowId: 1, hostProcess: { postMessage: () => {} } }),
    resolveWorkspace: () => ({ workspacePath: WORKSPACE_PATH }),
    createChannel: () => {
      const ports = createLinkedPorts();
      hostPort = ports.port2;
      return ports;
    },
    heartbeatIntervalMs: 60_000,
  });

  client.start();
  t.after(() => client.stop());

  assert.ok(await until(() => relay.state.hostSocket?.readyState === 1), "桌面应连上 relay");
  assert.ok(
    await until(() => relay.state.phoneChannel?.isSecure() === true),
    "E2EE 握手应完成（双端 confirm 校验通过）",
  );

  // 线上第一帧必须是 ZRE1 hello（手机端靠它区分 E2EE 与旧 bundle）
  const wire = relay.state.wireFromHost;
  assert.ok(wire.length > 0, "应有 wire 字节");
  assert.equal(wire[0].subarray(0, 4).toString("latin1"), "ZRE1");

  // Host → phone：明文帧经加密桥到达手机侧，逐字节一致
  const payloadA = Buffer.from("secret-init-frame");
  hostPort.postMessage(payloadA);
  assert.ok(await until(() => relay.state.phonePlaintext.length > 0), "手机侧应收到解密帧");
  assert.deepEqual(relay.state.phonePlaintext[0], payloadA, "解密帧应逐字节一致");

  // phone → Host：手机的请求经加密桥到达 Host 侧端口
  const gotByHost = [];
  hostPort.on("message", (e) => gotByHost.push(e.data));
  const payloadB = Buffer.from("phone-rpc-request");
  relay.state.phoneProtocol.send(VSBuffer.wrap(new Uint8Array(payloadB)));
  assert.ok(await until(() => gotByHost.length > 0), "Host 侧应收到手机请求");
  assert.deepEqual(Buffer.from(gotByHost[0]), payloadB, "请求应逐字节一致");

  // ★ 全程线上无明文（中继视角）：这是 E2EE 的存在意义
  const raw = Buffer.concat(relay.state.wireFromHost).toString("latin1");
  assert.ok(!raw.includes("secret-init-frame"), "wire 不得含 Host→phone 明文");
  assert.ok(!raw.includes("phone-rpc-request"), "wire 不得含 phone→Host 明文");
});

test("remoteRelayClient E2EE：channelKey 不一致 → fail-closed 断开，不产明文", async (t) => {
  // 手机侧用**不同**的 key（错配置 / MITM 换钥场景）
  const relay = await startE2eeFakeRelay(generateRelayChannelKey());
  t.after(relay.close);

  const client = createRemoteRelayClient({
    url: relay.url,
    hostSecret: HOST_SECRET,
    e2eeChannelKey: E2EE_KEY,
    logger: { info: () => {}, warn: () => {} },
    resolveTargetWindow: () => ({ windowId: 1, hostProcess: { postMessage: () => {} } }),
    resolveWorkspace: () => ({ workspacePath: WORKSPACE_PATH }),
    createChannel: () => createLinkedPorts(),
    heartbeatIntervalMs: 60_000,
  });

  client.start();
  t.after(() => client.stop());

  // 注意不能断言瞬态的 readyState===1：握手失败后连接立刻被关闭，轮询会错过 OPEN 窗口。
  assert.ok(await until(() => relay.state.hostConnections > 0), "桌面应至少建立过一次连接");
  assert.ok(await until(() => relay.state.phoneFatal !== null), "手机侧 confirm 校验应失败 fatal");
  assert.ok(
    await until(() => relay.state.hostSocket.readyState !== 1, 3000),
    "桌面侧应 fail-closed 断开连接",
  );
  assert.equal(relay.state.phonePlaintext.length, 0, "全程不得产出任何明文");
});
