/**
 * 侧栏顶部标题栏拖拽条（macOS 红绿灯让位区）：ProjectSidebar 与左侧「查看文件」
 * 文件树覆盖层（WorkspaceSidebar）必须共用同一留白规则。覆盖层以 absolute inset-0
 * 覆盖整个侧栏列，若不带这条拖拽条，树头部的「返回任务」按钮会顶到窗口上沿，
 * 与关闭/最小化按钮重叠（2026-10-25 bugfix）。
 */
export const SIDEBAR_TITLEBAR_STRIP_CLASS = "h-12 shrink-0 [app-region:drag]";
