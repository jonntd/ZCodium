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
 *   GET  /ws    (upgrade)    手机接入；鉴权用 zcode_lite_token cookie 或 ?token= 查询参数
 *   GET  /host  (upgrade)    桌面拨入；鉴权用 Bearer HOST_SECRET
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
/** 当前唯一的桌面连接与手机连接。 */
let hostSocket = null;
let clientSocket = null;

/** socket → 最近一次活动时间。心跳用它区分「空闲但健康」与「僵尸连接」。 */
const socketActivity = new Map();

function trackSocketActivity(ws) {
  socketActivity.set(ws, Date.now());
  for (const event of ["message", "ping", "pong"]) {
    ws.on(event, () => socketActivity.set(ws, Date.now()));
  }
}

/**
 * host→client 方向的配对前帧缓冲（spec §12.3.1）。
 * host 连上后立刻会发出 ChannelServer 的 Initialize 握手帧，而手机通常还没打开页面；
 * 不缓冲的话这帧被丢弃，手机的 ChannelClient 永远停在 Uninitialized，白屏。
 * 有界：超限丢最旧（握手帧在最前，正常远小于上限；极端积压时保新弃旧）。
 */
const PENDING_FRAMES_MAX = 32;
const PENDING_BYTES_MAX = 1024 * 1024;
let pendingHostFrames = [];
let pendingHostFrameBytes = 0;

function frameByteLength(data) {
  return typeof data === "string" ? Buffer.byteLength(data) : data.length;
}

function bufferHostFrame(data, isBinary) {
  pendingHostFrames.push({ data, isBinary });
  pendingHostFrameBytes += frameByteLength(data);
  while (
    pendingHostFrames.length > PENDING_FRAMES_MAX ||
    pendingHostFrameBytes > PENDING_BYTES_MAX
  ) {
    const dropped = pendingHostFrames.shift();
    pendingHostFrameBytes -= frameByteLength(dropped.data);
  }
}

