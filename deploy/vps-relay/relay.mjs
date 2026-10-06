#!/usr/bin/env node
/* eslint-disable max-lines -- 单文件中继是交付属性（README/Dockerfile/spec 都按「一个文件即可部署」描述），
   拆文件会破坏该属性；因此与 packages/web/src/main.tsx 等处同样用带理由的 disable，而不是为行数拆散鉴权与转发逻辑。 */
/**
 * ZCode VPS 中继（单文件，仅依赖 `ws`）。
 *
 * 职责：把一条「手机 WebSocket」与一条「桌面 WebSocket」配对，逐字节互相转发。
 *
 * 它**不理解 ZCode 的通道协议** —— 两端用的都是同一套 SocketProtocol 帧格式，
 * 所以转发是纯字节搬运，中继不需要解帧、不需要知道 payload 是什么。
 *
 * 端点：
 *   GET  /                   静态托管 web bundle（SPA fallback 仅限无扩展名路径；带扩展名的资产 404）
 *   GET  /api/server-info    手机端启动时读工作区；数据来自桌面的 /api/host-report。
 *                            cookie 或 ?token= 双通道门禁，未配对方拿不到（fail-closed）
 *   POST /api/host-report    桌面上报工作区（Bearer HOST_SECRET）
 *   GET  /ws    (upgrade)    手机接入；鉴权用 zcode_lite_token cookie 或 ?token= 查询参数；
 *                            从连接池认领空闲槽位（spec §17）
 *   GET  /host  (upgrade)    桌面拨入；鉴权用 Bearer HOST_SECRET；?slot=<k> 声明槽位，
 *                            同槽位重连顶替旧连接（4001 host-replaced），注册为该槽位唯一 host
 *
 * 环境变量：
 *   PORT               监听端口，默认 3180
 *   WEB_ROOT           web bundle 目录，默认 ./web
 *   RELAY_TOKEN        手机配对码（必填）
 *   HOST_SECRET        桌面共享密钥（必填）
 *   HOST_WAIT_GRACE_MS host 暂时缺位时手机等待的宽限毫秒数，默认 5000
 *   HEARTBEAT_INTERVAL_MS 两侧 ping 间隔，默认 30000（见下「心跳与空闲回收」）
 *   IDLE_TIMEOUT_MS    一侧多久无任何活动即视为僵尸连接并关闭，默认 60000
 *
 * 配对流程：用户打开 https://<vps>/?token=<RELAY_TOKEN> 一次，
 * 本进程下发 zcode_lite_token cookie，之后 /ws 升级靠该 cookie 放行。
 * 非 token 参数会被保留：`&autoReconnect=1` 是手机侧「断线自动重载」的显式开关。
 * 这与 `zcode --web --host 0.0.0.0` 的既有 token 机制完全一致，所以手机侧零改动。
 *
 * 时效签名链接（spec §18）：桌面可生成官方形状的签名凭据
 * `?s=<sid>&t=<签发秒>&e=<过期秒>&h=<HMAC(RELAY_TOKEN, "s|t|e")>`，
 * 验证全部无状态（常量时间比较），配对成功下发**派生会话 cookie**
 * `v1.<e>.<HMAC(RELAY_TOKEN, "cookie|e")>`（过期由服务端判定，非 Max-Age 提示）。
 * 客户端凭据共四通道：legacy cookie / legacy ?token= / v1 cookie / signed query。
 *
 * 帧缓冲（spec §12.3.1）：host 在无手机配对期间发出的帧（含 ChannelServer 构造时
 * 立即发出的 Initialize 握手帧）进入有界缓冲，配对成功时先回放。否则手机侧
 * ChannelClient 永远等不到 Initialize、一个 RPC 都不发，页面静默白屏。
 *
 * 宽限等待（spec §12.3.1）：手机刷新会连坐关闭 host 连接，桌面 ~0.1s 内快速补位；
 * 若新页面的 WS 仍撞进缺位窗口，等待宽限期而不是立刻 4002——立刻踢掉会让
 * web 端 bootstrap（open 即 resolve）误判成功，渲染空壳白屏。
 *
 * 心跳与空闲回收（spec §12.3.1「断开与恢复」）：两端都按 RFC 自动回 pong
 * （浏览器与 ws 客户端均如此），所以定期 ping 既能保活也能探测僵尸连接：
 * 超过 IDLE_TIMEOUT_MS 没有任何活动的一侧被关闭。host 用 4003（桌面侧按
 * 「快速补位」100ms 重连），client 用 4000。
 */
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 3180;
const WEB_ROOT = resolve(process.env.WEB_ROOT || "./web");
const RELAY_TOKEN = (process.env.RELAY_TOKEN || "").trim();
const HOST_SECRET = (process.env.HOST_SECRET || "").trim();
/** host 暂时缺位时手机等待的宽限：桌面侧对「手机离线连坐」用 ~100ms 快速补位，
 *  正常刷新远小于上限；仅当桌面真的离线（App 已退出等）才会等满后 4002。 */
