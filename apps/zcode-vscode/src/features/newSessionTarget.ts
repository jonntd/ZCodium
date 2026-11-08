/**
 * 「新建会话（+）」到底该作用在**哪一面**——纯判定，vitest 直测。
 *
 * ## 为什么需要这层判定
 *
 * 同一个 `$(add)` 按钮挂在两处菜单上：
 * - `view/title`（侧栏 `gode.chat` 视图标题栏）
 * - `editor/title`（编辑器对话页签的标签行）
 *
 * 而命令执行时**拿不到"用户是从哪一面点的"**——contributes.menus 不传来源参数。
 * 于是只能按"哪一面活着"去推断目标面。历史缺陷（2026-11-08 用户反馈
 * 「我点加号为什么会创建出一个 TAB 窗口」）正是漏了这层推断：
 * `gode.newSession` 只认编辑器页签，侧栏标题栏的 + 走同一条实现 →
 *   - 有编辑器页签：把**编辑器页签**清成草稿，侧栏那一页纹丝不动（点错了面）；
 *   - 没有编辑器页签：`reveal()` 直接**新开一个编辑器标签**（无中生有一个 TAB）。
 * 运行日志实证（~/.antigravity-ide 的 Gode 输出通道）：
 *   15:22:56 webview 已连接：gode.chat            ← 用户在侧栏
 *   15:22:59 新建对话页签：gode.chat.editor（reason=reveal:无存活页签，存活=0）
 *
 * ## 语义（用户口径）
 *
 * 点 + = **在眼前这一面开一个新对话**，绝不新开编辑器页签；只有"一个对话面都没有"
 * 时才创建页签（首次使用、页签被关光后的唯一出路）。
 *
 * 侧栏视图 id 由调用方传入（`CHAT_VIEW_ID`），本模块不复制字面量——视图 id 的
 * 唯一来源仍是 `ui/chatPanel.ts`（有清单一致性契约测试锁定）。
 */

export type NewSessionTarget =
  /** 投给编辑器对话页（用户眼前的页签）。 */
  | { readonly surface: "editor"; readonly connectionId: string }
  /** 投给侧栏对话视图（用户在侧栏标题栏点的 +，或只剩侧栏一面）。 */
  | { readonly surface: "sidebar"; readonly connectionId: string }
  /** 一个对话面都没有：新建草稿页签。 */
  | { readonly surface: "create" };

export interface NewSessionTargetInput {
  /** 存活编辑器对话页的连接 id（`chatEditorPanel.activeConnectionId()`）。 */
  readonly editorConnectionId: string | null;
  /**
   * 侧栏对话 webview 是否已挂桥（`hostRuntime.hasConnection(CHAT_VIEW_ID)`）。
   * 注意判"挂桥"而不是判"视图已展开"：没挂桥时投帧会被丢弃，等于点了没反应。
   */
  readonly sidebarOnline: boolean;
  /** 侧栏连接的固定 id（`CHAT_VIEW_ID`）。 */
  readonly sidebarConnectionId: string;
}

/**
 * 优先级：
 *   1. 存活编辑器对话页 → 它（`editor/title` 的 + 必定命中这条；命令面板/快捷键也优先
 *      复用眼前的页签，而不是再开一个）；
 *   2. 侧栏对话在线 → 侧栏（此时不会有编辑器页签：有的话第 1 条已命中）；
 *   3. 都没有 → 建草稿页签。
 */
export function resolveNewSessionTarget(input: NewSessionTargetInput): NewSessionTarget {
  if (input.editorConnectionId !== null) {
    return { surface: "editor", connectionId: input.editorConnectionId };
  }
  if (input.sidebarOnline) {
    return { surface: "sidebar", connectionId: input.sidebarConnectionId };
  }
  return { surface: "create" };
}
