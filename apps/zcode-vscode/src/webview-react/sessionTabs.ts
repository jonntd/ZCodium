/**
 * 插件会话标签栏的纯状态机（Claude Code「Untitled」标签同款）。
 *
 * 与 Root 内部的工作台状态解耦：这里只管「本窗口打开了哪些会话标签、顺序、
 * 是否锁定」，切换会话仍走 App 既有的 switchTarget/initialTaskId 路径。
 * 纯函数便于 vitest 直测，不依赖 vscode / DOM。
 */

export interface SessionTab {
  id: string;
  title: string;
  /** 绑定的会话 id；null = 草稿态（新对话）。 */
  sessionId: string | null;
  /** 锁定后固定在左侧，不可拖动、不可关闭。 */
  pinned: boolean;
}

export const SESSION_TAB_STORAGE_KEY = "gode.sessionTabs.v2";
/** 本 webview 选中的标签 id（各编辑器页签独立选会话，选中态不跨页中继、只本地恢复）。 */
export const SESSION_TAB_ACTIVE_STORAGE_KEY = "gode.sessionTabs.active";
export const SESSION_TAB_DEFAULT_TITLE = "Untitled";

let tabSeq = 0;

export function createSessionTab(
  sessionId: string | null = null,
  title: string = SESSION_TAB_DEFAULT_TITLE,
): SessionTab {
  tabSeq += 1;
  return {
    id: `session-tab-${Date.now().toString(36)}-${tabSeq}`,
    title,
    sessionId,
    pinned: false,
  };
}

/** 锁定的标签恒在前；其余保持传入顺序。 */
export function normalizeSessionTabs(tabs: readonly SessionTab[]): SessionTab[] {
  return [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
}

/**
 * 拖拽重排：只能在「未锁定」区间内移动，锁定标签既不作为源也不作为落点。
 * 返回新数组；非法/无变化时返回原数组引用，避免无谓重渲染。
 */
export function reorderSessionTabs(
  tabs: readonly SessionTab[],
  fromId: string,
  toId: string,
): readonly SessionTab[] {
  if (fromId === toId) return tabs;
  const source = tabs.find((tab) => tab.id === fromId);
  const target = tabs.find((tab) => tab.id === toId);
  if (!source || !target || source.pinned || target.pinned) return tabs;
  const movable = tabs.filter((tab) => !tab.pinned);
  const from = movable.findIndex((tab) => tab.id === fromId);
  const to = movable.findIndex((tab) => tab.id === toId);
  if (from < 0 || to < 0) return tabs;
  const next = [...movable];
  const [moved] = next.splice(from, 1);
  if (!moved) return tabs;
  next.splice(to, 0, moved);
  return [...tabs.filter((tab) => tab.pinned), ...next];
}

/** 切换锁定；取消锁定后仍保留在可移动区末尾（由 normalize 归位）。 */
export function toggleSessionTabPinned(
  tabs: readonly SessionTab[],
  id: string,
): SessionTab[] {
  return normalizeSessionTabs(
    tabs.map((tab) => (tab.id === id ? { ...tab, pinned: !tab.pinned } : tab)),
  );
}

export function canCloseSessionTab(tab: SessionTab): boolean {
  return !tab.pinned;
}

/** Root 内部会话切换 → 把当前标签绑定到真实 sessionId（草稿转正）。 */
export function bindActiveSession(
  tabs: readonly SessionTab[],
  activeId: string,
  sessionId: string | null,
): readonly SessionTab[] {
  const active = tabs.find((tab) => tab.id === activeId);
  if (!active || active.sessionId === sessionId) return tabs;
  return tabs.map((tab) => (tab.id === activeId ? { ...tab, sessionId } : tab));
}

/** 关闭标签并给出下一个应激活的标签（优先右邻，其次左邻）。 */
export function closeSessionTab(
  tabs: readonly SessionTab[],
  id: string,
): { tabs: SessionTab[]; nextActiveId: string | null } {
  const target = tabs.find((tab) => tab.id === id);
  if (!target || !canCloseSessionTab(target)) {
    return { tabs: [...tabs], nextActiveId: null };
  }
  const index = tabs.findIndex((tab) => tab.id === id);
  const next = tabs.filter((tab) => tab.id !== id);
  const fallback = next[Math.min(index, next.length - 1)] ?? null;
  return { tabs: next, nextActiveId: fallback?.id ?? null };
}

/** localStorage 读取：容错任意脏数据，至少返回一个可用标签。 */
export function parseStoredSessionTabs(raw: string | null): SessionTab[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const tabs = parsed
      .filter((item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
      )
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : "",
        title: typeof item.title === "string" ? item.title : SESSION_TAB_DEFAULT_TITLE,
        sessionId: typeof item.sessionId === "string" ? item.sessionId : null,
        pinned: item.pinned === true,
      }))
      .filter((tab) => tab.id.length > 0);
    return normalizeSessionTabs(tabs);
  } catch {
    return [];
  }
}
