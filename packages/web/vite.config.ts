import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pdfJsCMapsPlugin } from "../ui/vite/pdfJsCMapsPlugin.js";
import { thirdPartyNoticesVitePlugin } from "../../scripts/third-party-notices.mjs";
// Vite 配置在 Node 加载期执行，不能导入 @zcode/shared 根入口。
// 根入口包含 NodeNext 风格的源码 re-export，Node 会按真实文件查找 .js 并在 bootstrap 阶段失败。
//
// 子路径 @zcode/shared/zcodeEndpoint 同样不行：它仍指向同一份 TS 源码，而该文件内部
// 相对 import 了 "./env-names.js"——Vite 把 workspace 包交给 Node 原生加载，Node 24 的
// strip-types 不做 .js→.ts 重映射，bootstrap 阶段直接 ERR_MODULE_NOT_FOUND。
// 与 packages/desktop/tsup.config.ts 同一处理：改从相对路径引源码，交给 Vite 自身打包。
import {
  resolveRuntimeZCodeEndpointOrigin,
  pickProductEndpointEnv,
  resolveZaiOAuthClientId,
  resolveZaiOAuthOrigin,
} from "../shared/src/zcodeEndpoint.js";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(HERE, "../..");
const { version } = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf-8"));

/**
 * 构建期 commit 戳（`__ZCODE_COMMIT__`）。
 *
 * 优先用 CI / 启动脚本注入的 `ZCODE_COMMIT`；本地直接 `vite build` 时它通常是空的，
 * 此时回退到 `git rev-parse --short HEAD`。
 *
 * 为什么必须回退：中继托管的这份产物要跟桌面 Host 上报的 `buildCommitId`
 * （`packages/desktop/scripts/build-metadata.mjs` 的 `resolveCommitId()`，同样是 git 短 SHA）
 * 比对，用来提示「手机页面是旧构建」。恒为 `"unknown"` 就永远比不出来，
 * 护栏形同虚设（见 docs/spec/web-remote-ui-parity.md §7）。
 * ⚠ 必须用 `--short=8`：桌面侧就是 `git rev-parse --short=8 HEAD`，
 * 两边长度不一致（7 位 vs 8 位）会让护栏每次都误报。
 * 取不到 git（源码包 / 无 .git）时不抛错，维持 "unknown" —— 护栏 fail-open。
 */
function resolveBuildCommit(env: Record<string, string | undefined>): string {
  const injected = env.ZCODE_COMMIT?.trim();
  if (injected) return injected;
  try {
    return (
      execFileSync("git", ["rev-parse", "--short=8", "HEAD"], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() || "unknown"
    );
  } catch {
    return "unknown";
  }
}

function resolveZCodeEnv(value: string | undefined): "test" | "production" {
  return value?.trim().toLowerCase() === "production" ? "production" : "test";
}

export default defineConfig(({ mode }) => {
  // `.env*` 只提供链接常量；当前产品环境由启动脚本或 CI 注入 ZCODE_ENV。
  // 启动脚本通过 process.env 显式选择 test/production；它必须优先于 .env 文件，
  // 否则 share:test 可能被 mode 的旧配置误解析到错误 endpoint。
  const env = { ...loadEnv(mode, REPO_ROOT, ""), ...process.env };
  const zcodeEnv = resolveZCodeEnv(env.ZCODE_ENV);
  const endpointEnv = {
    ...env,
    ZCODE_ENV: zcodeEnv,
  };
  const zcodeEndpointOrigin = resolveRuntimeZCodeEndpointOrigin(endpointEnv);
  const zaiOAuthOrigin = resolveZaiOAuthOrigin(endpointEnv);
  // ZAI OAuth client_id 是公开标识，允许注入浏览器包；secret/token 不得走 VITE_。
  const zaiOAuthClientId = resolveZaiOAuthClientId(endpointEnv);

  return {
    plugins: [pdfJsCMapsPlugin(), react(), tailwindcss(), thirdPartyNoticesVitePlugin()],
    resolve: {
      alias: {
        // 修复 UI 组件库中的 @ 别名解析失败。
        // 问题原因：packages/ui 的源码直接被 web 应用交给 Vite 打包，但 web 自己没声明 @ -> packages/ui/src，
        // 所以像 "@/components/lib/utils" 这类导入会在运行时构建阶段报找不到模块。
        // 这里把别名补到消费方 Vite 配置里，保持现有组件源码不动，影响面最小。
        "@": resolve(__dirname, "../ui/src"),
        // Recharts 依赖 d3-shape@3.x，后者需要 d3-path 的 Path 导出。
        // hoisted node_modules 可能把 d3-shape 旁边的旧 d3-path@1.x 暴露给 Vite 预构建，
        // 导致桌面/Web dev 都在依赖优化阶段失败；显式指向根部 3.x 入口以固定解析边界。
        "d3-path": resolve(__dirname, "../../node_modules/d3-path/src/index.js"),
      },
    },
    server: {
      port: 5173,
      proxy: {
        // Web 登录本地调试时，OAuth token 交换必须先命中线上同源接口。
        // 该专用代理放在 `/api` 通配代理之前，避免被转发到本地 server 导致 404。
        "/api/v1/oauth/token": {
          target: zcodeEndpointOrigin,
          changeOrigin: true,
          secure: true,
        },
        // 将 /ws 和 /api 请求代理到 server（默认 3030 端口）
        "/ws": { target: "ws://localhost:3030", ws: true },
        "/api": { target: "http://localhost:3030" },
      },
    },
    optimizeDeps: {
      // 修复：在依赖预构建阶段显式加入 react 相关入口，避免 rolldown 解析 `react/jsx-runtime`
      // / `react/jsx-dev-runtime` 时返回无后缀路径导致的加载失败（UNLOADABLE_DEPENDENCY）。
      include: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],
    },
    worker: {
      rollupOptions: {
        // @pierre/diffs 的 worker 入口依赖 import 后注册 message 监听。
        // 它的 package sideEffects 漏声明会让生产 worker 子构建被摇成 0B；
        // 只关闭 worker 构建的摇树，避免影响主包。
        treeshake: false,
      },
    },
    define: {
      __ZCODE_ENDPOINT_ENV__: JSON.stringify(pickProductEndpointEnv(env)),
      __ZCODE_VERSION__: JSON.stringify(version),
      __ZCODE_COMMIT__: JSON.stringify(resolveBuildCommit(env)),
      __ZCODE_ENV__: JSON.stringify(zcodeEnv),
      "import.meta.env.VITE_ZCODE_BASE_URL": JSON.stringify(zcodeEndpointOrigin),
      // 兼容旧 Web runtime 读取名；新代码统一读 VITE_ZCODE_BASE_URL。
      "import.meta.env.VITE_ZCODE_ENDPOINT_ORIGIN": JSON.stringify(zcodeEndpointOrigin),
      // 明确注入 OAuth 公开配置，避免 Web 端在不同 mode 下隐式依赖源码 fallback。
      "import.meta.env.VITE_ZAI_OAUTH_CLIENT_ID": JSON.stringify(zaiOAuthClientId),
      "import.meta.env.VITE_ZAI_OAUTH_ORIGIN": JSON.stringify(zaiOAuthOrigin),
    },
    build: {
      // 生产不在浏览器产物暴露 sourceMappingURL，避免客户端侧还原业务源码。
      sourcemap: mode === "production" ? "hidden" : true,
    },
  };
});
