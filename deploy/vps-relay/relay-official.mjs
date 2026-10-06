#!/usr/bin/env node
/**
 * 路线 B：官方远控协议的**控制面**中继。
 *
 * 与同目录的 `relay.mjs`（路线 A，纯字节转发）是**两套独立技术栈**，不能混搭：
 *   - 路线 A 搬的是桌面内部的 `SocketProtocol` 二进制帧（13B 帧头），中继不理解内容
 *   - 本文件说的是官方远控的 **JSON 信封协议**，中继**必须理解**它才能做鉴权与房间路由
 *
 * 协议来源（只读逆向，未复制任何代码）：
 *   - 桌面侧：官方 asar 的 `[web-remote-control]` 模块与
 *     `createNodeWebRemoteControlRelayAuthProvider`
 *   - 手机侧：社区 fork 的 `packages/web/src/remote-v4/connection.ts`
 *   详见 `docs/spec/vps-relay-bridge.md` §14。
 *
 * 覆盖范围：**仅控制面**（注册 / 鉴权 / 配对 / 心跳 / data 信封转发）。
 * 数据面的 `bootstrap-*` / `workspace-bridge-*` / `rpc-frame-ack` 语义**不在本文件范围**
 * —— 那部分要由桌面侧适配器实现，属于路线 B 的第二阶段。
 *
 * 环境变量：
 *   PORT          监听端口，默认 3180
 *   LINK_ORIGIN   生成链接时使用的 origin（如 https://relay.example.com），用于拼链接
 */

