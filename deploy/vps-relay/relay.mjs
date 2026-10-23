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
 *                            凭据双通道（cookie 或 ?token=）解析出房间，未配对方拿不到（fail-closed）
 *   POST /api/host-report    桌面上报工作区（Bearer 房间密钥）
 *   GET  /ws    (upgrade)    手机接入；凭据解析出房间（v6 key-room，spec §19.2）；
 *                            FIFO 认领该房间的空闲槽位（spec §17）
 *   GET  /host  (upgrade)    桌面拨入；鉴权用 `Authorization: Bearer <roomKey>`；?slot=<i> 声明
 *                            房间内槽位，同槽位重连顶替旧连接（4001 host-replaced）
 *
 * v6 key-room（spec vps-relay-bridge.md §19）：一把房间密钥 `roomKey` 同时承担
 * 桌面拨入鉴权、手机配对凭据与房间路由；房间**按密钥按需创建**，因此本进程
 * 不再要求任何密钥环境变量——`.env` 只剩 `PORT` 等运维变量。
 *
 * 环境变量：
 *   PORT               监听端口，默认 3180
 *   WEB_ROOT           web bundle 目录，默认 ./web
 *   HOST_WAIT_GRACE_MS host 暂时缺位时手机等待的宽限毫秒数，默认 5000
 *   HEARTBEAT_INTERVAL_MS 两侧 ping 间隔，默认 30000（见下「心跳与空闲回收」）
 *   IDLE_TIMEOUT_MS    一侧多久无任何活动即视为僵尸连接并关闭，默认 60000
 *
 * 配对流程：用户打开 https://<vps>/?token=<roomKey> 一次（桌面「移动端远程控制」
 * 弹层的分享链接就是这个形状），本进程下发 zcode_lite_token cookie（值 = roomKey），
 * 之后 /ws 升级靠该 cookie 放行。非 token 参数会被保留：`&autoReconnect=1` 是手机侧
 * 「断线自动重载」的显式开关。这与 `zcode --web --host 0.0.0.0` 的既有 token 机制
 * 完全一致，所以手机侧零改动。
 *
 * 时效签名链接（spec §18，v6 起 HMAC 密钥 = roomKey）：桌面可生成官方形状的签名凭据
 * `?s=<sid>&t=<签发秒>&e=<过期秒>&h=<HMAC(roomKey, "s|t|e")>`，验证全部无状态
 * （常量时间比较，逐房间重算），配对成功下发**派生会话 cookie**
 * `v1.<f>.<e>.<HMAC(roomKey, "cookie|f|e")>`（f = 房间指纹，支持一台 relay 多房间；
 * 过期由服务端判定，非 Max-Age 提示）。
 * 客户端凭据共四通道：原始 key cookie / 原始 key ?token= / 派生 cookie / signed query。
 *
 * 房间治理（spec §19.2）：房间按首次见到的密钥创建，上限 MAX_ROOMS；心跳扫描回收
 * 「无 host、无 client、无上报」的空房间，防未知 key 刷房撑爆内存。日志只出现
 * 房间指纹（SHA-256 前 8 字符），永不出现密钥本体。
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
import { createHash, createHmac } from "node:crypto";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { gzip as gzipCallback } from "node:zlib";
import { WebSocketServer } from "ws";

const gzipAsync = promisify(gzipCallback);

const PORT = Number(process.env.PORT) || 3180;
const WEB_ROOT = resolve(process.env.WEB_ROOT || "./web");
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

/**
 * 房间治理参数（spec §19.2）：key-room 模式下房间按首次见到的密钥创建，
 * 必须有上限 + 回收，否则任何知道地址的人都能用随机 key 刷房撑内存。
 */
const MAX_ROOMS = 100;

