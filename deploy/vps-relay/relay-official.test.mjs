/**
 * relay-official.mjs（路线 B 控制面中继，spec vps-relay-bridge.md §14.2/§14.8/§14.9a）
 * 的集成测试：spawn 真实 relay，用脚本 device / terminal 客户端走 wire 协议。
 * 取代 §14.7 的一次性双端模拟，成为 §14.8 验收表（7 场景）与 §14.9a 终端页的回归套件。
 *
 * 运行：node --test deploy/vps-relay/relay-official.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";

// ─────────────────────────────────────────────────────────────────────────────
// 客户端原语（与 relay-official.mjs / 官方语义逐字对应；三方一致性本身就是测试点）
// ─────────────────────────────────────────────────────────────────────────────

const calculateProof = (key, nonce, role, sid) =>
  createHmac("sha256", key).update(`${nonce}|${role}|${sid}`).digest("base64url");

const sha256b64 = (s) => createHash("sha256").update(s).digest("base64");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const crc32Hex = (bytes) => {
  let crc = 0xffffffff;
  for (const b of bytes) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ b) & 0xff];
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
};

/** 一个可收发的测试端（device 或 terminal）。收到的每条消息都进 inbox 供断言/等待。 */
class TestClient {
  constructor(url, { mid } = {}) {
    this.url = mid ? `${url}/ws?mid=${mid}` : `${url}/ws`;
    this.inbox = [];
    this.waiters = new Set();
    this.closed = { code: null, reason: null };
  }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.on("open", resolve);
      this.ws.on("error", reject);
    });
    this.ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      this.inbox.push(msg);
      for (const w of this.waiters) {
        if (w.pred(msg)) {
          this.waiters.delete(w);
          w.resolve(msg);
        }
      }
    });
    this.ws.on("close", (code, reason) => {
      this.closed = { code, reason: String(reason) };
      for (const w of this.waiters) {
        if (w.predClose) {
          this.waiters.delete(w);
          w.resolve(this.closed);
        }
      }
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  /** 等待满足谓词的下一条消息（扫 inbox 优先，避免竞态丢消息）。 */
  waitFor(pred, what, timeoutMs = 5_000, { predClose = false } = {}) {
    const hit = this.inbox.find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(entry);
        reject(new Error(`等待 ${what} 超时`));
      }, timeoutMs);
      const entry = {
        pred,
        predClose,
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
      };
      this.waiters.add(entry);
    });
  }

  close() {
    this.ws?.close();
  }
}

/** device 流程：register → auth → 返回 { client, deviceSid, passHash }。 */
async function connectDevice(url) {
  const password = randomBytes(24).toString("base64url");
  const passHash = sha256b64(password);
  const client = new TestClient(url, { mid: "test-device" });
  await client.open();
  client.send({
    type: "device_register_init",
    pass_hash: passHash,
    device_mid: `mid-${randomBytes(6).toString("base64url")}`,
    meta: { name: "test-device" },
    client_ts: Date.now(),
  });
  const ack = await client.waitFor((m) => m.type === "device_register_ack", "device_register_ack");
  client.send({
    type: "auth_init",
    role: "device",
    device_sid: ack.device_sid,
    client_ts: Date.now(),
  });
  const challenge = await client.waitFor((m) => m.type === "auth_challenge", "auth_challenge");
  client.send({
    type: "auth_response",
    device_sid: ack.device_sid,
    proof: calculateProof(passHash, challenge.nonce, "device", ack.device_sid),
    client_ts: Date.now(),
  });
  await client.waitFor((m) => m.type === "auth_ack", "auth_ack");
  return { client, deviceSid: ack.device_sid, passHash };
}

/** terminal 流程：auth_init(role:terminal) → challenge → auth_ack。 */
async function connectTerminal(url, deviceSid, linkHash) {
  const client = new TestClient(url);
  await client.open();
  client.send({
    type: "auth_init",
    role: "terminal",
    device_sid: deviceSid,
    client_ts: Date.now(),
  });
  const challenge = await client.waitFor((m) => m.type === "auth_challenge", "auth_challenge");
  client.send({
    type: "auth_response",
    device_sid: deviceSid,
    proof: calculateProof(linkHash, challenge.nonce, "terminal", deviceSid),
    client_ts: Date.now(),
  });
  await client.waitFor((m) => m.type === "auth_ack", "auth_ack");
  return client;
}

