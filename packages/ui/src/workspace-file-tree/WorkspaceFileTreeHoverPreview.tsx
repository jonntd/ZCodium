import { useEffect, useState } from "react";
import { FileIcon } from "lucide-react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import {
  formatHoverPreviewSize,
  resolveHoverPreviewKind,
  HOVER_PREVIEW_TEXT_BYTES,
  HOVER_PREVIEW_IMAGE_MAX_BYTES,
} from "@/workspace-file-tree/hoverPreview.js";

/** 悬停打开/关闭延迟（spec: docs/spec/side-pane-file-preview.md §9）。 */
export const HOVER_PREVIEW_OPEN_DELAY_MS = 600;
export const HOVER_PREVIEW_CLOSE_DELAY_MS = 100;

/**
 * 树行悬停预览的内容体（spec: docs/spec/side-pane-file-preview.md §9）：
 * 由 RowView 把它放进 HoverCardContent。状态全部本地——读取随卡片挂载、
 * 关闭即卸载；不进全局 store、不持久化。
 */
export function WorkspaceFileTreeHoverPreviewBody({
  path,
  title,
  workspacePath,
  workspaceIdentity,
  workspaceRemoteSessionId,
}: {
  path: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceRemoteSessionId?: string;
}) {
  const { intl } = useZCodeIntl();
  const { fileService } = useWorkspaceServices(
    workspacePath,
    workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const kind = resolveHoverPreviewKind(path);
  const [state, setState] = useState<HoverPreviewBodyState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    // 一次悬停至多一个在途读取；卡片关闭即卸载，cancelled 防止迟到的旧结果覆盖新悬停。
    // 图片走无状态 readMediaPreview（base64，随卡片卸载自然丢弃，无释放语义）；
    // 超 512KB 或读取失败降级简卡。
    const pending =
      kind === "image"
        ? fileService
            .readMediaPreview({ path, maxBytes: HOVER_PREVIEW_IMAGE_MAX_BYTES })
            .then((preview) => {
              if (!cancelled) {
                setState({
                  status: "image",
                  dataUrl: `data:${preview.mediaType};base64,${preview.dataBase64}`,
                  totalBytes: preview.totalBytes,
                });
              }
            })
        : fileService.readTextFile({ path, length: HOVER_PREVIEW_TEXT_BYTES }).then((slice) => {
            if (cancelled) {
              return;
            }
            if (slice.isBinary) {
              setState({ status: "fallback" });
              return;
            }
            setState({
              status: "text",
              content: slice.content,
              truncated: slice.truncated,
              totalBytes: slice.totalBytes,
            });
          });
    void pending.catch(() => {
      if (!cancelled) {
        // 读取失败（含图片超 512KB）：降级简卡引导点击——点击后在 PreviewPane
        // 能看到真实错误，悬停卡不重复错误表面。
        setState({ status: "fallback" });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fileService, kind, path]);

  const sizeText =
    state.status === "text" || state.status === "image"
      ? formatHoverPreviewSize(state.totalBytes)
      : null;
  const truncatedHint = intl.formatMessage({
    id: "workspaceFileTree.hoverPreview.truncated",
  });
  const openHint = intl.formatMessage({ id: "workspaceFileTree.hoverPreview.openHint" });

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-ui-xs font-medium text-foreground">{title}</span>
        {sizeText ? (
          <span className="shrink-0 text-ui-xs text-foreground-subtle">{sizeText}</span>
        ) : null}
      </div>
      {state.status === "loading" ? (
        <div className="flex h-16 items-center justify-center text-ui-xs text-foreground-subtle">
          …
        </div>
      ) : null}
      {state.status === "text" ? (
        <>
          <pre className="max-h-72 overflow-auto whitespace-pre break-all font-mono text-ui-xs leading-4 text-foreground-subtle">
            {state.content}
          </pre>
          {state.truncated ? (
            <div className="text-ui-xs text-foreground-subtle/80">{truncatedHint}</div>
          ) : null}
        </>
      ) : null}
      {state.status === "image" ? (
        <img
          src={state.dataUrl}
          alt={title}
          className="max-h-48 w-auto self-start rounded-md object-contain"
          draggable={false}
        />
      ) : null}
      {state.status === "fallback" ? (
        <div className="flex items-center gap-1.5 text-ui-xs text-foreground-subtle">
          <FileIcon className="size-3.5 shrink-0" />
          <span>{openHint}</span>
        </div>
      ) : null}
    </div>
  );
}

type HoverPreviewBodyState =
  | { status: "loading" }
  | {
      status: "text";
      content: string;
      truncated: boolean;
      totalBytes: number;
    }
  | { status: "image"; dataUrl: string; totalBytes: number }
  | { status: "fallback" };
