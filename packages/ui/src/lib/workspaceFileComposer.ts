import type { MutableRefObject } from "react";
// LexicalChatInput 壳恢复后回归原始句柄类型（过渡的 ComposerInputHandle 最小面退役）。
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { basenameFromPath } from "@/lib/chatAttachmentMetadata.js";
import {
  createWorkspaceFileComposerMention,
  type WorkspaceFileDragPayload,
} from "@/lib/workspaceFileDrag.js";
import { toWorkspaceRelativePath } from "@/lib/taskChangeSummary.js";

export function appendWorkspaceFileMentionToComposer(params: {
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  currentMarkdown: string;
  payload: WorkspaceFileDragPayload;
  workspacePath: string;
  workspaceIdentity?: string;
  onTextChange: (text: string) => void;
}) {
  const mention = createWorkspaceFileComposerMention(
    params.payload,
    params.workspacePath,
    params.workspaceIdentity,
  );
  const separator =
    params.currentMarkdown.length > 0 && !/\s$/.test(params.currentMarkdown)
      ? " "
      : "";
  const nextText = `${params.currentMarkdown}${separator}${mention.markdown} `;

  params.onTextChange(nextText);
  params.inputApiRef.current?.appendFileMention(
    params.payload.name,
    mention.value,
    mention.markdown,
    mention.data,
  );
  params.inputApiRef.current?.focus();

  return nextText;
}

/**
 * 资源管理器拖拽批量注入（spec: composer-explorer-file-drop v2）：
 * N 个本地文件 → N 个 `@pill`，文本面按序拼接（同 workspace 用 relativePath）。
 * path 必须已经 host resolveFileDropPaths 校验（存在且为普通文件）。
 */
export function appendExplorerFileDropMentionsToComposer(params: {
  inputApiRef: MutableRefObject<LexicalChatInputHandle | null>;
  currentMarkdown: string;
  resolvedPaths: readonly string[];
  workspacePath: string;
  workspaceIdentity?: string;
  onTextChange: (text: string) => void;
}): string {
  let text = params.currentMarkdown;
  for (const filePath of params.resolvedPaths) {
    const payload: WorkspaceFileDragPayload = {
      type: "file",
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      path: filePath,
      relativePath: toWorkspaceRelativePath(params.workspacePath, filePath),
      name: basenameFromPath(filePath),
    };
    text = appendWorkspaceFileMentionToComposer({
      inputApiRef: params.inputApiRef,
      currentMarkdown: text,
      payload,
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      onTextChange: params.onTextChange,
    });
  }
  return text;
}
