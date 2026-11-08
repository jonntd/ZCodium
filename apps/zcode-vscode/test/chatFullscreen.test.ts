/**
 * 对话全屏切换回归（用户反馈 2026-11-08：「切换最大化按钮失效了；最大化时不要关闭
 * 资源管理器和已打开的代码标签」）。
 *
 * 锁死两条契约：
 * 1. 只在编辑器区域内做「展开 ↔ 均分」，绝不发任何隐藏/关闭类命令
 *    （closeSidebar / closeAuxiliaryBar / toggleMaximizeEditorGroup）；
 * 2. 单编辑器组时不发命令（编辑器区域没有第二块可让位），改为轻提示。
 */
import { describe, expect, it } from "vitest";

import {
  CHAT_FULLSCREEN_TOGGLE_COMMAND,
  toggleChatFullscreenLayout,
} from "../src/features/chatFullscreen";

function createDeps(groups: number) {
  const executed: string[] = [];
  let notified = 0;
  return {
    executed,
    notifyCount: () => notified,
    deps: {
      editorGroupCount: () => groups,
      executeCommand: async (command: string) => {
        executed.push(command);
        return undefined;
      },
      notifyAlreadyFull: () => {
        notified += 1;
      },
    },
  };
}

/** 任何"会藏起用户的栏/组/标签"的命令（出现一条就说明回退了）。 */
const FORBIDDEN_COMMANDS = [
  "workbench.action.closeSidebar",
  "workbench.action.closeAuxiliaryBar",
  "workbench.action.toggleMaximizeEditorGroup",
  "workbench.action.maximizeEditorHideSidebar",
  "workbench.action.closeAllEditors",
];

describe("对话全屏切换：编辑器区域内展开/均分", () => {
  it("多编辑器组：只发展开↔均分（toggleEditorWidths）", async () => {
    const { deps, executed, notifyCount } = createDeps(2);
    const result = await toggleChatFullscreenLayout(deps);
    expect(result).toEqual({ acted: true, groups: 2 });
    expect(executed).toEqual([CHAT_FULLSCREEN_TOGGLE_COMMAND]);
    expect(notifyCount()).toBe(0);
  });

  it("单编辑器组：不发任何命令，只给一次轻提示（原生最大化同样是 no-op）", async () => {
    const { deps, executed, notifyCount } = createDeps(1);
    const result = await toggleChatFullscreenLayout(deps);
    expect(result).toEqual({ acted: false, groups: 1 });
    expect(executed).toEqual([]);
    expect(notifyCount()).toBe(1);
  });

  it("任何分支都不会隐藏资源管理器/辅助栏，也不会隐藏其它编辑器组", async () => {
    for (const groups of [1, 2, 3]) {
      const { deps, executed } = createDeps(groups);
      await toggleChatFullscreenLayout(deps);
      for (const forbidden of FORBIDDEN_COMMANDS) {
        expect(executed).not.toContain(forbidden);
      }
    }
  });

  it("切换命令是键盘可逆的原生 toggle（展开 ↔ 均分），不是单向最大化", () => {
    expect(CHAT_FULLSCREEN_TOGGLE_COMMAND).toBe("workbench.action.toggleEditorWidths");
  });

  it("IDE 没有该命令时不冒泡异常（降级为不重排 + 一次提示）", async () => {
    let notified = 0;
    const result = await toggleChatFullscreenLayout({
      editorGroupCount: () => 2,
      executeCommand: () => Promise.reject(new Error("command not found")),
      notifyAlreadyFull: () => {},
      notifyUnsupported: () => {
        notified += 1;
      },
    });
    // 命令 handler 是 async：reject 冒泡出去就是未捕获的 Promise 拒绝 + IDE 红条。
    expect(result).toEqual({ acted: false, groups: 2 });
    expect(notified).toBe(1);
  });
});
