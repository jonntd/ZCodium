/**
 * composer-insert / 诊断注入的落点 workspace 解析（spec: composer-insert-delivery
 * 「落点 key」规则，2026-11-22 修订）。
 *
 * 事故（2026-11-21「右键加入 Gode 对话」全量失效）：1915364a 起侧栏挂载桌面 Root，
 * 可见对话区的 workspace 由 Root 的 tabStore（activeWorkspacePath/activeWorkspaceIdentity）
 * 持有，而 App/bootstrap 层的 `workspacePath` 是**另一份独立状态**——Root 页签内切换
 * 工作区不产生任何 host workspace 帧，App 层 key 冻结在 bootstrap folder。落点若用
 * App 层 key，请求会写进一个没有可见 composer 消费的 store 桶：host 日志显示帧已
 * 推送、链路无错，用户侧毫无反应。
 *
 * 因此落点必须与可见对话区同源：复用 Root 的 `resolveRootWorkspaceShellTarget`
 * （与 Root.tsx 同一接线：activeTab → activeWorkspacePath 覆盖面回退），本地页签下
 * 即 tabStore 的 path + identity。tabStore 尚无 active workspace（面板刚打开、Root
 * 未挂载）时回退 App 层 key——此刻 Root 首个页签就是 bootstrap folder，两者将收敛
 * 为同一值。纯函数 + 显式入参：vitest 直测，不摸 React/store 单例。
 */

import { resolveRootWorkspaceShellTarget } from "@/root/rootWorkspaceShellTarget.js";
import { isWorkspaceTab, type WindowTabState } from "@/store/tabStore.js";

/** 与 Root.tsx 的 workspaceShellPath 接线同构的 tabStore 状态最小面。 */
export interface TabStoreTargetState {
  tabs: readonly WindowTabState[];
  activeTabId: string | null;
  activeWorkspacePath: string | null;
  activeWorkspaceIdentity: string | null;
}

export interface ComposerInsertTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/** App 层兜底口径（原 index.tsx 内联逻辑）：聚焦 folder 在 folders 里才用，否则首个 folder。 */
export function fallbackInsertTarget(
  fallbackWorkspacePath: string,
  folders: readonly string[],
): string {
  return folders.includes(fallbackWorkspacePath)
    ? fallbackWorkspacePath
    : (folders[0] ?? fallbackWorkspacePath);
}

/**
 * 解析 composer-insert / 诊断注入的落点 workspace。
 *
 * @param tabState tabStore 快照（getCurrentWindowTabStore()?.getState()）；null =
 *   Provider 未挂载（React 未挂树，如面板刚 flush 的首帧）→ 走 App 层兜底。
 * @param fallbackWorkspacePath App/bootstrap 层 workspacePath（workspaceRef.current）。
 * @param folders bootstrap folders（data-folders），兜底时的候选集。
 */
export function resolveComposerInsertTarget(
  tabState: TabStoreTargetState | null,
  fallbackWorkspacePath: string,
  folders: readonly string[],
): ComposerInsertTarget {
  if (!tabState) {
    return {
      workspacePath: fallbackInsertTarget(fallbackWorkspacePath, folders),
    };
  }
  const activeTab = tabState.activeTabId
    ? (tabState.tabs.find((tab) => tab.id === tabState.activeTabId) ?? null)
    : null;
  const target = resolveRootWorkspaceShellTarget({
    activeWorkspaceTab: activeTab && isWorkspaceTab(activeTab) ? activeTab : null,
    activeWorkspacePath: tabState.activeWorkspacePath,
    activeWorkspaceIdentity: tabState.activeWorkspaceIdentity,
    workspaceTabs: tabState.tabs.filter(isWorkspaceTab),
  });
  // Root 未挂载（shell target 为 null）→ 旧口径兜底；identity 只在 tabStore 有值时透传
  // （App 层 key 历史行为就是 workspaceIdentity=undefined，key=workspacePath）。
  if (target.workspaceShellPath) {
    return {
      workspacePath: target.workspaceShellPath,
      ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
    };
  }
  return {
    workspacePath: fallbackInsertTarget(fallbackWorkspacePath, folders),
  };
}
