/**
 * 「新建会话（+）」目标面回归（用户反馈 2026-11-08：「我点加号为什么会创建出一个
 * TAB 窗口？」）。
 *
 * 事故现场（Gode 输出通道日志）：
 *   15:22:56 webview 已连接：gode.chat              ← 用户人在侧栏
 *   15:22:59 新建对话页签：gode.chat.editor
 *            （reason=reveal:无存活页签，存活=0）     ← 点 + 却开了个编辑器 TAB
 *
 * 成因：侧栏标题栏的 +（view/title）与标签行的 +（editor/title）绑定同一条命令，
 * 而该命令只认编辑器页签 —— 侧栏那一面永远轮不到。
 *
 * 本测试锁死判定口径（含"绝不无中生有建页签"这条）：
 * 1. 有编辑器页签 → 投编辑器，不建新页；
 * 2. 只剩侧栏 → 投侧栏，**不建页签**（这就是本 bug 的修复点）；
 * 3. 一个对话面都没有 → 才建草稿页签。
 */
import { describe, expect, it } from "vitest";

import { resolveNewSessionTarget } from "../src/features/newSessionTarget";

const SIDEBAR = "gode.chat";

describe("新建会话的投递目标面", () => {
  it("有存活编辑器页签：投编辑器这一页（不去动侧栏）", () => {
    expect(
      resolveNewSessionTarget({
        editorConnectionId: "gode.chat.editor.2",
        sidebarOnline: true,
        sidebarConnectionId: SIDEBAR,
      }),
    ).toEqual({ surface: "editor", connectionId: "gode.chat.editor.2" });
  });

  it("只剩侧栏一面：投侧栏，绝不新建编辑器页签（本 bug 的修复点）", () => {
    const target = resolveNewSessionTarget({
      editorConnectionId: null,
      sidebarOnline: true,
      sidebarConnectionId: SIDEBAR,
    });
    expect(target).toEqual({ surface: "sidebar", connectionId: SIDEBAR });
    // 没有 create 这一支 → 不可能出现"点 + 多出一个 TAB"
    expect(target.surface).not.toBe("create");
  });

  it("一个对话面都没有：才建草稿页签（首次使用 / 页签被关光）", () => {
    expect(
      resolveNewSessionTarget({
        editorConnectionId: null,
        sidebarOnline: false,
        sidebarConnectionId: SIDEBAR,
      }),
    ).toEqual({ surface: "create" });
  });

  it("侧栏 id 来自调用方（不复制字面量，视图改名不会漂移）", () => {
    const target = resolveNewSessionTarget({
      editorConnectionId: null,
      sidebarOnline: true,
      sidebarConnectionId: "gode.chat.renamed",
    });
    expect(target).toEqual({ surface: "sidebar", connectionId: "gode.chat.renamed" });
  });

  it("编辑器页签优先于侧栏（两者并存时点标签行的 + 不会清侧栏会话）", () => {
    const target = resolveNewSessionTarget({
      editorConnectionId: "gode.chat.editor",
      sidebarOnline: true,
      sidebarConnectionId: SIDEBAR,
    });
    expect(target.surface).toBe("editor");
  });
});
