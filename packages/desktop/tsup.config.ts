import { pickProductEndpointEnv } from "@zcode/shared/zcodeEndpoint";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "tsup";
import { getBuildMetadata } from "./scripts/build-metadata.mjs";
import { resolveDesktopProductFlavor } from "./scripts/desktop-product-identity.mjs";
import { resolveUpdateFeedTarget } from "./scripts/update-feed-target.mjs";
// tsup 会先打包配置文件；动态加载构建工具，避免其 import.meta.dirname 被重定位到 desktop。
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);
// CUA runtime alias 插件同样含 import.meta 消费面（读 runtime 包 exports 表），
// 与 builtin-provider-config 同理走动态加载（docs/spec/cua-runtime-builtin.md §A）。
const { createZcodeCuaRuntimeAliasPlugin } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/zcode-cua-runtime-alias.mjs")).href
);
const zcodeCuaRuntimeAliasPlugin = createZcodeCuaRuntimeAliasPlugin({
  runtimeRoot: resolve(import.meta.dirname, "../../runtimes/zcode-cua"),
});

const buildMetadata = getBuildMetadata();
// 更新源仓库坐标与 electron-builder publish 配置同源（update-feed-target.mjs），见 spec github-updates.md。
const updateFeedTarget = resolveUpdateFeedTarget();

// 手动加载 .env 文件，tsup 不像 Vite 会自动读取 .env.*；这些文件只提供链接常量。
function loadEnvFiles(): Record<string, string> {
  const vars: Record<string, string> = {};
  const files = ["../../.env", "../../.env.local"];
  if (process.env.NODE_ENV === "production") {
    files.push("../../.env.production");
  } else {
    files.push("../../.env.development", "../../.env.development.local");
  }
  for (const file of files) {
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2];
      }
    }
  }
  // 真实环境变量优先级最高
  if (process.env.ZCODE_ENV) vars.ZCODE_ENV = process.env.ZCODE_ENV;
  if (process.env.ZCODE_BASE_URL) vars.ZCODE_BASE_URL = process.env.ZCODE_BASE_URL;
  if (process.env.VITE_ZCODE_BASE_URL) vars.VITE_ZCODE_BASE_URL = process.env.VITE_ZCODE_BASE_URL;
  // OAuth origin/client_id 由 host runtime 读取；这里保留覆盖入口，方便开发构建时观察统一 env 来源。
  if (process.env.ZAI_OAUTH_CLIENT_ID) vars.ZAI_OAUTH_CLIENT_ID = process.env.ZAI_OAUTH_CLIENT_ID;
  if (process.env.ZAI_OAUTH_ORIGIN) vars.ZAI_OAUTH_ORIGIN = process.env.ZAI_OAUTH_ORIGIN;
  if (process.env.ZAI_BUSINESS_BASE_URL) {
    vars.ZAI_BUSINESS_BASE_URL = process.env.ZAI_BUSINESS_BASE_URL;
  }
  if (process.env.ZAI_BUSINESS_LOGIN_URL) {
    vars.ZAI_BUSINESS_LOGIN_URL = process.env.ZAI_BUSINESS_LOGIN_URL;
  }
  if (process.env.VITE_ZAI_OAUTH_CLIENT_ID) {
    vars.VITE_ZAI_OAUTH_CLIENT_ID = process.env.VITE_ZAI_OAUTH_CLIENT_ID;
  }
  if (process.env.VITE_ZAI_OAUTH_ORIGIN) {
    vars.VITE_ZAI_OAUTH_ORIGIN = process.env.VITE_ZAI_OAUTH_ORIGIN;
  }
  return {
    ...vars,
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ),
  };
}

const env = loadEnvFiles();
const { environment: zcodeEnv } = await loadBuiltinProviderConfig();
// 安装包身份与后端环境分轴：ZCODE_PREVIEW_IDENTITY=1 让生产后端的构建仍以 ZCode Preview 身份打包运行。
const zcodeProductFlavor = resolveDesktopProductFlavor({ ...process.env, ZCODE_ENV: zcodeEnv });
console.log(`[tsup] ZCODE_ENV=${zcodeEnv} ZCODE_PRODUCT_FLAVOR=${zcodeProductFlavor}`);

export function resolveDesktopTsupBundleSecurityOptions(
  runtimeEnv: Record<string, string | undefined> = process.env,
) {
  const isProduction = runtimeEnv.NODE_ENV === "production";
  const isE2ECoverageBuild = runtimeEnv.ZCODE_E2E_COVERAGE === "1";
  return {
    // 发布包的 main/host/preload 之前没有随 NODE_ENV=production 压缩，
    // 产物保留大量源码注释与格式化换行，增加逆向和内部实现暴露风险。
    keepNames: isProduction && !isE2ECoverageBuild,
    minify: isProduction && !isE2ECoverageBuild,
    // 生产包不随包发布 sourcemap，继续生成 sourceMappingURL 会暴露无效映射路径。
    // E2E coverage build 只会进入隔离 app cache，需要保留 map 才能把 V8 bundle range
    // 还原到 TypeScript 源码；正常发布构建仍保持无 sourcemap。
    sourcemap: isE2ECoverageBuild || !isProduction,
  };
}

