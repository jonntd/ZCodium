import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadZcodeCuaRuntimeImportTargets } from "../../../scripts/zcode-cua-runtime-alias.mjs";

// CUA 运行时内置的对齐守卫（docs/spec/cua-runtime-builtin.md 验收场景 3）。
// 三方版本必须一致：vendor 真实现（构建期 alias 进桌面 bundle）、workspace stub
// （typecheck 与 CLI bundle 的契约来源）、computer-use 插件 manifest（商店展示的
// 版本号）。任何一方漂移都会出现「运行时行为与插件版本不符 / 契约错位」。

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("zcode-cua runtime / stub / plugin manifest versions stay aligned", () => {
  const runtimePkg = readJson(resolve(repoRoot, "runtimes/zcode-cua/package.json"));
  const stubPkg = readJson(resolve(repoRoot, "packages/zcode-cua/package.json"));
  const pluginManifest = readJson(
    resolve(repoRoot, "plugins/zcode-cua-plugin/.zcode-plugin/plugin.json"),
  );
  assert.equal(runtimePkg.name, "@zcode/zcode-cua");
  assert.equal(stubPkg.name, "@zcode/zcode-cua");
  assert.equal(
    runtimePkg.version,
    stubPkg.version,
    "runtimes/zcode-cua 与 packages/zcode-cua stub 版本漂移：stub 是类型/契约来源，必须跟随 runtime 更新",
  );
  assert.equal(
    runtimePkg.version,
    pluginManifest.version,
    "runtimes/zcode-cua 与 plugins/zcode-cua-plugin manifest 版本漂移：商店展示版本会与实际运行时行为不符",
  );
});

test("zcode-cua exports 表里的每个 import 目标都真实存在（alias 插件的前提）", () => {
  const importTargets = loadZcodeCuaRuntimeImportTargets(
    resolve(repoRoot, "runtimes/zcode-cua"),
  );
  assert.ok(importTargets.has("."), "exports 必须包含根入口");
  for (const [key, target] of importTargets) {
    assert.ok(
      existsSync(target),
      `exports["${key}"] → ${target} 不存在，构建期 alias 会解析失败`,
    );
  }
});

test("workspace stub 与 runtime 的 exports 子路径集合一致（契约面不能收敛）", () => {
  const runtimePkg = readJson(resolve(repoRoot, "runtimes/zcode-cua/package.json"));
  const stubPkg = readJson(resolve(repoRoot, "packages/zcode-cua/package.json"));
  assert.deepEqual(
    Object.keys(runtimePkg.exports ?? {}).sort(),
    Object.keys(stubPkg.exports ?? {}).sort(),
    "stub 与 runtime 的 exports 子路径不一致：typecheck 或 CLI bundle 会缺一块契约面",
  );
});

test("vendor runtime 自包含（无 bare import，内联进 bundle 不需要额外依赖）", () => {
  // broker-server.js 是 host 侧 helper 生命周期的入口之一；它连同 vendor/dist-index.js
  // 都必须只依赖 node: 内建与相对路径（docs/spec/cua-runtime-builtin.md §A）。
  const files = ["index.js", "broker.js", "broker-server.js", "frame-contract.js"];
  const bareImportPattern = /(?:from\s+|import\s+)["']([a-z@][^"']*)["']/g;
  for (const file of files) {
    const source = readFileSync(resolve(repoRoot, "runtimes/zcode-cua", file), "utf8");
    for (const match of source.matchAll(bareImportPattern)) {
      assert.ok(
        match[1].startsWith("node:"),
        `${file} 出现非 node: 的 bare import "${match[1]}"，alias 内联会解析失败`,
      );
    }
  }
});

test("stub 与 runtime 的契约值谓词行为逐字一致（renderer 走 stub、host 走 vendor）", async () => {
  // 2026-09-30 实证：stub 的 isCuaPermissionStatusAvailable 用 `available === true`，
  // vendor 用 `available !== false`，而 host 返回的成功结果不带 available 字段——renderer
  // （vite 无 alias，解析到 stub）把每个成功状态判成 unavailable，设置页权限永远显示
  // 「未知」。谓词是跨 renderer/host 的共享契约，两侧必须行为一致，这里按行为对照防守。
  const stub = await import(resolve(repoRoot, "packages/zcode-cua/broker-ports.js").replace(
    /^file:/,
    "file://",
  ));
  const vendor = await import(
    resolve(repoRoot, "runtimes/zcode-cua/broker-ports.js").replace(/^file:/, "file://")
  );

  const successWithoutField = { grantOwner: "t", accessibility: "granted", screenRecording: "granted" };
  const cases = [
    [undefined, false],
    [null, false],
    [successWithoutField, true],
    [{ ...successWithoutField, available: true }, true],
    [{ ...successWithoutField, available: false }, false],
  ];
  for (const [input, expected] of cases) {
    assert.equal(
      stub.isCuaPermissionStatusAvailable(input),
      expected,
      `stub predicate drifted on case ${JSON.stringify(input)}`,
    );
    assert.equal(
      vendor.isCuaPermissionStatusAvailable(input),
      expected,
      `vendor predicate drifted on case ${JSON.stringify(input)}`,
    );
  }

  // 隐私契约同源：探针是否运行由 includeFunctionalProbes 显式意图 + denied 预检决定。
  const probeCases = [
    ["granted", undefined, false],
    ["granted", {}, false],
    ["granted", { includeFunctionalProbes: true }, true],
    ["denied", { includeFunctionalProbes: true }, false],
  ];
  for (const [state, options, expected] of probeCases) {
    assert.equal(stub.shouldRunCuaScreenCaptureProbe(state, options), expected);
    assert.equal(vendor.shouldRunCuaScreenCaptureProbe(state, options), expected);
  }
});
