/**
 * Gode VS Code 插件三产物打包脚本（架构 §7.1）。
 *
 * - extension host bundle：CJS、platform node、external vscode；
 *   内联 @zcode/shared + @zcode/services + @zcode/rpc + zod 成单文件
 *   dist/extension.js（.vsix 内零 node_modules）。不引 @zcode/client 与 @zcode/ui。
 * - webview bundle：ESM + code splitting（§7.2 ④懒加载：mermaid/shiki 重语言等
 *   dynamic-import 子树拆为按需 chunk，首屏 main.js 才能进 8MB 预算）、platform browser
 *   （node 内建导入构建期即失败——H10 护栏）；chatPanel 以 type="module" + cspSource
 *   白名单加载。内联 react@19 + @zcode/ui（cherry-pick 装配面）+ @zcode/shared +
 *   @zcode/client + @zcode/rpc。alias `@` → packages/ui/src（ui 包内部别名，与
 *   packages/web 同款处理）；§7.2 ①误引排除族（Office/PDF/PPTX 预览）别名到本地桩。
 * - CSS：@tailwindcss/node 程序化 API（tailwind v4）产出 dist/webview/styles.css
 *   （入口 src/webview-react/styles.css，`@source` 仅扫 webview-react 装配闭包 + ui styles 层）。
 */
import * as esbuild from "esbuild";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(here, "../..");
const watch = process.argv.includes("--watch");

/** @type {import("esbuild").BuildOptions} */
const extensionOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  // node-pty：含平台原生二进制（pty.node/spawn-helper），esbuild 只能内联其 JS，
  // 原生 .node 的动态 require（`build/Release/pty.node` 相对解析）在安装目录必然
  // 失败。保持 external，由打包脚本把整包 node-pty 拷进扩展（见 package-node-pty.mjs）。
  external: ["vscode", "node-pty"],
  outfile: "dist/extension.js",
  sourcemap: false,
  // §7.2 ③：minify + legalComments:none 是体积门禁（≤9MB）的预算内处置手段。
  minify: true,
  logLevel: "info",
  legalComments: "none",
  // 无 `#src` 别名：各包内部 `#src/*` 子路径导入由 esbuild 原生按所属包
  // package.json 的 `imports` 字段解析（shared/services 各自映射到自己的 src/），
  // 全局别名会把 @zcode/shared 的内部导入错误劫持到 packages/services。
  define: {
    // 构建期烙入 monorepo 根（fullui 产物定位，见 webviewOptions 同名 define）。
    __ZCODE_REPO_ROOT__: JSON.stringify(resolve(here, "../..")),
  },
};