/**
 * 房间密钥的形状：可打印 ASCII（含 base64/base64url 的 + / = - _），8..128 字符。
 * 桌面生成值是 43 字符 base64url；v5 迁移沿用的自定义历史密钥也在该范围内。
 * 形状校验只是第一道闸（挡空串/超长/控制字符），真正的准入 = 知道密钥本体。
 */
function isPlausibleKey(key) {
  return typeof key === "string" && /^[!-~]{8,128}$/.test(key);
}

/** 房间指纹（日志与派生 cookie 索引用）：不泄露密钥本体，长度固定可索引。 */
function roomFingerprint(key) {
  return createHash("sha256").update(key).digest("base64url").slice(0, 8);
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

/**
 * 值得 gzip 的扩展名：文本类压缩率约 3~4 倍（主 bundle 5.8MB → 1.6MB）。
 *
 * 这条是**慢链路上的刚需**：手机/iPad 首次打开要整包下载，未压缩时 15s 的
 * bundle 接管超时基本必然触发（实测某 VPS 单连接只有 10KB/s~1MB/s 抖动）。
 * 图片 / 字体本身已是压缩格式，再压只白耗 CPU，故不列入。
 */
const COMPRESSIBLE_EXT = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".map",
  ".mjs",
  ".svg",
  ".txt",
  ".wasm",
  ".xml",
]);
/** 小于 1KB 压了也没意义。 */
const GZIP_MIN_BYTES = 1024;

/**
 * 房间表（v6 key-room，spec §19.2）：key → Room。
 * Room = { key, fingerprint, slots, waiting, report, reportEncrypted }：
 * - slots：房间内的槽位表（slotId → 槽位状态），原全局 hostSlots 下沉到房间；
 * - waiting：等待配对的客户端（FIFO），原全局 waitingClients 按房间分组；
 * - report / reportEncrypted：该房间桌面的 host-report（原全局单份 → 房间级）。
 */
const rooms = new Map();
/** 房间指纹 → 房间：派生 cookie（v1.<f>.<e>.<sig>）按指纹 O(1) 定位房间。 */
const roomsByFingerprint = new Map();
/** ws → 角色（"host" | "client"），空闲回收用（含已被顶替但尚未走完 close 的连接）。 */
const socketRoles = new Map();
/** socket → 最近一次活动时间。心跳用它区分「空闲但健康」与「僵尸连接」。 */
const socketActivity = new Map();

function getRoom(key) {
  return rooms.get(key) ?? null;
}

/** 按需建房；房间数到上限时返回 null（调用方拒绝升级/请求）。 */
function getOrCreateRoom(key) {
  let room = rooms.get(key);
  if (room) return room;
  if (rooms.size >= MAX_ROOMS) return null;
  const fingerprint = roomFingerprint(key);
  room = {
    key,
    fingerprint,
    slots: new Map(),
    waiting: [],
    report: null,
    reportEncrypted: null,
  };
  rooms.set(key, room);
  roomsByFingerprint.set(fingerprint, room);
  return room;
}

/** 房间是否完全空闲（无 host、无 client、无等待者）。上报不算活动——保留它没有意义，
 *  桌面重连后会重新上报；空房间必须回收，否则未知 key 刷房会顶到 MAX_ROOMS。 */
function isRoomIdle(room) {
  for (const slot of room.slots.values()) {
    if (slot.ws || slot.client) return false;
  }
  return room.waiting.length === 0;
}

function dropRoom(room) {
  rooms.delete(room.key);
  if (roomsByFingerprint.get(room.fingerprint) === room) {
    roomsByFingerprint.delete(room.fingerprint);
  }
}

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

/** 时钟偏移容差（秒）：仅用于拒绝「签发时刻在未来」的伪造参数（spec §18.2）。
 *  注意**不能**拒绝「t 在过去」：t 是签发时刻，正常流程就是「生成链接 → 过一会儿
 *  才扫码/打开」，有效期完全由 e 把关 —— 曾把校验写成 |now-t|≤300 导致链接
 *  签发 5 分钟后就永远 401（真浏览器实测踩过）。 */
