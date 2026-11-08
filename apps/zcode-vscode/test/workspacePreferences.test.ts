/**
 * T12：指令/会话参数面板的设置写读与一次性导入幂等（P1-13/P1-16.1）。
 *
 * - 指令/语言/删除保护：services setting 频道既有字段（AppSettings）的读写投影；
 * - 附加目录：plat 读面（getWorkspaceSettings）+ 写面（updateAdditionalDirectories
 *   host 归一化 ≤256）的双端形状；
 * - 「从 CLAUDE.md/GODE.md 一次性导入」：幂等映射（重复导入不重复拼接）；
 * - T08 同源面：MCP CRUD 纯模型 + 「本次会话允许」pending permission 投影
 *   （sessionAllowlistRule 同口径）+ getWorkspaceSettings 白名单回归。
 *
 * 纯层测试：workspacePreferences.ts / mcpServersModel.ts 纯函数。
 */

import { describe, expect, it } from "vitest";
import { PLATFORM_METHOD_WHITELIST } from "../src/host/platformRpcHandler";
import {
  buildInstructionsPatch,
  buildDeleteProtectionPatch,
  instructionImportMarker,
  mapInstructionImport,
  normalizeAdditionalDirectoriesInput,
  projectInstructionsForm,
  projectSessionParamsForm,
} from "../src/webview-react/settings/workspacePreferences";
import {
  MCP_SERVERS_LIMIT,
  MCP_SESSION_REBUILD_HINT,
  appendServer,
  fromEditableServer,
  normalizeServersForSettings,
  normalizeWorkspaceSettingsSnapshot,
  projectPendingPermissions,
  removeServerAt,
  statusLabel,
  summarizeStatuses,
  toEditableServer,
  updateServerAt,
} from "../src/webview-react/settings/mcpServersModel";

// ── 自定义指令 / 回复语言（setting 频道字段投影） ──

describe("instructions form（AppSettings.customSystemPrompt/language 投影）", () => {
  it("读取：缺省字段回落空串（空提示词 = 恢复内置默认语义）", () => {
    expect(projectInstructionsForm(undefined)).toEqual({ customSystemPrompt: "", language: "" });
    expect(projectInstructionsForm({ customSystemPrompt: "团队规范", language: "zh-CN" })).toEqual({
      customSystemPrompt: "团队规范",
      language: "zh-CN",
    });
  });

  it("写回 patch：只携带面板字段；语言 trim；空串即恢复默认", () => {
    expect(buildInstructionsPatch({ customSystemPrompt: "", language: " zh-CN " })).toEqual({
      customSystemPrompt: "",
      language: "zh-CN",
    });
  });
});

// ── 一次性导入（CLAUDE.md/GODE.md → customSystemPrompt） ──

const importFiles = [
  {
    folder: "/repo",
    name: "GODE.md",
    path: "/repo/GODE.md",
    content: "使用 pnpm；测试统一 vitest。",
    sizeBytes: 24,
    truncated: false,
  },
  {
    folder: "/repo",
    name: "CLAUDE.md",
    path: "/repo/CLAUDE.md",
    content: "遗留规则",
    sizeBytes: 700 * 1024,
    truncated: true,
  },
];

describe("mapInstructionImport（P1-13.2 一次性拷贝 + 幂等）", () => {
  it("首次导入：节段带幂等标记拼到既有提示词之后；截断文件给 warning", () => {
    const outcome = mapInstructionImport(importFiles, "既有提示词");
    expect(outcome.imported).toEqual(["/repo/GODE.md", "/repo/CLAUDE.md"]);
    expect(outcome.promptDraft.startsWith("既有提示词\n\n<!-- zcodium:imported-instruction:/repo/GODE.md -->")).toBe(true);
    expect(outcome.promptDraft).toContain("使用 pnpm；测试统一 vitest。");
    expect(outcome.warnings[0]).toContain("/repo/CLAUDE.md");
    expect(outcome.skipped).toEqual([]);
  });

  it("幂等：重复导入同文件 → 跳过，不重复拼接（重复点击无副作用）", () => {
    const first = mapInstructionImport(importFiles, "");
    const second = mapInstructionImport(importFiles, first.promptDraft);
    expect(second.imported).toEqual([]);
    expect(second.skipped).toEqual(["/repo/GODE.md", "/repo/CLAUDE.md"]);
    expect(second.promptDraft).toBe(first.promptDraft);
    const firstFile = importFiles[0];
    expect(firstFile).toBeDefined();
    expect(second.promptDraft.split(instructionImportMarker(firstFile!))).toHaveLength(2);
  });

  it("空文件集 → 草稿不变（面板给「未找到 GODE.md/CLAUDE.md」语义）", () => {
    const outcome = mapInstructionImport([], "keep");
    expect(outcome).toEqual({ promptDraft: "keep", imported: [], skipped: [], warnings: [] });
  });
});

