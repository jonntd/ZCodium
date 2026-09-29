// CUA runtime 构建期 alias（docs/spec/cua-runtime-builtin.md §A）。
// workspace 的 packages/zcode-cua 是 fail-closed stub（保留为类型与契约来源）；
// 桌面 main/host/scheduler 与 node-repl-host 的 bundle 需要换成 runtimes/zcode-cua
// 真实现，host 里的 cua-permission-broker 才能真正安装/拉起 Helper。
//
// 为什么用 onResolve 插件而不是 esbuild alias：alias 是前缀替换，而本包的子路径是
// 「段 → kebab 文件」映射（如 ./broker/server → broker-server.js），alias 到目录
// 解析不了；逐条枚举又会在新增子路径时静默回退 stub。这里构建时直接读
// runtimes/zcode-cua/package.json 的 exports 表做解析，未知名走 errors 分支响亮失败。
//
// 消费方：packages/desktop/tsup.config.ts（注意 tsup 会打包配置文件，须用
// pathToFileURL 动态加载本模块，避免 import.meta 被重定位）与
// apps/zcode-cli/packages/node-repl-host/scripts/build.mjs。两处必须机械一致。

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ZCODE_CUA_PACKAGE_NAME = "@zcode/zcode-cua";

// exports key（"." 与 "./x/y"）→ runtimeRoot 下的绝对文件路径（取 "import" 条件）。
// 独立导出供对照测试使用：测试断言每个目标文件真实存在，防止 exports 表与产物脱节。
export function loadZcodeCuaRuntimeImportTargets(runtimeRoot) {
  const manifestPath = resolve(runtimeRoot, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const exportsTable = manifest.exports;
  if (!exportsTable || typeof exportsTable !== "object") {
    throw new Error(`[zcode-cua-alias] ${manifestPath} 缺少 exports 表，无法建立 runtime alias`);
  }
  const importTargets = new Map();
  for (const [key, value] of Object.entries(exportsTable)) {
    const target = typeof value === "string" ? value : value?.import;
    if (typeof target !== "string") {
      throw new Error(
        `[zcode-cua-alias] exports["${key}"] 没有 import 条件，bundle 无法消费该入口`,
      );
    }
    importTargets.set(key, resolve(runtimeRoot, target));
  }
  return importTargets;
}

export function createZcodeCuaRuntimeAliasPlugin({ runtimeRoot }) {
  const importTargets = loadZcodeCuaRuntimeImportTargets(runtimeRoot);

  return {
    name: "zcode-cua-runtime-alias",
    setup(build) {
      build.onResolve({ filter: /^@zcode\/zcode-cua(\/|$)/ }, (args) => {
        const suffix = args.path.slice(ZCODE_CUA_PACKAGE_NAME.length);
        const exportKey = suffix === "" ? "." : `.${suffix}`;
        const target = importTargets.get(exportKey);
        if (!target) {
          return {
            errors: [
              {
                text:
                  `${args.path} 不在 runtimes/zcode-cua 的 exports 表中。` +
                  "新增子路径后请同步上游包或调整消费方，不要静默回退 workspace stub。",
              },
            ],
          };
        }
        return { path: target };
      });
    },
  };
}
