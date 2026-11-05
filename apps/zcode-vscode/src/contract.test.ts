/**
 * 契约测试：验证 contract.ts 的公开导出真实可用，且契约面与文档三方一致
 * （src/CONTRACT.md re-export 清单 ↔ src/module.ts ↔ architecture-policy.yaml，T14）。
 */

import { describe, expect, it } from "vitest";
import * as contract from "./contract";
import { zcodeVscodeModule } from "./module";
import { bytesToBase64, base64ToBytes } from "./bridge/wire";

/**
 * CONTRACT.md「contract.ts 门面 re-export 清单」的运行时（值）导出。
 * 按 src/contract.ts 分组顺序书写（与 CONTRACT.md 同序）；断言时两侧排序比较。
 * 新增/删除 contract.ts 导出时：同步 CONTRACT.md 清单 + 此处清单（docs/contract-check.md §4）。
 */
const CONTRACT_REEXPORTS = [
  // 通信桥（host 侧）
  "HostRuntime",
  "HostBridgeProtocol",
  "PlatformRpcHandler",
  "PLATFORM_METHOD_WHITELIST",
  "HostSettingsBridge",
  "normalizeSettingsSnapshot",
  "normalizeToolRules",
  "normalizeAdditionalDirectories",
  "parseBridgeModelSelection",
  // 服务装配
  "createPluginServices",
  "createExposurePolicy",
  "DEFAULT_EXPOSED_CHANNELS",
  "builtinProviderConfigPath",
  // 薄编排
  "RuntimeController",
  // Webview 侧
  "WebviewMessagePortLike",
  "sendClientContext",
  "WEBVIEW_CLIENT_CONTEXT",
  "PlatformRpcClient",
  "HostFrameBus",
  "VscodePlatformService",
  "createConversationTransport",
  // 桥 wire
  "bytesToBase64",
  "base64ToBytes",
  "parseBridgeEnvelope",
  "rpcFrame",
  // 内核（无 vscode 依赖）
  "ApprovalService",
  "isDangerousCommand",
  "allowlistKey",
  "ExtensionStore",
  "CliLocator",
  // 错误码
  "EXTENSION_ERROR_CODES",
  "ExtensionProtocolError",
  "EXTENSION_ERROR_MESSAGES",
  "JSON_RPC_ERROR_CODES",
];

/**
 * CONTRACT.md「类型导出」清单的编译期守护（运行时不可断言，tsc 守护）：
 * 任一类型从 contract.ts 移除即在此处编译失败。
 */
export type ContractTypeExports = [
  contract.WebviewSender,
  contract.PlatformMethodHandler,
  contract.HostSettingsSnapshot,
  contract.PluginServiceAssembly,
  contract.PluginServiceAssemblyOptions,
  contract.BridgeEnvelope,
  contract.HostFrame,
  contract.HostFrameKind,
  contract.ApprovalChoice,
  contract.ApprovalRequest,
  contract.ApprovalUpdate,
  contract.SessionIdStore,
  contract.CliInfo,
  contract.ZcodiumUiState,
];

describe("zcode-vscode 公开契约", () => {
  it("模块清单与 architecture-policy 登记一致", () => {
    expect(zcodeVscodeModule.requires).toEqual(["shared", "services", "client", "ui", "rpc"]);
    expect(zcodeVscodeModule.publicEntrypoints).toEqual(["extension.ts"]);
  });

  it("contract.ts 运行时 re-export 清单与 CONTRACT.md 一致", () => {
    expect([...Object.keys(contract)].sort()).toEqual([...CONTRACT_REEXPORTS].sort());
  });

  it("内核类可实例化（无 vscode 依赖）", () => {
    expect(new contract.ApprovalService()).toBeInstanceOf(contract.ApprovalService);
    expect(new contract.CliLocator()).toBeInstanceOf(contract.CliLocator);
  });

  it("桥 wire 编解码 roundtrip", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const decoded = base64ToBytes(bytesToBase64(bytes));
    expect([...decoded]).toEqual([...bytes]);
    expect(contract.parseBridgeEnvelope({ t: "rpc", b64: bytesToBase64(bytes) })).not.toBeNull();
    expect(contract.parseBridgeEnvelope({ t: "evil" })).toBeNull();
  });

  it("HostSettingsBridge 归一化与 resume 约束可从契约入口使用", () => {
    const bridge = new contract.HostSettingsBridge(() => ({
      toolAllowlist: ["  Bash(git status)  ", "", 42 as unknown as string],
      toolDenylist: ["rm -rf /"],
      mcpServers: [{ type: "stdio", command: "mcp-server" }],
      additionalDirectories: ["/a", "/a", "/b"],
      mode: "plan",
      rawModel: "zai/glm-5",
    }));
    const create = bridge.resolveCreateParams("/repo");
    expect(create.toolAllowlist).toEqual(["Bash(git status)"]);
    expect(create.config.mode).toBe("plan");
    expect(create.config.modelSelection).toEqual({ providerId: "zai", modelId: "glm-5" });
    expect(create.additionalDirectories).toEqual(["/a", "/b"]);
    // P1-3.2：resume 必须带 allowlist/denylist。
    const resume = bridge.resolveResumeParams("s1", "/repo");
    expect(resume.sessionId).toBe("s1");
    expect(resume.toolAllowlist).toEqual(["Bash(git status)"]);
    expect(resume.toolDenylist).toEqual(["rm -rf /"]);
  });
});