/** 用 device 的 passHash 经链接端点换配对链接（§14.8 链接获取）。 */
async function fetchPairLink(baseUrl, deviceSid, passHash) {
  const proof = calculateProof(passHash, "link", "device", deviceSid);
  const res = await fetch(
    `${baseUrl}/api/remote-control/link?sid=${encodeURIComponent(deviceSid)}`,
    {
      headers: { authorization: `Bearer ${proof}` },
    },
  );
  return { res, body: await res.json() };
}

function parsePairLink(link) {
  const u = new URL(link);
  return { path: u.pathname, params: Object.fromEntries(u.searchParams) };
}

// ─────────────────────────────────────────────────────────────────────────────
// relay 生命周期
// ─────────────────────────────────────────────────────────────────────────────

let child;
let baseUrl;

async function waitForReady(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch {
      /* not ready yet */
    }
    if (Date.now() > deadline) throw new Error("relay did not become ready");
    await new Promise((r) => setTimeout(r, 100));
  }
}

before(async () => {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [joinRelayPath()], {
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForReady(baseUrl);
});

function joinRelayPath() {
  return new URL("./relay-official.mjs", import.meta.url).pathname;
}

after(() => {
  child?.kill("SIGTERM");
});

// ─────────────────────────────────────────────────────────────────────────────
// §14.8 验收表
// ─────────────────────────────────────────────────────────────────────────────

test("§14.8 #1 真 relay + 真 device + 模拟 terminal：双端收到 pair_status matched", async () => {
  const { client: device, deviceSid, passHash } = await connectDevice(baseUrl);
  try {
    const { body } = await fetchPairLink(baseUrl, deviceSid, passHash);
    const { params } = parsePairLink(body.link);
    const terminal = await connectTerminal(baseUrl, params.sid, params.hash);
    try {
      const tMatch = await terminal.waitFor(
        (m) => m.type === "pair_status_ack" && m.pair_status === "matched",
        "terminal matched",
      );
      const dMatch = await device.waitFor(
        (m) => m.type === "pair_status_ack" && m.pair_status === "matched",
        "device matched",
      );
      assert.equal(tMatch.pair_status, "matched");
      assert.equal(dMatch.pair_status, "matched");
    } finally {
      terminal.close();
    }
  } finally {
    device.close();
  }
});

test("§14.8 #2 链接端点无 / 错 proof：401 且不回链接内容", async () => {
  const { client: device, deviceSid, passHash } = await connectDevice(baseUrl);
  try {
    const noAuth = await fetch(
      `${baseUrl}/api/remote-control/link?sid=${encodeURIComponent(deviceSid)}`,
    );
    assert.equal(noAuth.status, 401);
    assert.equal((await noAuth.json()).link, undefined);

    const wrong = await fetch(
      `${baseUrl}/api/remote-control/link?sid=${encodeURIComponent(deviceSid)}`,
      {
        headers: { authorization: "Bearer not-a-proof" },
      },
    );
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).link, undefined);

    // 正确 proof 仍可用（对照，并证明 401 不是房间坏了）
    const ok = await fetchPairLink(baseUrl, deviceSid, passHash);
    assert.equal(ok.res.status, 200);
    assert.ok(ok.body.link);
  } finally {
    device.close();
  }
});

test("§14.8 #3 链接端点正确 proof：200，link 含 sid/hash 且 sid === device_sid", async () => {
  const { client: device, deviceSid, passHash } = await connectDevice(baseUrl);
  try {
    const { res, body } = await fetchPairLink(baseUrl, deviceSid, passHash);
    assert.equal(res.status, 200);
    const { path, params } = parsePairLink(body.link);
    assert.equal(path, "/remote/v4");
    assert.equal(params.sid, deviceSid);
    assert.ok(params.hash, "链接必须带 terminal HMAC key（hash）");
    assert.ok(params.t, "链接必须带签发时刻 t");
  } finally {
    device.close();
  }
});

