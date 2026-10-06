/**
 * 路线 B 数据面集成测试（spec vps-relay-bridge.md §14.9）：
 * spawn 真实 relay-official + 真 device 客户端 + 真数据面分派器 + 假 Host +
 * 裸 WS 模拟 terminal（terminal 复用同一 codec 实现，与控制面套件的验证思路一致）。
 * 运行：node --import tsx --test packages/desktop/tests/remote-official-data-plane.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";

import { createRemoteOfficialDeviceClient } from "../src/main/remoteOfficialDeviceClient.ts";
import { createOfficialDataPlane } from "../src/main/remoteOfficialDataPlane.ts";
import { createOfficialFrameCodec } from "../src/main/remoteOfficialFrameCodec.ts";

const DEVICE_MID = `mid-${randomBytes(8).toString("base64url")}`;
const DEVICE_PASSWORD = `pw-${randomBytes(18).toString("base64url")}`;
const APP_VERSION = "test-1.0.0";
const DEMO_WORKSPACE = "/tmp/ws-demo";
const passHash = createHash("sha256").update(DEVICE_PASSWORD).digest("base64");
const calculateProof = (key, nonce, role, sid) =>
  createHmac("sha256", key).update(`${nonce}|${role}|${sid}`).digest("base64url");

let child;
let httpUrl;
let wsUrl;
let device;
let dataPlane;
let terminal;
let hostMessages = [];
let hostSender = null;
let hostAttach = null;

async function getFreePort() {
  const probe = createServer();
  await new Promise((resolvePromise) => probe.listen(0, "127.0.0.1", resolvePromise));
  const port = probe.address().port;
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  return port;
}

before(async () => {
  const port = await getFreePort();
  httpUrl = `http://127.0.0.1:${port}`;
  wsUrl = `ws://127.0.0.1:${port}`;
  child = spawn(
    process.execPath,
    [join(import.meta.dirname, "../../../deploy/vps-relay/relay-official.mjs")],
    { env: { ...process.env, PORT: String(port) }, stdio: "ignore" },
  );
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`${httpUrl}/healthz`)).ok) break;
    } catch {
      /* not ready yet */
    }
    if (Date.now() > deadline) throw new Error("relay-official 未就绪");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }

  /** 假 Host：postMessage 捕获 attach；transfer 回来的 port2 就是「Host 侧」发送端。 */
  const fakeHostProcess = {
    postMessage: (msg, transfer) => {
      hostAttach = { msg, transfer };
      hostSender = transfer?.[0] ?? null;
    },
  };
  dataPlane = createOfficialDataPlane({
    logger: { info() {}, warn() {}, debug() {} },
    appVersion: APP_VERSION,
    getDeviceSid: () => device?.getStatus().deviceSid ?? null,
    listWorkspaces: () => [{ workspacePath: DEMO_WORKSPACE }],
    resolveBridgeTarget: (workspaceKey) =>
      workspaceKey === DEMO_WORKSPACE ? { windowId: 1, hostProcess: fakeHostProcess } : null,
    resolveWindowWorkspace: () => ({ workspacePath: DEMO_WORKSPACE }),
    createChannel: () => createLinkedPorts(),
    sendData: (payload) => device?.sendData(payload) ?? false,
  });
  device = createRemoteOfficialDeviceClient({
    url: wsUrl,
    deviceMid: DEVICE_MID,
    devicePassword: DEVICE_PASSWORD,
    heartbeatIntervalMs: 500,
    authTimeoutMs: 5_000,
    logger: { info() {}, warn() {}, debug() {} },
    onData: (payload) => dataPlane.handlePayload(payload),
  });
  device.start();
  await waitFor(() => device.getStatus().deviceSid, "device_sid");
  terminal = await openTerminal(device.getStatus().deviceSid);
});

after(() => {
  device?.stop();
  dataPlane?.dispose();
  terminal?.ws.close();
  child?.kill();
});

/** 假 MessagePort 对：postMessage 即在对端触发 message 事件（裸 payload 直传）。 */
function createLinkedPorts() {
  const makePort = () => ({
    listeners: [],
    peer: null,
    on(event, listener) {
      this.listeners.push(listener);
      return this;
    },
    off(event, listener) {
      this.listeners = this.listeners.filter((item) => item !== listener);
      return this;
    },
    postMessage(data) {
      this.peer?.listeners.forEach((listener) => listener({ data }));
    },
    start() {},
    close() {},
  });
  const port1 = makePort();
  const port2 = makePort();
  port1.peer = port2;
  port2.peer = port1;
  return { port1, port2 };
}

