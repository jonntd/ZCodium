import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * Agent CLI bundle 的新鲜度判定（dev 快速启动用，纯函数便于单测）。
 *
 * 背景：`pnpm dev:desktop` 每次都会全量重建 CLI 链（9 个 workspace 包 + 2 个插件
 * runtime，外置卷上约 3-9 分钟），即使一行 CLI 代码都没改。这段时间 CPU/IO 长时间
 * 打满，是「dev 一跑就 100%」的主要来源。
 *
 * 这里的判定只回答一个问题：`apps/zcode-cli/packages/cli/dist/zcode.cjs` 是否比
 * 所有相关源文件都新？只有「是」才允许复用。
 *
 * ⚠ 正确性优先：bundle 陈旧会让 CLI 侧改动在 dev 里静默不生效（历史上出现过陈旧 3 天、
 * 被误判成「代码没作用」的事故）。因此：
 * - 判定用 mtime，而不是 git 状态（未提交改动同样能识别）；
 * - 源目录由 `@zcode/cli` 的 workspace 依赖闭包**动态推导**，不维护第二份包清单
 *   （`build-desktop-agent-cli.mjs` 的 `cliWorkspaceBuilds` 已经因为手写清单漂移过）；
 * - 任何读取失败一律按「不新鲜」处理，退回全量构建。
 */

/** 扫描时跳过的目录：构建产物与依赖缓存不参与新鲜度比较。 */
const IGNORED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "out",
  ".git",
  ".turbo",
  ".cache",
  "coverage",
]);

/** workspace 包所在的两级目录（CLI 子 workspace + 根 workspace）。 */
const WORKSPACE_PACKAGE_ROOTS = ["apps/zcode-cli/packages", "packages"];

/** 依赖闭包只沿运行时依赖走；devDependencies 是测试工具，与 bundle 内容无关。 */
const CLOSURE_DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"];

/** 闭包入口：CLI 自身。它的 dist/zcode.cjs 就是被判定新鲜度的产物。 */
const CLOSURE_ENTRY_PACKAGE = "@zcode/cli";

/** 每个包参与比较的子目录；不存在就跳过（插件包大多没有 src）。 */
const SCANNED_PACKAGE_SUBDIRECTORIES = ["src", "scripts"];

async function readWorkspacePackageIndex(repoRoot) {
  /** @type {Map<string, string>} package name -> absolute directory */
  const index = new Map();
  for (const relativeRoot of WORKSPACE_PACKAGE_ROOTS) {
    const root = resolve(repoRoot, relativeRoot);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const directory = join(root, entry.name);
      try {
        const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
        if (typeof manifest.name === "string" && manifest.name.length > 0) {
          index.set(manifest.name, directory);
        }
      } catch {
        // 没有 package.json（或内容损坏）的目录不是 workspace 包，不参与闭包。
      }
    }
  }
  return index;
}

