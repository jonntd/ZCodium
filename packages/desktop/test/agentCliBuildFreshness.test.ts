import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

type SourceRootsOptions = { additionalPackageNames?: string[] };
type FreshnessOptions = {
  bundlePath: string;
  sourceRoots: string[];
  bundleMtimeMs?: number;
  newestSourceMtimeMs?: number;
};
type FreshnessReport = {
  fresh: boolean;
  reason: string;
  bundleMtimeMs: number | null;
  newestSourceMtimeMs: number | null;
};

let resolveAgentCliSourceRoots: (repoRoot: string, options?: SourceRootsOptions) => Promise<string[]>;
let findNewestSourceMtimeMs: (sourceRoots: string[]) => Promise<number>;
let isAgentCliBundleFresh: (options: FreshnessOptions) => Promise<boolean>;
let inspectAgentCliBundleFreshness: (options: FreshnessOptions) => Promise<FreshnessReport>;

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const BASE_MTIME_MS = Date.parse("2026-01-01T00:00:00.000Z");

beforeAll(async () => {
  const moduleUrl = pathToFileURL(
    resolve(repositoryRoot, "scripts/agent-cli-build-freshness.mjs"),
  ).href;
  const module = (await import(moduleUrl)) as {
    resolveAgentCliSourceRoots: typeof resolveAgentCliSourceRoots;
    findNewestSourceMtimeMs: typeof findNewestSourceMtimeMs;
    isAgentCliBundleFresh: typeof isAgentCliBundleFresh;
    inspectAgentCliBundleFreshness: typeof inspectAgentCliBundleFreshness;
  };
  resolveAgentCliSourceRoots = module.resolveAgentCliSourceRoots;
  findNewestSourceMtimeMs = module.findNewestSourceMtimeMs;
  isAgentCliBundleFresh = module.isAgentCliBundleFresh;
  inspectAgentCliBundleFreshness = module.inspectAgentCliBundleFreshness;
});

const tempDirs: string[] = [];

async function makeTempDir() {
  const directory = await mkdtemp(join(tmpdir(), "zcode-agent-cli-freshness-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

function writeFile(path: string, contents = "export const value = 1;\n") {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

/** 写入 `<root>/<relative>/package.json`（含 name 与 dependencies）。 */
function writePackage(
  root: string,
  relativeDirectory: string,
  name: string,
  dependencies: Record<string, string> = {},
) {
  const directory = resolve(root, relativeDirectory);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ name, version: "0.0.0", dependencies }, null, 2),
  );
  return directory;
}

function setMtimeMs(path: string, mtimeMs: number) {
  const seconds = mtimeMs / 1000;
  utimesSync(path, seconds, seconds);
}

/** 把整棵子树（含目录自身）的 mtime 固定到同一时刻，消除「刚创建」带来的时间漂移。 */
function freezeTreeMtimeMs(path: string, mtimeMs: number) {
  if (!existsSync(path)) return;
  setMtimeMs(path, mtimeMs);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) freezeTreeMtimeMs(child, mtimeMs);
    else setMtimeMs(child, mtimeMs);
  }
}

describe("resolveAgentCliSourceRoots", () => {
  it("follows the @zcode/cli workspace dependency closure and skips unrelated packages", async () => {
    const root = await makeTempDir();
    writePackage(root, "apps/zcode-cli/packages/cli", "@zcode/cli", {
      "@zcode/core": "workspace:*",
      "playwright-core": "1.59.1",
    });
    writePackage(root, "apps/zcode-cli/packages/core", "@zcode/core", {
      "@zcode/shared": "workspace:*",
    });
    writePackage(root, "packages/shared", "@zcode/shared", { "@zcode/rpc": "workspace:*" });
    writePackage(root, "packages/rpc", "@zcode/rpc");
    // 非依赖包：UI / desktop 与 CLI bundle 无关，不应进入比较范围（否则改前端也要重建 CLI）。
    writePackage(root, "packages/ui", "@zcode/ui");
    writePackage(root, "packages/desktop", "@zcode/desktop");

    for (const relative of [
      "apps/zcode-cli/packages/cli/src",
      "apps/zcode-cli/packages/cli/scripts",
      "apps/zcode-cli/packages/core/src",
      "packages/shared/src",
      "packages/rpc/src",
      "packages/ui/src",
      "packages/desktop/src",
    ]) {
      writeFile(resolve(root, relative, "index.ts"));
    }

    const roots = (await resolveAgentCliSourceRoots(root)).map((entry) =>
      entry.slice(root.length + 1),
    );

    expect(roots).toEqual(
      [
        "apps/zcode-cli/packages/cli/package.json",
        "apps/zcode-cli/packages/cli/scripts",
        "apps/zcode-cli/packages/cli/src",
        "apps/zcode-cli/packages/core/package.json",
        "apps/zcode-cli/packages/core/src",
        "packages/rpc/package.json",
        "packages/rpc/src",
        "packages/shared/package.json",
        "packages/shared/src",
      ].sort(),
    );
  });

  it("pulls in separately built MCP runtimes only when they are named explicitly", async () => {
    const root = await makeTempDir();
    writePackage(root, "apps/zcode-cli/packages/cli", "@zcode/cli");
    writeFile(resolve(root, "apps/zcode-cli/packages/cli/src/index.ts"));
    writePackage(root, "apps/zcode-cli/packages/node-repl-host", "@zcode/node-repl-host");
    writeFile(resolve(root, "apps/zcode-cli/packages/node-repl-host/src/index.ts"));

    const withoutRuntime = await resolveAgentCliSourceRoots(root);
    expect(withoutRuntime.some((entry) => entry.includes("node-repl-host"))).toBe(false);

    const withRuntime = await resolveAgentCliSourceRoots(root, {
      additionalPackageNames: ["@zcode/node-repl-host"],
    });
    expect(withRuntime).toContain(resolve(root, "apps/zcode-cli/packages/node-repl-host/src"));
    expect(withRuntime).toContain(
      resolve(root, "apps/zcode-cli/packages/node-repl-host/package.json"),
    );
  });

  it("tolerates missing package directories and unknown package names", async () => {
    const root = await makeTempDir();
    writePackage(root, "apps/zcode-cli/packages/cli", "@zcode/cli");
    expect(
      await resolveAgentCliSourceRoots(root, { additionalPackageNames: ["@zcode/nope"] }),
    ).toEqual([resolve(root, "apps/zcode-cli/packages/cli/package.json")]);
  });
});