test("§14.8 #4 data 信封双向：relay 原样转发不解释", async () => {
  const { client: device, deviceSid, passHash } = await connectDevice(baseUrl);
  try {
    const { body } = await fetchPairLink(baseUrl, deviceSid, passHash);
    const { params } = parsePairLink(body.link);
    const terminal = await connectTerminal(baseUrl, params.sid, params.hash);
    try {
      // device → terminal
      const payloadOut = { zcode_type: "bootstrap-request", requestId: "req-1" };
      device.send({ type: "data", payload: payloadOut });
      const tData = await terminal.waitFor((m) => m.type === "data", "terminal data");
      assert.deepEqual(tData.payload, payloadOut);
      // terminal → device
      const payloadBack = {
        zcode_type: "bootstrap-response",
        requestId: "req-1",
        result: { workspaces: [] },
      };
      terminal.send({ type: "data", payload: payloadBack });
      const dData = await device.waitFor((m) => m.type === "data", "device data");
      assert.deepEqual(dData.payload, payloadBack);
    } finally {
      terminal.close();
    }
  } finally {
    device.close();
  }
});

test("§14.8 #5 错误 proof / 同房间第二 terminal / 未知 sid：auth_failed / terminal_busy / sid_invalid", async () => {
  const { client: device, deviceSid, passHash } = await connectDevice(baseUrl);
  try {
    // 5a. 错误 proof → auth_failed 且断开
    const badTerminal = new TestClient(baseUrl);
    await badTerminal.open();
    badTerminal.send({
      type: "auth_init",
      role: "terminal",
      device_sid: deviceSid,
      client_ts: Date.now(),
    });
    await badTerminal.waitFor((m) => m.type === "auth_challenge", "challenge");
    badTerminal.send({
      type: "auth_response",
      device_sid: deviceSid,
      proof: "wrong-proof",
      client_ts: Date.now(),
    });
    const err = await badTerminal.waitFor((m) => m.type === "error", "error(auth_failed)");
    assert.equal(err.code, "auth_failed");
    await badTerminal.waitFor(() => false, "close", 5_000, { predClose: true });
    assert.equal(badTerminal.closed.code, 4403);
    badTerminal.close();

    // 5b. 同房间第二 terminal → terminal_busy
    const { body } = await fetchPairLink(baseUrl, deviceSid, passHash);
    const { params } = parsePairLink(body.link);
    const t1 = await connectTerminal(baseUrl, params.sid, params.hash);
    const t2 = new TestClient(baseUrl);
    await t2.open();
    t2.send({ type: "auth_init", role: "terminal", device_sid: params.sid, client_ts: Date.now() });
    const busy = await t2.waitFor((m) => m.type === "error", "error(terminal_busy)");
    assert.equal(busy.code, "terminal_busy");
    t1.close();
    t2.close();

    // 5c. 未知 sid → sid_invalid
    const ghost = new TestClient(baseUrl);
    await ghost.open();
    ghost.send({
      type: "auth_init",
      role: "terminal",
      device_sid: "d_does-not-exist",
      client_ts: Date.now(),
    });
    const invalid = await ghost.waitFor((m) => m.type === "error", "error(sid_invalid)");
    assert.equal(invalid.code, "sid_invalid");
    ghost.close();
  } finally {
    device.close();
  }
});

