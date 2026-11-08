/**
 * 错误码表（原 zcodeProtocol/errorCodes.ts 迁移；协议类型唯一所有者回归 @zcode/shared，
 * 插件侧错误码与 UI 呈现语义保留在此）。
 */

/** JSON-RPC 2.0 标准保留错误码。 */
export const JSON_RPC_ERROR_CODES = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** 插件侧错误码（1xxx 段，仅插件内部 UI 呈现用，不上 wire）。 */
export const EXTENSION_ERROR_CODES = {
  E_CLI_NOT_FOUND: 1001,
  E_PROTOCOL_VERSION_MISMATCH: 1002,
  E_PROTOCOL_PARSE: 1003,
  E_REQUEST_TIMEOUT: 1004,
  E_SESSION_CRASHED: 1005,
  E_PERMISSION_UNKNOWN_REQUEST: 1006,
  E_TRANSPORT_CLOSED: 1007,
  E_SERVICES_ASSEMBLY_FAILED: 1008,
} as const;

/** 用户可读的插件侧错误信息（中文，供 UI 呈现）。 */
export const EXTENSION_ERROR_MESSAGES: Record<number, string> = {
  [EXTENSION_ERROR_CODES.E_CLI_NOT_FOUND]:
    "未找到 zcodium CLI。请安装后重试，或在设置中配置 gode.cliPath。",
  [EXTENSION_ERROR_CODES.E_PROTOCOL_VERSION_MISMATCH]:
    "ZCode Protocol 版本不匹配，请升级 zcodium CLI 后重试。",
  [EXTENSION_ERROR_CODES.E_PROTOCOL_PARSE]:
    "Agent 返回了无法解析的协议帧，连接已关闭。",
  [EXTENSION_ERROR_CODES.E_REQUEST_TIMEOUT]: "Agent 请求超时（30s）。",
  [EXTENSION_ERROR_CODES.E_SESSION_CRASHED]:
    "Agent 进程异常退出，正在自动恢复。",
  [EXTENSION_ERROR_CODES.E_PERMISSION_UNKNOWN_REQUEST]:
    "收到未知审批请求（requestId 不在待审批列表）。",
  [EXTENSION_ERROR_CODES.E_TRANSPORT_CLOSED]: "与 Agent 的连接已关闭。",
  [EXTENSION_ERROR_CODES.E_SERVICES_ASSEMBLY_FAILED]:
    "Gode 服务装配失败，请查看诊断输出（Gode: 显示日志）。",
};

/**
 * -32601 / "Method not found" → 能力缺失识别（FR-A13 插件侧；services 侧契约见
 * packages/services/src/zcode-agent/zcodeAgent.ts:655-668）。
 *
 * 旧 CLI 未实现某方法时，`ZCodeProtocolClientError` 以 code=-32601 上抛并经 RPC 层
 * passthrough（channelServer.ts 的 code 白名单）透传到调用方；server dist 未重建时
 * 则抛无 code 的 "Method not found" 文本——两种形状都是能力缺失，调用方据此降级呈现
 * （P1-10.3「当前 CLI 版本不支持」），不得伪装成请求失败，services 内不做静默兜底。
 */
export function isCapabilityMissingError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    if (
      (error as { code?: unknown }).code === JSON_RPC_ERROR_CODES.methodNotFound
    )
      return true;
    const message = error instanceof Error ? error.message : undefined;
    return typeof message === "string" && message.includes("Method not found");
  }
  return typeof error === "string" && error.includes("Method not found");
}

/** 插件侧协议错误对象：携带 code 供 UI 分支判断。 */
export class ExtensionProtocolError extends Error {
  readonly code: number;

  constructor(code: number, message?: string) {
    super(
      message ?? EXTENSION_ERROR_MESSAGES[code] ?? `Gode 插件错误 ${code}`,
    );
    this.name = "ExtensionProtocolError";
    this.code = code;
  }
}