async function waitFor(fn, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待 ${label} 超时`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 40));
  }
}

/** 模拟 terminal：控制面鉴权一次；数据面收发与同款 codec 由各测试复用。 */
function openTerminal(deviceSid) {
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(`${wsUrl}/ws`);
    const controlInbox = [];
    const dataLog = [];
    let codecT = null;
    // codec 以 sendEnvelope 的布尔返回判断「通道可发」；必须显式回 true/false。
    const sendPayload = (payload) => {
      ws.send(JSON.stringify({ type: "data", payload }));
      return ws.readyState === WebSocket.OPEN;
    };
    ws.on("error", rejectPromise);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "auth_init", role: "terminal", device_sid: deviceSid, client_ts: Date.now() }));
    });
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === "data") {
        dataLog.push(msg.payload);
        // raw transport 信封交给 terminal codec（ack/重组）。
        if (msg.payload.zcode_type === "rpc-frame" || msg.payload.zcode_type === "rpc-frame-ack") {
          codecT?.handleEnvelope(msg.payload);
        }
        return;
      }
      if (msg.type === "auth_challenge") {
        // 链接 hash 是 terminal 的 HMAC key（§14.2）；这里从配对链接现取。
        void fetchLinkHash(deviceSid).then((hash) => {
          ws.send(JSON.stringify({
            type: "auth_response",
            device_sid: deviceSid,
            proof: calculateProof(hash, msg.nonce, "terminal", deviceSid),
            client_ts: Date.now(),
          }));
        });
        return;
      }
      controlInbox.push(msg);
    });
    (async () => {
      const hash = await fetchLinkHash(deviceSid);
      await waitFor(() => controlInbox.some((m) => m.pair_status === "matched"), "terminal matched");
      resolvePromise({
        ws,
        sendPayload,
        linkHash: hash,
        waitForData: (match, label) =>
          waitFor(() => [...dataLog].reverse().find(match) ?? null, label),
        /** 建立 terminal 侧 codec（每个 bridge 一个，onMessage 可后续注入）。 */
        attachCodec: (identity) => {
          let onMessage = () => {};
          codecT = createOfficialFrameCodec({
            identity,
            sendEnvelope: sendPayload,
            onMessage: (bytes) => onMessage(bytes),
            onDegrade: () => {},
            logger: { warn() {} },
          });
          return {
            sendFrame: (bytes) => codecT.sendFrame(bytes),
            setOnMessage: (handler) => {
              onMessage = handler;
            },
            // terminal 收到 workspace-bridge-ready 即视为发送就绪（与 device 侧对等）。
            markReady: () => codecT.markReady(),
          };
        },
      });
    })().catch(rejectPromise);
  });
}

async function fetchLinkHash(deviceSid) {
  const linkProof = calculateProof(passHash, "link", "device", deviceSid);
  const response = await fetch(`${httpUrl}/api/remote-control/link?sid=${encodeURIComponent(deviceSid)}`, {
    headers: { authorization: `Bearer ${linkProof}` },
  });
  assert.equal(response.status, 200);
  const { link } = await response.json();
  return new URL(link).searchParams.get("hash");
}

/** 建立 echo 桥：Host 收到即回显，返回 codec 句柄。 */
async function openEchoBridge(bridgeSessionId, requestId) {
  terminal.sendPayload({
    zcode_type: "workspace-bridge-open",
    requestId,
    bridgeSessionId,
    workspaceKey: DEMO_WORKSPACE,
  });
  await terminal.waitForData(
    (p) => p.zcode_type === "workspace-bridge-ready" && p.requestId === requestId,
    "bridge ready",
  );
  hostMessages = [];
  hostSender.on("message", (event) => {
    hostMessages.push(Buffer.from(event.data));
    hostSender.postMessage(event.data);
  });
  const codec = terminal.attachCodec({ bridgeSessionId });
  const received = [];
  codec.setOnMessage((bytes) => received.push(Buffer.from(bytes)));
  codec.markReady();
  return { codec, received };
}

test("bootstrap-request → bootstrap-response：success + workspaces + windowControlSessionId", async () => {
  terminal.sendPayload({ zcode_type: "bootstrap-request", requestId: "req-b1" });
  const response = await terminal.waitForData(
    (p) => p.zcode_type === "bootstrap-response" && p.requestId === "req-b1",
    "bootstrap-response",
  );
  assert.equal(response.success, true);
  assert.equal(response.result.windowControlSessionId, device.getStatus().deviceSid);
  assert.equal(response.result.desktopAppVersion, APP_VERSION);
  assert.equal(response.result.workspaces[0].workspaceKey, DEMO_WORKSPACE);
  assert.deepEqual(response.result.tasks, []);
});

test("workspace-bridge-open → ready：bridge 字段齐全 + Host 收到 attach", async () => {
  terminal.sendPayload({
    zcode_type: "workspace-bridge-open",
    requestId: "req-o1",
    bridgeSessionId: "bs-test-1",
    workspaceKey: DEMO_WORKSPACE,
  });
  const ready = await terminal.waitForData(
    (p) => p.zcode_type === "workspace-bridge-ready" && p.requestId === "req-o1",
    "workspace-bridge-ready",
  );
  assert.equal(ready.bridgeSessionId, "bs-test-1");
  assert.equal(ready.bridge.workspacePath, DEMO_WORKSPACE);
  assert.equal(ready.bridge.readyAnnounced, true);
  assert.ok(ready.bridge.attachmentId.startsWith("official-bridge-"));
  assert.equal(dataPlane.getBridgeIdentity()?.bridgeSessionId, "bs-test-1");
  assert.ok(hostAttach, "Host 应收到 attach 消息");
  assert.equal(hostAttach.msg.type, "attach-service-port");
  assert.equal(hostAttach.msg.clientMode, "web-remote-replayable");
  assert.deepEqual(hostAttach.msg.scope, { kind: "local" });
  assert.equal(hostAttach.msg.attachmentId, ready.bridge.attachmentId);
});

test("rpc-frame 双向往返：terminal 帧 → Host；Host echo → terminal；ack 到达 terminal", async () => {
  const { codec, received } = await openEchoBridge("bs-echo", "req-o2");
  const payload = Buffer.from(`frame-${randomBytes(16).toString("hex")}`);
  assert.equal(codec.sendFrame(new Uint8Array(payload)), true, "terminal 发帧应成功");
  const byHost = await waitFor(() => hostMessages[0], "Host 收到帧");
  assert.deepEqual(byHost, payload, "Host 收到的裸 payload 应与 terminal 发出的一致");
  const atTerminal = await waitFor(() => received[0], "terminal 收到 echo");
  assert.deepEqual(atTerminal, payload, "terminal 收到的 echo 应逐字节一致");
  const ack = await terminal.waitForData((p) => p.zcode_type === "rpc-frame-ack", "terminal 收到 ack");
  assert.ok(ack.ackMessageSeq >= 1);
});

test("大于 1MiB 的帧：双向分片重组逐字节保真", async () => {
  const { codec, received } = await openEchoBridge("bs-big", "req-o3");
  const big = Buffer.alloc(1536 * 1024);
  for (let i = 0; i < big.length; i += 4096) big.writeUInt32LE(i, i);
  assert.equal(codec.sendFrame(new Uint8Array(big)), true);
  const byHost = await waitFor(() => hostMessages[0], "Host 收到 1.5MiB 帧", 15_000);
  assert.deepEqual(byHost, big, "分片重组后应逐字节一致");
  const back = await waitFor(() => received[0], "terminal 收到反向 1.5MiB 帧", 15_000);
  assert.deepEqual(back, big, "反向分片重组后应逐字节一致");
});

test("workspaceKey 不匹配 → workspace-bridge-error", async () => {
  terminal.sendPayload({
    zcode_type: "workspace-bridge-open",
    requestId: "req-e1",
    bridgeSessionId: "bs-bad",
    workspaceKey: "/not/a/real/workspace",
  });
  const error = await terminal.waitForData(
    (p) => p.zcode_type === "workspace-bridge-error" && p.requestId === "req-e1",
    "workspace-bridge-error",
  );
  assert.equal(error.bridgeSessionId, "bs-bad");
  assert.ok(error.error.length > 0);
});
