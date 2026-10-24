// relay.mjs 加固行为集成测试（spec §20）：per-IP 限流、建房形状、信封策略、派生 cookie。
// 每个用例独占一个 relay 子进程（与 vps-relay-forward.test.mjs 同款装置）。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";

const RELAY_PATH = fileURLToPath(
  new URL("../../../deploy/vps-relay/relay.mjs", import.meta.url),
);

/** 合规建房形状（spec §20.2：43 字符 base64url，桌面 generateRelayRoomKey 同形状）。 */
const shapeKey = (n) => `${String(n).padStart(3, "0")}${randomBytes(30).toString("base64url")}`;

async function startRelay(t, options = {}) {
  const port = 31000 + Math.floor(Math.random() * 20000);
  const webRoot = await mkdtemp(join(tmpdir(), "relay-hardening-"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>relay-hardening</title>");
  let logText = "";
  const proc = spawn(process.execPath, [RELAY_PATH], {
    env: {
      ...process.env,
      PORT: String(port),
      WEB_ROOT: webRoot,
      ...(options.roomCreateLimit ? { ROOM_CREATE_LIMIT: String(options.roomCreateLimit) } : {}),
      ...(options.wsConnectLimit ? { WS_CONNECT_LIMIT: String(options.wsConnectLimit) } : {}),
      ...(options.keyShape ? { RELAY_KEY_SHAPE: options.keyShape } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => proc.kill());
  proc.stdout.on("data", (c) => (logText += c.toString()));
  proc.stderr.on("data", (c) => (logText += c.toString()));
  const base = `http://127.0.0.1:${port}`;
  // /Volumes/date 冷缓存下 relay 启动可能 >4s（挂载卷 I/O 停顿，见 run-workflow 记忆）：
  // 等满 10s 且必须等到，否则后续断言会以 ECONNREFUSED 假失败。
  let up = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await (await fetch(`${base}/healthz`)).json()).ok) {
        up = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error(`relay 未在 10s 内就绪\n${logText}`);
  return { port, base, logText: () => logText };
}

/**
 * 原始 WS upgrade 请求，返回状态行（如 "HTTP/1.1 101 Switching Protocols"）。
 * 用裸 socket 而非 ws 客户端：429/401 都发生在 upgrade 完成前，ws 库拿不到状态码；
 * host 参数用于模拟不同来源 IP（spec §20.1 的 per-IP 隔离断言；macOS 未分配
 * 127.0.0.2 别名，用 ::1 作为第二个来源）。
 */
function upgradeStatus(port, path, headers = {}, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const sock = connect({ port, host }, () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
        "Sec-WebSocket-Version: 13",
        ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
        "\r\n",
      ];
      sock.write(lines.join("\r\n"));
    });
    let buf = "";
    sock.on("data", (c) => {
      buf += c.toString("latin1");
      const end = buf.indexOf("\r\n\r\n");
      if (end >= 0) {
        const statusLine = buf.slice(0, buf.indexOf("\r\n"));
        sock.destroy();
        resolve(statusLine);
      }
    });
    sock.on("error", reject);
  });
}

test("§20.2 形状校验：junk key 建房 401，合规 key 正常，日志不含 key 本体", async (t) => {
  const relay = await startRelay(t);
  const junk = "short-key"; // isPlausibleKey 通过但非 43 字符 base64url

  const hostStatus = await upgradeStatus(relay.port, "/host", { authorization: `Bearer ${junk}` });
  assert.ok(hostStatus.includes(" 401 "), `junk /host 应 401，实际 ${hostStatus}`);
  const wsStatus = await upgradeStatus(relay.port, `/ws?token=${encodeURIComponent(junk)}`);
  assert.ok(wsStatus.includes(" 401 "), `junk /ws 应 401，实际 ${wsStatus}`);
  // server-info 同样拒绝：房间不存在，不能凭 junk key 查/建
  const info = await fetch(`${relay.base}/api/server-info?token=${encodeURIComponent(junk)}`);
  assert.equal(info.status, 401);
  assert.ok(!relay.logText().includes(junk), "日志不得出现 key 本体");

  const okStatus = await upgradeStatus(relay.port, "/host", {
    authorization: `Bearer ${shapeKey(1)}`,
  });
  assert.ok(okStatus.includes(" 101 "), `合规 key /host 应 101，实际 ${okStatus}`);
});