const CLOCK_SKEW_SECONDS = 300;

/**
 * 手机侧凭据 → 房间（v6 key-room，spec §19.2）。
 *
 * 为什么需要查询参数通道：实测发现 Electron 内置浏览器（webview 分区）里 302 的
 * Set-Cookie 可能不落地（分区 cookie 为空），页面只能带着无 cookie 的 WS 撞 401，
 * 表现为空白/启动失败（spec §12.4「token 双通道」）。roomKey 本来就是经 `?token=`
 * 明文到达 relay 的凭据，放进查询参数没有新增暴露面；E2EE 的 `#k=` 在 fragment 里，
 * 永远不会进请求。
 *
 * 通道清单（spec §19.2）：
 *   1. 原始 key query    `?token=<roomKey>`
 *   2. 原始 key cookie   `zcode_lite_token = <roomKey>`
 *   3. 派生 cookie       `v1.<f>.<e>.<sig>`（时效链接配对后下发，按指纹定位房间）
 *   4. signed query      `?s=&t=&e=&h=`（逐房间重算 HMAC(roomKey, "s|t|e")）
 *
 * 返回房间或 null；`create` 为 true 时对通道 1/2 按需建房（/ws 用），false 时只认
 * 已存在房间（server-info 用——不应凭一个未知 key 凭空建房）。
 */
function resolveRoom(req, url, { create = false } = {}) {
  const queryToken = (url.searchParams.get("token") || "").trim();
  if (isPlausibleKey(queryToken)) {
    return create ? getOrCreateRoom(queryToken) : getRoom(queryToken);
  }
  const cookie = readCookie(req, COOKIE_NAME);
  if (cookie) {
    // 派生 cookie（v1.<f>.<e>.<sig>）优先判定：原始 key 不会以 v1. 开头
    //（isPlausibleKey 允许任意可打印 ASCII，但桌面生成的 key 与 v5 沿用值都不是 v1. 前缀）。
    if (cookie.startsWith("v1.")) return resolveSessionCookie(cookie);
    if (isPlausibleKey(cookie)) {
      return create ? getOrCreateRoom(cookie) : getRoom(cookie);
    }
  }
  return resolveSignedShareQuery(url);
}

function hmacRoomKey(roomKey, message) {
  return createHmac("sha256", roomKey).update(message).digest("base64url");
}

/**
 * 派生会话 cookie（spec §18.3 / §19.3）：值里编入**房间指纹 f** 与过期时刻 `e`，
 * 验证时按指纹定位房间、重算 HMAC 并判 `now < e` —— 过期是**服务端强制**的
 * （Max-Age 只是浏览器提示）。无状态，重启不失效。多房间部署下指纹保证
 * 「cookie 只属于签发它的那个房间」，server-info 不会拿错桌面。
 */
function deriveSessionCookie(room, expiresAtSec) {
  return `v1.${room.fingerprint}.${expiresAtSec}.${hmacRoomKey(room.key, `cookie|${room.fingerprint}|${expiresAtSec}`)}`;
}

function resolveSessionCookie(value) {
  const parts = value.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const [, fingerprint, expiresAtRaw, sig] = parts;
  const expiresAtSec = Number.parseInt(expiresAtRaw, 10);
  if (!Number.isInteger(expiresAtSec) || expiresAtSec * 1000 <= Date.now()) return null;
  const room = roomsByFingerprint.get(fingerprint);
  if (!room) return null;
  if (!safeEqual(sig, hmacRoomKey(room.key, `cookie|${fingerprint}|${expiresAtSec}`))) return null;
  return room;
}

