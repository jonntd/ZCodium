/**
 * T11：Claude 会话导入的检测引导与导入映射（P1-12 / P1-10.2 / P1-15）。
 *
 * - isDesktop 门（H7，vscodePlatformService.ts:40 `isDesktop = true`）不满足时
 *   导入面降级为「仅桌面可用」引导；
 * - 检测/扫描/导入全部发生在扩展宿主进程（services zcode-task 频道）——§9 核实项 4
 *   的证据：IZCodeTaskService 的 `scanImportableClaudeSessions` /
 *   `importClaudeSessions` 就是 ~/.claude/projects 扫描与导入的服务面（编译期断言）；
 * - 子代理面板投影（P1-15）：snapshot.subagents 运行态 + listSessionSubagents
 *   ended 查询的可读化。
 *
 * 纯层测试：onboarding.ts / subagentsModel.ts 纯函数 + 接口形状编译期断言。
 */

import { describe, expect, it, vi } from "vitest";
import type { ZCodeImportableSessionCandidate, ZCodeImportSessionsResult } from "@zcode/shared";
import type { IZCodeTaskService } from "@zcode/services";
import {
  CLAUDE_DETECTED_GUIDANCE,
  CLAUDE_DESKTOP_ONLY_GUIDANCE,
  CLAUDE_NOT_DETECTED_GUIDANCE,
  buildImportRequest,
  formatCandidateRows,
  mapImportResult,
  projectClaudeImportSupport,
} from "../src/webview-react/import/onboarding";
import {
  projectEndedSubagents,
  projectSubagentProjection,
  subagentStatusLabel,
} from "../src/webview-react/subagents/subagentsModel";

// ── §9 核实项 4 证据：importSessions 所在频道 = zcode-task（编译期形状断言） ──

it("IZCodeTaskService 携带 ~/.claude 扫描/导入服务面（scanImportableClaudeSessions / importClaudeSessions）", () => {
  // 编译期断言：两个方法存在于 zcode-task 频道接口（桌面与插件共用同一实现，
  // 扫描行为一致性由 @zcode/services 单一实现保证——插件侧无平行实现）。
  const evidence: Pick<IZCodeTaskService, "scanImportableClaudeSessions" | "importClaudeSessions"> =
    {
      scanImportableClaudeSessions: vi.fn(),
      importClaudeSessions: vi.fn(),
    };
  expect(evidence.scanImportableClaudeSessions).toBeTypeOf("function");
  expect(evidence.importClaudeSessions).toBeTypeOf("function");
});

// ── 检测引导态 ──

describe("projectClaudeImportSupport（isDesktop 门 + 扫描结果 → 引导态）", () => {
  it("非桌面（isDesktop=false/缺省）→ 拦截 + 仅桌面引导", () => {
    for (const isDesktop of [false, undefined]) {
      const support = projectClaudeImportSupport({ isDesktop });
      expect(support.supported).toBe(false);
      expect(support.reason).toBe("desktopOnly");
      expect(support.guidance).toBe(CLAUDE_DESKTOP_ONLY_GUIDANCE);
    }
  });

  it("桌面 + 尚未扫描 → 引导文案为空（面板静默等待扫描）", () => {
    const support = projectClaudeImportSupport({ isDesktop: true });
    expect(support.supported).toBe(true);
    expect(support.scanned).toBe(false);
    expect(support.guidance).toBe("");
  });

  it("桌面 + 扫描空结果 → 「未检测到」引导（P1-10.2 检测提示）", () => {
    const support = projectClaudeImportSupport({ isDesktop: true, candidates: [] });
    expect(support.scanned).toBe(true);
    expect(support.detected).toBe(false);
    expect(support.guidance).toBe(CLAUDE_NOT_DETECTED_GUIDANCE);
  });

  it("桌面 + 有候选 → 「检测到可导入」", () => {
    const support = projectClaudeImportSupport({
      isDesktop: true,
      candidates: [candidate({ sessionId: "s1" })],
    });
    expect(support.detected).toBe(true);
    expect(support.guidance).toBe(CLAUDE_DETECTED_GUIDANCE);
  });

  it("扫描错误 → 可读错误引导（不静默）", () => {
    const support = projectClaudeImportSupport({
      isDesktop: true,
      candidates: null,
      scanError: "EACCES: ~/.claude",
    });
    expect(support.scanError).toBe("EACCES: ~/.claude");
    expect(support.guidance).toContain("EACCES: ~/.claude");
  });
});

function candidate(partial: Partial<ZCodeImportableSessionCandidate>): ZCodeImportableSessionCandidate {
  return {
    provider: "claude",
    sessionId: "s1",
    workspacePath: "/repo",
    sourcePath: "/home/u/.claude/projects/repo/s1.jsonl",
    updatedAt: 1_000,
    ...partial,
  };
}

