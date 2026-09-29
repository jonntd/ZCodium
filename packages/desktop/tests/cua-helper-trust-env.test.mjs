import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyBundledCuaHelperTrustEnv,
  ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL_ENV,
} from "../src/main/desktopCuaHelperTrustEnv.js";
import {
  isExplicitLocalDevOptIn,
  isUnsignedHelperLocalDevRequested,
} from "../../../runtimes/zcode-cua/broker-server.js";

// CUA helper 信任门 env 决策的回归守卫（docs/spec/cua-runtime-builtin.md §B 偏离第三条 +
// 验收场景 7）。desktopCuaHelperInstaller.ts 依赖 electron/services 导入面，node --test
// 无法直接加载；信任决策因此抽到零依赖纯函数 desktopCuaHelperTrustEnv.ts，这里直测。

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

test("打包态（有随包 helper）：信任门 env 由主进程确定性置 1，覆盖用户注入", () => {
  const env = applyBundledCuaHelperTrustEnv(
    { PATH: "/usr/bin", [ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL_ENV]: "0" },
    "/Resources/cua-helper/ZCode Computer Use.app",
  );
  assert.equal(env[ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL_ENV], "1");
  assert.equal(env.PATH, "/usr/bin");

  // shell/launchctl 残留的空串、任意值同样被覆盖为 "1"
  const cleaned = applyBundledCuaHelperTrustEnv(
    { [ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL_ENV]: "" },
    "/x",
  );
  assert.equal(cleaned[ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL_ENV], "1");
});

test("dev（无随包 helper）：保持上游语义，不代持信任门", () => {
  const env = { A: "b" };
  assert.deepEqual(applyBundledCuaHelperTrustEnv(env, undefined), { A: "b" });
  assert.equal(
    applyBundledCuaHelperTrustEnv(env, "")[ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL_ENV],
    undefined,
  );
  assert.equal(env[ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL_ENV], undefined);
});

test("vendor 信任门 opt-in 语法与 fork patch 语义（vendored 升级回归守卫）", () => {
  // 宽松语法（与 prepare-cua-helper / 上游 isExplicitLocalDevOptIn 一致）：1|true|on，忽略大小写与空白
  assert.equal(isExplicitLocalDevOptIn("1"), true);
  assert.equal(isExplicitLocalDevOptIn(" TRUE "), true);
  assert.equal(isExplicitLocalDevOptIn("On"), true);
  assert.equal(isExplicitLocalDevOptIn("0"), false);
  assert.equal(isExplicitLocalDevOptIn(""), false);
  assert.equal(isExplicitLocalDevOptIn(undefined), false);

  assert.equal(
    isUnsignedHelperLocalDevRequested({ [ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL_ENV]: "1" }),
    true,
  );
  assert.equal(isUnsignedHelperLocalDevRequested({}), false);
  assert.equal(
    isUnsignedHelperLocalDevRequested({ [ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL_ENV]: "0" }),
    false,
  );
  // dev-mode 一票通过（vendor 自身语义，dev 变体默认期望随它走）
  assert.equal(isUnsignedHelperLocalDevRequested({ ZCODE_CUA_DEV_MODE: "1" }), true);
});

test("vendor 里的 fork patch 未被 vendored 升级冲掉（production 门不得回归）", () => {
  const source = readFileSync(resolve(repoRoot, "runtimes/zcode-cua/vendor/dist-index.js"), "utf8");
  const start = source.indexOf("function isUnsignedHelperLocalDevRequested(");
  assert.ok(start >= 0, "vendor 缺少信任门函数");
  const end = source.indexOf("\n}", start);
  const body = source.slice(start, end);
  assert.ok(body.includes("isExplicitLocalDevOptIn"), "信任门必须保留 opt-in 判定");
  // stock 实现会把信任限制在本地开发运行时（consult COMPILED flag / ZCODE_RUNTIME_ENV）；
  // fork patch 去掉该门，vendored 上游新版本时这里会立即失败，而不是打包态静默拒收 helper。
  assert.ok(
    !body.includes("isCuaLocalDevelopmentRuntime") &&
      !body.includes("compiledLocalDevelopmentRuntime"),
    "isUnsignedHelperLocalDevRequested 出现 production 门：vendor 升级冲掉了 ZCodium fork patch",
  );
});

test("installer 不再 delete 信任门 env（上游合并回归守卫）", () => {
  const source = readFileSync(
    resolve(repoRoot, "packages/desktop/src/main/desktopCuaHelperInstaller.ts"),
    "utf8",
  );
  assert.ok(source.includes("applyBundledCuaHelperTrustEnv"), "installer 必须经由信任门纯函数");
  assert.ok(
    !source.includes("delete env.ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL"),
    "installer 重新引入上游 delete 会复现打包态 onboarding fail-closed（98d2680 修复前语义）",
  );
});
