/**
 * 对话全屏切换：**只在编辑器区域内重排，绝不隐藏资源管理器、绝不动用户标签。**
 *
 * 为什么不复用 IDE 原生「最大化编辑器组」（workbench.action.toggleMaximizeEditorGroup）：
 * - 内核 `arrangeGroups(0)` 第一行就判 `if (this.count < 2 || !this.gridWidget) return;`
 *   ——编辑器组只有 1 个时是**结构性 no-op**，按钮点了毫无反应（用户反馈的「失效」）；
 * - 它一旦生效，`gridWidget.maximizeView()` 会把其它编辑器组整体 `setChildVisible(false)`，
 *   用户的代码标签看起来像"被关掉"（其实只是被隐藏），与「最大化时别动我的资源管理器
 *   和已打开的代码标签」直接冲突。
 *
 * 改用编辑器区域的「展开 ↔ 均分」（workbench.action.toggleEditorWidths，内核
 * `toggleExpandGroup`：expanded ? arrangeGroups(2) : arrangeGroups(1)）：
 * - 展开时对话所在组吃满编辑器区域宽度，其它组缩到各自最小宽度**仍然可见**——
 *   标签一个都不关、资源管理器一格不动；
 * - 再点一次恢复均分（原生自反转，不用我们记状态，也不怕用户中途拖拽分隔条）。
 * - 仍只有 1 个编辑器组时没有可重排的第二块（对话本来就占满编辑器区域），
 *   给一次状态栏轻提示，不做任何布局改动。
 */
export interface ChatFullscreenDeps {
  /** 当前窗口编辑器组数量（vscode.window.tabGroups.all.length）。 */
  readonly editorGroupCount: () => number;
  /** 执行工作台命令。 */
  readonly executeCommand: (command: string) => Thenable<unknown>;
  /** 单组时的轻提示（状态栏消息，不打断用户）。 */
  readonly notifyAlreadyFull: () => void;
}

export interface ChatFullscreenResult {
  /** 是否真的做了布局重排。 */
  acted: boolean;
  /** 触发时的编辑器组数量（诊断日志用）。 */
  groups: number;
}

/**
 * 展开/均分切换命令（= 内核 `toggleExpandGroup`）。
 * **不要**换成 `workbench.action.toggleMaximizeEditorGroup`：见文件头注释。
 */
export const CHAT_FULLSCREEN_TOGGLE_COMMAND = "workbench.action.toggleEditorWidths";

export async function toggleChatFullscreenLayout(
  deps: ChatFullscreenDeps,
): Promise<ChatFullscreenResult> {
  const groups = deps.editorGroupCount();
  if (groups < 2) {
    // 单组：没有第二块可让位。原生最大化在这个前提下同样无效，而唯一"更满"的办法
    // 是隐藏侧栏——用户明确不要。此处只解释，不动布局。
    deps.notifyAlreadyFull();
    return { acted: false, groups };
  }
  await deps.executeCommand(CHAT_FULLSCREEN_TOGGLE_COMMAND);
  return { acted: true, groups };
}
