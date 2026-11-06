/**
 * contract.example.ts — zcode-vscode 契约用法示例（架构治理产物四件套之一）。
 *
 * 面向「本模块之外的复用方 / 回归 harness」：全部示例只经 src/contract.ts 门面
 * 消费内核面（无 vscode 运行时依赖，可被 headless vitest 直接加载执行）。
 * 扩展宿主侧的装配入口见 src/extension.ts（policy 唯一登记入口）。
 */

import {
  allowlistKey,
  ApprovalService,
  base64ToBytes,
  bytesToBase64,
  CliLocator,
  EXTENSION_ERROR_CODES,
  ExtensionProtocolError,
  HostSettingsBridge,
  isDangerousCommand,
  parseBridgeEnvelope,
  rpcFrame,
  type HostSettingsSnapshot,
} from "./contract";

/** 示例 1：审批安全边界 —— 危险命令识别与会话 allowlist 键（approvals/ 内核面）。 */
export const exampleDangerousCommand = isDangerousCommand("rm -rf /");
export const exampleAllowlistKey = allowlistKey("Bash", { command: "git status" });

/**
 * 示例 2：审批服务实例。宿主侧经 PlatformRpcHandler.attach 注入应答/告警通道后，
 * interaction/requestPermission 反向请求由该服务分流（会话 allowlist 自动放行，
 * 其余登记 pending 并推送 UI 卡片）。
 */
export function createExampleApprovalService(): ApprovalService {
  return new ApprovalService();
}

/** 示例 3：CLI 定位（CliLocator 沿 PATH / 自定义路径解析 zcodium 可执行）。 */
export async function exampleLocateCli(customPath?: string) {
  return new CliLocator().locate(customPath);
}

/** 示例 4：桥 wire 帧 roundtrip —— rpc 帧（base64 VSBuffer）编码与白名单解码。 */
export function exampleRpcFrameRoundtrip(payload: Uint8Array) {
  const frame = rpcFrame(payload);
  const decoded = parseBridgeEnvelope(frame);
  if (!decoded || decoded.t !== "rpc") {
    throw new ExtensionProtocolError(
      EXTENSION_ERROR_CODES.E_PROTOCOL_PARSE,
      "示例 rpc 帧解码失败",
    );
  }
  return [...base64ToBytes(decoded.b64)];
}

/** 示例 5：code.* 设置 → create/resume 参数归一（HostSettingsBridge 消费面）。 */
export function exampleResolveSessionParams(snapshot: HostSettingsSnapshot) {
  const bridge = new HostSettingsBridge(() => snapshot);
  return {
    create: bridge.resolveCreateParams("/repo"),
    resume: bridge.resolveResumeParams("s1", "/repo"),
  };
}

/** 示例 4 的字节样本（Uint8Array → base64）。 */
export const exampleWireBytes = bytesToBase64(new Uint8Array([0, 1, 2, 250, 255]));