type DesktopTsupEsbuildOptions = {
  chunkNames?: string;
  legalComments?: "none" | "inline" | "eof" | "linked" | "external";
};

export function applyDesktopTsupEsbuildSecurityOptions(options: DesktopTsupEsbuildOptions) {
  // 生产压缩时 esbuild 默认可能保留 license/legal 注释，
  // 发布包不应在 main/host/preload 里留下源码注释或 sourcemap 入口注释。
  options.legalComments = "none";
}

const desktopTsupBundleSecurityOptions = resolveDesktopTsupBundleSecurityOptions();

function createSharedDefines() {
  return {
    __ZCODE_VERSION__: JSON.stringify(buildMetadata.appVersion),
    __ZCODE_COMMIT__: JSON.stringify(buildMetadata.buildCommitId),
    __ZCODE_BUILD_TIME__: JSON.stringify(buildMetadata.buildTime),
    __ZCODE_ENV__: JSON.stringify(zcodeEnv),
    __ZCODE_ENDPOINT_ENV__: JSON.stringify(pickProductEndpointEnv(env)),
    __ZCODE_PRODUCT_FLAVOR__: JSON.stringify(zcodeProductFlavor),
    // CUA 本地开发运行时开关：vendor runtime 的信任门（unsigned Helper 逃生口）只在
    // true + ZCODE_RUNTIME_ENV!=production 时放开。必须构建期折叠——
    // vendor 兜底读运行时 process.env.NODE_ENV，而桌面 host 的 NODE_ENV 被有意清空，
    // 不定义的话 dev:desktop 会被误判成生产运行时、helper 装不上。
    __ZCODE_LOCAL_DEVELOPMENT_RUNTIME__: JSON.stringify(process.env.NODE_ENV !== "production"),
    // Helper buildId 不在此折叠（2026-09-30 退役，docs/spec/cua-runtime-builtin.md §C）：
    // vendor 产物在自身构建期已把 buildId 折叠成上游字面量，这里 define 无处替换；
    // 配对由 desktopRuntimeEnv 主进程运行时实测 Info.plist 后经 env 注入。
    // 客户端只有一个 CDN 配置，与发布端 OSS 目标列表分离。
    __ZCODE_CDN_BASE_URL__: JSON.stringify(env.ZCODE_CDN_BASE_URL?.trim() || ""),
    // 桌面更新源仓库坐标（GitHub provider），与 electron-builder publish 配置同源注入。
    __ZCODE_UPDATE_GITHUB_OWNER__: JSON.stringify(updateFeedTarget.owner),
    __ZCODE_UPDATE_GITHUB_REPO__: JSON.stringify(updateFeedTarget.repo),
    // 发布构建内置的自有 remote 资源源（本仓库该 tag 的 GitHub Release 资产）。
    // 注入后安装版开箱即可连接 WSL/SSH；dev/本地构建为空，仍走 mock-cdn / 显式配置。
    __ZCODIUM_REMOTE_ASSET_CDN_BASE_URL__: JSON.stringify(
      process.env.ZCODIUM_REMOTE_ASSET_CDN_BASE_URL?.trim() || "",
    ),
  };
}

const desktopNodeRuntimeExternals = [
  "electron",
  "node-pty",
  "ssh2",
  "undici",
  "@larksuiteoapi/node-sdk",
  "yaml",
  // node-forge 内部用动态 require("crypto")，内联进 ESM main/host bundle 后 Electron 会报
  // Dynamic require of "crypto" is not supported。和 undici 同样保留为运行时外部依赖。
  "node-forge",
  // ZIP 解包器内部依赖 CommonJS require("fs")，不能内联到 ESM main/host 产物。
  "yauzl",
];

function createDevReadyMarkerHook(target: "main" | "host" | "preload"): string {
  // CLI 级 --onSuccess 在多 config watch 模式下会被每个子构建分别触发。
  // 之前 preload 先成功时就提前写入 ready 标记，Electron 仍会在 main/host 未完成时启动。
  // 这里改成每个 config 自己在成功后写独立 marker，让 dev 启动脚本能精确等待全部构建完成。
  return `node scripts/write-dev-ready-marker.mjs ${target}`;
}