const HOST_WAIT_GRACE_MS = Number(process.env.HOST_WAIT_GRACE_MS) || 5000;

/** 与 packages/server 一致的 cookie 名，保证手机端沿用既有 token 流程。 */
const COOKIE_NAME = "zcode_lite_token";
/** 单帧上限。协议侧 continuous 档 streamOutputCapBytes = 256 KiB，
 *  replayable 会经 snapshot/rows 传更大的块，这里给足余量。 */
const MAX_PAYLOAD = 64 * 1024 * 1024;
/** 转发积压告警阈值：超过说明对端消费不过来，记 warn 便于排障。 */
const BACKPRESSURE_WARN_BYTES = 16 * 1024 * 1024;
/** 心跳：两侧都按 RFC 自动回 pong（浏览器 / ws 客户端皆然），因此定期 ping 既保活也探活。 */
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS) || 30_000;
/** 超过该时长无任何活动（消息 / ping / pong）的一侧视为僵尸连接并关闭。 */
const IDLE_TIMEOUT_MS = Number(process.env.IDLE_TIMEOUT_MS) || 60_000;

if (!RELAY_TOKEN || !HOST_SECRET) {
  console.error("[relay] RELAY_TOKEN 与 HOST_SECRET 必须同时设置");
  process.exit(1);
}

const MIME = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** 桌面上报的工作区信息，用于回答手机的 /api/server-info。 */
let hostReport = null;

/**
 * 连接池（spec §17）：slotId → 槽位状态。
 * slotId 来自桌面拨出时的 `/host?slot=<k>`（缺省 0 = 兼容单槽位旧行为）。
 * 每个槽位独立持有：host ws、认领的 client ws、配对句柄、配对前帧缓冲——
 * 多个槽位互不影响，协议/E2EE/手机端零改动。
 */
const hostSlots = new Map();
/** 等待槽位的客户端（FIFO）：ws → { timer }（宽限计时器，spec §12.3.1）。 */
const waitingClients = new Map();
/** ws → 角色（"host" | "client"），空闲回收用（含已被顶替但尚未走完 close 的连接）。 */
const socketRoles = new Map();
/** socket → 最近一次活动时间。心跳用它区分「空闲但健康」与「僵尸连接」。 */
const socketActivity = new Map();

function trackSocketActivity(ws, role) {
  socketRoles.set(ws, role);
  socketActivity.set(ws, Date.now());
  for (const event of ["message", "ping", "pong"]) {
    ws.on(event, () => socketActivity.set(ws, Date.now()));
  }
}

/**
 * host→client 方向的配对前帧缓冲（spec §12.3.1）：**按槽位独立**。
 * host 连上后立刻会发出 ChannelServer 的 Initialize 握手帧，而客户端通常还没认领；
 * 不缓冲的话这帧被丢弃，客户端的 ChannelClient 永远停在 Uninitialized，白屏。
 * 有界：超限丢最旧（握手帧在最前，正常远小于上限；极端积压时保新弃旧）。
 */
const PENDING_FRAMES_MAX = 32;
const PENDING_BYTES_MAX = 1024 * 1024;

function frameByteLength(data) {
  return typeof data === "string" ? Buffer.byteLength(data) : data.length;
}

function bufferSlotFrame(slot, data, isBinary) {
  slot.buffer.push({ data, isBinary });
  slot.bufferBytes += frameByteLength(data);
  while (slot.buffer.length > PENDING_FRAMES_MAX || slot.bufferBytes > PENDING_BYTES_MAX) {
    const dropped = slot.buffer.shift();
    slot.bufferBytes -= frameByteLength(dropped.data);
  }
}

