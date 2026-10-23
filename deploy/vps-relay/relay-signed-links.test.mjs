/**
 * relay.mjs 时效签名链接（spec vps-relay-bridge.md §18）的集成测试：
 * spawn 真实单文件中继，覆盖四通道凭据与 fail-closed 行为。
 * 运行：node --test deploy/vps-relay/relay-signed-links.test.mjs
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { get as httpGet } from "node:http";
import { gunzipSync } from "node:zlib";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { WebSocket } from "ws";

// v6 key-room（spec §19）：一把房间密钥同时承担桌面 Bearer 与手机 cookie/?token=。
const ROOM_KEY = `rk-${randomBytes(12).toString("base64url")}`;
/** 房间指纹：与 relay.mjs 一致（SHA-256 前 8 字符 base64url），派生 cookie 按它定位房间。 */
function roomFingerprint(key) {
  return createHash("sha256").update(key).digest("base64url").slice(0, 8);
}
const LARGE_ASSET = `export const testPayload = "${"relay-static-payload-".repeat(2048)}";\n`;

/** 与 relay.mjs / remoteRelayShareLink.ts 一致的签名算法（三方一致性本身就是测试点）。 */
function signShare(sid, t, e) {
  return createHmac("sha256", ROOM_KEY).update(`${sid}|${t}|${e}`).digest("base64url");
}

/** §19.3 派生会话 cookie：v1.<f>.<e>.<HMAC(roomKey, "cookie|f|e")>。 */
function deriveSessionCookie(expiresAtSec) {
  const f = roomFingerprint(ROOM_KEY);
  return `v1.${f}.${expiresAtSec}.${createHmac("sha256", ROOM_KEY).update(`cookie|${f}|${expiresAtSec}`).digest("base64url")}`;
}

/** 起一条 host 连接（Bearer roomKey）让房间存在——server-info 不凭未知 key 建房。 */
async function ensureRoomExists() {
  const { WebSocket: WsClient } = await import("ws");
  const port = new URL(baseUrl).port;
  const ws = new WsClient(`ws://127.0.0.1:${port}/host`, {
    headers: { authorization: `Bearer ${ROOM_KEY}` },
  });
  await new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error("host open timeout")), 5_000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolvePromise();
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });
  return ws;
}

function buildSignedQuery({ t = Math.floor(Date.now() / 1000), ttl = 3600, sid, sigOverride }) {
  const s = sid ?? randomBytes(16).toString("base64url");
  const e = t + ttl;
  const h = sigOverride ?? signShare(s, t, e);
  // v6 自验时效链接（spec §19.2）：自带 token，签名用链接里的 key 自证。
  return `token=${encodeURIComponent(ROOM_KEY)}&s=${encodeURIComponent(s)}&t=${t}&e=${e}&h=${encodeURIComponent(h)}`;
}

let child;
let baseUrl;
let webRoot;
let indexHtml = "<html>relay-test</html>";

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
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
}

function readSetCookieValue(res, name) {
  const raw = res.headers.get("set-cookie") ?? "";
  const pair = raw.split(";")[0] ?? "";
  const [key, ...rest] = pair.split("=");
  return key?.trim() === name ? rest.join("=") : "";
}

