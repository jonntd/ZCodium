/**
 * 「加入对话上下文」落面回归（用户反馈 2026-11-19：右键 Gode → 加入对话上下文，
 * 弹出的是新窗口，而非把内容送进当前激活的对话面）。
 *
 * 事故现场（与 2026-11-08「点加号创建出一个 TAB」同一类缺陷）：
 *   composer-insert 帧本身已由 pushToActiveHostFrame 投给最近活动对话页（侧栏），
 *   但 createCodeActionEntry 的 submit/addContext 在推帧后**无条件**执行
 *   gode.openChat —— 用户只开着侧栏面时，openChat 的 reveal() 因"无存活编辑器
 *   页签"而 create() 一个新页签，表现为凭空弹出新窗口、内容没送到眼前的面。
 *
 * 本测试锁死口径（createCodeActionEntry.revealChatWhenMissing）：
 * 1. 已有对话面（hasChatSurface=true）→ 只推帧，**绝不执行 gode.openChat**；
 * 2. 一个对话面都没有 → 推帧 + 执行 gode.openChat（帧在 pending 队列等新开
 *    webview ready 后 flush，此时 openChat 是必要路径）；
 * 3. 帧载荷语义不变：addContext 单帧批量 mention（prepend-if-missing），
 *    submit 指令 + mention 前缀（replace）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeCommand } = vi.hoisted(() => ({ executeCommand: vi.fn() }));
// editorCommands 顶层拉起 quickEdit/git/terminal/history/logger，全部只在函数内
// 触 vscode API；logger.write 自带 try/catch，最小桩即可。
vi.mock("vscode", () => ({ commands: { executeCommand } }));

import { createCodeActionEntry } from "../src/features/editorCommands";
import type { PendingContext } from "../src/features/pendingContext";

function mentionItem(label: string): PendingContext {
  return {
    chip: { id: label, label },
    text: `<file path="${label}">内容</file>`,
    mention: {
      id: `file:/w/${label}`,
      category: "files",
      label,
      value: label,
      markdown: `[${label}](./${label})`,
      data: { kind: "file", path: `/w/${label}`, relativePath: label },
    },
  };
}

function plainItem(label: string): PendingContext {
  return { chip: { id: label, label }, text: `<diagnostics>…</diagnostics>` };
}

describe("composer 入口的开窗门控（2026-11-19 加入上下文弹新窗口回归）", () => {
  beforeEach(() => {
    executeCommand.mockClear();
  });

  it("已有对话面：addContext 只推帧，不执行 gode.openChat（本 bug 的修复点）", async () => {
    const pushFrame = vi.fn();
    const entry = createCodeActionEntry(pushFrame, () => true);

    await entry.addContext([mentionItem("a.ts"), mentionItem("b.ts")]);

    expect(pushFrame).toHaveBeenCalledTimes(1);
    expect(pushFrame).toHaveBeenCalledWith("composer-insert", {
      text: "[a.ts](./a.ts) [b.ts](./b.ts) ",
      mentions: expect.any(Array),
      mode: "prepend-if-missing",
    });
    // 桌面上已激活的对话面就是投递目标 → 不允许再开新窗/新页签
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("没有任何对话面：addContext 推帧后执行 gode.openChat（pending 队列 flush 路径）", async () => {
    const pushFrame = vi.fn();
    const entry = createCodeActionEntry(pushFrame, () => false);

    await entry.addContext([mentionItem("a.ts")]);

    expect(pushFrame).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    expect(executeCommand).toHaveBeenCalledWith("gode.openChat");
  });

  it("已有对话面：submit（解释/修复/重构/写测试）只推帧，不开新窗", async () => {
    const pushFrame = vi.fn();
    const entry = createCodeActionEntry(pushFrame, () => true);

    await entry.submit("请解释这段代码", [mentionItem("a.ts")]);

    expect(pushFrame).toHaveBeenCalledWith("composer-insert", {
      text: "[a.ts](./a.ts) 请解释这段代码",
      mention: expect.any(Object),
      mode: "replace",
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("没有任何对话面：submit 推帧后执行 gode.openChat", async () => {
    const pushFrame = vi.fn();
    const entry = createCodeActionEntry(pushFrame, () => false);

    await entry.submit("请解释这段代码", []);

    expect(pushFrame).toHaveBeenCalledWith("composer-insert", {
      text: "请解释这段代码",
    });
    expect(executeCommand).toHaveBeenCalledWith("gode.openChat");
  });

  it("无 mention 兜底分支同样受门控：有对话面时不执行 openChat", async () => {
    const pushFrame = vi.fn();
    const entry = createCodeActionEntry(pushFrame, () => true);

    await entry.addContext([plainItem("diag")]);

    expect(pushFrame).toHaveBeenCalledWith("composer-insert", {
      text: "<diagnostics>…</diagnostics>",
    });
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