function clearSlotBuffer(slot) {
  slot.buffer = [];
  slot.bufferBytes = 0;
}

const log = (msg, extra) =>
  console.log(`[relay ${new Date().toISOString()}] ${msg}${extra ? " " + JSON.stringify(extra) : ""}`);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolvePromise(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function readBearer(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return "";
}

/** 常量时间比较，避免按字符提前返回泄漏长度/前缀信息。 */
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 手机侧配对凭据的**多通道**校验：cookie 或查询参数，二者等价。
 *
 * 为什么需要查询参数通道：实测发现 Electron 内置浏览器（webview 分区）里 302 的
 * Set-Cookie 可能不落地（分区 cookie 为空），页面只能带着无 cookie 的 WS 撞 401，
 * 表现为空白/启动失败（spec §12.4「token 双通道」）。RELAY_TOKEN 本来就是 relay
 * 自己签发的凭据（经 `?token=` 明文到达 relay），放进查询参数没有新增暴露面；
 * E2EE 的 `#k=` 在 fragment 里，永远不会进请求。
 *
 * 通道清单（spec §18.4）：
 *   1. legacy cookie      `zcode_lite_token = RELAY_TOKEN`
 *   2. legacy query       `?token=<RELAY_TOKEN>`
 *   3. 派生 cookie        `v1.<e>.<sig>`（时效链接配对后下发，服务端判过期）
 *   4. signed query       `?s=&t=&e=&h=` 全参数签名验证
 */
function isClientAuthorized(req, url) {
  const cookie = readCookie(req, COOKIE_NAME);
  if (safeEqual(cookie, RELAY_TOKEN)) return true;
  if (isSessionCookieValid(cookie)) return true;
  const queryToken = (url.searchParams.get("token") || "").trim();
  if (queryToken.length > 0 && safeEqual(queryToken, RELAY_TOKEN)) return true;
  return isSignedShareQueryValid(url);
}

/** 时钟偏移容差（秒）：签名校验允许 |now - t| 的偏差（spec §18.2）。 */
const CLOCK_SKEW_SECONDS = 300;

function hmacRelayToken(message) {
  return createHmac("sha256", RELAY_TOKEN).update(message).digest("base64url");
}

/**
 * 派生会话 cookie（spec §18.3）：值里编入过期时刻 `e`，验证时服务端重算 HMAC 并判
 * `now < e` —— 过期是**服务端强制**的（Max-Age 只是浏览器提示）。无状态，重启不失效。
 */
function deriveSessionCookie(expiresAtSec) {
  return `v1.${expiresAtSec}.${hmacRelayToken(`cookie|${expiresAtSec}`)}`;
}

function isSessionCookieValid(value) {
  if (!value.startsWith("v1.")) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const expiresAtSec = Number.parseInt(parts[1], 10);
  if (!Number.isInteger(expiresAtSec) || expiresAtSec * 1000 <= Date.now()) return false;
  return safeEqual(parts[2], hmacRelayToken(`cookie|${expiresAtSec}`));
}

/** §18.2 签名四元组校验：h 常量时间比对，t 在 ±300s 内，e 必须在未来。 */
function isSignedShareQueryValid(url) {
  const sid = (url.searchParams.get("s") || "").trim();
  const t = Number.parseInt(url.searchParams.get("t") || "", 10);
  const e = Number.parseInt(url.searchParams.get("e") || "", 10);
  const h = (url.searchParams.get("h") || "").trim();
  if (!sid || !Number.isInteger(t) || !Number.isInteger(e)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - t) > CLOCK_SKEW_SECONDS) return false;
  if (e * 1000 <= Date.now()) return false;
  return safeEqual(h, hmacRelayToken(`${sid}|${t}|${e}`));
}

function buildServerInfo() {
  const workspace = hostReport?.workspacePath
    ? {
        path: hostReport.workspacePath,
        label: hostReport.workspacePath.split("/").filter(Boolean).pop() || hostReport.workspacePath,
        ...(hostReport.workspaceIdentity ? { workspaceIdentity: hostReport.workspaceIdentity } : {}),
      }
    : null;
  return {
    serverId: hostReport?.hostLabel || "zcode-relay",
    version: hostReport?.appVersion || "relay",
    protocolVersion: 1,
    authRequired: true,
    workspaces: workspace ? [workspace] : [],
    capabilities: { desktopContinuous: true, websocketRpc: true },
  };
}

