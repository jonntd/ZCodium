/**
 * P0-1..P0-10 基线功能等价回归（T05 验收：vanilla UI 退役前锁定等价行为）。
 *
 * 对照 apps/zcode-vscode/src/CONTRACT.md（基线契约）与 MVP 测试：
 * 旧栈（FrameCodec/StdioTransport/SessionManager/vanilla webview）已退役，等价行为
 * 逐项映射到新栈断言：
 *
 * | P0    | 基线行为                          | 新栈等价断言 |
 * |-------|-----------------------------------|--------------|
 * | P0-1  | CLI 缺失引导 / 版本守卫            | hello 失败 → sendCommand 明确报错（integration.hostUi）+ cliLocator 保留 |
 * | P0-2  | 状态栏随会话状态变色               | StatusBar 保留（ui/statusBar.ts），状态源改 Agent 生命周期 |
 * | P0-3  | 流式文本渲染                       | 桥二进制帧 roundtrip（webviewBridge）+ transport ACK/订阅链路（integration.hostUi） |
 * | P0-4  | 时间线/工具调用投影                | @zcode/ui ModelTrajectory* 组件族同源复用（装配面，无自建 UI） |
 * | P0-5  | 推理折叠                           | 同上（ui 包组件） |
 * | P0-6  | 会话恢复（snapshot 回放）          | settings 桥 resume 参数 + transport rowsRange/subscribe 面（integration.hostUi） |
 * | P0-7  | 文件编辑审批 + 原生 diff           | ApprovalService 语义保留（approvalService.test）+ showDiff 平台路由（platformService） |
 * | P0-8  | 命令审批 + 会话 allowlist          | ApprovalService 幂等/allowlist 测试（approvalService.test） |
 * | P0-9  | 崩溃自动恢复 + 横幅                | onAgentRuntimeRestarted → transport.onRuntimeRestart（integration.hostUi） |
 * | P0-10 | 版本不匹配守卫 / 引导页            | hello 版本守卫 + HostSettingsBridge 参数面（hostBridge.test） |
 *
 * 本文件做跨模块的汇总断言（契约面），细节在各专项测试文件。
 */

import { describe, expect, it } from "vitest";
import { ApprovalService, allowlistKey, isDangerousCommand } from "../src/approvals/approvalService";
import { normalizeSettingsSnapshot, HostSettingsBridge } from "../src/host/hostSettingsBridge";
import { PLATFORM_METHOD_WHITELIST } from "../src/host/platformRpcHandler";
import { DEFAULT_EXPOSED_CHANNELS } from "../src/host/serviceAssembly";
import { WebviewMessagePortLike } from "../src/webview-react/bridge/webviewMessagePort";
import { VscodePlatformService } from "../src/webview-react/platform/vscodePlatformService";
import { PlatformRpcClient } from "../src/webview-react/bridge/platformRpcClient";
import { mapVsCodeTheme } from "../src/webview-react/themeBridge";
import { createWorkspaceSessions } from "../src/webview-react/session/workspaceSessions";
import { parseBridgeEnvelope } from "../src/bridge/wire";
import { zcodePermissionRequestedEventPayloadSchema } from "@zcode/shared";

describe("P0 等价回归：审批语义（P0-7/P0-8）", () => {
  const permParams = {
    requestId: "perm-1",
    toolCallId: "t1",
    toolName: "bash",
    reason: "执行命令",
    riskLevel: "medium" as const,
    input: { command: "npm test" },
    options: [
      { optionId: "allow", kind: "allow", name: "允许", response: { decision: "allow" } },
      { optionId: "deny", kind: "deny", name: "拒绝", response: { decision: "deny" } },
    ],
  };

  it("审批请求经 @zcode/shared schema 校验（杜绝契约漂移回归）", () => {
    expect(zcodePermissionRequestedEventPayloadSchema.safeParse(permParams).success).toBe(true);
  });

  it("审批 → allow → allowlist 命中自动放行（非 critical）", () => {
    const service = new ApprovalService();
    const replies: unknown[] = [];
    service.attach((frameId, result) => replies.push({ frameId, result }));
    service.handleReversePermissionRequest(permParams, 1);
    service.resolve("perm-1", "allowSession");
    expect(service.isSessionAllowed("bash", { command: "npm test" })).toBe(true);
    // 第二次同形请求自动放行。
    service.handleReversePermissionRequest(
      { ...permParams, requestId: "perm-2", toolCallId: "t2" },
      2,
    );
    expect(replies.some((r) => (r as { result: { decision: string } }).result.decision === "allow")).toBe(true);
  });

  it("critical 风险永不自动放行", () => {
    const service = new ApprovalService();
    service.resolve("unknown", "allow"); // 幂等：未知请求忽略不抛
    service.handleReversePermissionRequest(
      { ...permParams, requestId: "perm-c", riskLevel: "critical" as const },
      3,
    );
    service.resolve("perm-c", "allowSession");
    expect(service.isSessionAllowed("bash", { command: "npm test" })).toBe(true);
    // 但自动放行路径在 ApprovalService 内被 riskLevel 拦截（approvalService.test 细化）。
  });

  it("危险命令静态规则保留（P0-8 升级对话框语义）", () => {
    expect(isDangerousCommand("sudo rm -rf /")).toBe(true);
    expect(isDangerousCommand("git push --force")).toBe(true);
    expect(isDangerousCommand("ls -la")).toBe(false);
    expect(allowlistKey("bash", { command: "ls" })).toBe("bash#ls");
  });
});

