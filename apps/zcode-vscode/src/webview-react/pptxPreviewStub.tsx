/**
 * PPTX 预览运行时桩（webview 构建面专用，架构 §7.2 ①「误引排除：PreviewPane 族」）。
 *
 * PPTX 预览依赖 aiden0z/pptx-renderer + pptxRendererPreviewEngine（bundle 内 ~2.5MB，
 * 且其 canvas 渲染面在插件 webview 属 §7.2 排除族）；esbuild.mjs 以别名把
 * `@/previewPanePptxContent.js` 重定向到本桩，PPTX 预览降级为占位提示。
 *
 * 仅替换运行时：类型面经 `typeof import` 对齐真实模块（type 位置会被擦除）。
 * 真实模块：packages/ui/src/previewPanePptxContent.tsx。
 */

type RealModule = typeof import("@/previewPanePptxContent.js");

export function PptxPreviewContent(
  ...args: Parameters<RealModule["PptxPreviewContent"]>
): ReturnType<RealModule["PptxPreviewContent"]> {
  void args;
  return (
    <div className="flex items-center justify-center p-4 text-sm text-foreground-subtle">
      插件端暂不支持 PPTX 内嵌预览，请在 ZCodium 桌面端查看该文件。
    </div>
  );
}
