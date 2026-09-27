import assert from "node:assert/strict";
import test from "node:test";
import {
  formatHoverPreviewSize,
  resolveHoverPreviewKind,
  HOVER_PREVIEW_TEXT_BYTES,
  HOVER_PREVIEW_IMAGE_MAX_BYTES,
} from "../src/workspace-file-tree/hoverPreview.js";

// 树行悬停预览（docs/spec/side-pane-file-preview.md §9）：
// 图片/媒体/PDF/PPTX 走「点击查看」简卡，其余尝试文本读取，未知二进制由
// readTextFile 的 isBinary 兜底进简卡。

test("悬停预览：图片走缩略图档，媒体/PDF/PPTX 走简卡，其余走文本读取", () => {
  assert.equal(resolveHoverPreviewKind("/repo/logo.png"), "image");
  assert.equal(resolveHoverPreviewKind("/repo/logo.PNG"), "image");
  assert.equal(resolveHoverPreviewKind("/repo/logo.jpg"), "image");
  assert.equal(resolveHoverPreviewKind("/repo/demo.mp4"), "fallback");
  assert.equal(resolveHoverPreviewKind("/repo/spec.pdf"), "fallback");
  assert.equal(resolveHoverPreviewKind("/repo/deck.pptx"), "fallback");
  assert.equal(resolveHoverPreviewKind("/repo/index.ts"), "text");
  assert.equal(resolveHoverPreviewKind("/repo/README.md"), "text");
  assert.equal(resolveHoverPreviewKind("/repo/config.json"), "text");
  // 未知扩展名（可能是二进制）也先走文本读取，由 isBinary 兜底进简卡。
  assert.equal(resolveHoverPreviewKind("/repo/bundle.zip"), "text");
});

test("悬停预览：大小文案按 KB/MB 格式化", () => {
  assert.equal(formatHoverPreviewSize(0), "1 KB");
  assert.equal(formatHoverPreviewSize(512), "1 KB");
  assert.equal(formatHoverPreviewSize(16 * 1024), "16 KB");
  assert.equal(formatHoverPreviewSize(2 * 1024 * 1024 + 512 * 1024), "2.5 MB");
});

test("悬停预览：文本读取上限 16KB、图片缩略图上限 512KB", () => {
  assert.equal(HOVER_PREVIEW_TEXT_BYTES, 16384);
  assert.equal(HOVER_PREVIEW_IMAGE_MAX_BYTES, 512 * 1024);
});