async function serveStatic(res, pathname) {
  // SPA fallback 只给**无扩展名**的路径：带扩展名的（.js/.css/...）是资产请求，
  // 旧构建的哈希文件在新 dist 里不存在时必须回 404——兜底成 index.html 会把
  // HTML 当 JS 发回去，浏览器模块解析直接失败，页面白屏（实测踩过）。
  const hasFileExtension = /\.[A-Za-z0-9]{1,8}$/.test(pathname);
  // 先按原路径取；取不到再回落到 index.html（SPA fallback）。
  const candidates = hasFileExtension ? [pathname] : [pathname, "/index.html"];
  for (const candidate of candidates) {
    const relative = normalize(candidate).replace(/^([/\\])+/, "");
    const filePath = join(WEB_ROOT, relative);
    // 目录穿越防护：解析后必须仍在 WEB_ROOT 内。
    if (filePath !== WEB_ROOT && !filePath.startsWith(WEB_ROOT + sep)) continue;
    try {
      const body = await readFile(filePath);
      log("static", { status: 200, path: candidate, bytes: body.length });
      res.writeHead(200, {
        "content-type": MIME[extname(filePath)] || "application/octet-stream",
        "content-length": body.length,
        "cache-control": candidate === "/index.html" ? "no-store" : "public, max-age=3600",
      });
      res.end(body);
      return;
    } catch {
      // 试下一个候选
    }
  }
  log("static miss", { pathname });
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}

