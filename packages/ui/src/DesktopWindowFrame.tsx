import { memo, type ReactNode } from "react";
import { cn } from "@/components/lib/utils.js";

export const DesktopWindowFrame = memo(function DesktopWindowFrameComponent({
  title: _title,
  children,
  actions: _actions,
  tabBar: _tabBar,
  isDesktop = false,
  isMacDesktop = false,
  isWindowsDesktop = false,
  headerTestId: _headerTestId,
  showHeader: _showHeader = isDesktop,
}: {
  title: string;
  children: ReactNode;
  topBar?: ReactNode;
  actions?: ReactNode;
  /** 标签栏插槽，渲染在 header 内标题后面 */
  tabBar?: ReactNode;
  isDesktop?: boolean;
  isMacDesktop?: boolean;
  isWindowsDesktop?: boolean;
  headerTestId?: string;
  showHeader?: boolean;
}) {
  const isLinuxDesktop = isDesktop && !isMacDesktop && !isWindowsDesktop;
  // Web/Windows/Linux 都没有 macOS vibrancy 作为透明底层兜底，
  // 如果继续走半透明 alt 背景，会和浏览器或系统窗口底色混出异常灰块。
  // 修复原因（docs/spec/web-remote-ui-parity.md §2.1-A5）：中继页此前与 Windows/Linux 共用
  // bg-background-win-alt——手机页"带着 Windows 的底色"。Web 单独走 bg-background-web-alt
  // （styles.css 的 @theme + 三个主题段覆盖，取值与 win-alt 逐主题一致 ⇒ 零视觉变化），
  // 后续可独立调整中继页底色而不牵连桌面窗口底色；macOS 桌面保持半透明 alt 由 vibrancy 兜底。
  const rootSurfaceClassName = !isDesktop
    ? "bg-background-web-alt"
    : isWindowsDesktop || isLinuxDesktop
      ? "bg-background-win-alt"
      : "bg-background-alt";

  return (
    <div
      className={cn(
        // 手机浏览器的 100vh 会把地址栏区域算进页面高度，
        // 远控页底部输入框容易被挤到可视区外。动态视口高度能跟随浏览器 chrome 收放，桌面端视觉不变。
        "flex h-dvh flex-col overflow-hidden border-border text-foreground",
        // Linux BrowserWindow 的不透明底色会把最外层恢复为直角。
        // 外壳 16px 与内层 12px 面板及 4px inset 构成同心圆。Linux 合成器在原生拖拽/缩放时
        // 可能短暂丢失 overflow 圆角，额外使用同半径 clip-path 固定合成裁切；最大化时两者一起归零。
        isLinuxDesktop &&
          "rounded-[16px] [clip-path:inset(0_round_16px)] platform-linux-window-maximized:rounded-none platform-linux-window-maximized:[clip-path:inset(0)]",
        rootSurfaceClassName,
      )}
      data-desktop-window-frame="true"
    >
      <div className="relative flex-1 min-h-0 w-full">{children}</div>
    </div>
  );
});