/**
 * §18.2 签名四元组的参数解析与时间窗校验：t 不得在未来（±300s 容差）；e 必须在未来。
 * 注意**不能**拒绝「t 在过去」：t 是签发时刻，正常流程就是「生成链接 → 过一会儿
 * 才扫码/打开」，有效期完全由 e 把关 —— 曾把校验写成 |now-t|≤300 导致链接
 * 签发 5 分钟后就永远 401（真浏览器实测踩过）。
 * v6 key-room（§19.2）：链接**自带 token**，签名由链接里的 key 自证——
 * 中继无需预知密钥即可验证（isSelfSignedShareValid），离线场景（房间尚未建立）也能配对。
 */
function parseShareQueryParams(url) {
  const sid = (url.searchParams.get("s") || "").trim();
  const t = Number.parseInt(url.searchParams.get("t") || "", 10);
  const e = Number.parseInt(url.searchParams.get("e") || "", 10);
  const h = (url.searchParams.get("h") || "").trim();
  if (!sid || !Number.isInteger(t) || !Number.isInteger(e) || !h) return null;
  if (t > Math.floor(Date.now() / 1000) + CLOCK_SKEW_SECONDS) return null;
  if (e * 1000 <= Date.now()) return null;
  return { sid, t, e, h };
}

/** 自验通道（页面配对入口）：HMAC 密钥 = 链接里自带的 token（roomKey）。 */
function isSelfSignedShareValid(key, url) {
  const params = parseShareQueryParams(url);
  if (!params) return false;
  return safeEqual(params.h, hmacRoomKey(key, `${params.sid}|${params.t}|${params.e}`));
}

/** 房间通道（/ws、/api：302 后地址栏只剩 s/t/e/h，没有 token）：逐房间重算。
 *  房间数有上限（MAX_ROOMS），遍历代价可控；命中哪个房间就归属哪个房间
 *  （不同 key 不可能算出同一签名）。 */
function resolveSignedShareQuery(url) {
  const params = parseShareQueryParams(url);
  if (!params) return null;
  const message = `${params.sid}|${params.t}|${params.e}`;
  for (const room of rooms.values()) {
    if (safeEqual(params.h, hmacRoomKey(room.key, message))) return room;
  }
  return null;
}

/** 页面配对入口的 key 形状校验（`/?token=`）：只验形状不建房——真正建房发生在
 *  /ws 与 /host（自验时效链接除外：签名通过即证明持有 key，见 token 入口分支）。 */
function isPagePairingTokenValid(token) {
  return isPlausibleKey(token);
}

function buildServerInfo(room) {
  // E2EE 信封（spec §16.9）：原样回给手机解密，中继不组表明文。
  if (room.reportEncrypted) {
    return { ...room.reportEncrypted };
  }
  const workspace = room.report?.workspacePath
    ? {
        path: room.report.workspacePath,
        label: room.report.workspacePath.split("/").filter(Boolean).pop() || room.report.workspacePath,
        ...(room.report.workspaceIdentity ? { workspaceIdentity: room.report.workspaceIdentity } : {}),
      }
    : null;
  return {
    serverId: room.report?.hostLabel || "zcode-relay",
    version: room.report?.appVersion || "relay",
    protocolVersion: 1,
    authRequired: true,
    workspaces: workspace ? [workspace] : [],
    capabilities: { desktopContinuous: true, websocketRpc: true },
  };
}

function acceptsGzip(header) {
  return String(header ?? "")
    .split(",")
    .some((part) => {
      const [encoding, ...params] = part.trim().split(";");
      if (encoding?.trim().toLowerCase() !== "gzip") return false;
      const quality = params.find((param) => /^\s*q\s*=/i.test(param));
      return quality == null || Number(quality.split("=")[1]) > 0;
    });
}

