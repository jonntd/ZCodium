/**
 * 路线 B（官方远控协议）桌面侧 device 控制面客户端（spec vps-relay-bridge.md §14.8）。
 *
 * 职责：以官方协议的 device 角色连到自建中继（relay-official.mjs），完成
 * 注册 → 鉴权 → 心跳，并取回供官方手机端扫码的配对链接。
 *
 * 与路线 A（remoteRelayClient）是**两套独立技术栈**（§14.5）：不共享连接、
 * 配置与凭据。本模块**只做控制面**；数据面信封（bootstrap-* / workspace-bridge-* /
 * rpc-frame，§14.3）收到即 debug 丢弃，留待第二阶段适配。
 *
 * 日志纪律（对齐官方 safeAuthLogFields，§14.2/§14.8）：passHash、proof、完整
 * device_sid、链接 hash 一律不打，只允许 deviceSidSuffix（后 6 位）。
 */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getAppConfigDir } from "@zcode/services/node";
import { WebSocket } from "ws";

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
/** 心跳默认间隔：官方 `heartbeatIntervalMs ?? 10_000`（§14.1）。 */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
/** 连续两个心跳周期没等到 `pair_status_ack` 即判死链，主动重连（不能用超时掩盖同步问题）。 */
const HEARTBEAT_ACK_TOLERANCE_FACTOR = 2.5;
/** `auth_challenge` 后未在时限内完成鉴权即主动重连（relay 侧 30s 也会断）。 */
const DEFAULT_AUTH_TIMEOUT_MS = 30_000;

export type OfficialPairStatus = "waiting" | "matched";

export interface RemoteOfficialRelayFileConfig {
  enabled?: boolean;
  url?: string;
  deviceMid?: string;
  devicePassword?: string;
}

export interface OfficialRelayStartConfig {
  url: string;
  deviceMid: string;
  devicePassword: string;
}

export interface RemoteOfficialDeviceClientOptions {
  url: string;
  deviceMid: string;
  devicePassword: string;
  /** 随 `device_register_init` 上报、随配对链接下发的展示信息。 */
  meta?: { name?: string; version?: string };
  logger?: {
    info(message: string, detail?: unknown): void;
    warn(message: string, detail?: unknown): void;
    debug?(message: string, detail?: unknown): void;
  };
  heartbeatIntervalMs?: number;
  authTimeoutMs?: number;
  /** 便于单测注入；生产用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 取得（或重新注册后重新取得）配对链接。 */
  onLink?: (link: string) => void;
  /** 配对状态变化；`matched` = 官方手机端已接入。 */
  onPairStatus?: (status: OfficialPairStatus) => void;
  /**
   * 数据面信封入口（spec §14.9）：`type:"data"` 的 payload 原样交出，
   * 由 remoteOfficialDataPlane 按 zcode_type 分派。未提供时 debug 丢弃。
   */
  onData?: (payload: Record<string, unknown>) => void;
}

export interface RemoteOfficialDeviceClient {
  start(): void;
  stop(): void;
  /**
   * 数据面出口（spec §14.9）：把 payload 包成 `type:"data"` 信封发往对端。
   * 返回 false = 连接不可用。控制面状态机不感知数据面内容。
   */
  sendData(payload: Record<string, unknown>): boolean;
  /** 观测面：连接建立前 deviceSid 为 null。不作为跨重启的身份恢复依据（§14.8）。 */
  getStatus(): { state: string; deviceSid: string | null; pairStatus: OfficialPairStatus | null };
}

export function getOfficialRelayConfigFilePath(): string {
  return join(getAppConfigDir(), "remote-official-relay.json");
}

/**
 * 解析路线 B 启动配置；不满足启用条件（文件缺失 / enabled 非 true / 无 url）时
 * 返回 null，调用方完全不实例化客户端。env `ZCODE_OFFICIAL_RELAY_WS_URL` 优先于
 * 文件 url，但**不回写**文件里的 url。`deviceMid` / `devicePassword` 首次自动生成
 * 并持久化（与路线 A 的 pairingToken/channelKey/slotBase 同模式）：这两个值没有
 * 用户可读语义，手填只会退化成弱口令；轮换 = 清空字段重启。
 */