/** @type {import("esbuild").BuildOptions} */
const webviewOptions = {
  // 对象形式入口：main 是页面装配面；两个 worker 由 esbuild 以独立 entry 打包成
  // dist/webview/workers/*.js。esbuild 不重写 `new Worker(new URL(...))` 模式
  // （0.25 实测：输出里保留源码路径、零 chunk），运行时 worker URL 404 →
  // WorkerPoolManager 只 console.error 不降级 → 代码块高亮渲染永久挂起、
  // 文件搜索永远走降级路径。所以 worker 必须显式作为 entry 打包，
  // 源码侧用运行时拼接的 URL 指向打包产物（见 DiffsWorkerPoolProvider 注释）。
  entryPoints: [
    { in: "src/webview-react/index.tsx", out: "main" },
    {
      in: resolve(repoRoot, "packages/ui/src/workers/diffs.worker.ts"),
      out: "workers/diffs.worker",
    },
    {
      in: resolve(repoRoot, "packages/ui/src/workspace-file-search/workspaceFileSearchFilter.worker.ts"),
      out: "workers/workspaceFileSearchFilter.worker",
    },
  ],
  bundle: true,
  // §7.2 ④懒加载：ESM + code splitting 把 mermaid/echarts/shiki 重语言等
  // dynamic-import 子树拆出首屏 main.js（webview CSP 允许同目录 chunk 经
  // webview.cspSource 加载；chatPanel 的 <script> 需 type="module" 配合）。
  format: "esm",
  splitting: true,
  platform: "browser",
  target: "es2022",
  outdir: "dist/webview",
  // 主入口固定为 main.js（check-bundle-size.mjs 与 chatPanel 的产物契约）；
  // 其余入口名由 entryPoints 的 out 决定，不能用全局 entryNames 覆盖。
  sourcemap: false,
  // §7.2 ③：minify（未压缩 ≤8MB / gzip ≤2.5MB 门禁）。
  minify: true,
  logLevel: "info",
  legalComments: "none",
  define: {
    // ui 包源码在浏览器装配面使用的环境常量；webview 不连 ZCode 云端点，全部给安全默认值。
    "__ZCODE_VERSION__": JSON.stringify("0.2.0"),
    "__ZCODE_COMMIT__": JSON.stringify("vscode"),
    "__ZCODE_ENV__": JSON.stringify("production"),
    "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(""),
    "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(""),
    "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify(""),
    "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify(""),
    "process.env.NODE_ENV": JSON.stringify("production"),
    // Vite 环境面（ui/web 源码散读 DEV/PROD/BASE_URL/MODE；esbuild 不做 Vite 的
    // import.meta.env 注入，缺了就是 "Cannot read properties of undefined (reading 'DEV')"
    // ——Antigravity 实测崩溃）。生产构建固定生产值。
    // 注意：本对象是 webviewOptions 唯一的 define 键——历史上曾在此下方再写一个只含
    // __ZCODE_REPO_ROOT__ 的同名 define 键，对象字面量重复键后者胜出，整块注入被
    // 静默丢弃（运行时 reading 'PROD' 崩溃，2026-11-06 实测）。合并为一处。
    "import.meta.env.DEV": "false",
    "import.meta.env.PROD": "true",
    "import.meta.env.MODE": JSON.stringify("production"),
    "import.meta.env.BASE_URL": '"/"',
    "import.meta.env.SSR": "false",
    // 整对象兜底：`const env = import.meta.env`（RewardsWebview 等）整体读取的路径。
    // esbuild 更具体的子路径 define（上方）优先于本整体 define。
    "import.meta.env": JSON.stringify({
      DEV: false,
      PROD: true,
      MODE: "production",
      BASE_URL: "/",
      SSR: false,
      VITE_ZCODE_BASE_URL: "",
      VITE_ZCODE_ENDPOINT_ORIGIN: "",
      VITE_ZAI_OAUTH_CLIENT_ID: "",
      VITE_ZAI_OAUTH_ORIGIN: "",
    }),
    // 构建期烙入 monorepo 根：fullui（完整界面）需要定位 packages/server|web 的本机构建产物。
    // 发行版打包时若产物策略变化，可改由此 define 注入其他路径。
    __ZCODE_REPO_ROOT__: JSON.stringify(resolve(here, "../..")),
  },
  alias: {
    // ui 包内部 `@/...` 别名（与 packages/web/vite.config.ts 同款消费方别名）。
    // `#src/*` 不设全局别名：shared/services 的内部子路径导入走各包 `imports` 字段
    // （原生解析），见上方 extensionOptions 注释。
    "@": resolve(repoRoot, "packages/ui/src"),
    // §7.2 ①误引排除：Office 预览族（wasm ~5.5MB + webview CSP 禁 wasm 实例化）
    // 不进插件 webview，替换为类型兼容桩（src/webview-react/officePreviewStub.tsx）。
    // 两条消费链（AnimatedSidePanePanel→PreviewPane→previewPaneContent 静态链与
    // WorkflowArtifactBody 动态 import）都汇聚在 `@/previewPaneOfficeContent.js` 这一个
    // specifier 上，别名最具体前缀优先于上面的 `@` 通配。
    "@/previewPaneOfficeContent.js": resolve(here, "src/webview-react/officePreviewStub.tsx"),
    // §7.2 ①误引排除：PDF 预览族——react-pdf worker 走 vite `?url` 导入，esbuild
    // 构建面不识别该约定；替换为类型兼容桩（src/webview-react/pdfViewerStub.tsx）。
    "@/components/ui/pdf-viewer.js": resolve(here, "src/webview-react/pdfViewerStub.tsx"),
    // §7.2 ①误引排除：PPTX 预览族（pptx-renderer ~2.5MB，canvas 渲染面属排除族）。
    "@/previewPanePptxContent.js": resolve(here, "src/webview-react/pptxPreviewStub.tsx"),
    // 装配闭包内 JS 侧最后的 css side-effect 导入重定向为空模块：样式统一走 tailwind
    // 入口 styles.css，JS 构建面不再产出孤儿 main.css（样式已在 styles.css @import 收口）。
    "@/v4/composer/composerStats.css": resolve(here, "src/webview-react/emptyCssStub.ts"),
  },
  // react/react-dom 解析到仓库根部 19.x（webview 侧必需）。
  resolveExtensions: [".tsx", ".ts", ".jsx", ".js", ".css", ".json"],
  // ui 装配闭包 JS 侧 import 的二进制资产（ui assets：渠道/provider 图标、通知音效、
  // 字体）按 §7.1 loader:file 落盘（outfile 模式落 dist/webview/ 旁路，哈希命名）；
  // 缺 loader 会在 .mp3/.png/.svg 上构建失败。
  loader: {
    ".woff": "file",
    ".woff2": "file",
    ".ttf": "file",
    ".otf": "file",
    ".eot": "file",
    ".png": "file",
    ".jpg": "file",
    ".jpeg": "file",
    ".gif": "file",
    ".webp": "file",
    ".svg": "file",
    ".mp3": "file",
    ".wav": "file",
  },
};