describe("agent CLI bundle freshness", () => {
  async function fixture() {
    const root = await makeTempDir();
    writePackage(root, "apps/zcode-cli/packages/cli", "@zcode/cli", {
      "@zcode/core": "workspace:*",
    });
    writePackage(root, "apps/zcode-cli/packages/core", "@zcode/core");
    writeFile(resolve(root, "apps/zcode-cli/packages/cli/src/index.ts"));
    writeFile(resolve(root, "apps/zcode-cli/packages/core/src/index.ts"));
    const bundlePath = resolve(root, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
    writeFile(bundlePath, "// bundle\n");
    const sourceRoots = await resolveAgentCliSourceRoots(root);
    freezeTreeMtimeMs(resolve(root, "apps/zcode-cli/packages"), BASE_MTIME_MS);
    return { root, bundlePath, sourceRoots, coreSourceRoot: resolve(root, "apps/zcode-cli/packages/core/src") };
  }

  it("treats a missing bundle as stale", async () => {
    const root = await makeTempDir();
    const bundlePath = resolve(root, "missing/zcode.cjs");
    const report = await inspectAgentCliBundleFreshness({
      bundlePath,
      sourceRoots: [resolve(root, "src")],
    });
    expect(report).toMatchObject({ fresh: false, reason: "bundle-missing" });
    expect(await isAgentCliBundleFresh({ bundlePath, sourceRoots: [resolve(root, "src")] })).toBe(
      false,
    );
  });

  it("reuses a bundle that is newer than every source file", async () => {
    const { bundlePath, sourceRoots } = await fixture();
    setMtimeMs(bundlePath, BASE_MTIME_MS + 10_000);
    const report = await inspectAgentCliBundleFreshness({ bundlePath, sourceRoots });
    expect(report.fresh).toBe(true);
    expect(report.reason).toBe("fresh");
    expect(report.bundleMtimeMs).toBeGreaterThan(report.newestSourceMtimeMs ?? 0);
  });

  it("rebuilds when any single source file is newer than the bundle", async () => {
    const { root, bundlePath, sourceRoots } = await fixture();
    setMtimeMs(bundlePath, BASE_MTIME_MS + 10_000);
    const touched = resolve(root, "apps/zcode-cli/packages/core/src/index.ts");
    setMtimeMs(touched, BASE_MTIME_MS + 60_000);
    const report = await inspectAgentCliBundleFreshness({ bundlePath, sourceRoots });
    expect(report).toMatchObject({ fresh: false, reason: "source-newer" });
    expect(report.newestSourceMtimeMs).toBeGreaterThan(report.bundleMtimeMs ?? 0);
  });

  it("treats identical timestamps as fresh (filesystems flatten mtimes)", async () => {
    const { bundlePath, sourceRoots } = await fixture();
    setMtimeMs(bundlePath, BASE_MTIME_MS);
    expect((await inspectAgentCliBundleFreshness({ bundlePath, sourceRoots })).fresh).toBe(true);
  });

  it("ignores build outputs and dependency caches inside source roots", async () => {
    const { bundlePath, sourceRoots, coreSourceRoot } = await fixture();
    setMtimeMs(bundlePath, BASE_MTIME_MS + 10_000);
    for (const relative of [
      "dist/generated.js",
      "node_modules/dep/index.js",
      ".turbo/cache.json",
      "coverage/report.json",
    ]) {
      const path = resolve(coreSourceRoot, relative);
      writeFile(path);
      setMtimeMs(path, BASE_MTIME_MS + 600_000);
    }
    // 新建目录会刷新父目录 mtime；这里把它复位，从而只检验「被忽略目录内部的时间戳不参与比较」。
    freezeTreeMtimeMs(coreSourceRoot, BASE_MTIME_MS);
    for (const relative of [
      "dist/generated.js",
      "node_modules/dep/index.js",
      ".turbo/cache.json",
      "coverage/report.json",
    ]) {
      setMtimeMs(resolve(coreSourceRoot, relative), BASE_MTIME_MS + 600_000);
    }
    const report = await inspectAgentCliBundleFreshness({ bundlePath, sourceRoots });
    expect(report).toMatchObject({ fresh: true, reason: "fresh" });
  });

  it("detects structural changes through the directory mtime", async () => {
    const { root, bundlePath, sourceRoots } = await fixture();
    setMtimeMs(bundlePath, BASE_MTIME_MS + 10_000);
    // 复制/解包工具可能保留旧文件时间戳，但新增文件仍会刷新目录 mtime。
    writeFile(resolve(root, "apps/zcode-cli/packages/core/src/added.ts"));
    const report = await inspectAgentCliBundleFreshness({ bundlePath, sourceRoots });
    expect(report).toMatchObject({ fresh: false, reason: "source-newer" });
  });

  it("refuses to reuse the bundle when no source root is readable", async () => {
    const root = await makeTempDir();
    const bundlePath = resolve(root, "zcode.cjs");
    writeFile(bundlePath);
    expect(await findNewestSourceMtimeMs([resolve(root, "does-not-exist")])).toBe(0);
    expect(
      await inspectAgentCliBundleFreshness({ bundlePath, sourceRoots: [resolve(root, "nope")] }),
    ).toMatchObject({ fresh: false, reason: "sources-unreadable" });
  });

  it("accepts injected timestamps for callers that already statted the bundle", async () => {
    const { bundlePath, sourceRoots } = await fixture();
    expect(
      await isAgentCliBundleFresh({
        bundlePath,
        sourceRoots,
        bundleMtimeMs: 5_000,
        newestSourceMtimeMs: 4_000,
      }),
    ).toBe(true);
    expect(
      await isAgentCliBundleFresh({
        bundlePath,
        sourceRoots,
        bundleMtimeMs: 3_000,
        newestSourceMtimeMs: 4_000,
      }),
    ).toBe(false);
  });
});

describe("real repository wiring", () => {
  const runtimePackageNames = ["@zcode/node-repl-host", "@zcode/browser-use-plugin"];

  it("every declared source root exists, so no package can silently drop out of the scan", async () => {
    const roots = await resolveAgentCliSourceRoots(repositoryRoot, {
      additionalPackageNames: runtimePackageNames,
    });
    expect(roots.length).toBeGreaterThan(0);
    expect(roots.filter((entry) => !existsSync(entry))).toEqual([]);
  });

  it("covers the CLI build chain that dev rebuilds", async () => {
    const roots = await resolveAgentCliSourceRoots(repositoryRoot, {
      additionalPackageNames: runtimePackageNames,
    });
    const normalized = roots.map((entry) => entry.slice(repositoryRoot.length + 1));
    for (const relative of [
      "apps/zcode-cli/packages/cli/src",
      "apps/zcode-cli/packages/core/src",
      "apps/zcode-cli/packages/bootstrap/src",
      "apps/zcode-cli/packages/tui/src",
      "apps/zcode-cli/packages/node-repl-host/src",
      "apps/zcode-cli/packages/browser-use-plugin/src",
      "packages/shared/src",
      "packages/services/src",
      "packages/provider-node/src",
    ]) {
      expect(normalized, relative).toContain(relative);
    }
  });

  it("keeps the opt-in gate wired into the dev build script", () => {
    const buildScript = readFileSync(
      resolve(repositoryRoot, "scripts/build-desktop-agent-cli.mjs"),
      "utf8",
    );
    // 门禁必须在默认构建之前：放在后面就永远不会被触发。
    const gateIndex = buildScript.indexOf('process.env.ZCODE_SKIP_AGENT_CLI_BUILD === "1"');
    expect(gateIndex).toBeGreaterThan(0);
    expect(gateIndex).toBeLessThan(buildScript.indexOf("if (!useTurboBuild)"));
    expect(buildScript).toContain("inspectAgentCliBundleFreshness(");
    // 两个独立 MCP runtime 不在 CLI 依赖闭包里，必须显式补进源范围。
    expect(buildScript).toContain("requiredDevPluginRuntimeBuilds.map(({ packageName }) => packageName)");
  });

  it("passes the skip switch only to the agent CLI build step", () => {
    const devScript = readFileSync(resolve(repositoryRoot, "scripts/dev-desktop-env.mjs"), "utf8");
    expect(devScript).toContain('"--skip-agent-cli-build"');
    expect(devScript).toContain("skipAgentCliBuild ? { ZCODE_SKIP_AGENT_CLI_BUILD: \"1\" } : {}");
    const rootManifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));
    expect(rootManifest.scripts["dev:desktop:fast"]).toContain("--skip-agent-cli-build");
  });
});
