// relay.mjs 转发行为的集成测试（spec §12.3.1）。
//
// 覆盖四个最容易错的时序：
//   - 「桌面先连、手机后开」（正常使用顺序）：host 在无手机配对期间发出的帧
//     （ChannelServer 构造即发的 Initialize 握手帧）必须被缓冲并在配对时回放
//   - 「手机先等、host 后到」（刷新撞进缺位窗口）：宽限期内等待，host 回来即被服务
//   - host 真离线：宽限到期后明确 4002，不静默卡死
//   - 「新页面到达时 host 正在关闭」：不得与垂死 host 配对，否则新页面被连坐 4002 秒杀
//
// 每个用例独占一个 relay 子进程（随机端口 + 独立日志），避免共享实例时
// 上一用例未处理完的连接/日志与本用例产生竞态。两端用 ws 客户端模拟。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { WebSocket } from "ws";

const RELAY_TOKEN = "test-pairing-token";
const HOST_SECRET = "test-host-secret";
const HOST_WAIT_GRACE_MS = 400;
const RELAY_PATH = fileURLToPath(
  new URL("../../../deploy/vps-relay/relay.mjs", import.meta.url),
);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 起一个独占的 relay 子进程；返回端口与「等待某行日志出现」的断言工具。 */
async function startRelayServer(t, options = {}) {
  const port = 31000 + Math.floor(Math.random() * 20000);
  const webRoot = await mkdtemp(join(tmpdir(), "vps-relay-test-"));
  await writeFile(join(webRoot, "index.html"), "<!doctype html><title>relay-test</title>");
  let logText = "";
  const proc = spawn(process.execPath, [RELAY_PATH], {
    env: {
      ...process.env,
      RELAY_TOKEN,
      HOST_SECRET,
      HOST_WAIT_GRACE_MS: String(options.graceMs ?? HOST_WAIT_GRACE_MS),
      ...(options.heartbeatMs ? { HEARTBEAT_INTERVAL_MS: String(options.heartbeatMs) } : {}),
      ...(options.idleMs ? { IDLE_TIMEOUT_MS: String(options.idleMs) } : {}),
      PORT: String(port),
      WEB_ROOT: webRoot,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => proc.kill());
  // 常驻收集日志（不能在 waitForLog 里动态挂摘 data 监听器：child stdout 一旦进入
  // flowing 模式，摘掉监听器后产生的日志会被直接丢弃，造成偶发「日志未出现」假失败）。
  proc.stdout.on("data", (chunk) => {
    logText += chunk.toString();
  });
  proc.stderr.on("data", (chunk) => {
    logText += chunk.toString();
  });
  const waitForLog = (substring, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        clearInterval(poll);
        reject(new Error(`relay log 未出现 ${substring}，已收日志：\n${logText}`));
      }, timeoutMs);
      const poll = setInterval(() => {
        if (logText.includes(substring)) {
          clearTimeout(timer);
          clearInterval(poll);
          resolve();
        }
      }, 25);
    });
  await waitForLog("listening on");
  return { port, waitForLog };
}

/** 等待 WebSocket 进入 OPEN。 */
function openWebSocket(url, options) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.once("open", () => resolve(ws));
    ws.once("close", (code, reason) =>
      reject(new Error(`closed before open: ${code} ${reason}`)),
    );
    ws.once("error", reject);
  });
}

/** 等待一条消息（文本帧）。 */
function nextMessage(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", onMessage);
      reject(new Error("等待消息超时"));
    }, timeoutMs);
    const onMessage = (data) => {
      clearTimeout(timer);
      ws.off("message", onMessage);
      resolve(data.toString());
    };
    ws.on("message", onMessage);
  });
}