test("§14.8 #6 device 断线重连：新 device_sid，重新鉴权，terminal 重新接入后再次 matched", async () => {
  // 第一次会话
  const first = await connectDevice(baseUrl);
  const { body: body1 } = await fetchPairLink(baseUrl, first.deviceSid, first.passHash);
  const link1 = parsePairLink(body1.link);
  const t1 = await connectTerminal(baseUrl, link1.params.sid, link1.params.hash);
  await t1.waitFor(
    (m) => m.type === "pair_status_ack" && m.pair_status === "matched",
    "first matched",
  );
  // device 断开（旧房间等待回收）
  first.client.close();
  await t1.waitFor(
    (m) => m.type === "pair_status_ack" && m.pair_status === "waiting",
    "back to waiting",
  );
  t1.close();

  // 第二次会话：同 passHash 重新注册 ⇒ 新 sid
  const second = await connectDevice(baseUrl);
  assert.notEqual(second.deviceSid, first.deviceSid, "重连必须拿新 device_sid");
  const { body: body2 } = await fetchPairLink(baseUrl, second.deviceSid, second.passHash);
  const link2 = parsePairLink(body2.link);
  assert.equal(link2.params.sid, second.deviceSid);
  const t2 = await connectTerminal(baseUrl, link2.params.sid, link2.params.hash);
  const rematch = await t2.waitFor(
    (m) => m.type === "pair_status_ack" && m.pair_status === "matched",
    "second matched",
  );
  assert.equal(rematch.pair_status, "matched");
  t2.close();
  second.client.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// §14.9a 终端页 + rpc-frame 回显
// ─────────────────────────────────────────────────────────────────────────────

test("§14.9a /remote/v4 GET/HEAD 200 text/html、带尾斜杠 200、POST 405、其余路径 404", async () => {
  const get = await fetch(`${baseUrl}/remote/v4`);
  assert.equal(get.status, 200);
  assert.match(get.headers.get("content-type"), /text\/html/);
  const html = await get.text();
  assert.match(html, /ZCodium 远程终端/);
  assert.doesNotMatch(html, /src=|href=/, "终端页必须自包含，不允许外部资源");

  const slashed = await fetch(`${baseUrl}/remote/v4/`);
  assert.equal(slashed.status, 200);

  const head = await fetch(`${baseUrl}/remote/v4`, { method: "HEAD" });
  assert.equal(head.status, 200);

  const post = await fetch(`${baseUrl}/remote/v4`, { method: "POST" });
  assert.equal(post.status, 405);

  const asset = await fetch(`${baseUrl}/remote/v4/foo.js`);
  assert.equal(asset.status, 404);
});

/**
 * 从终端页 HTML 抽出 rpcProbeBytes 编码器（页面自包含、无外部资源，无法直接 import）。
 * 截取从 `const RPC_UNDEFINED` 到 `rpcProbeBytes` 数组字面量结尾的连续块再求值。
 */
function extractProbeEncoder(html) {
  const start = html.indexOf("const RPC_UNDEFINED");
  assert.ok(start >= 0, "终端页应包含探测帧编码器");
  const end = html.indexOf("];", html.indexOf("const rpcProbeBytes", start));
  assert.ok(end > start, "探测帧编码器应以数组字面量结尾");
  return new Function(`${html.slice(start, end + 2)}\nreturn rpcProbeBytes;`)();
}

test("§14.9a 终端页探测帧是合法 RPC 帧：与 canonical serialize 逐字节一致", async () => {
  const html = await (await fetch(`${baseUrl}/remote/v4`)).text();
  assert.match(html, /往返测试/, "终端页应已改直连往返模式");
  const rpcProbeBytes = extractProbeEncoder(html);

  // 权威字节由 packages/rpc/src/serialization.ts 实测得出：
  //   serialize([RequestType.PromiseCancel(101), id]) + serialize(undefined)
  //   类型标签 Array=4 / Int=6 / Undefined=0；VQL 7bit/字节（128 → [0x80,0x01]）。
  const canonical = new Map([
    [1, [4, 2, 6, 101, 6, 1, 0]],
    [2, [4, 2, 6, 101, 6, 2, 0]],
    [127, [4, 2, 6, 101, 6, 127, 0]],
    [128, [4, 2, 6, 101, 6, 128, 1, 0]],
    [300, [4, 2, 6, 101, 6, 172, 2, 0]],
  ]);
  for (const [id, expected] of canonical) {
    assert.deepEqual(rpcProbeBytes(id), expected, `id=${id} 的探测帧字节`);
  }
});

test("§14.9a rpc-frame 回显闭环：terminal 发帧 → device ack + 原样回显 → terminal ack", async () => {
  const { client: device, deviceSid, passHash } = await connectDevice(baseUrl);
  try {
    const { body } = await fetchPairLink(baseUrl, deviceSid, passHash);
    const { params } = parsePairLink(body.link);
    const terminal = await connectTerminal(baseUrl, params.sid, params.hash);
    try {
      await terminal.waitFor(
        (m) => m.type === "pair_status_ack" && m.pair_status === "matched",
        "matched",
      );

      // bridge open → ready（回显的前提）
      const bridgeSessionId = randomBytes(12).toString("base64url");
      terminal.send({
        type: "data",
        payload: {
          zcode_type: "workspace-bridge-open",
          requestId: "bridge-1",
          bridgeSessionId,
          workspaceKey: "/tmp/demo-repo",
        },
      });
      // relay 原样转发 ⇒ device 收到的就是 terminal 发的 payload；device 依此回 ready
      const open = await device.waitFor(
        (m) => m.type === "data" && m.payload?.zcode_type === "workspace-bridge-open",
        "device 侧 bridge-open 转发",
      );
      device.send({
        type: "data",
        payload: {
          zcode_type: "workspace-bridge-ready",
          requestId: open.payload.requestId,
          bridgeSessionId: open.payload.bridgeSessionId,
          bridge: { bridgeSessionId: open.payload.bridgeSessionId, kind: "local" },
        },
      });
      await terminal.waitFor(
        (m) => m.type === "data" && m.payload?.zcode_type === "workspace-bridge-ready",
        "bridge-ready",
      );

      // terminal → rpc-frame（单分片，含中文验证 UTF-8 链路）
      const text = `echo-${Date.now()}-终端→设备回显测试`;
      const bytes = new TextEncoder().encode(text);
      const b64url = Buffer.from(bytes).toString("base64url");
      terminal.send({
        type: "data",
        payload: {
          zcode_type: "rpc-frame",
          bridgeSessionId,
          seq: 1,
          messageSeq: 1,
          fragmentIndex: 0,
          fragmentCount: 1,
          messageBytes: bytes.length,
          checksum: { algorithm: "crc32", value: crc32Hex(bytes) },
          data: b64url,
        },
      });

      // device 侧：收到帧，校验 crc32 与内容，回 ack + 原样回显
      const frame = await device.waitFor(
        (m) => m.type === "data" && m.payload?.zcode_type === "rpc-frame",
        "device rpc-frame",
      );
      const echoBytes = Buffer.from(frame.payload.data, "base64url");
      assert.equal(frame.payload.checksum.value, crc32Hex(echoBytes), "crc32 必须一致");
      assert.equal(echoBytes.toString("utf8"), text, "解码后内容必须一致");
      device.send({
        type: "data",
        payload: {
          zcode_type: "rpc-frame-ack",
          bridgeSessionId,
          ackMessageSeq: frame.payload.messageSeq,
        },
      });
      device.send({ type: "data", payload: { ...frame.payload, seq: 2, messageSeq: 2 } });

      // terminal 侧：ack + 回显帧都要到
      const ack = await terminal.waitFor(
        (m) => m.type === "data" && m.payload?.zcode_type === "rpc-frame-ack",
        "terminal ack",
      );
      assert.equal(ack.payload.ackMessageSeq, 1);
      const echoed = await terminal.waitFor(
        (m) => m.type === "data" && m.payload?.zcode_type === "rpc-frame",
        "terminal echo",
      );
      assert.equal(echoed.payload.messageSeq, 2);
    } finally {
      terminal.close();
    }
  } finally {
    device.close();
  }
});

test("§14.7 回归 #10-#13：未鉴权 data 不放行（not_authed）", async () => {
  // 不走 auth_response，直接发 data
  const password = randomBytes(24).toString("base64url");
  const client = new TestClient(baseUrl, { mid: "test-device" });
  await client.open();
  client.send({
    type: "device_register_init",
    pass_hash: sha256b64(password),
    device_mid: "mid-bypass",
    client_ts: Date.now(),
  });
  const ack = await client.waitFor((m) => m.type === "device_register_ack", "ack");
  // 跳过鉴权直接发 data
  client.send({ type: "data", payload: { zcode_type: "bootstrap-request", requestId: "x" } });
  const err = await client.waitFor((m) => m.type === "error", "error(not_authed)");
  assert.equal(err.code, "not_authed");
  client.close();
  assert.ok(ack.device_sid);
});
