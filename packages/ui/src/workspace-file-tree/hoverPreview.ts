import {
  inferMediaPreview,
  isImagePreviewPath,
  isPdfPreviewPath,
  isPptxPreviewPath,
} from "@/lib/codeViewer.js";

/** 悬停预览的文本读取上限（spec: docs/spec/side-pane-file-preview.md §9）。 */
export const HOVER_PREVIEW_TEXT_BYTES = 16 * 1024;

/** 悬停图片缩略图的读取上限：超限走简卡降级，保证悬停响应速度。 */
export const HOVER_PREVIEW_IMAGE_MAX_BYTES = 512 * 1024;

export type HoverPreviewKind = "text" | "image" | "fallback";

/**
 * 悬停预览分流：图片走 readMediaPreview 缩略图（无状态 base64，随卡片卸载自然
 * 丢弃）；音视频/PDF/PPTX 走「点击查看」简卡（播放器/大文档不适合悬停卡）；
 * 其余尝试按文本读取，未知二进制由 readTextFile 的 isBinary 兜底进简卡。
 */
export function resolveHoverPreviewKind(path: string): HoverPreviewKind {
  if (isImagePreviewPath(path)) {
    return "image";
  }
  if (inferMediaPreview(path) || isPdfPreviewPath(path) || isPptxPreviewPath(path)) {
    return "fallback";
  }
  return "text";
}

/** 头部大小文案：KB 保留整数（至少 1 KB），≥1MB 显示 MB。 */
export function formatHoverPreviewSize(totalBytes: number): string {
  if (totalBytes >= 1024 * 1024) {
    return `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(totalBytes / 1024))} KB`;
}
