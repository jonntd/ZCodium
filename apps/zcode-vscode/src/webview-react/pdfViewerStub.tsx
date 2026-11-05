/**
 * PDF 预览运行时桩（webview 构建面专用，架构 §7.2 ①「误引排除：PreviewPane 族」）。
 *
 * react-pdf/pdfjs 的 worker 以 vite `?url` 约定导入（packages/ui/src/components/ui/pdf-viewer.tsx:8），
 * esbuild 构建面不识别该约定（无法落 worker 资产 URL）；插件端 PDF 内嵌预览降级为
 * 占位提示。类型面 re-export 真实模块（`export type` 会被擦除，不引入运行时依赖）。
 * esbuild.mjs 以别名把 `@/components/ui/pdf-viewer.js` 重定向到本桩。
 */

export type {
  PdfViewerRangeSource,
  PdfViewerSource,
  PdfViewerLabels,
  PdfViewerProps,
} from "@/components/ui/pdf-viewer.js";

type RealModule = typeof import("@/components/ui/pdf-viewer.js");

export function PdfViewer(
  ...args: Parameters<RealModule["PdfViewer"]>
): ReturnType<RealModule["PdfViewer"]> {
  // 消费方（previewPanePdfContent / ChatMediaAttachmentPreviewDialog 等）传 props 渲染；
  // 桩不消费 props，仅给出占位文案。
  void args;
  return (
    <div className="flex items-center justify-center p-4 text-sm text-foreground-subtle">
      插件端暂不支持 PDF 内嵌预览，请在 ZCodium 桌面端查看该文件。
    </div>
  );
}