test("§20.1 建房配额：同 IP 超限 429，另一 IP 不受影响", async (t) => {
  const relay = await startRelay(t, { roomCreateLimit: 2 });

  const k1 = shapeKey(1);
  const k2 = shapeKey(2);
  const k3 = shapeKey(3);
  assert.ok((await upgradeStatus(relay.port, "/host", { authorization: `Bearer ${k1}` })).includes(" 101 "));
  assert.ok((await upgradeStatus(relay.port, "/host", { authorization: `Bearer ${k2}` })).includes(" 101 "));
  const throttled = await upgradeStatus(relay.port, "/host", { authorization: `Bearer ${k3}` });
  assert.ok(throttled.includes(" 429 "), `第 3 个新房间应 429，实际 ${throttled}`);
  // 已存在房间不受配额影响（重连语义）
  assert.ok((await upgradeStatus(relay.port, "/host", { authorization: `Bearer ${k1}` })).includes(" 101 "));
  // 另一来源 IP 配额独立（::1 vs 127.0.0.1）
  const otherIp = await upgradeStatus(
    relay.port,
    "/host",
    { authorization: `Bearer ${k3}` },
    "::1",
  );
  assert.ok(otherIp.includes(" 101 "), `另一 IP 应不受限流影响，实际 ${otherIp}`);
});

test("§20.1 upgrade 连接配额：超限 429", async (t) => {
  const relay = await startRelay(t, { wsConnectLimit: 3 });
  const key = shapeKey(1);

  assert.ok((await upgradeStatus(relay.port, "/host", { authorization: `Bearer ${key}` })).includes(" 101 "));
  assert.ok((await upgradeStatus(relay.port, `/ws?token=${encodeURIComponent(key)}`)).includes(" 101 "));
  assert.ok((await upgradeStatus(relay.port, `/ws?token=${encodeURIComponent(key)}`)).includes(" 101 "));
  const throttled = await upgradeStatus(relay.port, `/ws?token=${encodeURIComponent(key)}`);
  assert.ok(throttled.includes(" 429 "), `第 4 次 upgrade 应 429，实际 ${throttled}`);
});

test("§20.3 信封策略：加密房间拒明文报告（409），明文房间双向覆盖正常", async (t) => {
  const relay = await startRelay(t);
  const e2eeRoom = shapeKey(1);
  const plainRoom = shapeKey(2);
  const envelope = JSON.stringify({ e2ee: true, v: 1, nonce: "bm9uY2U=", ciphertext: "Y2lwaGVydGV4dA==" });
  const post = (key, body) =>
    fetch(`${relay.base}/api/host-report`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body,
    });

  assert.equal((await post(e2eeRoom, envelope)).status, 200);
  const rejected = await post(e2eeRoom, JSON.stringify({ workspacePath: "/tmp/evil" }));
  assert.equal(rejected.status, 409, "加密房间收明文报告应 409");
  assert.ok(!relay.logText().includes("/tmp/evil"), "拒绝日志不得出现明文内容");

  assert.equal((await post(plainRoom, JSON.stringify({ workspacePath: "/tmp/ok" }))).status, 200);
  assert.equal((await post(plainRoom, envelope)).status, 200, "明文→信封覆盖是开启 E2EE 的正常路径");
});

test("§20.4 永久链接落地：派生 cookie（v1.）+ 地址栏摘 token + 不建房", async (t) => {
  const relay = await startRelay(t);
  const key = shapeKey(1);

  const landing = await fetch(`${relay.base}/?token=${encodeURIComponent(key)}&autoReconnect=1`, {
    redirect: "manual",
  });
  assert.equal(landing.status, 302);
  const setCookie = landing.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /zcode_lite_token=v1\./, "cookie 应为派生形状（v1. 前缀），而非 raw key");
  assert.ok(!setCookie.includes(key), "cookie 不得包含 raw key 本体");
  const location = landing.headers.get("location") ?? "";
  assert.ok(!location.includes("token="), "302 应摘掉 token");
  assert.ok(location.includes("autoReconnect=1"), "其余参数保留");

  // 落地不建房：cookie 对应房间尚未被桌面创建 → server-info 401（桌面拨入后恢复）
  const cookie = setCookie.split(";")[0];
  const info = await fetch(`${relay.base}/api/server-info`, { headers: { cookie } });
  assert.equal(info.status, 401);
  assert.ok(
    (await upgradeStatus(relay.port, "/host", { authorization: `Bearer ${key}` })).includes(" 101 "),
  );
  const infoAfter = await fetch(`${relay.base}/api/server-info`, { headers: { cookie } });
  assert.equal(infoAfter.status, 200, "桌面建房后同一派生 cookie 应可用");
});

test("§20.2 legacy 逃生口：RELAY_KEY_SHAPE=legacy 接受 v5 自定义历史密钥形状", async (t) => {
  const relay = await startRelay(t, { keyShape: "legacy" });
  const legacyKey = "legacy-custom-key-0123456"; // 可打印 ASCII，非 43 字符
  const status = await upgradeStatus(relay.port, "/host", { authorization: `Bearer ${legacyKey}` });
  assert.ok(status.includes(" 101 "), `legacy 形状应放行，实际 ${status}`);
});
