import type { EditorInfo, OpenInEditorRemoteTarget } from "@zcode/shared";
import type { IDisposable } from "@zcode/rpc";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { CodeViewerOpenIntent } from "@/lib/workspaceSidePane.js";
import type { WorkspaceFileGitStatus, WorkspaceFileTreeRow } from "@/workspace-file-tree/model.js";

export interface WorkspaceFileTreeOpenPreviewOptions {
  /** preview=占用可替换预览槽（单击）；open=正式打开普通标签（双击/右键打开）。 */
  intent?: CodeViewerOpenIntent;
}

export interface WorkspaceFileTreeProps {
  workspacePath: string;
  workspaceName?: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
  revealPath?: string;
  temporaryExternalDirectory?: boolean;
  canOpenLocalFileManager?: boolean;
  activePreviewPath?: string | null;
  /** 宿主自带关闭入口（如右侧面板 tab 条的 X）时隐藏顶部「返回任务」按钮。 */
  hideBackButton?: boolean;
  onClose: () => void;
  onOpenBrowserUrl?: (url: string) => void;
  onOpenPreview?: (source: CodeViewerSource, options?: WorkspaceFileTreeOpenPreviewOptions) => void;
  /**
   * 「与当前文件对比」基线 + 处理器（hooks 层读文件组 diff source）；
   * 两者都提供且行满足条件时才显示菜单项。树只透传行，不读文件。
   */
  compareBaseline?: WorkspaceFileTreeCompareBaseline | null;
  onCompareWithBaseline?: (row: WorkspaceFileTreeRow) => void;
}

export interface WorkspaceFileTreeWatcherRegistration {
  id: string;
  subscription: IDisposable;
  unwatch: () => Promise<void>;
}

export interface WorkspaceFileTreeStickyFolderItem {
  row: WorkspaceFileTreeRow;
  index: number;
}

export interface WorkspaceFileTreeContextMenuLabels {
  addToChat: string;
  copyAbsolutePath: string;
  copyRelativePath: string;
  open: string;
  openInBrowser: string;
  openFailed: string;
  openWith: string;
  reveal: string;
  /** 与当前文件对比（spec: docs/spec/side-pane-file-preview.md §8）。 */
  compareWithCurrent: string;
}

/** 「与当前文件对比」的基线（内嵌预览当前文件）；缺省时树不显示该菜单项。 */
export interface WorkspaceFileTreeCompareBaseline {
  path: string;
  title: string;
}

export interface WorkspaceFileTreeEditorState {
  canOpenLocalFileManager: boolean;
  installedEditors: EditorInfo[];
  isRemoteWorkspaceFileTree: boolean;
  remoteTarget?: OpenInEditorRemoteTarget;
}

export type WorkspaceFileGitStatusLabels = Record<WorkspaceFileGitStatus, string>;
