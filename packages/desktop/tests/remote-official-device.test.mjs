/**
 * 路线 B device 控制面客户端集成测试（spec vps-relay-bridge.md §14.8）：
 * spawn 真实 relay-official.mjs + 真实 remoteOfficialDeviceClient + 裸 WS 模拟 terminal。
 * 运行：node --import tsx --test packages/desktop/tests/remote-official-device.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";

import {
  createRemoteOfficialDeviceClient,
} from "../src/main/remoteOfficialDeviceClient.ts";
import {
  getOfficialRelayConfigFilePath,
  loadOfficialRelayStartConfig,
} from "../src/main/remoteOfficialConfig.ts";

const DEVICE_MID = `mid-${randomBytes(8).toString("base64url")}`;
const DEVICE_PASSWORD = `pw-${randomBytes(18).toString("base64url")}`;
/** 与 §14.2 官方算法一致（relay / 客户端 / 测试三方一致本身就是协议还原的验证点）。 */
const passHash = createHash("sha256").update(DEVICE_PASSWORD).digest("base64");
const calculateProof = (key, nonce, role, sid) =>
  createHmac("sha256", key).update(`${nonce}|${role}|${sid}`).digest("base64url");

let child;
let httpUrl;
let wsUrl;

async function getFreePort() {
  const probe = createServer();
  await new Promise((resolvePromise) => probe.listen(0, "127.0.0.1", resolvePromise));
  const port = probe.address().port;
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  return port;
}

before(async () => {
  // relay-official 的 PORT 同样不支持 0（Number("0") 为 falsy 回退 3180），先探空闲口。
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
      if ((await fetch(`${httpUrl}/healthz`)).ok) return;
    } catch {
      /* not ready yet */
    }
    if (Date.now() > deadline) throw new Error("relay-official 未就绪");
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
});

after(() => {
  child?.kill();
});

/** 收件箱：消息按谓词取用，未匹配的缓存（auth_ack 与 pair_status_ack 会重复投递）。 */
function attachInbox(ws) {
  const inbox = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const msg = JSON.parse(String(raw));
    const index = waiters.findIndex((waiter) => waiter.match(msg));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  return {
    wait(match, label, timeoutMs = 5_000) {
      const index = inbox.findIndex(match);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolvePromise, rejectPromise) => {
        const waiter = { match, resolve: resolvePromise };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
          rejectPromise(new Error(`等待 ${label} 超时`));
        }, timeoutMs);
        timer.unref?.();
      });
    },
    send: (msg) => ws.send(JSON.stringify(msg)),
  };
}

/** 裸 WS 设备端：注册 → 鉴权，resolve 出可收发句柄（data 转发回归用）。 */
function openRawDevice() {
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(`${wsUrl}/ws?mid=${DEVICE_MID}-raw`);
    const io = attachInbox(ws);
    ws.on("error", rejectPromise);
    ws.on("open", () => {
      io.send({
        type: "device_register_init",
        device_mid: DEVICE_MID,
        pass_hash: passHash,
        meta: {},
        client_ts: Date.now(),
      });
    });
    (async () => {
      const ack = await io.wait((m) => m.type === "device_register_ack", "注册 ack");
      const sid = String(ack.device_sid);
      io.send({ type: "auth_init", role: "device", device_sid: sid, meta: {}, client_ts: Date.now() });
      const challenge = await io.wait((m) => m.type === "auth_challenge", "device challenge");
      io.send({
        type: "auth_response",
        device_sid: sid,
        proof: calculateProof(passHash, challenge.nonce, "device", sid),
        client_ts: Date.now(),
      });
      await io.wait((m) => m.type === "auth_ack", "device auth ack");
      resolvePromise({ ws, sid, ...io });
    })().catch(rejectPromise);
  });
}

/**
 * 裸 WS 终端：发完 auth_init 即返回句柄。
 * 不能在这里等 challenge——terminal_busy 场景永远等不到 challenge，只能等 error。
 */
