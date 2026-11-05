/**
 * T02/② settings 桥参数面与写回归一化（P1-3.2 / P1-6.3 / P0-8 写回面）：
 *
 * - resume/create 恒带 allowlist/denylist/mcpServers/附加目录（恢复不绕过约束）；
 * - 每次 spawn 的工具面旗标快照与 --allowed-tools/--disallowed-tools argv 形状；
 * - 「本次会话允许」规则形（Tool/Tool(args)）与 allowlist 写回归一化（去空白/去重）。
 *
 * 纯层测试：HostSettingsBridge / approvalService 纯函数均不感知 vscode。
 */

import { describe, expect, it } from "vitest";
import {
  HostSettingsBridge,
  ZCODE_AGENT_SERVER_BASE_ARGS,
  buildToolRuleFlags,
  mergeAllowlistRules,
  normalizeSettingsSnapshot,
  resolveZcodeAgentSpawnCommand,
  type HostSettingsSnapshot,
} from "../src/host/hostSettingsBridge";
import { sessionAllowlistRule } from "../src/approvals/approvalService";

/** 可变快照源：模拟 settings 变更（每次 resolve 重新读取）。 */
function mutableBridge(initial: Partial<HostSettingsSnapshot>): {
  bridge: HostSettingsBridge;
  setSnapshot(next: Partial<HostSettingsSnapshot>): void;
} {
  let current: Partial<HostSettingsSnapshot> = initial;
  const bridge = new HostSettingsBridge(() => normalizeSettingsSnapshot(current));
  return {
    bridge,
    setSnapshot(next) {
      current = next;
    },
  };
}

describe("resume 恒带约束面（P1-3.2 / P1-6.3）", () => {
  it("resume 恒带 allowlist/denylist/mcpServers/附加目录 + workspacePath", () => {
    const { bridge } = mutableBridge({
      toolAllowlist: ["Bash(git status:*)"],
      toolDenylist: ["Bash(rm -rf:*)"],
      mcpServers: [{ type: "stdio", command: "mcp-server-file" }],
      additionalDirectories: ["/tmp/a"],
    });
    const params = bridge.resolveResumeParams("s-1", "/repo");
    expect(params.sessionId).toBe("s-1");
    expect(params.workspacePath).toBe("/repo");
    expect(params.toolAllowlist).toEqual(["Bash(git status:*)"]);
    expect(params.toolDenylist).toEqual(["Bash(rm -rf:*)"]);
    expect(params.mcpServers).toEqual([{ type: "stdio", command: "mcp-server-file" }]);
    expect(params.additionalDirectories).toEqual(["/tmp/a"]);
  });

  it("settings 全空时 resume 仍恒带（空数组在场，不缺省）", () => {
    const { bridge } = mutableBridge({});
    const params = bridge.resolveResumeParams("s-2", "/repo");
    expect(params.toolAllowlist).toEqual([]);
    expect(params.toolDenylist).toEqual([]);
    expect(params.mcpServers).toEqual([]);
    expect(params.additionalDirectories).toEqual([]);
  });

  it("settings 变更后 resume 沿用新快照（换代自动恢复不绕过约束）", () => {
    const { bridge, setSnapshot } = mutableBridge({ toolDenylist: ["Bash(old:*)"] });
    expect(bridge.resolveResumeParams("s-1", "/repo").toolDenylist).toEqual(["Bash(old:*)"]);
    setSnapshot({ toolDenylist: ["Bash(new:*)"], toolAllowlist: ["Read"] });
    const next = bridge.resolveResumeParams("s-1", "/repo");
    expect(next.toolDenylist).toEqual(["Bash(new:*)"]);
    expect(next.toolAllowlist).toEqual(["Read"]);
  });

  it("create 参数带 workspacePath（协议目标面）与完整会话参数", () => {
    const { bridge } = mutableBridge({
      toolAllowlist: ["Read"],
      mcpServers: [{ name: "files" }],
      additionalDirectories: ["/tmp/b"],
      mode: "plan",
      rawModel: "zai/glm-5",
    });
    const params = bridge.resolveCreateParams("/repo");
    expect(params.workspacePath).toBe("/repo");
    expect(params.workspace).toEqual({ path: "/repo" });
    expect(params.config.mode).toBe("plan");
    expect(params.config.modelSelection).toEqual({ providerId: "zai", modelId: "glm-5" });
  });
});

