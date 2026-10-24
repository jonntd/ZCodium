import type { WorkspaceMainView } from "@/app-shell/types.js";

/**
 * 工作区头部可见性（docs/spec/web-remote-ui-parity.md §2.1-A1）。
 *
 * 2026-10-17 决策：**Web（中继页 / 手机远控）草稿态也渲染 header**。
 * 此前条件是 `shouldRenderMainViewHeader && (activeTaskId !== null || isDesktop)`，
 * 没有 active task 的手机页会整个丢掉工作区头部——项目名、分支/变更摘要、帮助菜单、
 * 终端与侧栏开关全部消失，与桌面草案态观感割裂。
 *
 * 为什么可以恒真（仅按主视图排除）：桌面 chrome（窗控命中区、拖拽条、更新按钮等）
 * 本就由 `WorkspaceHeader` 内部按 `isDesktop` 裁剪——**有 active task 的手机页一直在
 * 渲染 header** 就是这条裁剪链已生效的证据。壳层无需再用「有没有 active task」
 * 决定整个头部的存亡；`automations` / `plugin-store` 自带面包屑与拖拽条布局
 * （见 automationsMainDragRegion 测试与 AutomationsMainBreadcrumbFrame），仍不渲染。
 */
export function shouldRenderWorkspaceHeaderForMainView(
  workspaceMainView: WorkspaceMainView,
): boolean {
  return workspaceMainView !== "automations" && workspaceMainView !== "plugin-store";
}