// ── 会话参数（附加目录 / 删除保护） ──

describe("session params（P1-16.1）", () => {
  it("附加目录：去空白/去空/去重，≤256 截断（与 host normalize 同口径）", () => {
    expect(normalizeAdditionalDirectoriesInput([" /a ", "", "/a", "/b"])).toEqual(["/a", "/b"]);
    const many = Array.from({ length: 300 }, (_, i) => `/d${i}`);
    expect(normalizeAdditionalDirectoriesInput(many)).toHaveLength(256);
  });

  it("删除保护：缺省开启兼容（AppSettings 缺失按开启）；阈值缺省 50、非法回落", () => {
    expect(projectSessionParamsForm(undefined)).toEqual({
      additionalDirectories: [],
      deleteProtectionEnabled: true,
      batchDeleteApprovalThreshold: 50,
    });
    expect(buildDeleteProtectionPatch({ deleteProtectionEnabled: false, batchDeleteApprovalThreshold: 0.4 })).toEqual({
      deleteProtectionEnabled: false,
      batchDeleteApprovalThreshold: 50,
    });
    expect(buildDeleteProtectionPatch({ deleteProtectionEnabled: true, batchDeleteApprovalThreshold: 12 })).toEqual({
      deleteProtectionEnabled: true,
      batchDeleteApprovalThreshold: 12,
    });
  });

  it("plat 读面快照归一化：缺字段防御（旧 host 兼容）", () => {
    expect(normalizeWorkspaceSettingsSnapshot(undefined)).toEqual({
      mcpServers: [],
      toolAllowlist: [],
      toolDenylist: [],
      additionalDirectories: [],
      mode: "build",
      rawModel: "",
    });
    expect(
      normalizeWorkspaceSettingsSnapshot({
        mcpServers: [{ name: "x" }],
        toolAllowlist: ["Bash", 3],
        additionalDirectories: ["/a"],
        mode: "plan",
        rawModel: "zai/glm-4.6",
      }),
    ).toEqual({
      mcpServers: [{ name: "x" }],
      toolAllowlist: ["Bash"],
      toolDenylist: [],
      additionalDirectories: ["/a"],
      mode: "plan",
      rawModel: "zai/glm-4.6",
    });
  });
});

// ── T08 同源面：MCP CRUD 纯模型 + 会话允许写回投影 ──

describe("MCP servers CRUD（P1-8.1 settings 形状）", () => {
  it("stdio/http 往返：形态字段互斥（stdio 无 type/url；http 无 command/args）", () => {
    const stdio = toEditableServer({ name: "fs", command: "npx", args: ["-y", "fs-mcp"] });
    expect(stdio).toMatchObject({ transport: "stdio", commandOrUrl: "npx", args: ["-y", "fs-mcp"] });
    expect(fromEditableServer(stdio)).toEqual({
      name: "fs",
      command: "npx",
      args: ["-y", "fs-mcp"],
      env: [],
    });

    const http = toEditableServer({ name: "web", type: "http", url: "https://mcp.example" });
    expect(http).toMatchObject({ transport: "http", commandOrUrl: "https://mcp.example" });
    expect(fromEditableServer(http)).toEqual({
      name: "web",
      type: "http",
      url: "https://mcp.example",
      headers: [],
    });
  });

  it("写回归一化：丢弃空名/空命令行；上限截断", () => {
    const servers = [
      { name: "ok", transport: "stdio" as const, commandOrUrl: "cmd", args: [] },
      { name: "", transport: "stdio" as const, commandOrUrl: "cmd", args: [] },
      { name: "nourl", transport: "http" as const, commandOrUrl: "", args: [] },
    ];
    expect(normalizeServersForSettings(servers)).toHaveLength(1);
    const overflow = Array.from({ length: MCP_SERVERS_LIMIT + 5 }, (_, i) => ({
      name: `s${i}`,
      transport: "stdio" as const,
      commandOrUrl: "cmd",
      args: [],
    }));
    expect(normalizeServersForSettings(overflow)).toHaveLength(MCP_SERVERS_LIMIT);
  });

  it("CRUD：追加/更新/删除按下标", () => {
    const one = appendServer([]);
    expect(one).toHaveLength(1);
    const updated = updateServerAt(one, 0, { name: "x" });
    expect(updated[0]?.name).toBe("x");
    expect(removeServerAt(updated, 0)).toHaveLength(0);
  });
});