function clearHostBuffer() {
  pendingHostFrames = [];
  pendingHostFrameBytes = 0;
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
 * 手机侧配对凭据的**双通道**校验：cookie 或 `?token=` 查询参数，二者等价。
 *
 * 为什么需要查询参数通道：实测发现 Electron 内置浏览器（webview 分区）里 302 的
 * Set-Cookie 可能不落地（分区 cookie 为空），页面只能带着无 cookie 的 WS 撞 401，
 * 表现为空白/启动失败（spec §12.4「token 双通道」）。RELAY_TOKEN 本来就是 relay
 * 自己签发的凭据（经 `?token=` 明文到达 relay），放进查询参数没有新增暴露面；
 * E2EE 的 `#k=` 在 fragment 里，永远不会进请求。
 */
function isClientAuthorized(req, url) {
  if (safeEqual(readCookie(req, COOKIE_NAME), RELAY_TOKEN)) return true;
  const queryToken = (url.searchParams.get("token") || "").trim();
  return queryToken.length > 0 && safeEqual(queryToken, RELAY_TOKEN);
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
    wss.handleUpgrade(req, socket, head, onHostOpen);
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
 * 配对后的连接治理：client→host 逐字节转发 + 任一侧关闭/出错时连坐另一侧
 * （close code 用于手机端区分「桌面离线」）。
 * host→client 方向不在这里挂：host 连上时就要开始接收帧（无人配对时进缓冲，
 * 见 bufferHostFrame），由 onHostOpen 的转发器负责。
 */
function pipe(a, b) {
  let closed = false;
  // client→host 的活转发。命名保存是为了 dispose 时能精确摘掉（漏摘会让旧连接继续注入）。
  const forwardToHost = (data, isBinary) => {
    if (a.readyState !== a.OPEN) return;
    if (a.bufferedAmount > BACKPRESSURE_WARN_BYTES) {
      log("backpressure on client→host", { bufferedAmount: a.bufferedAmount });
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
  };

  // 连坐监听集中登记（on/off 用同一张表），避免 dispose 漏摘 —— 漏摘会让旧 host 的 close
  // 误关手机端。
  const listeners = [
    [a, "close", () => shutdown(4002, "host-offline")],
    [a, "error", () => shutdown(4002, "host-error")],
    [b, "close", () => shutdown(4003, "client-offline")],
    [b, "error", () => shutdown(4003, "client-error")],
  ];
  for (const [socket, event, listener] of listeners) socket.on(event, listener);

  /**
   * 摘掉本 pair 的全部监听并让 shutdown 失效，**不关任何 socket**。
   * 只用于「host 被顶替」：旧 host 的 close 不得连坐关掉正被新 host 服务的手机端。
   * 反过来「client 被顶替」不能这么做 —— 新页面需要换一个新 attachment 才有属于它的
   * Initialize，所以那条路径继续依赖本 pair 的连坐把 host 换代（见 onClientOpen）。
   */
  const dispose = () => {
    closed = true;
    b.off("message", forwardToHost);
    for (const [socket, event, listener] of listeners) socket.off(event, listener);
  };

  return { shutdown, dispose };
}

let activePair = null;

/** 手机在 host 缺位期间的宽限定时器：到期仍无 host 才回 4002（spec §12.3.1）。 */
let clientWaitTimer = null;

function clearClientWait() {
  // clearTimeout(null|undefined) 本身就是 no-op，不必为「当前没有定时器」再分一个分支。
  clearTimeout(clientWaitTimer);
  clientWaitTimer = null;
}

/**
 * host 是否**可用**：不仅存在，还必须已 OPEN。
 *
 * 刷新时序（spec §12.3.1「残留竞态 3」）：手机端 WS 断开时 pipe 连坐对 host 调 `close(4003)`，
 * 但 host 的 `close` 事件要等 close 握手完成（WAN 上一个 RTT）。这段窗口里 `hostSocket`
 * 仍指向那个 CLOSING 的 socket —— 若此时把新页面配给它，垂死连接一到 close 就会用
 * `shutdown(4002, "host-offline")` 把刚连上的新页面一起关掉，而 web 端
 * `connectViaWebSocket` 在 open 时已 resolve，于是渲染空壳白屏且不重试。
 */
function isHostReady() {
  return Boolean(hostSocket) && hostSocket.readyState === hostSocket.OPEN;
}

/**
 * 让当前手机端进入宽限等待：期间 host 回来即配对并回放 Initialize，到期仍无 host 才 4002。
 * 立刻 4002 只会让 web 端（open 即 resolve）误判成功 → 空壳白屏。
 */
function holdClientUntilHost(ws) {
  if (!ws || ws.readyState !== ws.OPEN || clientWaitTimer) return;
  const hostState = hostSocket ? `not OPEN (readyState=${hostSocket.readyState})` : "offline";
  log(`host ${hostState}; holding client for up to ${HOST_WAIT_GRACE_MS}ms`);
  clientWaitTimer = setTimeout(() => {
    clientWaitTimer = null;
    if (clientSocket !== ws) return;
    // 到期必须重判 host：宽限期内 host 可能已经回来但没走到配对（例如被旧 pair 挡住）。
    // 直接结束会让客户端既不被服务也不被拒绝 —— 又是一个静默白屏。
    if (isHostReady()) return syncPairing();
    log("grace elapsed without host; rejecting client (4002)");
    try {
      ws.close(4002, "host-offline");
    } catch {
      ws.terminate();
    }
  }, HOST_WAIT_GRACE_MS);
}

/**
 * 配对的**唯一决策点**：host 可用就配对（先回放 Initialize 等缓冲帧），否则让手机端进宽限等待。
 *
 * 所有路径（host 连上 / 手机连上 / host 断开 / 宽限到期）都调用它，避免出现
 * 「有的路径配对、有的路径直接踢掉」的分叉 —— 那正是刷新后白屏的来源（spec §12.3.1）。
 * 只配 OPEN 的 host 与 OPEN 的 client：配给正在关闭的 socket 等于给新页面埋一个立刻触发的雷。
 */
function syncPairing() {
  if (activePair) return;
  if (!clientSocket || clientSocket.readyState !== clientSocket.OPEN) return;
  if (!isHostReady()) {
    holdClientUntilHost(clientSocket);
    return;
  }
  clearClientWait();
  if (pendingHostFrames.length > 0) {
    pendingHostFrames.forEach((frame) => clientSocket.send(frame.data, { binary: frame.isBinary }));
    log("replayed buffered host frames", {
      count: pendingHostFrames.length,
      bytes: pendingHostFrameBytes,
    });
  }
  clearHostBuffer();
  activePair = pipe(hostSocket, clientSocket);
  log("paired host↔client");
}

function clearPair() {
  activePair = null;
}

function onHostOpen(ws) {
  if (hostSocket && hostSocket !== ws) {
    log("replacing existing host connection");
    const previous = hostSocket;
    hostSocket = null;
    clearHostBuffer();
    // 旧 pair 必须被摘掉监听而不能只置空：否则旧 host 稍后的 close 会用 4002
    // 连坐关掉正被新 host 服务的手机端（手机端不需要重连，它会拿到新 attachment 的 Initialize）。
    activePair?.dispose();
    clearPair();
    try {
      previous.close(4001, "host-replaced");
    } catch {
      previous.terminate();
    }
  }
  hostSocket = ws;
  trackSocketActivity(ws);
  log("host connected");
  // host→client 转发从 host 连上就开始（而不是配对时才挂）：
  // ChannelServer 构造即发 Initialize，此刻手机多半还没配对，必须缓冲（spec §12.3.1）。
  ws.on("message", (data, isBinary) => {
    // 已被顶替的旧 host 仍在关闭过程中时，不得再往手机端注入帧。
    if (hostSocket !== ws) return;
    const target = clientSocket;
    if (target && target.readyState === target.OPEN) {
      if (target.bufferedAmount > BACKPRESSURE_WARN_BYTES) {
        log("backpressure on host→client", { bufferedAmount: target.bufferedAmount });
      }
      target.send(data, { binary: isBinary });
    } else {
      bufferHostFrame(data, isBinary);
    }
  });
  ws.on("close", () => {
    if (hostSocket !== ws) return;
    hostSocket = null;
    socketActivity.delete(ws);
    clearHostBuffer();
    clearPair();
    log("host disconnected");
    // host 走了但手机端可能还连着且没被配对（例如新页面在旧 pair 被摘掉前就已顶替）：
    // 这里补一次配对决策，让宽限计时器兜住它，否则桌面不再回来时会静默挂死。
    syncPairing();
  });
  ws.on("error", () => {});
  syncPairing();
}

function onClientOpen(ws) {
  if (clientSocket && clientSocket !== ws) {
    log("replacing existing client connection");
    const previous = clientSocket;
    clientSocket = null;
    // 不需要在这里单独清宽限定时器：下面紧跟一次 clearClientWait()。
    try {
      previous.close(4004, "client-replaced");
    } catch {
      previous.terminate();
    }
  }
  clientSocket = ws;
  clearClientWait();
  trackSocketActivity(ws);
  log("client connected");
  ws.on("close", () => {
    if (clientSocket !== ws) return;
    clientSocket = null;
    socketActivity.delete(ws);
    clearClientWait();
    clearPair();
    log("client disconnected");
  });
  ws.on("error", () => {});
  // host 缺位（手机刷新连坐了桌面连接，桌面 ~0.1s 内快速补位）或已发 close 但握手未完成：
  // syncPairing 会把它放进宽限等待，而不是配给垂死 host、更不是立刻 4002 踢掉（都会白屏）。
  syncPairing();
}

/**
 * 心跳与空闲回收（spec §12.3.1「断开与恢复」）。
 *
 * 定期 ping 两侧：既保活（移动网络/NAT 不会静默丢弃空闲连接），也探活——
 * 一侧超过 IDLE_TIMEOUT_MS 没有任何活动就视为僵尸连接（手机被回收、桌面卡死、
 * 网络半开）并关闭，避免它长期占住唯一 host/client 槽位。
 * 两端都按 RFC 自动回 pong，因此「空闲但健康」的连接不会被误关。
 */
setInterval(() => {
  const now = Date.now();
  for (const [ws, label] of [
    [hostSocket, "host"],
    [clientSocket, "client"],
  ]) {
    if (!ws || ws.readyState !== ws.OPEN) continue;
    if (now - (socketActivity.get(ws) ?? now) <= IDLE_TIMEOUT_MS) {
      try {
        ws.ping();
      } catch {
        /* 忽略：下一轮会按活动时间判定 */
      }
      continue;
    }
    log(`closing idle ${label} connection`);
    socketActivity.delete(ws);
    // host 用 4003：桌面侧按「快速补位」100ms 重连；client 用 4000（通用应用层关闭）。
    try {
      ws.close(label === "host" ? 4003 : 4000, "idle-timeout");
    } catch {
      ws.terminate();
    }
  }
}, HEARTBEAT_INTERVAL_MS);

server.listen(PORT, () => {
  log(`listening on :${PORT}`, { webRoot: WEB_ROOT });
});