before(async () => {
  // 占位取一个空闲端口：relay 的 PORT 不支持 0（Number("0") 为 falsy 会回退 3180）。
  const probe = createServer();
  await new Promise((resolvePromise) => probe.listen(0, "127.0.0.1", resolvePromise));
  const port = probe.address().port;
  await new Promise((resolvePromise) => probe.close(resolvePromise));
  baseUrl = `http://127.0.0.1:${port}`;
  webRoot = await mkdtemp(join(tmpdir(), "zcode-relay-test-"));
  await writeFile(join(webRoot, "index.html"), indexHtml, "utf8");
  await writeFile(join(webRoot, "large-test.js"), LARGE_ASSET, "utf8");
  child = spawn(process.execPath, [join(import.meta.dirname, "relay.mjs")], {
    env: {
      ...process.env,
      PORT: String(port),
      WEB_ROOT: webRoot,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  await waitForReady(baseUrl);
});

after(() => {
  child?.kill("SIGTERM");
});

function getRaw(path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpGet(`${baseUrl}${path}`, { method, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
  });
}

test("静态文本资源：按 Accept-Encoding gzip 压缩；q=0 / identity 不压；HEAD 无响应体", async () => {
  const compressed = await getRaw("/large-test.js", { headers: { "accept-encoding": "gzip" } });
  assert.equal(compressed.status, 200);
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.match(compressed.headers.vary, /accept-encoding/i);
  assert.ok(Number(compressed.headers["content-length"]) < Buffer.byteLength(LARGE_ASSET));
  assert.equal(gunzipSync(compressed.body).toString(), LARGE_ASSET);

  const identity = await getRaw("/large-test.js", { headers: { "accept-encoding": "gzip;q=0, identity" } });
  assert.equal(identity.status, 200);
  assert.equal(identity.headers["content-encoding"], undefined);
  assert.match(identity.headers.vary, /accept-encoding/i);
  assert.equal(identity.body.toString(), LARGE_ASSET);

  const head = await getRaw("/large-test.js", { method: "HEAD", headers: { "accept-encoding": "gzip" } });
  assert.equal(head.status, 200);
  assert.equal(head.headers["content-encoding"], "gzip");
  assert.ok(Number(head.headers["content-length"]) > 0);
  assert.equal(head.body.length, 0);
});

test("legacy ?token= 入口：302 摘 token、下发 roomKey cookie；形状过短 401", async () => {
  const good = await fetch(`${baseUrl}/?token=${encodeURIComponent(ROOM_KEY)}&autoReconnect=1`, {
    redirect: "manual",
  });
  assert.equal(good.status, 302);
  assert.match(good.headers.get("location"), /autoReconnect=1$/);
  assert.ok(!good.headers.get("location").includes("token="));
  assert.equal(readSetCookieValue(good, "zcode_lite_token"), ROOM_KEY);

  // v6 key-room：页面入口只验 key 形状（≥8 字符），过短一律 401。
  const bad = await fetch(`${baseUrl}/?token=wrong`);
  assert.equal(bad.status, 401);
});

test("自验时效链接入口：302 摘 token 保留 s/t/e/h，下发 v1 派生 cookie 并建房（§19.2/§19.3）", async () => {
  const res = await fetch(`${baseUrl}/?${buildSignedQuery({})}&autoReconnect=1`, {
    redirect: "manual",
  });
  assert.equal(res.status, 302);
  // token 被摘掉（永久凭据不进地址栏/历史），s/t/e/h 保留（web bundle 靠它们带凭据）。
  const location = res.headers.get("location") ?? "";
  assert.ok(!location.includes("token="), location);
  assert.match(location, /s=&|s=[^&]/);
  assert.match(location, /autoReconnect=1$/);
  const cookie = readSetCookieValue(res, "zcode_lite_token");
  assert.match(cookie, /^v1\.[A-Za-z0-9_-]{8}\.\d+\./);
  // cookie 里的 sig 必须能用 roomKey 重算（格式 §19.3：HMAC 键 = roomKey，载荷含指纹）。
  const [, f, e, sig] = cookie.split(".");
  assert.equal(f, roomFingerprint(ROOM_KEY));
  assert.equal(
    sig,
    createHmac("sha256", ROOM_KEY).update(`cookie|${f}|${e}`).digest("base64url"),
  );

  // 自验建房：桌面离线（房间未建立）时签名通过的 key 也能建出房间——
  // 302 后的请求（纯 s/t/e/h，无 token）必须能被逐房间验签放行。
  const redirected = await fetch(`${baseUrl}${location}`, { redirect: "manual" });
  assert.equal(redirected.status, 200);
  assert.match(readSetCookieValue(redirected, "zcode_lite_token"), /^v1\./);
});

test("自验时效链接 fail-closed：篡改 h / 过期 e / 未来 t 都 401，且不建房", async () => {
  const now = Math.floor(Date.now() / 1000);
  const forged = await fetch(
    `${baseUrl}/?${buildSignedQuery({ sigOverride: "forged".repeat(7) })}`,
    { redirect: "manual" },
  );
  assert.equal(forged.status, 401);
  const expired = await fetch(
    `${baseUrl}/?${buildSignedQuery({ t: now - 7200, ttl: 3600 })}`,
    { redirect: "manual" },
  );
  assert.equal(expired.status, 401);
  const futureT = await fetch(`${baseUrl}/?${buildSignedQuery({ t: now + 3600 })}`, {
    redirect: "manual",
  });
  assert.equal(futureT.status, 401);
});

test("自验时效链接：过去的 t 合法（t 是签发时刻，有效期由 e 把关）", async () => {
  const now = Math.floor(Date.now() / 1000);
  // t 是**签发时刻**：正常流程「生成 → 过一会儿才打开」，过去一小时必须仍然放行
  // （有效期由 e 把关，spec §18.2 —— 曾误拒过去 t 导致链接 5 分钟后失效）。
  const oldIssuance = await fetch(
    `${baseUrl}/?${buildSignedQuery({ t: now - 3600, ttl: 7200 })}`,
    { redirect: "manual" },
  );
  assert.equal(oldIssuance.status, 302);
  // s 与 h 必须成对出现：只有 s 不走签名入口（无凭据打开页面本身是允许的）。
  const partial = await fetch(`${baseUrl}/?s=abc&autoReconnect=1`);
  assert.equal(partial.status, 200);
});

test("/api/server-info 四通道：signed query、v1 cookie、roomKey token 均放行；无凭据/过期 v1 均 401", async () => {
  // 房间必须先存在（桌面连上才建房，spec §19.2）：server-info 不凭未知 key 建房。
  const host = await ensureRoomExists();

  const query = buildSignedQuery({});
  const byQuery = await fetch(`${baseUrl}/api/server-info?${query}`);
  assert.equal(byQuery.status, 200);

  const pairing = await fetch(`${baseUrl}/?${query}`);
  const v1 = readSetCookieValue(pairing, "zcode_lite_token");
  const byV1 = await fetch(`${baseUrl}/api/server-info`, {
    headers: { cookie: `zcode_lite_token=${v1}` },
  });
  assert.equal(byV1.status, 200);

  const byToken = await fetch(`${baseUrl}/api/server-info?token=${encodeURIComponent(ROOM_KEY)}`);
  assert.equal(byToken.status, 200);

  const anonymous = await fetch(`${baseUrl}/api/server-info`);
  assert.equal(anonymous.status, 401);

  // 手造一个已过期的 v1 cookie：签名合法但 e 在过去 → 服务端必须拒绝（Max-Age 只是提示）。
  const pastE = Math.floor(Date.now() / 1000) - 10;
  const expired = deriveSessionCookie(pastE);
  const byExpired = await fetch(`${baseUrl}/api/server-info`, {
    headers: { cookie: `zcode_lite_token=${expired}` },
  });
  assert.equal(byExpired.status, 401);

  host.close();
});

test("/ws 升级：v1 cookie 放行；无凭据 401 拒绝", async () => {
  const query = buildSignedQuery({});
  const pairing = await fetch(`${baseUrl}/?${query}`);
  const v1 = readSetCookieValue(pairing, "zcode_lite_token");

  await new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(baseUrl).port}/ws`, {
      headers: { cookie: `zcode_lite_token=${v1}` },
    });
    const timer = setTimeout(() => {
      ws.terminate();
      rejectPromise(new Error("ws open timeout"));
    }, 5_000);
    ws.on("open", () => {
      clearTimeout(timer);
      ws.close();
      resolvePromise();
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
  });

  const rejection = await new Promise((resolvePromise, rejectPromise) => {
    const ws = new WebSocket(`ws://127.0.0.1:${new URL(baseUrl).port}/ws`);
    const timer = setTimeout(() => {
      ws.terminate();
      rejectPromise(new Error("ws rejection timeout（应立刻 401）"));
    }, 5_000);
    ws.on("open", () => {
      clearTimeout(timer);
      ws.close();
      rejectPromise(new Error("无凭据的 /ws 不应升级成功"));
    });
    ws.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise(error);
    });
  });
  assert.match(String(rejection?.message ?? rejection), /401/);
});