export default defineConfig([
  {
    name: "main",
    entry: {
      "main/index": "src/main/index.ts",
      "main/browserWebmRecorder": "src/main/browserView/electronBrowserWebmRecorder.ts",
      "main/zcodeDataSizeWorker": "src/main/zcodeDataSizeWorker.ts",
      // 资源管理器「存储」tab 的扫描 Worker：main 持有 StorageService，遍历放独立线程，供 new Worker(new URL()) 解析。
      "main/storageScanWorker": "src/main/storageScanWorker.ts",
    },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // undici 如果被 main ESM bundle 直接内联，运行时会落到它内部的 CommonJS require("assert")，
    // Electron 加载 main 产物时会报 Dynamic require of "assert" is not supported。
    // desktop 保持 undici 为外部依赖，remote 单文件 bundle 再单独内联。
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      // Provider Refactor 的 workspace 包导出 TypeScript 源码；Electron 生产运行时没有
      // TS loader，必须随 Desktop bundle 内联，不能留下指向 src/index.ts 的裸包引用。
      "@zcode/provider",
      "@zcode/provider-node",
      // services 已内联进 main，但其 producer import 曾被保留为裸包引用；
      // electron-builder 又会排除 node_modules/@zcode，导致安装包启动即 ERR_MODULE_NOT_FOUND。
      // producer 的 JS broker 必须跟随 services 一起内联，原生 addon 仍只存在于独立 Helper。
      "@zcode/zcode-cua",
    ],
    esbuildPlugins: [zcodeCuaRuntimeAliasPlugin],
    // OTLP 端点与鉴权只在运行时读取；构建环境中的凭据不能写进公开安装包。
    define: createSharedDefines(),
    // main/host 同时 watch 且共享 out 根目录时，默认 chunk 命名会互相覆盖，
    // 可能让 main 的 import 指向被 host 刚重写的 chunk，触发“缺少命名导出”的偶发启动报错。
    // 这里按目标分目录输出 chunk，确保并发构建下产物隔离。
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "main/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("main"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "preload",
    entry: {
      "preload/embeddedBrowserJavaScriptDialog": "src/preload/embeddedBrowserJavaScriptDialog.ts",
      "preload/codingPlanWebview": "src/preload/codingPlanWebview.ts",
      "preload/browserVideoRecorder": "src/preload/browserVideoRecorder.ts",
      "preload/index": "src/preload/index.ts",
      "preload/resourceManager": "src/preload/resourceManager.ts",
      "preload/cuaPermissionPanel": "src/preload/cuaPermissionPanel.ts",
    },
    outDir: "out",
    format: "cjs",
    platform: "node",
    target: "node22",
    external: ["electron"],
    noExternal: ["@zcode/shared"],
    outExtension: () => ({ js: ".cjs" }),
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
    },
    onSuccess: createDevReadyMarkerHook("preload"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "host",
    entry: {
      "host/index": "src/host/index.ts",
      "host/tasksStorageWorker": "src/host/tasksStorageWorker.ts",
    },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // host 与 main 共用同一套 services 图，继续内联 undici 会在 Electron ESM runtime 里触发同样的 dynamic require 崩溃。
    // 这里同样保留为外部依赖，避免 desktop 开发态和打包态 host 进程启动失败。
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      "@zcode/provider",
      "@zcode/provider-node",
      "@zcode/zcode-cua",
    ],
    esbuildPlugins: [zcodeCuaRuntimeAliasPlugin],
    define: createSharedDefines(),
    // 与 main 保持一致的 chunk 隔离策略，避免 host/main 产物相互覆盖。
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "host/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("host"),
    ...desktopTsupBundleSecurityOptions,
  },
  {
    name: "scheduler",
    entry: { "scheduler/index": "src/scheduler/index.ts" },
    outDir: "out",
    format: "esm",
    platform: "node",
    target: "node22",
    // 与 host 同构：常驻 cron scheduler 进程复用 @zcode/services（tasks-index + cron），
    // 同样保留 undici 等为外部依赖，避免 Electron ESM runtime 的 dynamic require 崩溃。
    external: desktopNodeRuntimeExternals,
    noExternal: [
      "@zcode/server",
      "@zcode/shared",
      "@zcode/rpc",
      "@zcode/services",
      "@zcode/client",
      "@zcode/provider",
      "@zcode/provider-node",
      "@zcode/zcode-cua",
    ],
    esbuildPlugins: [zcodeCuaRuntimeAliasPlugin],
    define: createSharedDefines(),
    esbuildOptions(options) {
      applyDesktopTsupEsbuildSecurityOptions(options);
      options.chunkNames = "scheduler/chunk-[hash]";
    },
    onSuccess: createDevReadyMarkerHook("scheduler"),
    ...desktopTsupBundleSecurityOptions,
  },
]);