// ── 候选行与导入映射 ──

describe("formatCandidateRows（P1-12.1 标题+时间+workspace 归属）", () => {
  it("按最近活动倒序；标题缺省回退 sessionId", () => {
    const rows = formatCandidateRows([
      candidate({ sessionId: "old", updatedAt: 100 }),
      candidate({ sessionId: "new", updatedAt: 900, previewTitle: "修复登录" }),
    ]);
    expect(rows.map((row) => row.sessionId)).toEqual(["new", "old"]);
    const [first, second] = rows;
    expect(first?.title).toBe("修复登录");
    expect(second?.title).toBe("old");
    expect(first?.workspacePath).toBe("/repo");
    expect(first?.sourcePath).toContain(".claude/projects");
  });
});

describe("buildImportRequest（importClaudeSessions 入参）", () => {
  it("带选中项；workspacePath 仅在有值时携带", () => {
    expect(buildImportRequest({ sessionIds: ["a", "b"], workspacePath: "/repo" })).toEqual({
      sessionIds: ["a", "b"],
      workspacePath: "/repo",
    });
    expect(buildImportRequest({ sessionIds: ["a"], workspacePath: null })).toEqual({
      sessionIds: ["a"],
    });
  });
});

describe("mapImportResult（P1-12.2/12.3 打开新会话 + 可读错误）", () => {
  const result: ZCodeImportSessionsResult = {
    imported: [
      { provider: "claude", sessionId: "src-1", taskId: "task-1", workspacePath: "/repo" },
      { provider: "claude", sessionId: "src-2", taskId: "task-2", workspacePath: "/repo" },
    ],
    skipped: [{ provider: "claude", sessionId: "src-3", reason: "空会话" }],
    failed: [{ provider: "claude", sessionId: "src-4", reason: "jsonl 解析失败" }],
  };

  it("导入成功 → 打开目标 = 首个导入会话；汇总可读", () => {
    const outcome = mapImportResult(result);
    expect(outcome.openSessionId).toBe("src-1");
    expect(outcome.importedSessionIds).toEqual(["src-1", "src-2"]);
    expect(outcome.summary).toBe("成功导入 2 个会话；跳过 1 个；失败 1 个");
    expect(outcome.issues).toEqual([
      "导入失败 src-4：jsonl 解析失败",
      "已跳过 src-3：空会话",
    ]);
  });

  it("全失败 → 无打开目标", () => {
    const outcome = mapImportResult({
      imported: [],
      skipped: [],
      failed: [{ provider: "claude", sessionId: "x", reason: "boom" }],
    });
    expect(outcome.openSessionId).toBeNull();
    expect(outcome.issues).toEqual(["导入失败 x：boom"]);
  });

  it("null（未执行导入）→ 空结果", () => {
    expect(mapImportResult(null)).toEqual({
      importedSessionIds: [],
      openSessionId: null,
      summary: "",
      issues: [],
    });
  });
});

// ── 子代理面板投影（P1-15） ──

describe("subagentsModel（P1-15 运行/结束投影）", () => {
  it("snapshot.subagents → running 行 + endedTotal；缺字段 = 空投影", () => {
    const projection = projectSubagentProjection({
      revision: 3,
      childSessionIds: ["c1"],
      running: [
        {
          childSessionId: "c1",
          subagentType: "Explore",
          title: "查找调用点",
          status: "running",
        },
        { childSessionId: "c2", title: "等待审批", status: "waiting" },
      ],
      endedTotal: 4,
    });
    expect(projection.running).toHaveLength(2);
    expect(projection.running[0]).toMatchObject({
      childSessionId: "c1",
      title: "查找调用点",
      status: "running",
    });
    expect(projection.endedTotal).toBe(4);
    expect(projectSubagentProjection(undefined)).toEqual({ running: [], endedTotal: 0 });
  });

  it("listSessionSubagents 的 result.ended.items → 可读行（终态映射）", () => {
    const rows = projectEndedSubagents({
      revision: 1,
      childSessionIds: [],
      running: [],
      ended: {
        total: 2,
        items: [
          { childSessionId: "c1", title: "子任务A", status: "success" },
          { childSessionId: "c2", status: "failed" },
        ],
        nextCursor: undefined,
      },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ sessionId: "c1", title: "子任务A", statusLabel: "已结束" });
    expect(rows[1]).toMatchObject({ sessionId: "c2", statusLabel: "失败" });
  });

  it("状态文案覆盖 running/waiting/blocked/ended 四态（P1-15）", () => {
    expect(subagentStatusLabel("running")).toBe("运行中");
    expect(subagentStatusLabel("waiting")).toBe("等待中");
    expect(subagentStatusLabel("blocked")).toBe("被阻塞");
    expect(subagentStatusLabel("success")).toBe("已结束");
  });
});
