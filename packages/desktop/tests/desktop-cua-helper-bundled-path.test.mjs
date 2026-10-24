import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultDevCuaHelperRootCandidates,
  readCuaHelperBuildIdFromPlist,
  resolveDevCuaHelperAppPath,
} from "../src/main/desktopCuaHelperBundledPath.js";

// dev 态 CUA Helper bundled 源候选顺序的回归守卫（docs/spec/cua-runtime-builtin.md §C，
// 2026-10-24 回归修复）。desktopCuaHelperInstaller.ts 依赖 electron 导入面，node --test
// 无法直接加载；解析本体抽到零依赖纯函数 desktopCuaHelperBundledPath.ts，这里直测顺序，
// 另用源码守卫钉住 main 侧 installer 的接线不得被删（删掉即复现官方 CDN 回退）。

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function makeExists(known) {
  const set = new Set(known);
  return (path) => set.has(path);
}

test("staged 补丁件排在 zcode home 既有安装之前（986c692 顺序约束）", () => {
  const staged = "/repo/packages/desktop/bundled-cua-helper/darwin-arm64/ZCode Computer Use.app";
  const homeDev = "/home/.zcodium/computer-use/dev/ZCode Computer Use Dev.app";
  const homePlain = "/home/.zcodium/computer-use/ZCode Computer Use.app";
  const picked = resolveDevCuaHelperAppPath({
    zcodeHome: "/home/.zcodium",
    platformKey: "darwin-arm64",
    rootCandidates: ["/repo/packages/desktop/bundled-cua-helper"],
    existsSyncImpl: makeExists([staged, homeDev, homePlain]),
  });
  assert.equal(picked, staged);
});

test("home 既有安装按 dev 变体优先、平台 key 拼进 staged 路径", () => {
  const homeDev = "/home/.zcodium/computer-use/dev/ZCode Computer Use Dev.app";
  const homePlain = "/home/.zcodium/computer-use/ZCode Computer Use.app";
  const picked = resolveDevCuaHelperAppPath({
    zcodeHome: "/home/.zcodium",
    platformKey: "darwin-arm64",
    rootCandidates: ["/repo/packages/desktop/bundled-cua-helper"],
    existsSyncImpl: makeExists([homeDev, homePlain]),
  });
  assert.equal(picked, homeDev);

  const pickedPlain = resolveDevCuaHelperAppPath({
    zcodeHome: "/home/.zcodium",
    platformKey: "darwin-arm64",
    rootCandidates: ["/repo/packages/desktop/bundled-cua-helper"],
    existsSyncImpl: makeExists([homePlain]),
  });
  assert.equal(pickedPlain, homePlain);
});

test("显式 envOverride 存在时优先；不存在时不得拦截后续候选", () => {
  const staged = "/repo/packages/desktop/bundled-cua-helper/darwin-arm64/ZCode Computer Use.app";
  const override = "/opt/custom-helper/ZCode Computer Use.app";
  assert.equal(
    resolveDevCuaHelperAppPath({
      envOverride: override,
      zcodeHome: "/home/.zcodium",
      platformKey: "darwin-arm64",
      rootCandidates: ["/repo/packages/desktop/bundled-cua-helper"],
      existsSyncImpl: makeExists([staged, override]),
    }),
    override,
  );
  assert.equal(
    resolveDevCuaHelperAppPath({
      envOverride: "/missing/ZCode Computer Use.app",
      zcodeHome: "/home/.zcodium",
      platformKey: "darwin-arm64",
      rootCandidates: ["/repo/packages/desktop/bundled-cua-helper"],
      existsSyncImpl: makeExists([staged]),
    }),
    staged,
  );
});

test("全部缺失 → undefined（全新机器语义，交给安装引导）", () => {
  assert.equal(
    resolveDevCuaHelperAppPath({
      zcodeHome: "/home/.zcodium",
      platformKey: "darwin-arm64",
      rootCandidates: ["/repo/packages/desktop/bundled-cua-helper"],
      existsSyncImpl: makeExists([]),
    }),
    undefined,
  );
});

test("defaultDevCuaHelperRootCandidates 覆盖仓库根 / packages/desktop / 产物相对位置", () => {
  const candidates = defaultDevCuaHelperRootCandidates("/repo", "/repo/packages/desktop/src/main");
  assert.deepEqual(candidates, [
    "/repo/bundled-cua-helper",
    "/repo/packages/desktop/bundled-cua-helper",
    "/repo/packages/desktop/bundled-cua-helper",
  ]);
});

test("main 侧 installer 接线守卫：dev staged 兜底不得被删（否则复现官方 CDN 回退）", () => {
  const source = readFileSync(
    resolve(repoRoot, "packages/desktop/src/main/desktopCuaHelperInstaller.ts"),
    "utf8",
  );
  assert.ok(
    source.includes("resolveDevCuaHelperAppPath"),
    "createDesktopCuaHelperInstaller 必须接 desktopCuaHelperBundledPath 的 dev staged 解析；" +
      "删掉后 dev 态 onboarding 会回退官方 dev CDN 下载（fork 不可达），浮窗不再出现（2026-10-24 回归）",
  );
  // 与 host env 注入共用同一解析，不允许在 installer 里另写一份候选顺序。
  assert.ok(
    !source.includes("computer-use"),
    "installer 不得内联 zcode home 候选路径；候选顺序唯一事实源在 desktopCuaHelperBundledPath",
  );
  assert.ok(
    source.includes('ZCODE_CUA_HELPER_BUNDLE_ID: "dev.zcode.cua-helper"'),
    "dev 态必须 pin stock bundle id：dev 变体默认期望 dev.zcode.cua-helper.dev，" +
      "staged 件是官方 stock id，缺 pin 必报 bundle id does not match（2026-10-24 实测第二段）",
  );
  assert.ok(
    source.includes("readCuaHelperBuildIdFromPlist"),
    "dev 态必须用 staged 件 Info.plist 实读 buildId 钉住期望：vendor 内嵌字面量与 staged 不一致",
  );
});

test("readCuaHelperBuildIdFromPlist 对本机 staged 件实读成功且格式合法", () => {
  const staged = resolve(
    repoRoot,
    "packages/desktop/bundled-cua-helper/darwin-arm64/ZCode Computer Use.app",
  );
  if (!existsSync(staged)) return; // 未跑 prepare:cua-helper 的机器跳过
  const buildId = readCuaHelperBuildIdFromPlist(staged);
  assert.match(buildId, /^pipeline-[0-9]+-[0-9a-f]+$/, "staged 件 buildId 必须可实读");
});

test("desktopRuntimeEnv 与 installer 共用同一纯解析（防两链漂移）", () => {
  const source = readFileSync(
    resolve(repoRoot, "packages/desktop/src/main/desktopRuntimeEnv.ts"),
    "utf8",
  );
  assert.ok(
    source.includes("desktopCuaHelperBundledPath.js"),
    "desktopRuntimeEnv 的 dev 候选解析必须来自 desktopCuaHelperBundledPath 共享模块",
  );
});
