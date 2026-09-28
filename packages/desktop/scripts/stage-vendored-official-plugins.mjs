// ZcodePro 合入的官方插件（仓库根 plugins/*-plugin）→ bundled-agents/<key>/glm/packages/<name>-plugin
// 的统一 staging。spec：docs/spec/builtin-zcodepro-plugins.md。
//
// 为什么必须存在：official-plugin-definitions.ts 里这 12 个 definition 的 rootCandidates 首候选
// 是 `packages/<name>-plugin`，解析 baseDir 是 agent 入口（zcode.cjs）旁的 glm 目录；官方体系靠
// CDN/SEA 提供包源，本 fork 审计策略默认断连官方服务，包源只有仓库根 plugins/ 这一份。
// 打包链（prepare-agent-node-bundle.mjs）与 dev 链（scripts/build-desktop-agent-cli.mjs）都必须
// 调用本模块 —— 与 stage-agent-bundle.mjs 同理，两链共用一份实现，不可能漂移。
//
// glmDir 不由调用方各自解析，统一从 stage-agent-bundle.mjs 的 resolveAgentBundlePaths 取，
// 保证 staging 落点与 agent bundle 同源。
import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { rename } from "node:fs/promises";
import { build as esbuildBuild } from "esbuild";
import { resolveAgentBundlePaths } from "./stage-agent-bundle.mjs";

// 与 bootstrap bundled-plugins.ts 的 includedTopLevelPaths 白名单同构（该文件是 seed 侧权威）。
export const includedOfficialPluginTopLevelPaths = new Set([
  ".mcp.json",
  ".zcode-plugin",
  "README.md",
  "agents",
  "commands",
  "dist",
  "docs",
  "hooks",
  "output-styles",
  "package.json",
  "scripts",
  "skills",
  "templates",
]);

const excludedAssetNames = new Set([".DS_Store", ".venv", "__pycache__", "node_modules"]);

export function shouldCopyOfficialPluginAsset(sourcePath) {
  const name = basename(sourcePath);
  return !excludedAssetNames.has(name) && !name.endsWith(".pyc");
}

// definition.name → 仓库根插件包目录。stagedPath 必须与 definitions 的 rootCandidates 首候选
// （packages/<name>-plugin）一致；对照测试（test/official-definitions-vendored-alignment.test.ts）
// 机械校验这份表与 definitions、vendored manifest 三方一致。
export const VENDORED_OFFICIAL_PLUGINS = [
  { name: "android-emulator", directory: "android-emulator-plugin" },
  { name: "documents", directory: "documents-plugin" },
  { name: "image-search", directory: "image-search-plugin" },
  { name: "ios-simulator", directory: "ios-simulator-plugin" },
  { name: "pdf", directory: "pdf-plugin" },
  { name: "plugin-creator", directory: "plugin-creator-plugin" },
  { name: "presentations", directory: "presentations-plugin" },
  { name: "restore-legacy-sessions", directory: "restore-legacy-sessions-plugin" },
  { name: "skill-creator", directory: "skill-creator-plugin" },
  { name: "spreadsheets", directory: "spreadsheets-plugin" },
  { name: "computer-use", directory: "zcode-cua-plugin" },
  { name: "zcode-guide", directory: "zcode-guide-plugin" },
].map((entry) => ({
  ...entry,
  relativePath: `plugins/${entry.directory}`,
  stagedPath: `packages/${entry.directory}`,
}));

// MCP server bundle 里被上游 esbuild 留成 external 的 bare import（ajv/ajv-formats）。
// seed 有意不拷 node_modules，插件缓存里也没有任何可解析路径 —— 不内联的话 MCP 一启动就崩。
// 只有命中该模式的入口才重新 bundle；node:* 等内置模块由 platform:"node" 自动保持 external。
const bareImportPattern = /(?:require\(\s*|from\s+|import\s+)["']([a-z@][^"']*)["']/g;

function hasBareImport(source) {
  for (const match of source.matchAll(bareImportPattern)) {
    const specifier = match[1];
    if (!specifier.startsWith(".") && !specifier.startsWith("node:")) return true;
  }
  return false;
}

async function inlineMcpServerDependencies(serverPath, repoRoot, log) {
  const source = readFileSync(serverPath, "utf8");
  if (!hasBareImport(source)) return false;

  // entry 与 outfile 不能同路径：先写临时文件再原子替换，失败时保留原文件。
  // 格式必须保持 esm：包为 "type": "module"，入口带 top-level await 与 import.meta.main
  // （Node 24 原生支持，Electron 41 内置 Node 24），cjs 化会直接破坏入口语义。
  const tempOutput = `${serverPath}.inline-tmp`;
  rmSync(tempOutput, { force: true });
  await esbuildBuild({
    entryPoints: [serverPath],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: tempOutput,
    // 插件包内没有 node_modules，bare 依赖统一从仓库根解析（ajv/ajv-formats 为 root 依赖）。
    nodePaths: [resolve(repoRoot, "node_modules")],
    logLevel: "warning",
  });
  await rename(tempOutput, serverPath);
  log(`[stage:vendored-plugins] inlined bare dependencies into ${basename(serverPath)}`);
  return true;
}

export function stageOfficialPluginPackage({
  repoRoot,
  glmDir,
  relativePath,
  stagedPath,
  requiredSeedPaths = [],
  log = console.log,
}) {
  const sourceRoot = resolve(repoRoot, relativePath);
  const manifestPath = resolve(sourceRoot, ".zcode-plugin", "plugin.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`[stage:official-plugins] missing plugin manifest: ${manifestPath}`);
  }

  const targetRoot = resolve(glmDir, stagedPath);
  for (const entryName of includedOfficialPluginTopLevelPaths) {
    const sourcePath = resolve(sourceRoot, entryName);
    if (!existsSync(sourcePath)) continue;
    cpSync(sourcePath, resolve(targetRoot, entryName), {
      recursive: true,
      filter: shouldCopyOfficialPluginAsset,
    });
  }
  for (const seedPath of requiredSeedPaths) {
    const stagedAssetPath = resolve(targetRoot, ...seedPath.split("/"));
    if (!existsSync(stagedAssetPath)) {
      throw new Error(`[stage:official-plugins] missing staged seed asset: ${stagedAssetPath}`);
    }
  }
  log(`[stage:official-plugins] staged ${stagedPath}`);
  return targetRoot;
}

export async function stageVendoredOfficialPlugins({ repoRoot, platformKey, log = console.log }) {
  const { glmDir } = resolveAgentBundlePaths({ repoRoot, platformKey });
  for (const plugin of VENDORED_OFFICIAL_PLUGINS) {
    const targetRoot = stageOfficialPluginPackage({
      repoRoot,
      glmDir,
      relativePath: plugin.relativePath,
      stagedPath: plugin.stagedPath,
      log,
    });

    const stagedServerPath = resolve(targetRoot, "dist", "mcp", "server.js");
    if (existsSync(stagedServerPath)) {
      await inlineMcpServerDependencies(stagedServerPath, repoRoot, log);
    }
  }
}