export async function loadOfficialRelayStartConfig(
  logger?: RemoteOfficialDeviceClientOptions["logger"],
): Promise<OfficialRelayStartConfig | null> {
  const envUrl = process.env.ZCODE_OFFICIAL_RELAY_WS_URL?.trim() || null;
  let file: RemoteOfficialRelayFileConfig | null = null;
  try {
    const raw = await readFile(getOfficialRelayConfigFilePath(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      file = parsed as RemoteOfficialRelayFileConfig;
    } else {
      logger?.warn("官方中继配置文件不是 JSON 对象，已忽略", getOfficialRelayConfigFilePath());
    }
  } catch {
    file = null;
  }

  const fileUrl = typeof file?.url === "string" ? file.url.trim() : "";
  const url = envUrl ?? (fileUrl || null);
  if (file?.enabled !== true || !url) return null;

  const deviceMid = file.deviceMid || randomBytes(16).toString("base64url");
  const devicePassword = file.devicePassword || randomBytes(24).toString("base64url");
  if (!file.deviceMid || !file.devicePassword) {
    // 只在生成凭据时落盘，且保留文件里的 url/enabled 原值（env 只影响本次运行）。
    const nextFile: RemoteOfficialRelayFileConfig = { ...file, deviceMid, devicePassword };
    try {
      const path = getOfficialRelayConfigFilePath();
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, `${JSON.stringify(nextFile, null, 2)}\n`, "utf8");
    } catch (error) {
      logger?.warn("官方中继配置写入失败，凭据仅在本次会话内有效", error);
    }
  }
  return { url, deviceMid, devicePassword };
}

/** 与 §14.2 官方算法逐字对应（relay-official.mjs 同款）。 */
function calculateProof(key: string, nonce: string, role: string, sid: string): string {
  return createHmac("sha256", key).update(`${nonce}|${role}|${sid}`).digest("base64url");
}

/** 日志纪律（§14.8）：sid 只允许出现后 6 位。 */
function sidLogFields(deviceSid: string | null): {
  hasDeviceSid: boolean;
  deviceSidSuffix: string | null;
} {
  return {
    hasDeviceSid: Boolean(deviceSid),
    deviceSidSuffix: deviceSid ? deviceSid.slice(-6) : null,
  };
}