describe("spawn 工具面旗标注入点（P1-3：settings 变更 = 下次 spawn 生效）", () => {
  it("resolveSpawnToolFlags 每次调用读新快照", () => {
    const { bridge, setSnapshot } = mutableBridge({ toolAllowlist: ["Read"] });
    expect(bridge.resolveSpawnToolFlags()).toEqual({ toolAllowlist: ["Read"], toolDenylist: [] });
    setSnapshot({ toolDenylist: ["Bash(rm -rf:*)"] });
    expect(bridge.resolveSpawnToolFlags()).toEqual({ toolAllowlist: [], toolDenylist: ["Bash(rm -rf:*)"] });
  });

  it("buildToolRuleFlags：非空面编译为旗标对，空面不注入", () => {
    expect(
      buildToolRuleFlags({ toolAllowlist: ["Read", "Bash(git status:*)"], toolDenylist: ["Bash(rm -rf:*)"] }),
    ).toEqual(["--allowed-tools", "Read,Bash(git status:*)", "--disallowed-tools", "Bash(rm -rf:*)"]);
    expect(buildToolRuleFlags({ toolAllowlist: [], toolDenylist: [] })).toEqual([]);
    expect(buildToolRuleFlags({ toolAllowlist: ["WebFetch"], toolDenylist: [] })).toEqual([
      "--allowed-tools",
      "WebFetch",
    ]);
  });

  it("resolveZcodeAgentSpawnCommand：resolver 产物自带 app-server 协议服务模式基底 argv", () => {
    // services 进程管理对 resolver 产物 args 原样使用、不做合并——裸旗标会让进程
    // 永远进不了 app-server 模式（与桌面默认 resolver 的基底一致）。
    expect(ZCODE_AGENT_SERVER_BASE_ARGS).toEqual(["app-server", "--stdio"]);
    expect(resolveZcodeAgentSpawnCommand("/usr/local/bin/zcodium", { toolAllowlist: [], toolDenylist: [] })).toEqual({
      command: "/usr/local/bin/zcodium",
      args: ["app-server", "--stdio"],
    });
    expect(
      resolveZcodeAgentSpawnCommand("/usr/local/bin/zcodium", {
        toolAllowlist: ["Read"],
        toolDenylist: ["Bash(rm -rf:*)"],
      }),
    ).toEqual({
      command: "/usr/local/bin/zcodium",
      args: [
        "app-server",
        "--stdio",
        "--allowed-tools",
        "Read",
        "--disallowed-tools",
        "Bash(rm -rf:*)",
      ],
    });
  });
});

describe("「本次会话允许」写回（P0-8 写回面）", () => {
  it("sessionAllowlistRule：命令/路径 → Tool(args)，无目标 → Tool", () => {
    expect(sessionAllowlistRule("bash", { command: "npm test" })).toBe("bash(npm test)");
    expect(sessionAllowlistRule("edit_file", { path: "/repo/a.ts" })).toBe("edit_file(/repo/a.ts)");
    expect(sessionAllowlistRule("read_file", { file_path: "/repo/b.ts" })).toBe(
      "read_file(/repo/b.ts)",
    );
    expect(sessionAllowlistRule("web_fetch", { url: "https://x" })).toBe("web_fetch");
  });

  it("mergeAllowlistRules：归一化 + 去重（与既有 settings 合并）", () => {
    expect(
      mergeAllowlistRules(["Bash(git status:*)", "  ", 42], ["Bash(git status:*)", "Read"]),
    ).toEqual(["Bash(git status:*)", "Read"]);
  });

  it("resume 恒带断言（与写回面同源：写回后的规则随 resume 携带）", () => {
    const existing = ["Bash(git status:*)"];
    const merged = mergeAllowlistRules(existing, [sessionAllowlistRule("bash", { command: "ls -la" })]);
    const { bridge } = mutableBridge({ toolAllowlist: merged });
    expect(bridge.resolveResumeParams("s-1", "/repo").toolAllowlist).toEqual([
      "Bash(git status:*)",
      "bash(ls -la)",
    ]);
  });
});