async function readWorkspaceManifest(directory) {
  try {
    return JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * CLI 链的源目录清单：从 `@zcode/cli` 出发沿 workspace 运行时依赖做广度优先遍历，
 * 收集每个包的 `package.json`（依赖变化必须触发重建）+ `src` / `scripts` 目录。
 *
 * 为什么包含 `package.json`：改了 workspace 依赖却不重建 bundle 时，产物里的
 * import 图会与真实依赖不一致，属于最难排查的一类陈旧。
 *
 * 外部依赖（playwright-core、koffi 等）不在 workspace 索引里，自然被跳过；
 * 它们的版本变化由 pnpm install 负责，不归本判定管。
 *
 * ⚠ `@zcode/node-repl-host` / `@zcode/browser-use-plugin` 这类独立 MCP runtime **不在**
 * `@zcode/cli` 的依赖闭包里（它们由 seed 侧按路径加载），但确实参与同一次全量构建。
 * 调用方必须把它们作为 `additionalPackageNames` 传进来，否则改了它们会被误判为「可跳过」。
 *
 * @param {string} repoRoot 仓库根目录
 * @param {{ additionalPackageNames?: string[] }} [options]
 * @returns {Promise<string[]>} 参与新鲜度比较的绝对路径（目录或文件）
 */
export async function resolveAgentCliSourceRoots(repoRoot, { additionalPackageNames = [] } = {}) {
  const index = await readWorkspacePackageIndex(repoRoot);
  const roots = new Set();
  const visited = new Set();
  const queue = [CLOSURE_ENTRY_PACKAGE, ...additionalPackageNames];

  while (queue.length > 0) {
    const packageName = queue.shift();
    if (packageName === undefined || visited.has(packageName)) continue;
    visited.add(packageName);
    const directory = index.get(packageName);
    if (directory === undefined) continue;

    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) roots.add(manifestPath);
    for (const subdirectory of SCANNED_PACKAGE_SUBDIRECTORIES) {
      const candidate = join(directory, subdirectory);
      if (existsSync(candidate)) roots.add(candidate);
    }

    const manifest = await readWorkspaceManifest(directory);
    if (manifest === null) continue;
    for (const field of CLOSURE_DEPENDENCY_FIELDS) {
      const dependencies = manifest[field];
      if (dependencies === null || typeof dependencies !== "object") continue;
      for (const dependencyName of Object.keys(dependencies)) {
        if (index.has(dependencyName) && !visited.has(dependencyName)) queue.push(dependencyName);
      }
    }
  }

  return [...roots].sort();
}

async function scanNewestMtimeMs(path) {
  let entryStat;
  try {
    entryStat = await stat(path);
  } catch {
    // 目录/文件不存在（例如某个包尚未落盘）不参与比较；整体判定由 bundle 是否存在兜底。
    return 0;
  }
  if (!entryStat.isDirectory()) {
    return entryStat.mtimeMs;
  }

  // 目录自身的 mtime 也计入：新增/删除文件会更新目录 mtime，即使新增文件本身
  // 的 mtime 因复制工具保留旧时间戳而偏旧，也能识别出结构变化。
  let newest = entryStat.mtimeMs;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return newest;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) {
      continue;
    }
    newest = Math.max(newest, await scanNewestMtimeMs(join(path, entry.name)));
  }
  return newest;
}

/** 所有源路径里最新的 mtime（毫秒）。一个都读不到时返回 0，交由调用方保守处理。 */
export async function findNewestSourceMtimeMs(sourceRoots) {
  let newest = 0;
  for (const root of sourceRoots) {
    newest = Math.max(newest, await scanNewestMtimeMs(root));
  }
  return newest;
}

/**
 * bundle 新鲜度详情（供调用方打日志；`isAgentCliBundleFresh` 是它的布尔投影）。
 *
 * @param {{ bundlePath: string, sourceRoots: string[], bundleMtimeMs?: number,
 *           newestSourceMtimeMs?: number }} options
 *   后两个参数仅供单测注入，正常调用只传路径。
 * @returns {Promise<{ fresh: boolean, reason: string, bundleMtimeMs: number | null,
 *           newestSourceMtimeMs: number | null }>}
 */
export async function inspectAgentCliBundleFreshness({
  bundlePath,
  sourceRoots,
  bundleMtimeMs,
  newestSourceMtimeMs,
}) {
  if (!existsSync(bundlePath)) {
    return { fresh: false, reason: "bundle-missing", bundleMtimeMs: null, newestSourceMtimeMs: null };
  }

  let resolvedBundleMtime = bundleMtimeMs;
  if (resolvedBundleMtime === undefined) {
    try {
      resolvedBundleMtime = (await stat(bundlePath)).mtimeMs;
    } catch {
      return {
        fresh: false,
        reason: "bundle-unreadable",
        bundleMtimeMs: null,
        newestSourceMtimeMs: null,
      };
    }
  }

  const resolvedNewestSource = newestSourceMtimeMs ?? (await findNewestSourceMtimeMs(sourceRoots));
  if (resolvedNewestSource === 0) {
    // 源目录一个都读不到时不冒险复用。
    return {
      fresh: false,
      reason: "sources-unreadable",
      bundleMtimeMs: resolvedBundleMtime,
      newestSourceMtimeMs: 0,
    };
  }
  // 相等视为新鲜：某些文件系统（复制/解包）会把同一批文件的 mtime 抹平。
  const fresh = resolvedBundleMtime >= resolvedNewestSource;
  return {
    fresh,
    reason: fresh ? "fresh" : "source-newer",
    bundleMtimeMs: resolvedBundleMtime,
    newestSourceMtimeMs: resolvedNewestSource,
  };
}

/**
 * bundle 是否可直接复用。
 *
 * @param {{ bundlePath: string, sourceRoots: string[], bundleMtimeMs?: number,
 *           newestSourceMtimeMs?: number }} options
 */
export async function isAgentCliBundleFresh(options) {
  return (await inspectAgentCliBundleFreshness(options)).fresh;
}