import { createServer } from "node:http";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT) || 3180;
const LINK_ORIGIN = (process.env.LINK_ORIGIN || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");

/** 单帧上限。官方客户端有 maxPhysical 检查，这里给足余量。 */
const MAX_PAYLOAD = 64 * 1024 * 1024;
/** challenge 有效期：超时未回 auth_response 则断开。 */
const AUTH_TIMEOUT_MS = 30_000;
/** 心跳 watchdog：超过该时间没收到 pair_status_query 就认为对端已死。 */
const HEARTBEAT_TIMEOUT_MS = 45_000;

const log = (msg, detail) =>
  console.log(
    `[relay-b ${new Date().toISOString()}] ${msg}${detail ? " " + JSON.stringify(detail) : ""}`,
  );

// ─────────────────────────────────────────────────────────────────────────────
// 鉴权原语 —— 与官方实现逐字对应（spec §14.2）
//
// 客户端侧还有两个原语，本 relay **不需要**，仅在此记录以保持协议完整：
//   createPassword = randomBytes(24).toString("base64url")     // 设备口令（仅客户端生成）
//   createPassHash = sha256(password).digest("base64")          // 客户端算好后经
//                                                               // device_register_init 上传
// relay 只保存上传来的 pass_hash，并用它作为 HMAC key 校验 device 的 proof。
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 官方：calculateProof(key, nonce, role, sid) =
 *   HMAC_SHA256(key, `${nonce}|${role}|${sid}`).digest("base64url")
 *
 * 注意 key 的含义两端不同：
 *   - 桌面 device：key = 持久化的 passHash
 *   - 手机 terminal：key = 链接里的 hash
 */
const calculateProof = (key, nonce, role, sid) =>
  createHmac("sha256", key).update(`${nonce}|${role}|${sid}`).digest("base64url");

/** 常量时间比较，避免按字符提前返回泄漏前缀信息。 */
function safeEqualString(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

// ─────────────────────────────────────────────────────────────────────────────
// 房间状态（内存态；生产应换持久化）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * device_sid 即房间 id —— 已确认链接里的 `sid` 与桌面端的 `device_sid` 是同一个值
 * （手机发 `auth_init{device_sid: pairing.sid}`，桌面发 `auth_init{device_sid}`）。
 */
const rooms = new Map();

function createRoom({ deviceMid, passHash, meta }) {
  const deviceSid = `d_${randomBytes(16).toString("base64url")}`;
  const room = {
    deviceSid,
    // 桌面的 HMAC key（注册时上传，后续 auth_response 用它验签）
    passHash,
    // 手机的 HMAC key（随链接下发给用户）
    linkHash: randomBytes(32).toString("base64url"),
    deviceMid,
    meta,
    device: null,
    terminal: null,
    deviceAuthed: false,
    terminalAuthed: false,
    createdAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    /** 上一次广播过的 pair_status，用于只记录状态变化。 */
    lastPairStatus: null,
  };
  rooms.set(deviceSid, room);
  return room;
}

/** 配对成功条件：两端都已鉴权。 */
const isPaired = (room) => room.deviceAuthed && room.terminalAuthed;

function pairStatusOf(room) {
  return isPaired(room) ? "matched" : "waiting";
}

// ─────────────────────────────────────────────────────────────────────────────
// 消息收发
// ─────────────────────────────────────────────────────────────────────────────

function send(socket, message) {
  if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function sendError(socket, code, message) {
  send(socket, { type: "error", code, message });
}

function sendPairStatus(socket, room) {
  send(socket, { type: "pair_status_ack", pair_status: pairStatusOf(room) });
}

/** 两端都已鉴权时，向双方各推一次 matched；否则推 waiting。 */
function broadcastPairStatus(room) {
  const status = pairStatusOf(room);
  for (const socket of [room.device, room.terminal]) {
    if (socket) send(socket, { type: "pair_status_ack", pair_status: status });
  }
  // 只在状态**变化**时记日志，避免重复刷屏。
  if (room.lastPairStatus !== status) {
    room.lastPairStatus = status;
    log("pair_status changed", { status, sidSuffix: room.deviceSid.slice(-6) });
  }
}

/** 处理 challenge-response 的公共部分。 */
function handleAuthChallenge(room, socket, role, expectedKey, sid) {
  const nonce = randomBytes(32).toString("base64url");
  const timer = setTimeout(() => {
    sendError(socket, "auth_timeout", "auth_response 超时");
    socket.close(4401, "auth-timeout");
  }, AUTH_TIMEOUT_MS);

  socket.__pendingAuth = { nonce, role, expectedKey, sid, timer };
  send(socket, { type: "auth_challenge", nonce });
}

function verifyAuthResponse(room, socket, payload) {
  const pending = socket.__pendingAuth;
  if (!pending) {
    sendError(socket, "auth_failed", "未发起 challenge");
    return false;
  }
  clearTimeout(pending.timer);
  socket.__pendingAuth = null;

  const expected = calculateProof(pending.expectedKey, pending.nonce, pending.role, pending.sid);
  if (!safeEqualString(expected, String(payload.proof ?? ""))) {
    // 只记事实，不记任何凭据值。
    sendError(socket, "auth_failed", "proof 校验失败");
    log("auth failed", { role: pending.role, sidSuffix: String(pending.sid).slice(-6) });
    socket.close(4403, "auth-failed");
    return false;
  }

  if (pending.role === "device") room.deviceAuthed = true;
  else room.terminalAuthed = true;

  log("auth ok", { role: pending.role, sidSuffix: String(pending.sid).slice(-6) });
  send(socket, { type: "auth_ack", pair_status: pairStatusOf(room) });
  broadcastPairStatus(room);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 连接处理
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 一个 WS 连接会经历：
 *   device：device_register_init → device_register_ack → auth_init(device) → … → auth_ack
 *   terminal：auth_init(terminal) → … → auth_ack
 * 之后就是 pair_status_query 心跳与 data 信封转发。
 */
function handleSocket(socket, role) {
  socket.__role = role;
  socket.__room = null;

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      sendError(socket, "bad_json", "消息不是合法 JSON");
      return;
    }
    if (!msg || typeof msg.type !== "string") {
      sendError(socket, "bad_message", "缺少 type");
      return;
    }
    handleMessage(socket, msg);
  });

  socket.on("close", () => {
    const room = socket.__room;
    if (!room) return;
    if (room.device === socket) room.device = null;
    if (room.terminal === socket) room.terminal = null;
    room.deviceAuthed = room.device ? room.deviceAuthed : false;
    room.terminalAuthed = room.terminal ? room.terminalAuthed : false;
    log("socket closed", { sidSuffix: room.deviceSid.slice(-6) });
    broadcastPairStatus(room);
  });

  socket.on("error", () => {});
}

function handleMessage(socket, msg) {
  switch (msg.type) {
    // ── 桌面注册：上传 pass_hash，换回 device_sid ──────────────────────────
    case "device_register_init": {
      if (socket.__role !== "device") {
        sendError(socket, "role_mismatch", "该端点只接受 device");
        return;
      }
      const passHash = String(msg.pass_hash ?? "");
      if (!passHash) {
        sendError(socket, "bad_message", "缺少 pass_hash");
        return;
      }
      const room = createRoom({
        deviceMid: String(msg.device_mid ?? ""),
        passHash,
        meta: msg.meta ?? null,
      });
      socket.__room = room;
      room.device = socket;
      log("device registered", { sidSuffix: room.deviceSid.slice(-6) });
      send(socket, { type: "device_register_ack", device_sid: room.deviceSid });
      return;
    }

    // ── 两端共用的 auth_init ──────────────────────────────────────────────
    case "auth_init": {
      const role = msg.role === "terminal" ? "terminal" : "device";
      const sid = String(msg.device_sid ?? "");
      const room = rooms.get(sid);
      if (!room) {
        sendError(socket, "sid_invalid", "未知的 device_sid");
        return;
      }
      // ⚠ 绑定 socket.__room 必须放在**所有准入检查之后**：被拒绝的连接若也绑定了房间，
      // 它断开时会在 close 里改动房间状态并广播一条假的 pair_status。
      if (role === "device") {
        if (room.device && room.device !== socket) {
          sendError(socket, "device_busy", "该房间已有设备连接");
          return;
        }
        socket.__room = room;
        room.device = socket;
        handleAuthChallenge(room, socket, "device", room.passHash, sid);
        return;
      }
      if (room.terminal && room.terminal !== socket) {
        sendError(socket, "terminal_busy", "该房间已有手机连接");
        return;
      }
      socket.__room = room;
      room.terminal = socket;
      handleAuthChallenge(room, socket, "terminal", room.linkHash, sid);
      return;
    }

    // ── challenge-response 的响应 ─────────────────────────────────────────
    case "auth_response": {
      const room = socket.__room;
      if (!room) {
        sendError(socket, "sid_invalid", "尚未绑定房间");
        return;
      }
      verifyAuthResponse(room, socket, msg);
      return;
    }

    // ── 心跳 ─────────────────────────────────────────────────────────────
    case "pair_status_query": {
      const room = socket.__room ?? rooms.get(String(msg.device_sid ?? ""));
      if (!room) {
        sendError(socket, "sid_invalid", "未知的 device_sid");
        return;
      }
      room.lastHeartbeatAt = Date.now();
      sendPairStatus(socket, room);
      return;
    }

    // ── 数据面：未鉴权不放行 ─────────────────────────────────────────────
    case "data": {
      const room = socket.__room;
      if (!room) {
        sendError(socket, "sid_invalid", "尚未绑定房间");
        return;
      }
      const authed = socket.__role === "device" ? room.deviceAuthed : room.terminalAuthed;
      if (!authed) {
        sendError(socket, "not_authed", "未完成鉴权");
        return;
      }
      const peer = socket.__role === "device" ? room.terminal : room.device;
      if (!peer) {
        sendError(socket, "peer_offline", "对端不在线");
        return;
      }
      // 信封原样转发：本文件只负责控制面与转发，不解释 payload 语义。
      send(peer, { type: "data", payload: msg.payload });
      return;
    }

    default: {
      sendError(socket, "unknown_type", `未知消息类型 ${msg.type}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP：生成配对链接（控制面用；生产应加设备鉴权）
// ─────────────────────────────────────────────────────────────────────────────

function buildLink(room) {
  const params = new URLSearchParams({
    sid: room.deviceSid,
    hash: room.linkHash,
    t: String(Date.now()),
    mid: room.deviceMid,
    name: room.meta?.name ?? "",
    app_version: room.meta?.version ?? "",
  });
  return `${LINK_ORIGIN}/remote/v4?${params.toString()}`;
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  // 生成某房间的配对链接。
  // 鉴权为自建扩展（spec vps-relay-bridge.md §14.8）：proof = calculateProof(
  //   passHash, "link", "device", sid) —— 复用 §14.2 算法，nonce 固定为字面量 "link"。
  // 缺头 / 错 proof / 未知 sid 一律 401，不区分「房间不存在」与「proof 错误」，
  // 避免向未鉴权方泄露房间存在性。
  if (url.pathname === "/api/remote-control/link") {
    const sid = url.searchParams.get("sid") ?? "";
    const room = rooms.get(sid);
    const proof = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const expected = room ? calculateProof(room.passHash, "link", "device", sid) : "";
    if (!expected || !safeEqualString(expected, proof)) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ link: buildLink(room) }));
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not found" }));
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

server.on("upgrade", (req, socket, head) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    socket.destroy();
    return;
  }
  // 官方是同一个 /ws 端点，靠 auth_init 的 role 区分设备与手机。
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleSocket(ws, url.searchParams.get("mid") ? "device" : "terminal");
  });
});

server.listen(PORT, () => {
  log(`listening on :${PORT}`, { linkOrigin: LINK_ORIGIN });
});

// 心跳 watchdog：长时间无 pair_status_query 的房间做清理。
setInterval(() => {
  const now = Date.now();
  for (const [sid, room] of rooms) {
    if (room.device || room.terminal) continue;
    if (now - room.lastHeartbeatAt > HEARTBEAT_TIMEOUT_MS) {
      rooms.delete(sid);
      log("room expired", { sidSuffix: sid.slice(-6) });
    }
  }
}, 30_000).unref?.();
