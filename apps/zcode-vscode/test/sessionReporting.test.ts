/**
 * 会话归属上报迁移决策面回归（spec: composer-insert-delivery「落点 key」规则
 * 2026-11-22 修订 + vscode-pending-changes §6 绑定 folder 口径修订）。
 *
 * 事故：App 层上报读 bootstrap folder——面板页签切到别的工作区后，那里创建的会话
 * 被记到 bootstrap folder 名下（恢复键污染 + pending-changes 错绑），且可见工作区
 * 内的会话删除不可见（漏报）。决策面锁死四条迁移语义：
 * 1. 挂载基线不报（host 已按恢复键 setActiveSession）；
 * 2. 同工作区 activeTaskId 迁移 → created / deleted（删除须经判定面确认）；
 * 3. 切页签不是删除——旧会话恢复键保持；新页签有会话则重报归属；
 * 4. created.folder 用原始 folder 路径（host 按 folderKey(folder) 归一，identity 场景 key ≠ path）。
 */
import { describe, expect, it } from "vitest";
import {
  resolveSessionReportAction,
  type SessionReportAnchor,
} from "../src/webview-react/sessionReporting";

const A = "/w/claude-code";
const B = "/Volumes/date/download/zcode-patcher";

function anchor(
  workspaceKey: string,
  folderPath: string,
  taskId: string | null,
): SessionReportAnchor {
  return { workspaceKey, folderPath, taskId };
}

describe("resolveSessionReportAction（会话归属迁移语义）", () => {
  it("挂载基线：不报（host 已按恢复键写活跃会话）", () => {
    expect(
      resolveSessionReportAction(null, anchor(A, A, "task-1"), () => true),
    ).toEqual({ kind: "none" });
  });

  it("同工作区 null→会话：created，folder 为原始路径", () => {
    expect(
      resolveSessionReportAction(anchor(A, A, null), anchor(A, A, "task-1"), () => true),
    ).toEqual({ kind: "created", folder: A, sessionId: "task-1" });
  });

  it("同工作区会话→另一会话：created（幂等重报归属）", () => {
    expect(
      resolveSessionReportAction(
        anchor(A, A, "task-1"),
        anchor(A, A, "task-2"),
        () => true,
      ),
    ).toEqual({ kind: "created", folder: A, sessionId: "task-2" });
  });

  it("同工作区会话→null 且判定面确认已删：deleted", () => {
    expect(
      resolveSessionReportAction(
        anchor(A, A, "task-1"),
        anchor(A, A, null),
        () => true,
      ),
    ).toEqual({ kind: "deleted", sessionId: "task-1" });
  });

  it("同工作区会话→null 但判定面否定（回草稿/新建）：不报删除", () => {
    expect(
      resolveSessionReportAction(
        anchor(A, A, "task-1"),
        anchor(A, A, null),
        () => false,
      ),
    ).toEqual({ kind: "none" });
  });

  it("切页签（本 bug 现场）：旧会话不报删除，新页签有会话则重报归属到新 folder", () => {
    expect(
      resolveSessionReportAction(
        anchor(A, A, "task-1"),
        anchor(B, B, "task-2"),
        () => true,
      ),
    ).toEqual({ kind: "created", folder: B, sessionId: "task-2" });
  });

  it("切页签到无会话页签：不报任何动作（旧会话恢复键保持）", () => {
    expect(
      resolveSessionReportAction(
        anchor(A, A, "task-1"),
        anchor(B, B, null),
        () => true,
      ),
    ).toEqual({ kind: "none" });
  });

  it("identity 归一化 key 相等视为同工作区（远程 key ≠ path 也不误判切页签）", () => {
    expect(
      resolveSessionReportAction(
        anchor("ssh://dev/w", "/local/mirror", "task-1"),
        anchor("ssh://dev/w", "/local/mirror", "task-1"),
        () => true,
      ),
    ).toEqual({ kind: "none" });
  });
});