/** 等待连接关闭，返回 close code。 */
function nextClose(ws, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待关闭超时")), timeoutMs);
    ws.once("close", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function openHost(relay) {
  return openWebSocket(`ws://127.0.0.1:${relay.port}/host`, {
    headers: { authorization: `Bearer ${HOST_SECRET}` },
  });
}

async function openClient(relay) {
  return openWebSocket(`ws://127.0.0.1:${relay.port}/ws`, {
    headers: { cookie: `zcode_lite_token=${RELAY_TOKEN}` },
  });
}

/**
 * 用手写握手起一个「不回应 close 帧」的 host。
 *
 * 用途：复现「host 正在关闭」窗口。relay 对 host 调 `close(4003)` 后要等对端回 close 帧
 * 才会触发自己的 `close` 事件；这个假 host 收完 101 就 pause，于是 relay 侧 host 停在
 * CLOSING，正好是真实网络里 close 握手占一个 RTT 的那段时间（spec §12.3.1「残留竞态 3」）。
 */
async function openRawHost(relay) {
  return new Promise((resolve, reject) => {
    const socket = connect(relay.port, "127.0.0.1", () => {
      socket.write(
        [
          "GET /host HTTP/1.1",
          `Host: 127.0.0.1:${relay.port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          "Sec-WebSocket-Version: 13",
          `Authorization: Bearer ${HOST_SECRET}`,
          "",
          "",
        ].join("\r\n"),
      );
    });
    let handshake = "";
    const onData = (chunk) => {
      handshake += chunk.toString("latin1");
      if (!handshake.includes("\r\n\r\n")) {
        return;
      }
      socket.off("data", onData);
      if (!handshake.startsWith("HTTP/1.1 101")) {
        reject(new Error(`host upgrade 失败：${handshake.split("\r\n")[0]}`));
        return;
      }
      socket.pause(); // 不再读 → relay 的 close 帧得不到回应 → host 停在 CLOSING
      resolve(socket);
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

/** 若在窗口期内关闭则返回 close code，否则返回 null（不抛错，便于断言「没被关掉」）。 */
function closeWithin(ws, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.off("close", onClose);
      resolve(null);
    }, timeoutMs);
    const onClose = (code) => {
      clearTimeout(timer);
      resolve(code);
    };
    ws.once("close", onClose);
  });
}

test("host 先连、手机后开：配对前 host 帧必须被回放（Initialize 缓冲）", async (t) => {
  const relay = await startRelayServer(t);
  const host = await openHost(relay);
  t.after(() => host.close());
  await relay.waitForLog("host connected");

  // 模拟 Host attach 后立即发出的 Initialize 握手帧：此刻手机还没连。
  host.send(Buffer.from("initialize-handshake-frame"));
  await wait(150); // 等 relay 收下并缓冲

  const client = await openClient(relay);
  t.after(() => client.close());

  // 手机配对后收到的第一帧必须是回放的缓冲帧，而不是什么都收不到。
  assert.equal(await nextMessage(client), "initialize-handshake-frame");
  await relay.waitForLog("replayed buffered host frames");

  // 配对后的活转发双向成立：host 后发的帧直达手机，手机的请求也直达 host。
  host.send(Buffer.from("live-host-frame"));
  assert.equal(await nextMessage(client), "live-host-frame");

  const hostGotRequest = nextMessage(host);
  client.send(Buffer.from("client-rpc-request"));
  assert.equal(await hostGotRequest, "client-rpc-request");
});

test("host 短暂缺位：手机在宽限期内等待，host 回来即被服务（刷新撞窗场景）", async (t) => {
  const relay = await startRelayServer(t);

  // 手机先连（host 缺位窗口内）：不得被立刻踢掉，而应进入宽限等待。
  const client = await openClient(relay);
  t.after(() => client.close());
  await relay.waitForLog("holding client for up to");

  // 宽限期内 host 回来 → 自动配对。
  const host = await openHost(relay);
  t.after(() => host.close());
  await relay.waitForLog("paired host↔client");

  // 模拟桌面 attach 后立即发出的 Initialize：此时配对已完成，应经活转发直达等待中的手机。
  host.send(Buffer.from("late-initialize-frame"));
  assert.equal(await nextMessage(client), "late-initialize-frame");
});

test("host 真离线：宽限到期后明确 close 4002，不静默卡死", async (t) => {
  const relay = await startRelayServer(t);

  const client = await openClient(relay);
  t.after(() => client.close());
  await relay.waitForLog("holding client for up to");

  // 宽限 400ms：既不能立刻踢（那会撞白屏窗口），也不能无限等。
  const closedWith = await nextClose(client, 2000);
  assert.equal(closedWith, 4002);
  await relay.waitForLog("grace elapsed without host");
});

test("新页面到达时 host 正在关闭：不配对、不秒杀，host 回来即恢复", async (t) => {
  // 宽限放宽到 1.5s：本用例刻意制造「host 停在 CLOSING」的窗口，需要留出断言时间。
  const relay = await startRelayServer(t, { graceMs: 1500 });

  const host = await openRawHost(relay);
  t.after(() => host.destroy());
  await relay.waitForLog("host connected");

  const client1 = await openClient(relay);
  t.after(() => client1.close());
  await relay.waitForLog("paired host↔client");

  // 刷新第一拍：旧手机端断开 → relay 连坐对 host 发 close(4003)；假 host 不回应，
  // 于是 relay 侧 host 停在 CLOSING，close 事件还没到。
  client1.close();
  await relay.waitForLog("client disconnected");
  await wait(150);

  // 刷新第二拍：新页面的 WS 到达。此刻 hostSocket 仍是那个垂死 socket。
  const client2 = await openClient(relay);
  t.after(() => client2.close());
  await relay.waitForLog("host not OPEN (readyState=2); holding client for up to");

  // 关键断言 1：新页面必须进宽限等待，而不是配给垂死连接。
  assert.equal(await closeWithin(client2, 300), null, "新页面不应与正在关闭的 host 配对");

  // host 的 close 握手终于结束（真实网络里就是一个 RTT，本用例用 TCP 断开模拟）。
  host.destroy();
  await relay.waitForLog("host disconnected");
  // 关键断言 2：垂死 host 的 close 连坐绝不能波及新页面（修复前这里会被 4002 秒杀）。
  assert.equal(await closeWithin(client2, 300), null, "垂死 host 的 close 不得关掉新页面");

  // 桌面快速补位（真实实现 100ms）：新 host 回来，新页面必须被服务。
  const host2 = await openHost(relay);
  t.after(() => host2.close());
  await wait(100);
  host2.send(Buffer.from("initialize-after-refresh"));
  assert.equal(await nextMessage(client2), "initialize-after-refresh");
  // 关键断言 3：配对必须清掉宽限计时器。等待超过 1.5s 宽限仍未关闭，才证明是真的配上了。
  assert.equal(await closeWithin(client2, 900), null, "配对后宽限计时器必须被清掉");
});

test("host 被顶替：新 host 接管，不得连坐关掉手机端", async (t) => {
  const relay = await startRelayServer(t);

  const host1 = await openHost(relay);
  t.after(() => host1.close());
  await relay.waitForLog("host connected");

  const client = await openClient(relay);
  t.after(() => client.close());
  await relay.waitForLog("paired host↔client");

  // 桌面旧连接还没被判定断开就又拨进来（半开连接 / 快速重启）：relay 走 host 顶替分支。
  const host2 = await openHost(relay);
  t.after(() => host2.close());
  await relay.waitForLog("replacing existing host connection");

  // 关键断言 1：手机端必须活着 —— 修复前旧 pair 的连坐会用 4002 把它关掉。
  assert.equal(await closeWithin(client, 300), null, "host 顶替不得连坐关掉手机端");

  // 关键断言 2：新 host 与手机端必须真的配上（client→host 靠新 pipe；修复前该方向是断的）。
  const host2Got = nextMessage(host2);
  client.send(Buffer.from("client-request-after-replace"));
  assert.equal(await host2Got, "client-request-after-replace");

  // 关键断言 3：旧 host 关闭后手机端继续存活（dispose 后旧 pair 不再有任何副作用）。
  await wait(200);
  assert.equal(await closeWithin(client, 200), null, "旧 host 关闭后手机端必须继续存活");
});

test("配对重定向只摘 token，保留其它参数（autoReconnect 开关不能被吃掉）", async (t) => {
  const relay = await startRelayServer(t);
  const base = `http://127.0.0.1:${relay.port}`;

  const withFlag = await fetch(`${base}/?token=${RELAY_TOKEN}&autoReconnect=1`, {
    redirect: "manual",
  });
  assert.equal(withFlag.status, 302);
  assert.equal(withFlag.headers.get("location"), "/?autoReconnect=1");
  assert.match(withFlag.headers.get("set-cookie") ?? "", /zcode_lite_token=/);

  // 没有其它参数时保持原来的干净路径（token 不留在历史里）。
  const clean = await fetch(`${base}/?token=${RELAY_TOKEN}`, { redirect: "manual" });
  assert.equal(clean.status, 302);
  assert.equal(clean.headers.get("location"), "/");
});

test("/api/server-info 鉴权：无/错 cookie 一律 401（fail-closed），配对后才放行", async (t) => {
  const relay = await startRelayServer(t);
  const base = `http://127.0.0.1:${relay.port}`;

  // 未配对（无 cookie）→ 401：工作区路径/主机标签不向匿名探测暴露。
  const anonymous = await fetch(`${base}/api/server-info`);
  assert.equal(anonymous.status, 401);

  // 错误 cookie 同样拒绝（不是只认「有 cookie」）。
  const wrong = await fetch(`${base}/api/server-info`, {
    headers: { cookie: `zcode_lite_token=wrong-token` },
  });
  assert.equal(wrong.status, 401);

  // 正常配对流程：?token= → Set-Cookie → 带 cookie 读取 → 200（host 未上报时工作区为空）。
  const paired = await fetch(`${base}/?token=${RELAY_TOKEN}`, { redirect: "manual" });
  const cookie = (paired.headers.get("set-cookie") ?? "").split(";")[0];
  assert.ok(cookie.startsWith("zcode_lite_token="));
  const empty = await fetch(`${base}/api/server-info`, { headers: { cookie } });
  assert.equal(empty.status, 200);
  assert.deepEqual(await empty.json().then((b) => b.workspaces), []);

  // 桌面上报工作区后，同一 cookie 能读到完整 server-info。
  await fetch(`${base}/api/host-report`, {
    method: "POST",
    headers: { authorization: `Bearer ${HOST_SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ workspacePath: "/tmp/demo-workspace", hostLabel: "test-host" }),
  });
  const reported = await fetch(`${base}/api/server-info`, { headers: { cookie } });
  assert.equal(reported.status, 200);
  const body = await reported.json();
  assert.equal(body.workspaces[0].path, "/tmp/demo-workspace");
});

test("空闲回收：不回 pong 的僵尸连接被关闭，健康连接不受影响", async (t) => {
  // 心跳 80ms / 空闲 250ms：把生产默认值（30s / 60s）压缩到测试可接受的时间。
  const relay = await startRelayServer(t, { heartbeatMs: 80, idleMs: 250 });

  // 假 host 收完 101 就 pause：不会回 pong → 应被判为僵尸并关闭。
  const zombie = await openRawHost(relay);
  t.after(() => zombie.destroy());
  await relay.waitForLog("host connected");
  await relay.waitForLog("closing idle host connection", 4000);

  // 反向用例：正常 ws 客户端按 RFC 自动回 pong，空闲也不得被误关。
  const alive = await openHost(relay);
  t.after(() => alive.close());
  assert.equal(
    await closeWithin(alive, 700),
    null,
    "会自动回 pong 的健康连接不得被空闲回收误关",
  );
});
