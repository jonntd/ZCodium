import { memo, useCallback, useEffect, useState } from "react";
import {
  ProjectSidebar,
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
        <div className="absolute inset-0">
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
      ) : null}
    </div>
  );
});