function openTerminalInit(sid) {
  return new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(`${wsUrl}/ws`);
    const io = attachInbox(ws);
    ws.on("error", () => {});
    ws.on("open", () => {
      io.send({ type: "auth_init", role: "terminal", device_sid: sid, client_ts: Date.now() });
      resolvePromise({ ws, ...io });
    });
    ws.on("error", rejectPromise);
  });
}

/** 回应 terminal 的 challenge；badProof=true 时故意回错（auth_failed 场景）。 */
async function answerTerminalChallenge(terminal, sid, linkHash, { badProof = false } = {}) {
  const challenge = await terminal.wait((m) => m.type === "auth_challenge", "terminal challenge");
  terminal.send({
    type: "auth_response",
    device_sid: sid,
    proof: badProof ? "not-a-real-proof" : calculateProof(linkHash, challenge.nonce, "terminal", sid),
    client_ts: Date.now(),
  });
}

async function waitFor(fn, label, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待 ${label} 超时`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
}

function makeDevice(overrides = {}) {
  const events = { links: [], statuses: [] };
  const client = createRemoteOfficialDeviceClient({
    url: wsUrl,
    deviceMid: DEVICE_MID,
    devicePassword: DEVICE_PASSWORD,
    heartbeatIntervalMs: 500,
    authTimeoutMs: 5_000,
    onLink: (link) => events.links.push(link),
    onPairStatus: (status) => events.statuses.push(status),
    ...overrides,
  });
  return { client, events };
}

/** 从链接端点取配对链接（正确 proof），并解析出 sid/hash。 */
async function fetchLink(sid) {
  const proof = calculateProof(passHash, "link", "device", sid);
  const response = await fetch(`${httpUrl}/api/remote-control/link?sid=${encodeURIComponent(sid)}`, {
    headers: { authorization: `Bearer ${proof}` },
  });
  assert.equal(response.status, 200, "正确 proof 应取到链接");
  const { link } = await response.json();
  const url = new URL(link);
  return { link, sid: url.searchParams.get("sid"), hash: url.searchParams.get("hash") };
}

/** 真 device 客户端 + 模拟 terminal 的完整配对，返回两端的观测句柄。 */
async function pairDeviceAndTerminal() {
  const { client, events } = makeDevice();
  client.start();
  const deviceSid = await waitFor(() => client.getStatus().deviceSid, "device_sid");
  const { link, hash } = await fetchLink(deviceSid);
  const terminal = await openTerminalInit(deviceSid);
  await answerTerminalChallenge(terminal, deviceSid, hash);
  const matched = await terminal.wait((m) => m.pair_status === "matched", "terminal matched");
  assert.equal(matched.pair_status, "matched");
  await waitFor(
    () => events.statuses.includes("matched") && events.links.length === 1,
    "device matched+link",
  );
  return { client, events, deviceSid, hash, link, terminal };
}

test("链接端点：无 proof / 错 proof / 未知 sid 一律 401，不泄露房间存在性", async () => {
  const device = await openRawDevice();
  const noProof = await fetch(`${httpUrl}/api/remote-control/link?sid=${device.sid}`);
  const badProof = await fetch(`${httpUrl}/api/remote-control/link?sid=${device.sid}`, {
    headers: { authorization: "Bearer wrong-proof" },
  });
  const ghostSid = "z".repeat(20);
  const unknownSid = await fetch(`${httpUrl}/api/remote-control/link?sid=${ghostSid}`, {
    headers: { authorization: `Bearer ${calculateProof(passHash, "link", "device", ghostSid)}` },
  });
  assert.equal(noProof.status, 401);
  assert.equal(badProof.status, 401);
  assert.equal(unknownSid.status, 401);
  device.ws.close();
});

test("真客户端注册→鉴权→waiting；terminal 接入后双端 matched，客户端取得链接", async () => {
  const { client, events, deviceSid, link } = await pairDeviceAndTerminal();
  assert.equal(client.getStatus().pairStatus, "matched");
  const url = new URL(link);
  assert.equal(url.searchParams.get("sid"), deviceSid, "链接 sid 必须等于 device_sid");
  assert.ok(url.searchParams.get("hash"), "链接必须带 terminal 的 HMAC key");
  assert.equal(url.searchParams.get("mid"), DEVICE_MID);
  // 链接里的 t 是取链接时刻，两次请求必然不同——只比形状，不比全等。
  const delivered = new URL(events.links[0]);
  assert.equal(delivered.origin + delivered.pathname, url.origin + url.pathname);
  assert.equal(delivered.searchParams.get("sid"), deviceSid);
  client.stop();
});

test("data 信封双向原样转发（relay 回归）", async () => {
  const device = await openRawDevice();
  const { hash } = await fetchLink(device.sid);
  const terminal = await openTerminalInit(device.sid);
  await answerTerminalChallenge(terminal, device.sid, hash);
  await terminal.wait((m) => m.type === "auth_ack" || m.pair_status, "terminal 鉴权");
  device.send({ type: "data", payload: { zcode_type: "probe", n: 1 } });
  const atTerminal = await terminal.wait((m) => m.type === "data", "terminal 收 data");
  assert.deepEqual(atTerminal.payload, { zcode_type: "probe", n: 1 });
  terminal.send({ type: "data", payload: { zcode_type: "probe", n: 2, deep: { a: [1, 2] } } });
  const atDevice = await device.wait((m) => m.type === "data", "device 收 data");
  assert.deepEqual(atDevice.payload, { zcode_type: "probe", n: 2, deep: { a: [1, 2] } });
  device.ws.close();
  terminal.ws.close();
});

test("terminal proof 错误 → error(auth_failed)", async () => {
  const device = await openRawDevice();
  const { hash } = await fetchLink(device.sid);
  const badTerminal = await openTerminalInit(device.sid);
  await answerTerminalChallenge(badTerminal, device.sid, hash, { badProof: true });
  const error = await badTerminal.wait((m) => m.type === "error", "auth_failed");
  assert.equal(error.code, "auth_failed");
  device.ws.close();
});

test("同房间第二个 terminal（首个仍在线）→ error(terminal_busy)", async () => {
  const { client, deviceSid, terminal } = await pairDeviceAndTerminal();
  const second = await openTerminalInit(deviceSid);
  const error = await second.wait((m) => m.type === "error", "terminal_busy");
  assert.equal(error.code, "terminal_busy");
  second.ws.close();
  terminal.ws.close();
  // 必须停掉客户端：心跳/重连 timer 会让 node --test 的事件循环永不排空。
  client.stop();
});

test("stop/start 后持久化复用：device_sid 不变（手机链接跨重启有效）", async () => {
  const { client, terminal } = await pairDeviceAndTerminal();
  const sidBefore = client.getStatus().deviceSid;
  try {
    client.stop();
    client.start();
    const sidAfter = await waitFor(() => client.getStatus().deviceSid, "重连后的 device_sid");
    assert.equal(sidAfter, sidBefore, "持久化模式复用同一房间，不再换新 sid（spec §14.8）");
    // terminal 仍在线时重鉴权直接广播 matched；离线时是 waiting。
    await waitFor(
      () => ["waiting", "matched"].includes(client.getStatus().pairStatus ?? ""),
      "复用房间后重新鉴权",
    );
  } finally {
    // 失败路径也必须停掉客户端：心跳/重连 timer 会让 node --test 事件循环永不排空。
    client.stop();
    terminal.ws.close();
  }
});

test("持久化 deviceSid：跳过注册直接 auth_init，复用同一房间（rooms 数不增）", async () => {
  // 先造一个已注册房间并拿到 sid，再断开原始 socket（模拟桌面重启）。
  const raw = await openRawDevice();
  const persistedSid = raw.sid;
  const roomsBefore = (await (await fetch(`${httpUrl}/healthz`)).json()).rooms;
  raw.ws.close();
  // 等 relay 的 close 处理落定（healthz 不暴露单房间 socket 状态）。
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));

  const { client, events } = makeDevice({ deviceSid: persistedSid });
  client.start();
  const sidAfter = await waitFor(() => client.getStatus().deviceSid, "复用的 device_sid");
  assert.equal(sidAfter, persistedSid, "必须复用持久化的房间 id，不得新建房间");
  const roomsAfter = (await (await fetch(`${httpUrl}/healthz`)).json()).rooms;
  assert.equal(roomsAfter, roomsBefore, "rooms 数不变 = 未走注册");
  await waitFor(() => events.statuses.includes("waiting"), "复用房间后完成鉴权");
  client.stop();
});

test("持久化 sid 失效（ghost）→ 自愈回退注册并重写持久化", async () => {
  const persistedCalls = [];
  const { client } = makeDevice({
    deviceSid: "ghost-sid-does-not-exist",
    onPersistDeviceSid: (sid) => persistedCalls.push(sid),
  });
  client.start();
  const newSid = await waitFor(
    () => {
      const sid = client.getStatus().deviceSid;
      return sid && sid !== "ghost-sid-does-not-exist" ? sid : null;
    },
    "自愈后的新 device_sid",
  );
  assert.deepEqual(persistedCalls[0], null, "失效先清除持久化");
  assert.equal(persistedCalls[persistedCalls.length - 1], newSid, "注册成功后写入新 sid");
  await waitFor(() => client.getStatus().pairStatus === "waiting", "自愈后完成鉴权");
  client.stop();
});

test("loadOfficialRelayStartConfig：缺失→null；启用→生成并持久化凭据；禁用→null；env url 不回写", async (t) => {
  const savedDataDir = process.env.ZCODIUM_DATA_BASE_DIR;
  const savedEnvUrl = process.env.ZCODE_OFFICIAL_RELAY_WS_URL;
  const sandbox = await mkdtemp(join(tmpdir(), "official-relay-cfg-"));
  process.env.ZCODIUM_DATA_BASE_DIR = sandbox;
  delete process.env.ZCODE_OFFICIAL_RELAY_WS_URL;
  t.after(() => {
    if (savedDataDir === undefined) delete process.env.ZCODIUM_DATA_BASE_DIR;
    else process.env.ZCODIUM_DATA_BASE_DIR = savedDataDir;
    if (savedEnvUrl === undefined) delete process.env.ZCODE_OFFICIAL_RELAY_WS_URL;
    else process.env.ZCODE_OFFICIAL_RELAY_WS_URL = savedEnvUrl;
  });

  assert.equal(await loadOfficialRelayStartConfig(), null, "文件缺失时不启用");

  const configPath = getOfficialRelayConfigFilePath();
  await writeFile(configPath, `${JSON.stringify({ enabled: true, url: "ws://relay.example" })}\n`, "utf8");
  const first = await loadOfficialRelayStartConfig();
  assert.ok(first?.url && first.deviceMid && first.devicePassword, "启用后应产出完整启动配置");
  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(persisted.deviceMid, first.deviceMid, "凭据必须持久化（与 pairingToken/channelKey 同模式）");
  assert.equal(persisted.devicePassword, first.devicePassword);
  const second = await loadOfficialRelayStartConfig();
  assert.deepEqual(second, first, "第二次读取复用同一凭据，不重新生成");

  await writeFile(
    configPath,
    `${JSON.stringify({ enabled: true, url: "ws://relay.example", deviceSid: "sid-persisted" })}\n`,
    "utf8",
  );
  const withSid = await loadOfficialRelayStartConfig();
  assert.equal(withSid?.deviceSid, "sid-persisted", "持久化的 deviceSid 应随启动配置返回");

  await writeFile(configPath, `${JSON.stringify({ enabled: false, url: "ws://relay.example" })}\n`, "utf8");
  assert.equal(await loadOfficialRelayStartConfig(), null, "enabled=false 不启用");

  process.env.ZCODE_OFFICIAL_RELAY_WS_URL = "ws://env-relay.example";
  await writeFile(configPath, `${JSON.stringify({ enabled: true })}\n`, "utf8");
  const viaEnv = await loadOfficialRelayStartConfig();
  assert.equal(viaEnv?.url, "ws://env-relay.example", "env url 优先");
  const afterEnv = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(afterEnv.url, undefined, "env url 不回写文件");
});
