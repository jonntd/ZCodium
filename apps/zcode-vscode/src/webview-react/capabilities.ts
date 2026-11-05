/**
 * 能力声明 → UI 显隐投影（T07；P1-10.3「当前 CLI 版本不支持」标注）。
 *
 * 数据源 = v4 hello.capabilities（agentV4ConnectionHandshake 收敛的 HelloMessage）；
 * 能力面缺失（旧 CLI / 握手未达）整体降级为不可用 + 汇总提示，不做部分猜测。
 * 纯投影：vitest 直测，UI 组件按投影布尔值显隐入口。
 */

/** v4 hello.capabilities 的投影子面（helloMessageSchema capabilities 字段同形子集）。 */
export interface RuntimeCapabilityFlags {
  /** 原生对话框（桌面 shell 专用；VS Code webview 场景恒 false → 入口隐藏）。 */
  nativeDialogs: boolean;
  /** 本机终端面板。 */
  localTerminal: boolean;
  /** 二进制帧传输（false → base64 文本帧退化链路）。 */
  binaryFrames: boolean;
  /** 压缩协商（none 之外的值表示链路已压缩）。 */
  compression: string;
}

export interface CapabilityUiProjection {
  /** 终端入口显隐。 */
  showTerminalEntry: boolean;
  /** 原生对话框入口显隐。 */
  showNativeDialogEntry: boolean;
  /** 二进制帧缺失时的链路降级提示（null = 无需提示）。 */
  binaryFrameHint: string | null;
  /** 能力面整体缺失（hello 未达/旧 CLI）的降级提示（P1-10.3）。 */
  unsupportedHint: string | null;
}

export const CAPABILITY_UNSUPPORTED_HINT = "当前 CLI 版本不支持";
export const CAPABILITY_BINARY_FRAME_HINT = "当前链路不支持二进制帧，传输已退化为 base64 文本帧";

/**
 * hello.capabilities → UI 显隐投影。
 * - capabilities 缺失（null/undefined）：全部入口隐藏 + unsupportedHint（不做部分猜测）；
 * - flags 在场：按位投影；binaryFrames=false 给出链路降级提示。
 */
export function projectCapabilities(
  capabilities: RuntimeCapabilityFlags | null | undefined,
): CapabilityUiProjection {
  if (!capabilities) {
    return {
      showTerminalEntry: false,
      showNativeDialogEntry: false,
      binaryFrameHint: null,
      unsupportedHint: CAPABILITY_UNSUPPORTED_HINT,
    };
  }
  return {
    showTerminalEntry: capabilities.localTerminal === true,
    showNativeDialogEntry: capabilities.nativeDialogs === true,
    binaryFrameHint: capabilities.binaryFrames === true ? null : CAPABILITY_BINARY_FRAME_HINT,
    unsupportedHint: null,
  };
}

/**
 * 从 v4 hello 载荷收敛投影面（handshake 侧调用；形状不合法按整体缺失降级，不抛错）。
 */
export function capabilitiesFromHello(hello: unknown): RuntimeCapabilityFlags | null {
  if (typeof hello !== "object" || hello === null) return null;
  const capabilities = (hello as { capabilities?: unknown }).capabilities;
  if (typeof capabilities !== "object" || capabilities === null) return null;
  const record = capabilities as Record<string, unknown>;
  if (typeof record["nativeDialogs"] !== "boolean" || typeof record["localTerminal"] !== "boolean") {
    return null;
  }
  return {
    nativeDialogs: record["nativeDialogs"],
    localTerminal: record["localTerminal"],
    binaryFrames: record["binaryFrames"] === true,
    compression: typeof record["compression"] === "string" ? record["compression"] : "none",
  };
}