async function serveStatic(req, res, pathname) {
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
      const extension = extname(filePath).toLowerCase();
      const compressible = COMPRESSIBLE_EXT.has(extension) && body.length >= GZIP_MIN_BYTES;
      const compressed = compressible && acceptsGzip(req.headers["accept-encoding"]);
      const payload = compressed ? await gzipAsync(body) : body;
      const headers = {
        "content-type": MIME[extension] || "application/octet-stream",
        "content-length": payload.length,
        // /assets/ 下是 Vite 的内容哈希文件名：内容变 ⇒ 名字变，index.html 又是 no-store
        // ⇒ 可以放心给一年 immutable（重复访问直接命中缓存，不再重新下载 1.7MB 主包）。
        // 其余非哈希文件（public/ 拷贝物）保守给 1 小时。
        "cache-control":
          candidate === "/index.html"
            ? "no-store"
            : candidate.startsWith("/assets/")
              ? "public, max-age=31536000, immutable"
              : "public, max-age=3600",
      };
      // 必须对 identity 与 gzip 两种响应都发 Vary，否则共享缓存可能把 gzip 字节
      // 发给不支持 gzip 的客户端（或反过来）。
      if (compressible) headers.vary = "Accept-Encoding";
      if (compressed) headers["content-encoding"] = "gzip";
      log("static", {
        status: 200,
        path: candidate,
        bytes: body.length,
        ...(compressed ? { gzipBytes: payload.length } : {}),
      });
      res.writeHead(200, headers);
      // Node 对 HEAD 通常会抑制响应体；这里显式保证只发 GET 的 payload。
      res.end(req.method === "HEAD" ? undefined : payload);
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
  // v6 key-room：值 = 房间密钥本体；只验形状不建房（建房收口在 /ws 与 /host）。
  // 带 s/t/e/h 时是**自验时效链接**（spec §19.2）：签名用链接里的 key 自证，
  // 验证通过才下发派生 cookie 并按需建房（桌面离线、房间未建立时也能配对）。
  if (url.searchParams.get("token") && !url.pathname.startsWith("/api/")) {
    const key = (url.searchParams.get("token") || "").trim();
    if (!isPagePairingTokenValid(key)) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    if (url.searchParams.get("s") && url.searchParams.get("h")) {
      if (!isSelfSignedShareValid(key, url)) {
        sendJson(res, 401, { error: "Unauthorized" });
        return;
      }
      const expiresAtSec = Number.parseInt(url.searchParams.get("e"), 10);
      const maxAge = Math.max(0, expiresAtSec - Math.floor(Date.now() / 1000));
      const fingerprint = roomFingerprint(key);
      res.setHeader(
        "set-cookie",
        `${COOKIE_NAME}=v1.${fingerprint}.${expiresAtSec}.${hmacRoomKey(key, `cookie|${fingerprint}|${expiresAtSec}`)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
      );
      // 签名通过即证明持有 key：按需建房，后续 /ws（只带 s/t/e/h）才能定位到房间。
      getOrCreateRoom(key);
      // 与普通 token 入口一样 302 摘掉 token（永久凭据不能留在地址栏/历史/Referer），
      // **保留 s/t/e/h**——重定向后的请求走「signed 无 token」分支（逐房间验签），
      // web bundle 也靠它们把凭据附到 /ws 与 /api。不会循环：第二次请求已无 token。
      const remaining = new URLSearchParams(url.searchParams);
      remaining.delete("token");
      const query = remaining.toString();
      res.writeHead(302, { location: query ? `${url.pathname}?${query}` : url.pathname });
      res.end();
      return;
    }
    res.setHeader(
      "set-cookie",
      `${COOKIE_NAME}=${key}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
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
    const room = resolveSignedShareQuery(url);
    if (!room) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    const expiresAtSec = Number.parseInt(url.searchParams.get("e"), 10);
    const maxAge = Math.max(0, expiresAtSec - Math.floor(Date.now() / 1000));
    res.setHeader(
      "set-cookie",
      `${COOKIE_NAME}=${deriveSessionCookie(room, expiresAtSec)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`,
    );
    await serveStatic(req, res, url.pathname);
    return;
  }

  if (url.pathname === "/api/server-info") {
    // 与 /ws 同一门禁（fail-closed，双通道）：工作区路径/主机标签不向未配对方暴露。
    // 未带凭据的调用方收到 401 —— web 端 resolveWebBootstrap() 对非 200 优雅降级
    // （只少拿初始工作区提示，不会失败），正常配对流程不受影响。
    // 不建房（create:false）：server-info 不该凭一个未知 key 凭空创建房间。
    const room = resolveRoom(req, url);
    if (!room) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    sendJson(res, 200, buildServerInfo(room));
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
    // Bearer 即房间密钥（v6 key-room）：房间按需创建（桌面先于手机到达是常态）。
    const bearer = readBearer(req);
    const room = isPlausibleKey(bearer) ? getOrCreateRoom(bearer) : null;
    if (!room) {
      sendJson(res, 401, { error: "Unauthorized" });
      return;
    }
    try {
      const body = await readJson(req);
      if (
        body &&
        body.e2ee === true &&
        body.v === 1 &&
        typeof body.nonce === "string" &&
        typeof body.ciphertext === "string"
      ) {
        // E2EE 信封（spec §16.9）：原样存储。中继没有 channelKey，无从解析——
        // 日志只记密文规模，路径/标签永不出现。
        room.report = null;
        room.reportEncrypted = { v: 1, e2ee: true, nonce: body.nonce, ciphertext: body.ciphertext };
        log("host report updated", { room: room.fingerprint, e2ee: true, ciphertextBytes: body.ciphertext.length });
        sendJson(res, 200, { ok: true });
        return;
      }
      room.reportEncrypted = null;
      room.report = {
        workspacePath: typeof body.workspacePath === "string" ? body.workspacePath : null,
        workspaceIdentity:
          typeof body.workspaceIdentity === "string" ? body.workspaceIdentity : null,
        hostLabel: typeof body.hostLabel === "string" ? body.hostLabel : null,
        appVersion: typeof body.appVersion === "string" ? body.appVersion : null,
      };
      // 日志一律不带工作区路径（spec §16.9：即使明文模式也不在日志落路径）。
      log("host report updated", {
        room: room.fingerprint,
        hasWorkspacePath: typeof room.report.workspacePath === "string",
      });
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

  await serveStatic(req, res, url.pathname);
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
    // Bearer 即房间密钥（v6 key-room）：房间按需创建；到上限时拒绝（防刷房）。
    const bearer = readBearer(req);
    const room = isPlausibleKey(bearer) ? getOrCreateRoom(bearer) : null;
    if (!room) {
      log("host upgrade rejected: bad room key");
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    // 槽位号（spec §17）：房间内 0..99，缺省 0 = 兼容单槽位旧桌面。
    const slotParam = (url.searchParams.get("slot") ?? "0").trim() || "0";
    const slotId = Number.parseInt(slotParam, 10);
    if (!Number.isInteger(slotId) || slotId < 0 || slotId > 99) {
      log("host upgrade rejected: bad slot", { slot: slotParam });
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onHostOpen(room, ws, String(slotId)));
    return;
  }

  if (url.pathname === "/ws") {
    // 凭据 → 房间（按需建房）：手机可能先于桌面到达，房间必须能先建出来等 host。
    const room = resolveRoom(req, url, { create: true });
    if (!room) {
      log("client upgrade rejected: bad cookie/token");
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onClientOpen(room, ws));
    return;
  }

  rejectUpgrade(socket, 404, "Not Found");
});

/**
 * 配对后的连接治理（spec §17）：client→host 逐字节转发 + 任一侧关闭/出错时连坐另一侧
 * （close code 用于客户端区分「桌面离线」）。每个 pair 绑定一个房间槽位。
 * host→client 方向不在这里挂：host 连上时就要开始接收帧（无人认领时进槽位缓冲，
 * 见 bufferSlotFrame），由 onHostOpen 的转发器负责。
 */
function pipe(slot, a, b) {
  let closed = false;
  // client→host 的活转发。命名保存是为了 dispose 时能精确摘掉（漏摘会让旧连接继续注入）。
  const forwardToHost = (data, isBinary) => {
    if (a.readyState !== a.OPEN) return;
    if (b.bufferedAmount > BACKPRESSURE_WARN_BYTES) {
      log("backpressure on client→host", { bufferedAmount: b.bufferedAmount, slot: slot.id });
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
    if (slot.room.slots.get(slot.id) === slot) {
      slot.client = null;
      slot.pair = null;
    }
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
function hostStateForLog(room) {
  for (const slot of room.slots.values()) {
    if (slot.ws && slot.ws.readyState !== slot.ws.OPEN) {
      return `not OPEN (readyState=${slot.ws.readyState})`;
    }
  }
  return "offline";
}

/**
 * 客户端进入宽限等待：期间该房间有空闲槽位即被配对，到期仍无槽位才 4002（reason no-free-host）。
 * 立刻 4002 只会让 web 端（open 即 resolve）误判成功 → 空壳白屏。
 */
function armClientGrace(room, ws) {
  const entry = room.waiting.find((item) => item.ws === ws);
  if (!entry || entry.timer) return;
  log(`host ${hostStateForLog(room)}; holding client for up to ${HOST_WAIT_GRACE_MS}ms`, {
    room: room.fingerprint,
  });
  entry.timer = setTimeout(() => {
    if (!room.waiting.some((item) => item.ws === ws)) return; // 已配对或已断开
    // 到期必须重判：宽限期内可能有槽位回来但没走到配对。直接结束会让客户端
    // 既不被服务也不被拒绝 —— 又一个静默白屏。
    syncPairingAll();
    if (!room.waiting.some((item) => item.ws === ws)) return;
    room.waiting = room.waiting.filter((item) => item.ws !== ws);
    log("grace elapsed without host; rejecting client (4002)", { room: room.fingerprint });
    try {
      ws.close(4002, "no-free-host");
    } catch {
      ws.terminate();
    }
  }, HOST_WAIT_GRACE_MS);
}

/**
 * 配对的**唯一决策点**（spec §17）：每个「OPEN 且空闲」的房间槽位按 FIFO 认领一个
 * 等待客户端，认领后先回放该槽位的缓冲帧（含 Initialize）。被顶替后仍持有 client 的
 * 槽位直接与新 host 重新建 pipe（dispose 语义，client 存活）。所有路径（host 连上 /
 * 客户端连上 / host 断开 / 宽限到期）都调用它 —— 单一决策点是刷新白屏修复的根基
 * （spec §12.3.1）。只配 OPEN 的 host 与 OPEN 的 client：配给正在关闭的 socket
 * 等于给新页面埋雷。
 */
function syncPairingAll() {
  for (const room of rooms.values()) {
    for (const slot of room.slots.values()) {
      if (slot.pair || !slot.ws || slot.ws.readyState !== slot.ws.OPEN) continue;
      let clientWs = slot.client;
      if (!clientWs || clientWs.readyState !== clientWs.OPEN) {
        const next = room.waiting.shift();
        if (!next) continue;
        clientWs = next.ws;
        if (next.timer) clearTimeout(next.timer);
        slot.client = clientWs;
      }
      if (slot.buffer.length > 0) {
        slot.buffer.forEach((frame) => clientWs.send(frame.data, { binary: frame.isBinary }));
        log("replayed buffered host frames", {
          room: room.fingerprint,
          slot: slot.id,
          count: slot.buffer.length,
          bytes: slot.bufferBytes,
        });
      }
      clearSlotBuffer(slot);
      slot.pair = pipe(slot, slot.ws, clientWs);
      log("paired host↔client", { room: room.fingerprint, slot: slot.id });
    }
  }
}

function onHostOpen(room, ws, slotId) {
  let slot = room.slots.get(slotId);
  if (slot && slot.ws && slot.ws !== ws) {
    log("replacing existing host connection", { room: room.fingerprint, slot: slotId });
    // 旧 pair 必须被摘掉监听而不能只置空：否则旧 host 稍后的 close 会用 4002
    // 连坐关掉正被服务的客户端。已认领的 client 保留，由新 host 接管。
    slot.pair?.dispose();
    // dispose 只摘监听，不清槽位登记：这里必须显式置空，否则 syncPairingAll 会认为
    // 槽位仍在配对中而跳过重建，客户端的帧就发进了没有转发器的死管道。
    slot.pair = null;
    clearSlotBuffer(slot);
    const previous = slot.ws;
    try {
      previous.close(4001, "host-replaced");
    } catch {
      previous.terminate();
    }
    slot.ws = ws;
  } else if (slot) {
    slot.ws = ws;
  } else {
    slot = { id: slotId, room, ws, client: null, pair: null, buffer: [], bufferBytes: 0 };
    room.slots.set(slotId, slot);
  }
  trackSocketActivity(ws, "host");
  log("host connected", { room: room.fingerprint, slot: slotId });
  // host→client 转发从 host 连上就开始（而不是配对时才挂）：
  // ChannelServer 构造即发 Initialize，此刻客户端多半还没认领，必须缓冲（spec §12.3.1）。
  ws.on("message", (data, isBinary) => {
    // 已被顶替的旧 host 仍在关闭过程中时，不得再往客户端注入帧。
    if (room.slots.get(slotId)?.ws !== ws) return;
    const target = slot.client;
    if (target && target.readyState === target.OPEN) {
      if (target.bufferedAmount > BACKPRESSURE_WARN_BYTES) {
        log("backpressure on host→client", {
          bufferedAmount: target.bufferedAmount,
          room: room.fingerprint,
          slot: slotId,
        });
      }
      target.send(data, { binary: isBinary });
    } else {
      bufferSlotFrame(slot, data, isBinary);
    }
  });
  ws.on("close", () => {
    if (room.slots.get(slotId)?.ws !== ws) return;
    room.slots.delete(slotId);
    socketActivity.delete(ws);
    log("host disconnected", { room: room.fingerprint, slot: slotId });
    // 该槽位的 pair 会经 a-close 监听连坐关闭其客户端（4002）并自行释放登记；
    // 其它槽位不受影响。这里补一次配对决策，让等待中的客户端认领其它空闲槽位。
    syncPairingAll();
  });
  ws.on("error", () => {});
  syncPairingAll();
}

function onClientOpen(room, ws) {
  trackSocketActivity(ws, "client");
  log("client connected", { room: room.fingerprint });
  ws.on("close", () => {
    // 配对中的断开由 pipe 的 b-close 监听连坐处理；这里只清等待登记。
    room.waiting = room.waiting.filter((item) => item.ws !== ws);
    socketActivity.delete(ws);
    log("client disconnected", { room: room.fingerprint });
  });
  ws.on("error", () => {});
  // 连接池下新客户端不再互相顶替：认领空闲槽位；无空闲则进宽限等待
  // （armClientGrace 布防计时器），而不是配给垂死 host、更不是立刻 4002（都会白屏）。
  const entry = { ws, timer: null };
  room.waiting.push(entry);
  armClientGrace(room, ws);
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
 *
 * 同一轮顺带回收空房间（spec §19.2）：无 host、无 client、无等待者且无上报的房间
 * 直接删除——桌面重连/手机再访问都会按需重建。
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
  for (const room of [...rooms.values()]) {
    if (isRoomIdle(room)) {
      dropRoom(room);
      log("dropped idle room", { room: room.fingerprint });
    }
  }
}, HEARTBEAT_INTERVAL_MS);

server.listen(PORT, () => {
  log(`listening on :${PORT}`, { webRoot: WEB_ROOT });
});
