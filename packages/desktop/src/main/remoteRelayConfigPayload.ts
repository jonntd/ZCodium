/**
 * `remoteRelaySetConfig` 请求的纯解析/校验。
 *
 * 独立成模块的原因有两个：
 * 1. 它必须可单测 —— 这里曾经漏掉一次真实的数据损坏：preload 把请求签名写成
 *    `(config, apply)` 并再次包一层，而契约是**单个请求对象**，于是保存时把
 *    `{ config, apply }` 整个当成 config 写进了配置文件，App 重启后读不到 url、直接掉线。
 * 2. 它不能依赖 electron（IPC 模块有 `ipcMain` 值导入，纯 Node 测试里无法加载）。
 *
 * 因此这里做**白名单**校验：出现未知字段（尤其是嵌套的 `config`）一律拒绝并报错，
 * 让签名不匹配这类错误在写入之前就失败，而不是静默写坏配置。
 */
import {
  decodeRelayChannelKey,
  type RemoteRelayFileConfig,
  type RemoteRelayPreviewShareUrlsRequest,
  type RemoteRelaySetConfigRequest,
  type RemoteRelayShareLinkRequest,
} from "@zcode/shared";

/** 允许写入配置文件的字段（与 `RemoteRelayFileConfig` 对齐；v6 起 hostSecret/pairingToken/slotBase 移除）。 */
const ALLOWED_CONFIG_KEYS = new Set([
  "url",
  "roomKey",
  "publicUrl",
  "workspace",
  "windowId",
  "autoStart",
  "e2ee",
  "channelKey",
  "slots",
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** 未提供或空串都视为「未设置」：允许清空可选字段，而不是报格式错误。 */
function isBlank(value: unknown): boolean {
  return value === undefined || (typeof value === "string" && value.trim() === "");
}

/** 校验并归一化 `remoteRelaySetConfig` 的 payload；不合法时抛出带原因的错误。 */
export function parseRemoteRelaySetConfigRequest(payload: unknown): RemoteRelaySetConfigRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("请求体必须是对象");
  }
  const { config, apply } = payload as { config?: unknown; apply?: unknown };
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("config 必须是对象");
  }
  const c = config as Record<string, unknown>;

  // 白名单第一：请求信封被当成 config 传进来时（嵌套 config）会在这里被挡住。
  const unknownKeys = Object.keys(c).filter((key) => !ALLOWED_CONFIG_KEYS.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(`config 含未知字段：${unknownKeys.join(", ")}`);
  }

  // null 归一化为「未设置」并剔除（2026-11-03 回归修复）：外部工具/手工编辑写出的
  // 配置文件可能带 `"publicUrl": null`，而 UI 轮询会把 fileConfig 原样带回
  // setConfig 请求 —— 不剔除的话，一次合法的「清空该字段」意图会在字段校验里炸成
  // 「publicUrl 必须以 http:// 或 https:// 开头」，主开关从此拨不动（实测踩中）。
  // 在入口统一剔除后，写回的文件不再含 null，round-trip 收敛为「键缺席 = 未设置」，
  // 与 RemoteRelayFileConfig 的可选字段语义一致。
  const v = Object.fromEntries(
    Object.entries(c).filter(([, value]) => value !== null),
  ) as Record<string, unknown>;

  // 空字符串表示「未设置/恢复默认」（清空公开地址=按中继地址推导、清空工作区=跟随窗口），
  // 因此只在**非空**时校验格式。历史上这里把空串当非法，导致这些字段根本清不掉。
  if (!isBlank(v.url) && !(typeof v.url === "string" && /^wss?:\/\//i.test(v.url.trim()))) {
    throw new Error("url 必须以 ws:// 或 wss:// 开头");
  }
  if (!isBlank(v.roomKey) && typeof v.roomKey !== "string") {
    throw new Error("roomKey 必须是字符串");
  }
  if (!isBlank(v.workspace) && typeof v.workspace !== "string") {
    throw new Error("workspace 必须是字符串");
  }
  if (
    v.windowId !== undefined &&
    (typeof v.windowId !== "number" || !Number.isInteger(v.windowId) || v.windowId <= 0)
  ) {
    throw new Error("windowId 必须是正整数");
  }
  if (v.autoStart !== undefined && typeof v.autoStart !== "boolean") {
    throw new Error("autoStart 必须是布尔值");
  }
  if (
    !isBlank(v.publicUrl) &&
    !(typeof v.publicUrl === "string" && /^https?:\/\//i.test(v.publicUrl.trim()))
  ) {
    throw new Error("publicUrl 必须以 http:// 或 https:// 开头");
  }
  if (v.e2ee !== undefined && typeof v.e2ee !== "boolean") {
    throw new Error("e2ee 必须是布尔值");
  }
  // 并发客户端槽位数（spec §17）：1..8，上不封顶会打爆 Host attachment 与中继连接。
  if (v.slots !== undefined) {
    if (
      typeof v.slots !== "number" ||
      !Number.isInteger(v.slots) ||
      v.slots < 1 ||
      v.slots > 8
    ) {
      throw new Error("slots 必须是 1..8 的整数");
    }
  }
  // 非空时必须是合法的 32B base64url：把 typo 在写入前拦住（否则 client 拨出时才失败）。
  if (!isBlank(v.channelKey)) {
    try {
      decodeRelayChannelKey(v.channelKey as string);
    } catch (error) {
      throw new Error(`channelKey 不合法：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { config: v as RemoteRelayFileConfig, apply: apply !== false };
}

/**
 * `remoteRelayGetShareLink` 请求的解析（spec §18）：null/缺省 = 永久 legacy token 链接。
 * 与配置解析同模块同理由：必须可单测、不依赖 electron、越界在进 Main 前拦住。
 */
export function parseRemoteRelayShareLinkRequest(payload: unknown): RemoteRelayShareLinkRequest {
  if (payload == null) return {};
  if (typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload 必须是对象");
  }
  const { ttlSeconds } = payload as { ttlSeconds?: unknown };
  if (ttlSeconds === undefined || ttlSeconds === null) return {};
  if (typeof ttlSeconds !== "number" || !Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("ttlSeconds 必须是正数或 null");
  }
  return { ttlSeconds };
}

/**
 * `remoteRelayPreviewShareUrls` 请求的解析（spec §21）。与配置解析同模块同理由：
 * 必须可单测、不依赖 electron；非法地址在进 Main 前拦住（推导函数假定输入已是
 * `ws(s)://` 完整地址，预览 handler 不做第二次容错）。
 */
export function parseRemoteRelayPreviewShareUrlsRequest(
  payload: unknown,
): RemoteRelayPreviewShareUrlsRequest {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload 必须是对象");
  }
  const { relayUrl } = payload as { relayUrl?: unknown };
  if (typeof relayUrl !== "string" || !/^wss?:\/\//i.test(relayUrl.trim())) {
    throw new Error("relayUrl 必须以 ws:// 或 wss:// 开头");
  }
  return { relayUrl: relayUrl.trim() };
}

/**
 * 兼容修复：把历史上被写坏的 `{ config: {...}, apply }` 信封还原成扁平配置。
 *
 * 只认「有嵌套 config 对象、且自身没有 url」的形状；正常文件原样返回。
 */
export function unwrapLegacyRemoteRelayConfigFile(parsed: unknown): {
  config: RemoteRelayFileConfig;
  recovered: boolean;
} {
  const value = parsed as Record<string, unknown> | null;
  const nested = value?.config;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    nested &&
    typeof nested === "object" &&
    !Array.isArray(nested) &&
    !isNonEmptyString(value.url)
  ) {
    return { config: nested as RemoteRelayFileConfig, recovered: true };
  }
  return { config: (value ?? {}) as RemoteRelayFileConfig, recovered: false };
}
