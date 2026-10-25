import { memo, useCallback, useEffect, useState } from "react";
import {
  ProjectSidebar,
  SIDEBAR_TITLEBAR_STRIP_CLASS,
  type ProjectSidebarProps,
  type SidebarFileTreeOpenRequest,
} from "@/project-sidebar/index.js";
import { WorkspaceFileTree } from "@/WorkspaceFileTree.js";

export type { SidebarFileTreeOpenRequest } from "@/project-sidebar/index.js";

/** 项目与任务归 Host 目录；这里仅保留审计版既有文件树的展示/返回状态。 */
export const WorkspaceSidebar = memo(function WorkspaceSidebar(props: ProjectSidebarProps) {
  const [target, setTarget] = useState<SidebarFileTreeOpenRequest["target"] | null>(null);
  const [open, setOpen] = useState(false);
  const openFiles = useCallback(
    (next: SidebarFileTreeOpenRequest["target"]) => {
      if (props.onOpenFileManager) props.onOpenFileManager(next);
      else {
        setTarget(next);
        setOpen(true);
      }
    },
    [props.onOpenFileManager],
  );
  useEffect(() => {
    if (props.fileTreeOpenRequest) openFiles(props.fileTreeOpenRequest.target);
  }, [props.fileTreeOpenRequest, openFiles]);
  useEffect(() => {
    props.onFileTreeOpenChange?.(open);
    return () => props.onFileTreeOpenChange?.(false);
  }, [open, props.onFileTreeOpenChange]);
  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      <div
        className={open ? "h-full -translate-x-full pointer-events-none" : "h-full"}
        aria-hidden={open}
        inert={open || undefined}
      >
        <ProjectSidebar {...props} onOpenFileManager={openFiles} />
      </div>
      {open && target ? (
        // 原因：覆盖层 absolute inset-0 会随 ProjectSidebar 的 -translate-x-full 把顶部
        // 标题栏拖拽条一起移出视野，文件树头部只剩 pt-3，「返回任务」按钮顶到窗口上沿，
        // 与 macOS 红绿灯（关闭/最小化）重叠。覆盖层与侧栏共用同一条让位规则：
        // 先渲染拖拽条，文件树渲染在红绿灯下方（2026-10-25 bugfix）。
        <div
          className="absolute inset-0 flex min-h-0 flex-col"
          data-testid="sidebar-file-tree-overlay"
        >
          <div
            className={`${SIDEBAR_TITLEBAR_STRIP_CLASS} ${props.isWebRemoteControl ? "max-md:hidden" : ""}`}
          />
          <div className="min-h-0 flex-1">
            <WorkspaceFileTree
              {...target}
              canOpenLocalFileManager={props.isDesktop}
              activePreviewPath={props.activePreviewPath}
              onClose={() => setOpen(false)}
              onOpenBrowserUrl={props.isDesktop ? props.onOpenBrowserUrl : undefined}
              onOpenPreview={(source, options) =>
                // options 透传 preview/open 意图（单击=预览槽，双击=正式打开），
                // spec docs/spec/sidebar-file-viewer.md §2 入口 A 的点击语义。
                props.onOpenCodeViewer?.(
                  {
                    ...source,
                    workspacePath: target.workspacePath,
                    workspaceIdentity: target.workspaceIdentity,
                    workspaceRemoteSessionId: target.workspaceRemoteSessionId,
                  },
                  options,
                )
              }
            />
          </div>
        </div>
      ) : null}
    </div>
  );
});