const server = createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    sendJson(res, 400, { error: "bad request" });
    return;
  }

  // 配对：带 ?token= 的一次性入口，下发 cookie 后重定向，
  // 只摘掉 token（避免留在浏览器历史/Referer 里），**保留其它参数**——
  // 手机把 `/?token=…&autoReconnect=1` 加进主屏后，重定向不能把开关吃掉。
  // 仅对页面路径生效：/api/* 的 ?token= 是「token 双通道」鉴权（spec §12.4），
  // 不能被重定向劫持（否则 server-info 的查询参数通道永远 401）。
  if (url.searchParams.get("token") && !url.pathname.startsWith("/api/")) {
    if (!safeEqual(url.searchParams.get("token"), RELAY_TOKEN)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    res.setHeader(
      "set-cookie",
      `${COOKIE_NAME}=${RELAY_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
    );
    const remaining = new URLSearchParams(url.searchParams);
    remaining.delete("token");
    const query = remaining.toString();
    res.writeHead(302, { location: query ? `${url.pathname}?${query}` : url.pathname });
    res.end();
    return;
  }

  // 时效签名链接配对入口（spec §18.2/§18.4）：验证通过即下发派生 cookie 并**直接
  // 返回页面**。与 token 入口不同，这里不能 302：signed 参数要保留在地址栏（它们
  // 就是本次会话凭据，web bundle 会附到 /ws 与 /api），原样保留参数的 302 会造成
  // 重定向循环。serveStatic 的 writeHead 会与 setHeader 合并，cookie 随页面下发。
  if (url.searchParams.get("s") && url.searchParams.get("h") && !url.pathname.startsWith("/api/")) {
    if (!isSignedShareQueryValid(url)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const expiresAtSec = Number.parseInt(url.searchParams.get("e"), 10);
    const maxAge = Math.max(0, expiresAtSec - Math.floor(Date.now() / 1000));
    res.setHeader(
      "set-cookie",
      `${COOKIE_NAME}=${deriveSessionCookie(expiresAtSec)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
    );
    await serveStatic(res, url.pathname);
    return;
  }

  if (url.pathname === "/api/server-info") {
    // 与 /ws 同一门禁（fail-closed，双通道）：工作区路径/主机标签不向未配对方暴露。
    // 未带凭据的调用方收到 401 —— web 端 resolveWebBootstrap() 对非 200 优雅降级
    // （只少拿初始工作区提示，不会失败），正常配对流程不受影响。
    if (!isClientAuthorized(req, url)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    sendJson(res, 200, buildServerInfo());
    return;
  }

  // 健康检查：只回 {ok:true}，不回任何状态细节（避免给未授权方做侦察）。
  // 桌面是否在线请看日志里的 host connected / host disconnected。
  if (url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === "/api/host-report") {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method Not Allowed" });
      return;
    }
    if (!safeEqual(readBearer(req), HOST_SECRET)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    try {
      const body = await readJson(req);
      hostReport = {
        workspacePath: typeof body.workspacePath === "string" ? body.workspacePath : null,
        workspaceIdentity:
          typeof body.workspaceIdentity === "string" ? body.workspaceIdentity : null,
        hostLabel: typeof body.hostLabel === "string" ? body.hostLabel : null,
        appVersion: typeof body.appVersion === "string" ? body.appVersion : null,
      };
      log("host report updated", { workspacePath: hostReport.workspacePath });
      sendJson(res, 200, { ok: true });
    } catch {
      sendJson(res, 400, { error: "Invalid body" });
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(res, 405, { error: "Method Not Allowed" });
    return;
  }

  await serveStatic(res, url.pathname);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

function rejectUpgrade(socket, status, message) {
  socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    rejectUpgrade(socket, 400, "Bad Request");
    return;
  }

  if (url.pathname === "/host") {
    if (!safeEqual(readBearer(req), HOST_SECRET)) {
      log("host upgrade rejected: bad secret");
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    // 槽位号（spec §17）：缺省 0 = 兼容单槽位旧桌面；0..99。
    const slotParam = (url.searchParams.get("slot") ?? "0").trim() || "0";
    const slotId = Number.parseInt(slotParam, 10);
    if (!Number.isInteger(slotId) || slotId < 0 || slotId > 99) {
      log("host upgrade rejected: bad slot", { slot: slotParam });
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onHostOpen(ws, String(slotId)));
    return;
  }

  if (url.pathname === "/ws") {
    if (!isClientAuthorized(req, url)) {
      log("client upgrade rejected: bad cookie/token");
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    wss.handleUpgrade(req, socket, head, onClientOpen);
    return;
  }

  rejectUpgrade(socket, 404, "Not Found");
});

/**
 * 配对后的连接治理（spec §17）：client→host 逐字节转发 + 任一侧关闭/出错时连坐另一侧
 * （close code 用于客户端区分「桌面离线」）。每个 pair 绑定一个槽位。
 * host→client 方向不在这里挂：host 连上时就要开始接收帧（无人认领时进槽位缓冲，
 * 见 bufferSlotFrame），由 onHostOpen 的转发器负责。
 */
function pipe(slotId, slot, a, b) {
  let closed = false;
  // client→host 的活转发。命名保存是为了 dispose 时能精确摘掉（漏摘会让旧连接继续注入）。
  const forwardToHost = (data, isBinary) => {
    if (a.readyState !== a.OPEN) return;
    if (b.bufferedAmount > BACKPRESSURE_WARN_BYTES) {
      log("backpressure on client→host", { bufferedAmount: b.bufferedAmount, slot: slotId });
    }
    a.send(data, { binary: isBinary });
  };
  b.on("message", forwardToHost);

  const shutdown = (code, reason) => {
    if (closed) return;
    closed = true;
    for (const socket of [a, b]) {
      try {
        if (socket.readyState === socket.OPEN) socket.close(code, reason);
      } catch {
        socket.terminate();
      }
    }
    // 释放槽位与客户端登记（任一侧 close 都会走到这里，closed 保证幂等）。
    if (hostSlots.get(slotId) === slot) {
      slot.client = null;
      slot.pair = null;
    }
    waitingClients.delete(b);
    socketActivity.delete(b);
  };

  // 连坐监听集中登记（on/off 用同一张表），避免 dispose 漏摘 —— 漏摘会让旧 host 的 close
  // 误关客户端。
  const listeners = [
    [a, "close", () => shutdown(4002, "host-offline")],
    [a, "error", () => shutdown(4002, "host-error")],
    [b, "close", () => shutdown(4003, "client-offline")],
    [b, "error", () => shutdown(4003, "client-error")],
  ];
  for (const [socket, event, listener] of listeners) socket.on(event, listener);

  /**
   * 摘掉本 pair 的全部监听并让 shutdown 失效，**不关任何 socket**。
   * 只用于「同槽位 host 被顶替」：旧 host 的 close 不得连坐关掉正被服务的客户端，
   * 新 host 会接管同一客户端（syncPairingAll 里按 slot.client 重新建 pipe）。
   */
  const dispose = () => {
    closed = true;
    b.off("message", forwardToHost);
    for (const [socket, event, listener] of listeners) socket.off(event, listener);
  };

  return { shutdown, dispose };
}

/** 供宽限日志用的 host 状态描述（措辞沿用单槽位版，集成测试断言依赖它）。 */
function hostStateForLog() {
  for (const slot of hostSlots.values()) {
    if (slot.ws && slot.ws.readyState !== slot.ws.OPEN) {
      return `not OPEN (readyState=${slot.ws.readyState})`;
    }
  }
  return "offline";
}

/**
 * 客户端进入宽限等待：期间有空闲槽位即被配对，到期仍无槽位才 4002（reason no-free-host）。
 * 立刻 4002 只会让 web 端（open 即 resolve）误判成功 → 空壳白屏。
 */
function armClientGrace(ws) {
  const entry = waitingClients.get(ws);
  if (!entry || entry.timer) return;
  log(`host ${hostStateForLog()}; holding client for up to ${HOST_WAIT_GRACE_MS}ms`);
  entry.timer = setTimeout(() => {
    if (!waitingClients.has(ws)) return; // 已配对或已断开
    // 到期必须重判：宽限期内可能有槽位回来但没走到配对。直接结束会让客户端
    // 既不被服务也不被拒绝 —— 又一个静默白屏。
    syncPairingAll();
    if (!waitingClients.has(ws)) return;
    waitingClients.delete(ws);
    log("grace elapsed without host; rejecting client (4002)");
    try {
      ws.close(4002, "no-free-host");
    } catch {
      ws.terminate();
    }
  }, HOST_WAIT_GRACE_MS);
}

/**
 * 配对的**唯一决策点**（spec §17）：每个「OPEN 且空闲」的槽位按 FIFO 认领一个等待客户端，
 * 认领后先回放该槽位的缓冲帧（含 Initialize）。被顶替后仍持有 client 的槽位直接与新
 * host 重新建 pipe（dispose 语义，client 存活）。所有路径（host 连上 / 客户端连上 /
 * host 断开 / 宽限到期）都调用它 —— 单一决策点是刷新白屏修复的根基（spec §12.3.1）。
 * 只配 OPEN 的 host 与 OPEN 的 client：配给正在关闭的 socket 等于给新页面埋雷。
 */
function syncPairingAll() {
  for (const [slotId, slot] of hostSlots) {
    if (slot.pair || !slot.ws || slot.ws.readyState !== slot.ws.OPEN) continue;
    let clientWs = slot.client;
    if (!clientWs || clientWs.readyState !== clientWs.OPEN) {
      clientWs = waitingClients.keys().next().value;
      if (!clientWs) continue;
      const entry = waitingClients.get(clientWs);
      if (entry?.timer) clearTimeout(entry.timer);
      waitingClients.delete(clientWs);
      slot.client = clientWs;
    }
    if (slot.buffer.length > 0) {
      slot.buffer.forEach((frame) => clientWs.send(frame.data, { binary: frame.isBinary }));
      log("replayed buffered host frames", {
        slot: slotId,
        count: slot.buffer.length,
        bytes: slot.bufferBytes,
      });
    }
    clearSlotBuffer(slot);
    slot.pair = pipe(slotId, slot, slot.ws, clientWs);
    log("paired host↔client", { slot: slotId });
  }
}

function onHostOpen(ws, slotId) {
  const existing = hostSlots.get(slotId);
  if (existing && existing.ws && existing.ws !== ws) {
    log("replacing existing host connection", { slot: slotId });
    // 旧 pair 必须被摘掉监听而不能只置空：否则旧 host 稍后的 close 会用 4002
    // 连坐关掉正被服务的客户端。已认领的 client 保留，由新 host 接管。
    existing.pair?.dispose();
    // dispose 只摘监听，不清槽位登记：这里必须显式置空，否则 syncPairingAll 会认为
    // 槽位仍在配对中而跳过重建，客户端的帧就发进了没有转发器的死管道。
    existing.pair = null;
    clearSlotBuffer(existing);
    const previous = existing.ws;
    try {
      previous.close(4001, "host-replaced");
    } catch {
      previous.terminate();
    }
    existing.ws = ws;
  } else if (existing) {
    existing.ws = ws;
  } else {
    hostSlots.set(slotId, { ws, client: null, pair: null, buffer: [], bufferBytes: 0 });
  }
  const slot = hostSlots.get(slotId);
  trackSocketActivity(ws, "host");
  log("host connected", { slot: slotId });
  // host→client 转发从 host 连上就开始（而不是配对时才挂）：
  // ChannelServer 构造即发 Initialize，此刻客户端多半还没认领，必须缓冲（spec §12.3.1）。
  ws.on("message", (data, isBinary) => {
    // 已被顶替的旧 host 仍在关闭过程中时，不得再往客户端注入帧。
    if (hostSlots.get(slotId)?.ws !== ws) return;
    const target = slot.client;
    if (target && target.readyState === target.OPEN) {
      if (target.bufferedAmount > BACKPRESSURE_WARN_BYTES) {
        log("backpressure on host→client", { bufferedAmount: target.bufferedAmount, slot: slotId });
      }
      target.send(data, { binary: isBinary });
    } else {
      bufferSlotFrame(slot, data, isBinary);
    }
  });
  ws.on("close", () => {
    if (hostSlots.get(slotId)?.ws !== ws) return;
    hostSlots.delete(slotId);
    socketActivity.delete(ws);
    log("host disconnected", { slot: slotId });
    // 该槽位的 pair 会经 a-close 监听连坐关闭其客户端（4002）并自行释放登记；
    // 其它槽位不受影响。这里补一次配对决策，让等待中的客户端认领其它空闲槽位。
    syncPairingAll();
  });
  ws.on("error", () => {});
  syncPairingAll();
}

function onClientOpen(ws) {
  trackSocketActivity(ws, "client");
  log("client connected");
  ws.on("close", () => {
    // 配对中的断开由 pipe 的 b-close 监听连坐处理；这里只清等待登记。
    waitingClients.delete(ws);
    socketActivity.delete(ws);
    log("client disconnected");
  });
  ws.on("error", () => {});
  // 连接池下新客户端不再互相顶替：认领空闲槽位；无空闲则进宽限等待
  // （armClientGrace 布防计时器），而不是配给垂死 host、更不是立刻 4002（都会白屏）。
  waitingClients.set(ws, { timer: null });
  armClientGrace(ws);
  syncPairingAll();
}

/**
 * 心跳与空闲回收（spec §12.3.1「断开与恢复」）。
 *
 * 定期 ping 所有连接：既保活（移动网络/NAT 不会静默丢弃空闲连接），也探活——
 * 一侧超过 IDLE_TIMEOUT_MS 没有任何活动就视为僵尸连接（客户端被回收、桌面卡死、
 * 网络半开）并关闭，腾出槽位。遍历 socketRoles（含已被顶替但尚未走完 close 的
 * 连接），保证僵尸无论是否还在槽位表里都会被回收。两端都按 RFC 自动回 pong，
 * 因此「空闲但健康」的连接不会被误关。
 */
setInterval(() => {
  const now = Date.now();
  for (const [ws, role] of socketRoles) {
    if (ws.readyState !== ws.OPEN) continue;
    if (now - (socketActivity.get(ws) ?? now) <= IDLE_TIMEOUT_MS) {
      try {
        ws.ping();
      } catch {
        /* 忽略：下一轮会按活动时间判定 */
      }
      continue;
    }
    log(`closing idle ${role} connection`);
    socketRoles.delete(ws);
    socketActivity.delete(ws);
    // host 用 4003：桌面侧按「快速补位」100ms 重连；client 用 4000（通用应用层关闭）。
    try {
      ws.close(role === "host" ? 4003 : 4000, "idle-timeout");
    } catch {
      ws.terminate();
    }
  }
}, HEARTBEAT_INTERVAL_MS);

server.listen(PORT, () => {
  log(`listening on :${PORT}`, { webRoot: WEB_ROOT });
});