/**
 * 用 @tailwindcss/cli 产出 tailwind v4 CSS。
 *
 * 历史 Bug（Antigravity 实测暴露）：曾用 @tailwindcss/node 程序化 API
 * `compile() + build([])`——该 API 的 candidates 由调用方提供，**不含自动内容扫描**，
 * 空数组 = 零工具类生成（styles.css 只剩主题变量层：invisible/absolute/flex 全缺失，
   ui 隐身测量串现形 → 草稿问候语渲染两遍、布局失去间距）。修复 = 走 CLI（自带 Scanner，
   按 styles.css 的 @source 指令扫描：本目录装配闭包 + packages/ui/src 类来源）。
 */
async function buildStyles() {
  const { execFileSync } = await import("node:child_process");
  const { mkdir, readFile } = await import("node:fs/promises");
  const input = resolve(here, "src/webview-react/styles.css");
  const output = resolve(here, "dist/webview/styles.css");
  await mkdir(resolve(here, "dist/webview"), { recursive: true });
  // CLI bin 经 @tailwindcss/cli 的 package.json 定位（pnpm workspace 提升到根 node_modules）。
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const cliPkgDir = resolve(require.resolve("@tailwindcss/cli/package.json"), "..");
  const cliEntry = resolve(cliPkgDir, "dist/index.mjs");
  execFileSync(
    process.execPath,
    [cliEntry, "-i", input, "-o", output, "--minify"],
    { stdio: "inherit", cwd: here },
  );
  // styles.css 内联的 katex css 保留相对字体 URL（url(fonts/KaTeX_*.woff2)）——
  // tailwind 不复制二进制资产，这里按 URL 约定落 dist/webview/fonts/（§7.1 资产行）。
  const katexFonts = resolve(repoRoot, "node_modules/katex/dist/fonts");
  try {
    const { readdir, copyFile } = await import("node:fs/promises");
    await mkdir(resolve(here, "dist/webview/fonts"), { recursive: true });
    for (const font of await readdir(katexFonts)) {
      await copyFile(resolve(katexFonts, font), resolve(here, "dist/webview/fonts", font));
    }
  } catch {
    // katex 字体缺失不阻塞构建：math 渲染回退系统字体。
  }
  await readFile(output, "utf8");
  console.log("[esbuild] styles.css 产出完成");
}

if (watch) {
  const ctxExt = await esbuild.context(extensionOptions);
  const ctxWeb = await esbuild.context(webviewOptions);
  await Promise.all([ctxExt.watch(), ctxWeb.watch()]);
  await copyMaterialFileIcons();
  console.log("[esbuild] watch 模式已启动");
} else {
  // ZCODE_WEBVIEW_METAFILE=<path>：产出 webview metafile 供 §7.2 体积分析
  // （写 dist 外路径，避免混入门禁的 dist 总量）。
  const metafilePath = process.env.ZCODE_WEBVIEW_METAFILE;
  if (metafilePath) webviewOptions.metafile = true;
  const webResult = await esbuild.build(webviewOptions);
  await esbuild.build(extensionOptions);
  await buildStyles();
  await copyMaterialFileIcons();
  if (metafilePath && webResult.metafile) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(metafilePath, JSON.stringify(webResult.metafile), "utf8");
    console.log(`[esbuild] webview metafile 已写入 ${metafilePath}`);
  }
  console.log(
    "[esbuild] 构建完成：dist/extension.js + dist/webview/main.js + dist/webview/styles.css",
  );
}

/**
 * 文件图标素材（fileDisplay.buildMaterialFileIconSrc）在 web/desktop 由 public/
 * material-icons 静态目录承担；VS Code webview 的文档 URL 不是扩展目录（相对路径
 * 全部落空），素材必须随产物携带。这里整体拷进 dist/webview/material-icons，
 * 运行时基址由 buildChatWebviewHtml 经 bootstrap data-icon-base 注入
 * （webview.asWebviewUri），CSP img-src cspSource 放行。
 */
async function copyMaterialFileIcons() {
  const { cpSync } = await import("node:fs");
  const source = resolve(repoRoot, "packages/web/public/material-icons");
  try {
    cpSync(source, resolve(here, "dist/webview/material-icons"), { recursive: true });
    console.log("[esbuild] material-icons 已拷入 dist/webview/");
  } catch (error) {
    console.warn(
      "[esbuild] material-icons 拷贝失败（文件图标将回退内置占位）：",
      error instanceof Error ? error.message : String(error),
    );
  }
}
