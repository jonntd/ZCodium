import type { ZCodePersistedFileChange } from "@zcode/shared";
import type { CodeViewerSource } from "@/lib/codeViewer.js";
import type { CodeViewerWorkspaceScope } from "@/lib/codeViewerWorkspaceScope.js";

export function buildChangeSummaryDiffViewerSource({
  patch,
  path,
  snapshot,
  relativePath,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
}: {
  patch?: string;
  path?: string;
  snapshot: ZCodePersistedFileChange["snapshots"][number] | undefined;
  relativePath: string;
} & CodeViewerWorkspaceScope): CodeViewerSource | undefined {
  const workspaceScope = {
    ...(workspacePath ? { workspacePath } : {}),
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
  };
  if (patch) {
    return {
      type: "patch",
      title: relativePath,
      path: path ?? snapshot?.path,
      patch,
      ...workspaceScope,
    };
  }

  if (!snapshot) {
    return undefined;
  }

  return {
    type: "multi-file-diff",
    title: relativePath,
    path: snapshot.path,
    beforeContent: snapshot.beforeContent ?? "",
    afterContent: snapshot.afterContent,
    ...workspaceScope,
  };
}

export function buildChangeSummaryFilePreviewSource(
  input: {
    path: string;
    relativePath: string;
    workspacePath: string;
  } & CodeViewerWorkspaceScope,
): CodeViewerSource {
  const { path, relativePath, workspacePath, workspaceIdentity, workspaceRemoteSessionId } = input;
  return {
    type: "file",
    title: relativePath,
    path,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(workspaceRemoteSessionId ? { workspaceRemoteSessionId } : {}),
  };
}

/**
 * diff 源（patch / before-after 快照）可能缺席。旧实现此时把整行和「审查」按钮
 * 一起禁用，点击 `openChangeSummaryDiffViewer(undefined, ...)` 静默返回 false，
 * 用户看到的就是「点了没反应」。改为降级到文件源：点击始终能打开点什么。
 */
export function resolveChangeSummaryViewerSource(
  diffSource: CodeViewerSource | undefined,
  fileSource: CodeViewerSource,
): CodeViewerSource {
  return diffSource ?? fileSource;
}

export function openChangeSummaryDiffViewer(
  source: CodeViewerSource | undefined,
  onOpenCodeViewer: ((source: CodeViewerSource) => void) | undefined,
) {
  if (!source || !onOpenCodeViewer) {
    return false;
  }

  onOpenCodeViewer(source);
  return true;
}
