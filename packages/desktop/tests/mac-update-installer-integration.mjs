// 直替换安装器独立集成验证：用真实 dist 应用 + 真实 feed zip 走一遍
// 决策 → 解压 → plist/codesign 自检 → rename 替换 → 回滚语义。
// 依据 docs/spec/macos-direct-swap-update.md。
// 运行前提：先本地打包（packages/desktop/dist/mac-arm64/ZCodium.app）并准备
// .tmp/e2e-swap/feed 的升级版 zip（见 .tmp/e2e-swap/prepare-feed.sh，本地辅助脚本不入库）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  installMacUpdateBundleSwap,
  cleanupStaleMacUpdateArtifacts,
  resolveMacAppBundlePathFromResources,
} from "../src/main/macUpdateInstaller.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const E = path.join(repoRoot, ".tmp/e2e-swap");
const DIST_APP = path.join(repoRoot, "packages/desktop/dist/mac-arm64/ZCodium.app");
const FEED_ZIP = path.join(E, "feed/ZCodium-3.14.4-mac-arm64.zip");
if (!existsSync(DIST_APP) || !existsSync(FEED_ZIP)) {
  console.log("SKIP: local pack artifacts missing (run local bundle + prepare-feed.sh first)");
  process.exit(0);
}

function plistVersion(appPath) {
  return execFileSync("/usr/bin/plutil", [
    "-extract",
    "CFBundleShortVersionString",
    "raw",
    "-o",
    "-",
    path.join(appPath, "Contents", "Info.plist"),
  ])
    .toString()
    .trim();
}

const sandbox = path.join(E, "installer-it");
rmSync(sandbox, { recursive: true, force: true });
mkdirSync(path.join(sandbox, "apps"), { recursive: true });

// 1) 组装"已安装应用"目录结构：apps/ZCodium.app（3.14.3）
const bundlePath = path.join(sandbox, "apps", "ZCodium.app");
cpSync(DIST_APP, bundlePath, { recursive: true });
assert.equal(plistVersion(bundlePath), "3.14.3");

// 2) 资源路径推导
assert.equal(
  resolveMacAppBundlePathFromResources(path.join(bundlePath, "Contents", "Resources")),
  bundlePath,
);

// 3) 版本不新于当前 → skip，不动 bundle
const skipResult = await installMacUpdateBundleSwap({
  targetVersion: "3.14.3",
  updateZipPath: FEED_ZIP,
  isPackaged: true,
  currentVersion: "3.14.4",
  bundlePath,
  execPath: path.join(bundlePath, "Contents", "MacOS", "ZCodium"),
});
assert.deepEqual(skipResult, { ok: false, reason: "update-version-not-newer" });
assert.equal(plistVersion(bundlePath), "3.14.3", "skip must not touch the bundle");

// 4) zip 缺失 → skip
const missingZip = await installMacUpdateBundleSwap({
  targetVersion: "3.14.4",
  updateZipPath: null,
  isPackaged: true,
  currentVersion: "3.14.3",
  bundlePath,
  execPath: path.join(bundlePath, "Contents", "MacOS", "ZCodium"),
});
assert.deepEqual(missingZip, { ok: false, reason: "missing-update-zip" });

// 5) 正式替换：3.14.3 → 3.14.4
const swapResult = await installMacUpdateBundleSwap({
  targetVersion: "3.14.4",
  updateZipPath: FEED_ZIP,
  isPackaged: true,
  currentVersion: "3.14.3",
  bundlePath,
  execPath: path.join(bundlePath, "Contents", "MacOS", "ZCodium"),
});
assert.equal(swapResult.ok, true, `swap failed: ${swapResult.reason}`);
assert.equal(swapResult.execPath, path.join(bundlePath, "Contents", "MacOS", "ZCodium"));
assert.equal(plistVersion(bundlePath), "3.14.4", "bundle must be the new version");
assert.ok(existsSync(swapResult.execPath), "new executable must exist");

// 6) 备份目录保留旧版本（3.14.3），密封自洽
const entries = execFileSync("/bin/ls", [path.join(sandbox, "apps")])
  .toString()
  .trim()
  .split("\n");
const backupName = entries.find((e) => e.startsWith("ZCodium.app.update-backup-"));
assert.ok(backupName, "backup dir must be kept");
assert.equal(plistVersion(path.join(sandbox, "apps", backupName)), "3.14.3");
execFileSync("/usr/bin/codesign", ["--verify", "--strict", bundlePath]);
console.log("swapped bundle seal: OK");

// 7) 启动期清理：清掉备份，不影响在用 bundle
await cleanupStaleMacUpdateArtifacts(bundlePath);
assert.ok(!existsSync(path.join(sandbox, "apps", backupName)), "backup must be cleaned on startup");
assert.ok(existsSync(bundlePath), "current bundle must survive cleanup");

// 8) 重复替换同一版本被拒（幂等）
const repeat = await installMacUpdateBundleSwap({
  targetVersion: "3.14.4",
  updateZipPath: FEED_ZIP,
  isPackaged: true,
  currentVersion: "3.14.4",
  bundlePath,
  execPath: path.join(bundlePath, "Contents", "MacOS", "ZCodium"),
});
assert.deepEqual(repeat, { ok: false, reason: "update-version-not-newer" });

rmSync(sandbox, { recursive: true, force: true });
console.log("ALL INSTALLER INTEGRATION CHECKS PASSED");
