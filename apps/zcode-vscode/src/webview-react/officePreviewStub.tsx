/**
 * Office 预览运行时桩（webview 构建面专用，架构 §7.2 ①「误引排除：PreviewPane 族」）。
 *
 * 插件 webview CSP（script-src 'nonce-…'）不允许 wasm 实例化（缺 wasm-unsafe-eval），
 * 且 react-xlsx/react-docx 的 wasm 共 ~5.5MB 属 §7.2 排除族——esbuild.mjs 以别名把
 * `@/previewPaneOfficeContent.js` 重定向到本桩，Office/工作流产物内嵌预览降级为占位提示。
 *
 * 仅替换运行时：类型面经 `typeof import` 对齐真实模块（type 位置会被擦除，不引入 wasm
 * 运行时依赖）。真实模块：packages/ui/src/previewPaneOfficeContent.tsx。
 */

type RealModule = typeof import("@/previewPaneOfficeContent.js");

export function PreviewPaneOfficeContent(
  ...args: Parameters<RealModule["PreviewPaneOfficeContent"]>
): ReturnType<RealModule["PreviewPaneOfficeContent"]> {
  // 消费方（previewPaneContent / WorkflowArtifactBody）传 props 渲染预览区；
  // 桩不消费 props，仅给出占位文案。
  void args;
  return (
    <div className="flex items-center justify-center p-4 text-sm text-foreground-subtle">
      插件端暂不支持 Office 文件内嵌预览，请在 ZCodium 桌面端查看该文件。
    </div>
  );
}
