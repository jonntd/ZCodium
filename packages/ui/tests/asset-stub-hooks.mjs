/**
 * node:test 资产桩钩子：`.png/.svg/.css` 等静态资产在加载期直接返回空模块。
 *
 * 背景（CI: ERR_UNKNOWN_FILE_EXTENSION，2026-11-19 起 branches 全红）：
 * `src/lib/pluginIconSource.ts` 等模块静态 `import x from "@/assets/.../*.png"`，
 * 该导入链经 `@/plugin-ui/index.js` 桶文件可达 `test/workspaceSidebarVisibilityPreference.test.ts`
 * 等 node:test 文件。vitest/esbuild 有资产管线，node（tsx 链）没有——加载期即抛
 * `Unknown file extension ".png"` 并炸掉整个 node:test 进程。
 *
 * 本钩子只拦资产的 `load`，其余全部委托下一环（tsx），对 vitest 零影响。
 */
const ASSET_RE = /\.(png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|css)$/;

export async function load(url, context, nextLoad) {
  if (ASSET_RE.test(new URL(url).pathname)) {
    return { format: "module", source: "export default '';", shortCircuit: true };
  }
  return nextLoad(url, context);
}