export function createRemoteOfficialDeviceClient(
  options: RemoteOfficialDeviceClientOptions,
): RemoteOfficialDeviceClient {
  const logger = options.logger;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const authTimeoutMs = options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const httpOrigin = options.url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
  // passHash 现算不落盘（§14.8：可从 password 推导，少存一份高价值派生物）。
  const passHash = createHash("sha256").update(options.devicePassword).digest("base64");

  let socket: WebSocket | null = null;
  let deviceSid: string | null = null;
  let state: "idle" | "connecting" | "registering" | "authenticating" | "paired" = "idle";
  let pairStatus: OfficialPairStatus | null = null;
  let linkFetched = false;
  let stopped = true;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let authTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHeartbeatAckAt = 0;

  function send(message: Record<string, unknown>): void {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  function clearTimers(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (authTimer) {
      clearTimeout(authTimer);
      authTimer = null;
    }
  }

  function setState(next: typeof state): void {
    if (state !== next) {
      state = next;
      logger?.debug?.(`官方中继状态：${next}`, sidLogFields(deviceSid));
    }
  }

  function scheduleReconnect(reason: string): void {
    if (stopped || reconnectTimer) return;
    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    // 先记日志再清 sid：断线原因里带上旧 sid 后缀便于对账。
    logger?.warn(`官方中继将在 ${delay}ms 后重连（${reason}）`, sidLogFields(deviceSid));
    deviceSid = null;
    pairStatus = null;
    linkFetched = false;
    setState("idle");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  /**
   * 取配对链接（自建扩展的鉴权端点，spec §14.8）。
   * 重新注册后 linkFetched 已复位，会用新 sid 重新取。
   */
  async function fetchLink(): Promise<void> {
    if (!deviceSid || linkFetched) return;
    const proof = calculateProof(passHash, "link", "device", deviceSid);
    try {
      const response = await fetchImpl(
        `${httpOrigin}/api/remote-control/link?sid=${encodeURIComponent(deviceSid)}`,
        { headers: { authorization: `Bearer ${proof}` } },
      );
      if (!response.ok) {
        logger?.warn("官方中继配对链接获取失败", { status: response.status, ...sidLogFields(deviceSid) });
        return;
      }
      const body = (await response.json()) as { link?: unknown };
      if (typeof body.link !== "string" || !body.link) {
        logger?.warn("官方中继配对链接响应缺少 link 字段", sidLogFields(deviceSid));
        return;
      }
      linkFetched = true;
      logger?.info("已取得官方远控配对链接", sidLogFields(deviceSid));
      options.onLink?.(body.link);
    } catch (error) {
      logger?.warn("官方中继配对链接获取异常", error);
    }
  }

  function handlePairStatus(status: unknown): void {
    if (status !== "waiting" && status !== "matched") return;
    // auth_ack / pair_status_ack 会重复投递（§14.7 细节 2）：都算心跳证据。
    if (authTimer) {
      clearTimeout(authTimer);
      authTimer = null;
    }
    lastHeartbeatAckAt = Date.now();
    if (state === "authenticating") setState("paired");
    if (status === pairStatus) return;
    pairStatus = status;
    logger?.info(`官方远控配对状态：${status}`, sidLogFields(deviceSid));
    options.onPairStatus?.(status);
    if (status === "matched") void fetchLink();
  }

  function handleMessage(raw: unknown): void {
    let msg: { type?: unknown; [key: string]: unknown };
    try {
      msg = JSON.parse(String(raw));
    } catch {
      logger?.warn("官方中继消息不是合法 JSON，忽略");
      return;
    }
    switch (msg.type) {
      case "device_register_ack": {
        const sid = typeof msg.device_sid === "string" ? msg.device_sid : "";
        if (!sid) {
          logger?.warn("官方中继注册响应缺少 device_sid");
          socket?.close();
          return;
        }
        deviceSid = sid;
        lastHeartbeatAckAt = Date.now();
        send({
          type: "auth_init",
          role: "device",
          device_sid: sid,
          ...(options.meta ? { meta: options.meta } : {}),
          client_ts: Date.now(),
        });
        return;
      }
      case "auth_challenge": {
        if (!deviceSid || typeof msg.nonce !== "string") return;
        setState("authenticating");
        send({
          type: "auth_response",
          device_sid: deviceSid,
          proof: calculateProof(passHash, msg.nonce, "device", deviceSid),
          client_ts: Date.now(),
        });
        authTimer = setTimeout(() => {
          logger?.warn("官方中继鉴权超时，主动重连", sidLogFields(deviceSid));
          socket?.close();
        }, authTimeoutMs);
        return;
      }
      // 官方客户端把两者放同一个 case（§14.7 细节 2），这里同样处理。
      case "auth_ack":
      case "pair_status_ack": {
        handlePairStatus(msg.pair_status);
        return;
      }
      case "error": {
        logger?.warn(`官方中继错误 ${String(msg.code ?? "unknown")}`, sidLogFields(deviceSid));
        socket?.close();
        return;
      }
      case "data": {
        // 数据面（spec §14.9）：交给分派器；未接线时留痕丢弃，不静默吞。
        const payload = msg.payload;
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          if (options.onData) {
            options.onData(payload as Record<string, unknown>);
          } else {
            logger?.debug?.("收到数据面信封（未接分派器，丢弃）", {
              zcode_type: (payload as { zcode_type?: unknown }).zcode_type ?? null,
            });
          }
        } else {
          logger?.warn("收到非法数据面信封（payload 不是对象）");
        }
        return;
      }
      default:
        return;
    }
  }

  function startHeartbeat(): void {
    lastHeartbeatAckAt = Date.now();
    heartbeatTimer = setInterval(() => {
      send({ type: "pair_status_query", device_sid: deviceSid ?? "", client_ts: Date.now() });
      if (Date.now() - lastHeartbeatAckAt > heartbeatIntervalMs * HEARTBEAT_ACK_TOLERANCE_FACTOR) {
        logger?.warn("官方中继心跳超时，主动重连", sidLogFields(deviceSid));
        socket?.close();
      }
    }, heartbeatIntervalMs + Math.floor(Math.random() * 1_000));
  }

  function connect(): void {
    if (stopped) return;
    setState("connecting");
    const ws = new WebSocket(`${options.url}/ws?mid=${encodeURIComponent(options.deviceMid)}`);
    socket = ws;
    ws.on("open", () => {
      if (socket !== ws) return;
      setState("registering");
      send({
        type: "device_register_init",
        device_mid: options.deviceMid,
        pass_hash: passHash,
        meta: options.meta ?? {},
        client_ts: Date.now(),
      });
      startHeartbeat();
    });
    ws.on("message", (raw) => {
      if (socket !== ws) return;
      handleMessage(raw);
    });
    // error 之后必有 close，统一在 close 里收尾。
    ws.on("error", () => {});
    ws.on("close", () => {
      if (socket !== ws) return;
      socket = null;
      clearTimers();
      scheduleReconnect("连接断开");
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      void connect();
    },
    sendData(payload: Record<string, unknown>): boolean {
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
      send({ type: "data", payload });
      return true;
    },
    stop() {
      stopped = true;
      clearTimers();
      try {
        socket?.close();
      } catch {
        /* 忽略：socket 可能已死 */
      }
      socket = null;
      deviceSid = null;
      pairStatus = null;
      linkFetched = false;
      setState("idle");
    },
    getStatus() {
      return { state, deviceSid, pairStatus };
    },
  };
}
