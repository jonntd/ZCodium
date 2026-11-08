import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";
import { WorkspaceSidePaneToggleButton } from "@/WorkspaceSidePaneToggleButton.js";
import { WorkspaceTerminalToggleButton } from "@/WorkspaceTerminalToggleButton.js";
import { cn } from "@/components/lib/utils.js";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";
import { WorkspaceHelpMenuButton } from "@/WorkspaceHelpMenuButton.js";
import { DesktopWindowControls } from "@/DesktopWindowControls.js";

export type { WorkspaceHeaderActionSectionProps } from "@/WorkspaceHeaderSections/shared.js";

export function WorkspaceHeaderActionSection({
  variant = "task",
  readOnlyReason,
  workspaceAbsPath,
  workspaceIdentity,
  remoteTarget,
  isDesktop,
  isTerminalOpen,
  isSidePaneOpen,
  onToggleTerminal,
  onToggleSidePane,
  toggleSidePaneShortcutLabel,
  simplifyForNarrowRemote = false,
  hideHelpMenu = false,
  showWindowControls = false,
  useWindowsCaptionSpacing = false,
}: WorkspaceHeaderActionSectionProps) {
  // VS Code 插件宿主里 IDE 自带终端和帮助入口，隐藏应用内重复的 UI。
  // useOptionalPlatform 在无 Provider 的直测里返回 null，不影响其它宿主。
  const nativeTerminalHost = Boolean(useOptionalPlatform()?.nativeTerminalHost);
  return (
    <div
      className={cn(
        "flex shrink-0 items-center [app-region:no-drag]",
        // Windows header 内容区有 p-2，普通工具栏按钮 hover 只覆盖 32px 高度。
        // 标题栏按钮需要抵消这层垂直内边距，和原生窗控/右侧菜单保持同一个 48px hover 面。
        useWindowsCaptionSpacing ? "-my-2 h-12 gap-0" : "gap-0.5",
      )}
    >
      {/* 「在 <IDE> 中打开」在 VS Code 插件宿主里语义重复（本就在 IDE 内），
          且会拉起 getInstalledEditors / openInEditor 与偏好持久化。插件侧不渲染；
          桌面端与设置页仍复用同一组件，行为不变。 */}
      {variant === "task" && !nativeTerminalHost ? (
        <WorkspaceEditorButtonGroup
          disabledReason={readOnlyReason}
          workspaceAbsPath={workspaceAbsPath}
          workspaceIdentity={workspaceIdentity}
          remoteTarget={remoteTarget}
        />
      ) : null}
      {!simplifyForNarrowRemote && !nativeTerminalHost ? (
        <>
          {!hideHelpMenu ? <WorkspaceHelpMenuButton isDesktop={Boolean(isDesktop)} /> : null}
          {/* 远程控制移动端头部空间过窄，终端入口在这里会和核心操作争抢宽度。*/}
          <WorkspaceTerminalToggleButton
            isTerminalOpen={isTerminalOpen}
            onToggleTerminal={onToggleTerminal}
            disabledReason={readOnlyReason}
            useWindowsCaptionSpacing={useWindowsCaptionSpacing}
          />
        </>
      ) : null}
      {/* 远程控制移动端只保留图标，避免 diff 数字把按钮撑宽导致标题拥挤。 */}
      {!isSidePaneOpen ? (
        <WorkspaceSidePaneToggleButton
          isSidePaneOpen={isSidePaneOpen}
          onToggleSidePane={onToggleSidePane}
          shortcutLabel={toggleSidePaneShortcutLabel}
          useWindowsCaptionSpacing={useWindowsCaptionSpacing}
        />
      ) : null}
      {showWindowControls && !isSidePaneOpen ? <DesktopWindowControls /> : null}
    </div>
  );
}
