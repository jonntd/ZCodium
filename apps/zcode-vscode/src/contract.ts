/**
 * zcode-vscode 对外契约（架构治理唯一出口）。
 *
 * v0.2.0 增量（P1）：深度绑定内部模块的 VS Code 宿主——
 * 协议契约唯一所有者回归 @zcode/shared（手工同步 types.ts 已删除），
 * 传输/Agent 服务复用 @zcode/services，Webview 复用 @zcode/ui。
 * 模块外部（含未来复用方）只允许从这里 import。
 */

// ── 通信桥（host 侧） ──
export { HostRuntime } from "./host/hostRuntime";
export {
  HostBridgeProtocol,
  type WebviewSender,
} from "./host/hostBridgeProtocol";
export {
  PlatformRpcHandler,
  PLATFORM_METHOD_WHITELIST,
  type PlatformMethodHandler,
} from "./host/platformRpcHandler";
export {
  HostSettingsBridge,
  normalizeSettingsSnapshot,
  normalizeToolRules,
  normalizeAdditionalDirectories,
  parseModelSelection as parseBridgeModelSelection,
  type HostSettingsSnapshot,
} from "./host/hostSettingsBridge";

// ── 服务装配 ──
export {
  createPluginServices,
  createExposurePolicy,
  DEFAULT_EXPOSED_CHANNELS,
  builtinProviderConfigPath,
  type PluginServiceAssembly,
  type PluginServiceAssemblyOptions,
} from "./host/serviceAssembly";

// ── 薄编排 ──
export { RuntimeController } from "./runtimeController";

// ── Webview 侧（桥 shim + 平台服务） ──
export {
  WebviewMessagePortLike,
  sendClientContext,
  WEBVIEW_CLIENT_CONTEXT,
} from "./webview-react/bridge/webviewMessagePort";
export { PlatformRpcClient } from "./webview-react/bridge/platformRpcClient";
export { HostFrameBus } from "./webview-react/bridge/hostFrames";
export { VscodePlatformService } from "./webview-react/platform/vscodePlatformService";
export { createConversationTransport } from "./webview-react/session/conversationTransportFactory";

// ── 桥 wire（共享帧协议） ──
export {
  bytesToBase64,
  base64ToBytes,
  parseBridgeEnvelope,
  rpcFrame,
  type BridgeEnvelope,
  type HostFrame,
  type HostFrameKind,
} from "./bridge/wire";

// ── 内核（无 vscode 依赖，可独立测试） ──
export { ApprovalService, isDangerousCommand, allowlistKey } from "./approvals/approvalService";
export type { ApprovalChoice, ApprovalRequest, ApprovalUpdate } from "./approvals/approvalService";
export type { SessionIdStore } from "./store";
export { ExtensionStore } from "./store";

// ── 平台 UI（vscode 层，不作为 headless API 消费面） ──
// UI 类经 contract-ui.ts 出口（依赖运行时 vscode API，会拉起 vscode 模块图，
// 破坏本门面「无 vscode 依赖、可 headless 测试」的契约）。
export { CliLocator } from "./cli/cliLocator";
export type { CliInfo } from "./cli/cliLocator";
export type { ZcodiumUiState } from "./ui/statusBar";

// ── 错误码 ──
export {
  EXTENSION_ERROR_CODES,
  ExtensionProtocolError,
  EXTENSION_ERROR_MESSAGES,
  JSON_RPC_ERROR_CODES,
} from "./errors";