describe("MCP 状态投影（P1-8.2 mcp/list）", () => {
  it("summarize + 状态文案", () => {
    const statuses = {
      a: { status: "connected", transport: "stdio", toolCount: 3 },
      b: { status: "failed", transport: "http", toolCount: 0, error: "timeout" },
    };
    const summary = summarizeStatuses(statuses);
    expect(summary.connected).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.summary).toBe("● 1 connected / 1 failed");
    const statusA = statuses.a;
    const statusB = statuses.b;
    expect(statusA).toBeDefined();
    expect(statusB).toBeDefined();
    expect(statusLabel(statusA!)).toBe("已连接（工具 3）");
    expect(statusLabel(statusB!)).toBe("失败：timeout");
    expect(statusLabel({ status: "connecting", transport: "stdio", toolCount: 0 })).toBe("连接中");
  });

  it("降级提示一字不差呈现（PRD P1-8.3 口径）", () => {
    expect(MCP_SESSION_REBUILD_HINT).toBe("MCP 运行中不可动态增删，改动后需重建会话生效");
  });
});

describe("「本次会话允许」pending permission 投影（P0-8 写回面）", () => {
  it("permission 条目 → Tool/Tool(args) 规则；非 permission 忽略", () => {
    const summaries = projectPendingPermissions([
      {
        interactionId: "int-1",
        payload: {
          kind: "permission",
          toolName: "Bash",
          summary: "执行命令 npm test",
          detail: { command: "npm test" },
          options: [{ optionId: "allow", kind: "allowAlways", label: "本次会话允许" }],
        },
      },
      { interactionId: "int-2", payload: { kind: "userInput", prompt: "?" } },
      {
        interactionId: "int-3",
        payload: { kind: "permission", toolName: "Read", summary: "读文件", detail: { path: "/a" } },
      },
    ]);
    expect(summaries).toHaveLength(2);
    const [permissionWithCommand, permissionWithOnlyTool] = summaries;
    expect(permissionWithCommand).toMatchObject({
      interactionId: "int-1",
      toolName: "Bash",
      allowlistRule: "Bash(npm test)",
      hasSessionAllowOption: true,
    });
    expect(permissionWithOnlyTool?.allowlistRule).toBe("Read(/a)");
    expect(permissionWithOnlyTool?.hasSessionAllowOption).toBe(false);
  });
});

describe("host plat 读面（T08/T12 面板 CRUD 的 R）", () => {
  it("getWorkspaceSettings 在白名单内（写方法之外的最小读面）", () => {
    expect(PLATFORM_METHOD_WHITELIST).toContain("getWorkspaceSettings");
    expect(PLATFORM_METHOD_WHITELIST).toContain("updateMcpServers");
    expect(PLATFORM_METHOD_WHITELIST).toContain("updatePermissionRules");
    expect(PLATFORM_METHOD_WHITELIST).toContain("appendSessionAllowlist");
    expect(PLATFORM_METHOD_WHITELIST).toContain("updateAdditionalDirectories");
    expect(PLATFORM_METHOD_WHITELIST).toContain("importWorkspaceInstructions");
  });
});
