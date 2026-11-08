/**
 * 桥 wire 协议（架构 §2.2 唯一自定义 wire）。
 *
 * Webview postMessage（JSON 序列化）与 extension host 之间共用的帧类型与编解码。
 * 纯模块：不 import vscode / DOM，host 侧与 webview 侧（含 vitest）共用。
 *
 * - `rpc`/`flow`：@zcode/rpc VSBuffer（base64）↔ Uint8Array 后进 MessagePortProtocol /
 *   ChannelServer；该类对非 Uint8Array 消息天然丢弃，`t` 字段隔离充分。
 * - `plat-*`：VscodePlatformService ↔ PlatformRpcHandler 小 RPC；host 端方法白名单校验。
 * - `host`：主题/locale/workspace/可见性推送。
 */

/** webview → host 的 RPC 二进制帧（base64 编码的 VSBuffer）。 */
export interface RpcFrame {
  t: "rpc";
  /** VSBuffer 字节的 base64。 */
  b64: string;
}

/** MessagePort 流控透传帧（saturated/drained）。 */
export interface FlowFrame {
  t: "flow";
  state: "saturated" | "drained";
}

export interface PlatformRequestFrame {
  t: "plat-req";
  id: number;
  method: string;
  args: unknown[];
}

export type PlatformResponseFrame =
  | { t: "plat-res"; id: number; ok: true; value: unknown }
  | { t: "plat-res"; id: number; ok: false; error: string };

export interface PlatformEventFrame {
  t: "plat-evt";
  event: string;
  payload: unknown;
}

/**
 * host 帧型全集（T02/⑤ + M1 编辑器功能：帧协议集中定义）。
 *
 * **唯一定义处**：联合类型由本数组派生，`parseBridgeEnvelope` 的 host 分支也直接按
 * 本数组判定。此前这条规则被抄成三份（wire 的联合、wire 守卫里 12 条 `||`、
 * hostFrameKinds 的联合 + 数组），新增帧型漏改任何一处的结果都是**帧被静默丢弃**
 * （guard 返回 null，webview 收不到且无人报错）——与「当前页判定抄两份」同型缺陷。
 * theme/locale/workspace/visibility 为既有面；diagnostics/restart/open-panel 为
 * v0.2.0 新增（诊断下发、进程换代横幅、面板打开指令）；composer-insert/session-switch
 * 为 M1 编辑器功能新增（编辑器命令 → 对话 composer 预填 / 历史会话切换）；
 * capabilities 为 T07 capabilities 横切新增（agent 就绪后的能力面投影数据）；
 * workspace-sidebar-visible 为侧栏显隐偏好回推（多页签同步，见 hostRuntime）。
 * 载荷形状见 src/host/hostFrameKinds.ts（唯一 host 侧定义处）。
 */
export const HOST_FRAME_KINDS = [
  "theme",
  "locale",
  "workspace",
  "visibility",
  "diagnostics",
  "restart",
  "open-panel",
  "composer-insert",
  "session-switch",
  "full-ui-url",
  "capabilities",
  "session-tabs",
  "workspace-sidebar-visible",
] as const;

export type HostFrameKind = (typeof HOST_FRAME_KINDS)[number];

export interface HostFrame {
  t: "host";
  kind: HostFrameKind;
  payload: unknown;
}

export type BridgeEnvelope =
  | RpcFrame
  | FlowFrame
  | PlatformRequestFrame
  | PlatformResponseFrame
  | PlatformEventFrame
  | HostFrame;

// ---------------------------------------------------------------------------
// base64 ↔ bytes（webview 无 Buffer，用 btoa/atob；node 测试走 Buffer 快路径）
// ---------------------------------------------------------------------------

/** 字节 → base64。webview（browser）与 node 双端可用。 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
    return Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ).toString("base64");
  }
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 → 字节。webview（browser）与 node 双端可用。 */
export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined" && typeof Buffer.from === "function") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// 帧守卫（两侧 schema 校验的最小面：防 webview 侧任意注入非桥帧）
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 判定并收窄一条 postMessage 数据为桥帧；非法帧返回 null（调用方丢弃并告警）。 */
export function parseBridgeEnvelope(data: unknown): BridgeEnvelope | null {
  if (!isRecord(data)) return null;
  switch (data["t"]) {
    case "rpc":
      return typeof data["b64"] === "string"
        ? (data as unknown as RpcFrame)
        : null;
    case "flow":
      return data["state"] === "saturated" || data["state"] === "drained"
        ? (data as unknown as FlowFrame)
        : null;
    case "plat-req":
      return typeof data["id"] === "number" &&
        typeof data["method"] === "string" &&
        Array.isArray(data["args"])
        ? (data as unknown as PlatformRequestFrame)
        : null;
    case "plat-res":
      return typeof data["id"] === "number" &&
        (data["ok"] === true || data["ok"] === false)
        ? (data as unknown as PlatformResponseFrame)
        : null;
    case "plat-evt":
      return typeof data["event"] === "string"
        ? (data as unknown as PlatformEventFrame)
        : null;
    case "host": {
      const kind = data["kind"];
      // 按 HOST_FRAME_KINDS 判定（单一来源）：手写 `||` 链每次新增帧型都要同步，
      // 漏一处就是"帧发得出去、webview 一律丢弃"的静默故障。
      return typeof kind === "string" &&
        (HOST_FRAME_KINDS as readonly string[]).includes(kind)
        ? (data as unknown as HostFrame)
        : null;
    }
    default:
      return null;
  }
}

/** 构造 rpc 帧。 */
export function rpcFrame(bytes: Uint8Array): RpcFrame {
  return { t: "rpc", b64: bytesToBase64(bytes) };
}
