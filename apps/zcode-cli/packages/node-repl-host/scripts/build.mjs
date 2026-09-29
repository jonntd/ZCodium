import { mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { createZcodeCuaRuntimeAliasPlugin } from "../../../../../scripts/zcode-cua-runtime-alias.mjs";

const packageRoot = resolve(import.meta.dirname, "..");
// CUA runtime alias（docs/spec/cua-runtime-builtin.md §A）：workspace 的 @zcode/zcode-cua
// 是 fail-closed stub，本包内联的 helperInstaller/懒启动路径需要 runtimes/zcode-cua
// 真实现才能在打包态安装/拉起 Helper。仅 bundler 层替换，typecheck 仍解析 stub。
const zcodeCuaRuntimeAliasPlugin = createZcodeCuaRuntimeAliasPlugin({
  runtimeRoot: resolve(packageRoot, "../../../../runtimes/zcode-cua"),
});

// 见 browser-use-plugin/scripts/build.mjs 的同名修复：esbuild 的 esm 产物里
// __require shim 在 ESM 作用域没有 require 可用，@zcode/core 拖进来的 CJS 依赖（yaml →
// require("process")）会在**模块求值阶段**抛错，plugin host 的 await import() 直接失败，
// 表现为注册 0 个工具、模型侧完全看不到 mcp__node_repl__js。注入真实 createRequire。
const nodeRequireBanner = `import { createRequire as __zcodeCreateRequire } from "node:module";
const require = __zcodeCreateRequire(import.meta.url);`;

// 正式包上 Computer Use 曾完全
// 不可用 —— 每个 CUA 调用要么等到 MCP 客户端超时（实测 60/110/120s），要么等满 ~64s 后返回
// 「permission broker socket is not accepting connections yet」。
//
// 链路：懒启动（services/src/node.ts 的 `懒启动` 注释处）把 darwin 上 Helper 的
// 安装/拉起从宿主搬到了「SDK 首次 CUA 调用时自拉」，而那条路径跑在**本包**里 ——
// `helperInstaller` 因此随本 bundle 进入正式包。但 `__ZCODE_CUA_HELPER_BUILD_ID__` 此前
// **只有** packages/desktop/tsup.config.ts 注入（Electron main / app.asar），本文件的
// esbuild 调用一个 define 都没有。于是正式包里 producer 的 `ZCODE_CUA_HELPER_BUILD_ID`
// 折叠成空串（见 zcode-cua/src/broker/shared/cua-version.ts 的兜底），
// `resolveExpectedCuaHelperBuildId()` 返回 null，helperInstaller 撞上 fail-closed 守卫：
//
//   "Packaged ZCode is missing its embedded Computer Use Helper build identity;
//    refusing an unpinned Helper install"
//
// 结果 Helper 既不装也不起、一行日志都不写，而这句 throw 被 MCP 层翻成超时，没有落盘点 ——
// 所以它一直是隐形的。实证：宿主日志里 `[cua-product-helper]` 在 09-11（宿主路径，有 define）
// 有 5 行，09-14 为 0 行；`~/.zcode/computer-use/logs/` 从未创建；把已安装的 Helper 改名后
// 也不会重装。dev 不受影响（ALLOW_UNSIGNED_LOCAL + 非 production runtime 绕过该守卫），
// 所以只在正式包暴露，本地怎么测都测不出来。
//
// 取值与 desktop 侧保持同一来源：CI 注入 ZCODE_CUA_HELPER_BUILD_ID env；dev 为空串走兜底
// （dev Helper 不走下载/pin 校验）。见 packages/desktop/tsup.config.ts 同名 define 的注释。
const resolveCuaHelperBuildId = (env = process.env) =>
  env.ZCODE_CUA_HELPER_BUILD_ID?.trim() ?? "";

// workspace stub 的 fail-closed 文案。alias 插件生效时它不可能进入产物；出现即说明
// alias 漂移（入口漏挂、exports 表改名），打包态 CUA 会整体静默失效，直接失败。
const ZCODE_CUA_STUB_MARKER = "Computer Use is not available in this build.";

export const buildNodeReplHostBundle = async ({
  outfile = resolve(packageRoot, "dist", "mcp", "server.js"),
  cuaHelperBuildId = resolveCuaHelperBuildId(),
} = {}) => {
  await mkdir(dirname(outfile), { recursive: true });
  await build({
    banner: { js: nodeRequireBanner },
    bundle: true,
    plugins: [zcodeCuaRuntimeAliasPlugin],
    define: {
      __ZCODE_CUA_HELPER_BUILD_ID__: JSON.stringify(cuaHelperBuildId),
      // 与 desktop tsup 同名 define 同语义：vendor 信任门据此判定本地开发运行时
      // （unsigned Helper 逃生口 / buildId env 覆盖）。本包只随 dev 与打包链构建，
      // 这里按构建机 NODE_ENV 折叠，打包链（NODE_ENV=production）为 false。
      __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__: JSON.stringify(process.env.NODE_ENV !== "production"),
    },
    entryPoints: [resolve(packageRoot, "src", "server.ts")],
    format: "esm",
    legalComments: "none",
    outfile,
    platform: "node",
    target: "node24",
  });
  // 构建期守卫：define 名一旦漂移（改名、被 createSharedDefines 之类重构吞掉），
  // 产物会静默退回空串，而症状只在正式包出现且表现为超时。这里立刻失败，别再让它溜到用户手上。
  const bundled = await readFile(outfile, "utf8");
  if (cuaHelperBuildId && !bundled.includes(cuaHelperBuildId)) {
    throw new Error(
      `[node-repl-host] ZCODE_CUA_HELPER_BUILD_ID=${cuaHelperBuildId} 未折叠进 ${outfile}：` +
        "__ZCODE_CUA_HELPER_BUILD_ID__ define 没有生效，正式包的 Helper 安装会被 fail-closed 拒绝。",
    );
  }
  if (bundled.includes(ZCODE_CUA_STUB_MARKER)) {
    throw new Error(
      `[node-repl-host] ${outfile} 含 workspace stub 残留（"${ZCODE_CUA_STUB_MARKER}"）：` +
        "@zcode/zcode-cua alias 未生效，打包态 Computer Use 会整体失效。",
    );
  }
  return { outfile, cuaHelperBuildId };
};

// 这里原先写成 `file://${process.argv[1]}`。
// Windows 上 argv[1] 是 `C:\...\build.mjs`，而 import.meta.url 是 `file:///C:/.../build.mjs`，
// 两者永远不相等 —— 脚本被当成纯模块导入，什么都不做就退出：构建"成功"却没有产物，
// 直到 dev 守卫报「build succeeded without required MCP runtime」才暴露。
// browser-use 的同名脚本与仓库其他入口都用 pathToFileURL，抽包时我漏了这一处。
const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const { outfile } = await buildNodeReplHostBundle();
  console.log(`[node-repl-host] ${outfile}`);
}