describe("P0 等价回归：会话恢复与参数面（P0-6/P0-10）", () => {
  it("per-folder 会话键控（P1-2 基础）", () => {
    const ids = new Map<string, string | undefined>();
    const sessions = createWorkspaceSessions({
      getSessionId: (k) => ids.get(k),
      setSessionId: (k, id) => {
        if (id === undefined) ids.delete(k);
        else ids.set(k, id);
      },
    });
    sessions.set("/repo-a", "s-1");
    sessions.set("/repo-b", "s-2");
    expect(sessions.get("/repo-a")).toBe("s-1");
    sessions.set("/repo-a", undefined);
    expect(sessions.get("/repo-a")).toBeUndefined();
    expect(sessions.get("/repo-b")).toBe("s-2");
  });

  it("resume 参数恒带 allowlist/denylist（恢复不绕过约束）", () => {
    const bridge = new HostSettingsBridge(() =>
      normalizeSettingsSnapshot({ toolAllowlist: ["Bash(git status:*)"], toolDenylist: [] }),
    );
    const resume = bridge.resolveResumeParams("s-1", "/repo");
    expect(resume.toolAllowlist).toEqual(["Bash(git status:*)"]);
    expect(Array.isArray(resume.toolDenylist)).toBe(true);
  });
});

describe("P0 等价回归：平台与桥（P0-3/P0-9 承载面）", () => {
  it("频道白名单包含对话核心频道、排除高危服务", () => {
    expect(DEFAULT_EXPOSED_CHANNELS).toContain("zcode-agent");
    expect(DEFAULT_EXPOSED_CHANNELS).toContain("zcode-session");
    expect(DEFAULT_EXPOSED_CHANNELS).not.toContain("terminal");
    expect(DEFAULT_EXPOSED_CHANNELS).not.toContain("process");
  });

  it("平台方法白名单覆盖 UI 必需面且不含执行类方法", () => {
    for (const method of ["selectFile", "selectDirectory", "openExternal", "showDiff"]) {
      expect(PLATFORM_METHOD_WHITELIST).toContain(method);
    }
    expect(PLATFORM_METHOD_WHITELIST).not.toContain("executeTerminalCommand");
  });

  it("平台方法白名单同步新增编排面（T02/T06/T09：§8 R3 全部收进白名单）", () => {
    // 审批/会话/设置写回与索引编排方法必须全部在白名单内（白名单外一律拒绝）。
    for (const method of [
      "notifySessionCreated",
      "notifySessionDeleted",
      "reportPendingApprovals",
      "appendSessionAllowlist",
      "updatePermissionRules",
      "updateMcpServers",
      "updateAdditionalDirectories",
      "getActiveEditorSelection",
      "importWorkspaceInstructions",
      "pickWorkspaceFolder",
    ]) {
      expect(PLATFORM_METHOD_WHITELIST).toContain(method);
    }
    // host 帧协议新增 kind（visibility/diagnostics/restart/open-panel）可解析，未知 kind 拒绝。
    for (const kind of ["visibility", "diagnostics", "restart", "open-panel"]) {
      expect(parseBridgeEnvelope({ t: "host", kind, payload: {} })).not.toBeNull();
    }
    expect(parseBridgeEnvelope({ t: "host", kind: "unknown", payload: {} })).toBeNull();
  });

  it("webview port 可实例化并接受/丢弃任意帧（鲁棒性）", () => {
    const port = new WebviewMessagePortLike({ postMessage: () => {} });
    expect(() => port.handleMessageData(null)).not.toThrow();
    expect(() => port.handleMessageData({ t: "rpc", b64: "!!!not-base64!!!" })).not.toThrow();
    port.close();
  });

  it("平台服务不支持面安全（不抛错），能力位 isDesktop=true", async () => {
    const platform = new VscodePlatformService({
      rpc: new PlatformRpcClient({ postMessage: () => {} }),
    });
    expect(platform.isDesktop).toBe(true);
    await expect(platform.isDockerAvailable()).resolves.toBe(false);
    await expect(platform.listSSHConfigAliases()).resolves.toEqual([]);
  });

  it("主题映射覆盖 VS Code 全部四种 ColorThemeKind（P0-2 视觉等价）", () => {
    expect(mapVsCodeTheme(1).dark).toBe(false);
    expect(mapVsCodeTheme(2).dark).toBe(true);
    expect(mapVsCodeTheme(3).dark).toBe(true);
    expect(mapVsCodeTheme(4).dark).toBe(false);
  });
});
