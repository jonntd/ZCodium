import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// 2026-11-22 re-baseline：新建会话按钮随显示层对齐迁入 WorkspaceSidebarItem（每行 tab
// 一级），WorkspaceNewTaskTooltip 包装组件在新位置重建为 NewThreadTooltip（同契约：
// 正常状态不渲染 tooltip，仅只读状态展示禁用原因）。显示层对齐曾把本修复带回退
// （title={readOnlyReason ?? "新建会话"}），本守卫继续锁死契约。
describe("workspace sidebar new task tooltip", () => {
  it("正常状态不显示重复提示，仅只读状态展示禁用原因", async () => {
    const source = await readFile(
      new URL("../src/WorkspaceSidebarItem.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("if (!disabledReason) return children;");
    expect(source).toContain("<NewThreadTooltip disabledReason={readOnlyReason}>");
    expect(source).not.toMatch(
      /readOnlyReason \?\?\s*\n\s*intl\.formatMessage\(\{ id: "taskList\.newThread" \}/,
    );
  });
});
