import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 内置插件三方一致性机械对照（spec：docs/spec/builtin-zcodepro-plugins.md）。
// 三份手工清单历史上各自漂移（zcode-guide 0.2.0 vs 包源 0.3.0 曾分叉），用测试钉住：
// 1) official-plugin-definitions 的 name/version 必须与 vendored 包 .zcode-plugin/plugin.json 一致；
// 2) staging 表必须覆盖 definitions 中全部 vendored 插件，且 stagedPath 与 rootCandidates 首候选一致；
// 3) definitions 的 requiredSeedPaths 在包源里必须真实存在（seed 缺文件会拒绝缓存）；
// 4) shared 的 DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS 手写副本必须与 bootstrap 派生集合一致。

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS, OFFICIAL_PLUGIN_DEFINITIONS } from "../src/app/official-plugin-definitions.js";
import { VENDORED_OFFICIAL_PLUGINS } from "../../../../../packages/desktop/scripts/stage-vendored-official-plugins.mjs";
import { DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS as SHARED_DEFAULT_ENABLED_IDS } from "../../../../../packages/shared/src/plugin-marketplaces.js";

// 这两个插件包源在 apps/zcode-cli/packages/ 下、由 prepare-agent-node-bundle.mjs 的
// officialPluginPackages 单独 staging，不在 vendored 表范围内。
const NON_VENDORED_DEFINITION_NAMES = new Set(["browser-use", "node-repl-host"]);

function readVendoredManifest(directory: string): { name: string; version: string } {
  const manifestPath = resolve(repoRoot, "plugins", directory, ".zcode-plugin", "plugin.json");
  assert.ok(existsSync(manifestPath), `vendored manifest missing: ${manifestPath}`);
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

test("vendored plugin manifests match official definitions (name & version)", () => {
  for (const plugin of VENDORED_OFFICIAL_PLUGINS) {
    const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((entry) => entry.name === plugin.name);
    assert.ok(definition, `definition missing for vendored plugin: ${plugin.name}`);

    const manifest = readVendoredManifest(plugin.directory);
    assert.equal(
      manifest.name,
      definition.name,
      `${plugin.name}: manifest name drifts from definition`,
    );
    assert.equal(
      manifest.version,
      definition.version,
      `${plugin.name}: definition version drifts from vendored manifest`,
    );
  }
});

test("vendored staging table covers exactly the non-native definitions", () => {
  const expectedNames = OFFICIAL_PLUGIN_DEFINITIONS.map((entry) => entry.name).filter(
    (name) => !NON_VENDORED_DEFINITION_NAMES.has(name),
  );
  assert.deepEqual(
    VENDORED_OFFICIAL_PLUGINS.map((plugin) => plugin.name).sort(),
    [...expectedNames].sort(),
  );

  for (const plugin of VENDORED_OFFICIAL_PLUGINS) {
    const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((entry) => entry.name === plugin.name);
    // seed 解析 baseDir=glm 时的首个候选；stagedPath 必须与之对齐才能命中 filesystem seed。
    assert.equal(
      plugin.stagedPath,
      definition?.rootCandidates[0],
      `${plugin.name}: stagedPath does not match rootCandidates[0]`,
    );
  }
});

test("requiredSeedPaths exist in vendored plugin sources", () => {
  for (const definition of OFFICIAL_PLUGIN_DEFINITIONS) {
    if (NON_VENDORED_DEFINITION_NAMES.has(definition.name)) continue;
    const plugin = VENDORED_OFFICIAL_PLUGINS.find((entry) => entry.name === definition.name);
    assert.ok(plugin, `staging entry missing: ${definition.name}`);
    for (const relativePath of definition.requiredSeedPaths ?? []) {
      const seedPath = resolve(repoRoot, "plugins", plugin.directory, ...relativePath.split("/"));
      assert.ok(existsSync(seedPath), `${definition.name}: requiredSeedPath missing: ${seedPath}`);
    }
  }
});

test("dev entrypoint candidates resolve vendored plugin sources", () => {
  // dev 态 agent resolver dist 优先：entrypointDir = apps/zcode-cli/packages/cli/dist。
  // rootCandidates 必须含一条能从该 baseDir 命中仓库根 plugins/ 的候选，否则 dev 的
  // filesystem seed 找不到包源（desktop 首启只 seed 到 browser-use/node-repl-host 的回归）。
  const devEntrypointDir = resolve(repoRoot, "apps/zcode-cli/packages/cli/dist");
  for (const plugin of VENDORED_OFFICIAL_PLUGINS) {
    const definition = OFFICIAL_PLUGIN_DEFINITIONS.find((entry) => entry.name === plugin.name);
    assert.ok(definition, `definition missing for vendored plugin: ${plugin.name}`);
    const vendoredRoot = resolve(repoRoot, "plugins", plugin.directory);
    const hit = definition.rootCandidates.some(
      (candidate) => resolve(devEntrypointDir, candidate) === vendoredRoot,
    );
    assert.ok(
      hit,
      `${plugin.name}: no rootCandidate resolves from cli/dist to ${vendoredRoot}`,
    );
  }
});

test("shared DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS matches bootstrap derived set", () => {
  assert.equal(SHARED_DEFAULT_ENABLED_IDS.size, DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.size);
  for (const pluginId of SHARED_DEFAULT_ENABLED_IDS) {
    assert.ok(
      DEFAULT_ENABLED_OFFICIAL_PLUGIN_IDS.has(pluginId),
      `shared-only default enabled id: ${pluginId}`,
    );
  }
});
