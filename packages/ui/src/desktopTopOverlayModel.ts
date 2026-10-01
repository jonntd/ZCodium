/**
 * 顶部浮层「切换侧边栏」按钮的平台呈现模型（docs/spec/sidebar-toggle-button.md）。
 *
 * 状态与动作的所有者是 useAppPanels（isSidebarVisible / handleToggleSidebar），三端共用；
 * 这里只做「该平台以哪种形态展示按钮」的纯判定，保持按钮在桌面与 Web 都有可见入口。
 */
export type SidebarTogglePresentation = "logo-hover" | "icon";

export function resolveSidebarTogglePresentation(input: {
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
}): SidebarTogglePresentation {
  const isLinuxDesktop = Boolean(
    input.isDesktop && !input.isMacDesktop && !input.isWindowsDesktop,
  );
  // Windows/Linux 桌面占据自绘标题栏区域：按钮常态显示应用 logo、悬停才切换为侧栏图标；
  // macOS 与 Web 没有这层窗口装饰，直接展示侧栏图标（Web 与桌面共用同一状态与 ⌘B 快捷键）。
  return input.isWindowsDesktop || isLinuxDesktop ? "logo-hover" : "icon";
}
