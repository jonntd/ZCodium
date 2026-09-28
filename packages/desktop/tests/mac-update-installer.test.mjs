import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMacDirectSwapPlan } from "../src/main/macUpdateInstallerPlan.ts";
import { resolveMacAppBundlePathFromResources } from "../src/main/macUpdateInstaller.ts";

// 依据 docs/spec/macos-direct-swap-update.md 的安装前置校验顺序。

function buildSwapInput(overrides = {}) {
  return {
    platform: "darwin",
    isPackaged: true,
    currentVersion: "3.14.7",
    targetVersion: "3.14.8",
    appBundlePath: "/Applications/ZCodium.app",
    updateZipPath: "/tmp/update.zip",
    ...overrides,
  };
}

test("swaps when darwin packaged with newer update zip", () => {
  const plan = resolveMacDirectSwapPlan(buildSwapInput());
  assert.equal(plan.action, "swap");
});

test("skips non-darwin platforms (windows/linux keep native updater flow)", () => {
  for (const platform of ["win32", "linux"]) {
    const plan = resolveMacDirectSwapPlan(buildSwapInput({ platform }));
    assert.deepEqual(plan, { action: "skip", reason: "non-darwin-platform" });
  }
});

test("skips unpackaged runtime (dev builds have no publish bundle to swap)", () => {
  const plan = resolveMacDirectSwapPlan(buildSwapInput({ isPackaged: false }));
  assert.deepEqual(plan, { action: "skip", reason: "not-packaged-runtime" });
});

test("skips when app bundle path cannot be resolved", () => {
  const plan = resolveMacDirectSwapPlan(buildSwapInput({ appBundlePath: null }));
  assert.deepEqual(plan, { action: "skip", reason: "missing-app-bundle" });
});

test("skips when update zip path is unavailable", () => {
  const plan = resolveMacDirectSwapPlan(buildSwapInput({ updateZipPath: null }));
  assert.deepEqual(plan, { action: "skip", reason: "missing-update-zip" });
});

test("skips when target version equals current version (idempotent re-entry)", () => {
  const plan = resolveMacDirectSwapPlan(
    buildSwapInput({ targetVersion: "3.14.7", currentVersion: "3.14.7" }),
  );
  assert.deepEqual(plan, { action: "skip", reason: "update-version-not-newer" });
});

test("skips when target version is older than current version (no downgrade)", () => {
  const plan = resolveMacDirectSwapPlan(
    buildSwapInput({ targetVersion: "3.14.6", currentVersion: "3.14.7" }),
  );
  assert.deepEqual(plan, { action: "skip", reason: "update-version-not-newer" });
});

test("compares coerced semver so prerelease-style feed versions still work", () => {
  const plan = resolveMacDirectSwapPlan(
    buildSwapInput({ targetVersion: "3.14.10", currentVersion: "3.14.9" }),
  );
  assert.equal(plan.action, "swap");
});

test("resolves bundle path from packaged resources path", () => {
  assert.equal(
    resolveMacAppBundlePathFromResources("/Applications/ZCodium.app/Contents/Resources"),
    "/Applications/ZCodium.app",
  );
});

test("returns null when resources path does not look like a mac bundle", () => {
  assert.equal(resolveMacAppBundlePathFromResources("/Users/dev/ZCodium/out"), null);
});
