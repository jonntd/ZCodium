import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMacAdhocCodesignArgs,
  resolveMacAdhocCodesignPlan,
} from "../scripts/adhoc-codesign-mac.mjs";

// 依据 docs/spec/macos-adhoc-codesign.md 的触发条件与让位规则。
test("signs when packing darwin target on macOS without certificate", () => {
  const plan = resolveMacAdhocCodesignPlan({
    electronPlatformName: "darwin",
    hostPlatform: "darwin",
    enableMacSigning: false,
  });
  assert.equal(plan.action, "sign");
});

test("defers to real certificate signing", () => {
  const plan = resolveMacAdhocCodesignPlan({
    electronPlatformName: "darwin",
    hostPlatform: "darwin",
    enableMacSigning: true,
  });
  assert.equal(plan.action, "skip");
  assert.match(plan.reason, /certificate/);
});

test("skips non-darwin targets", () => {
  const plan = resolveMacAdhocCodesignPlan({
    electronPlatformName: "win32",
    hostPlatform: "darwin",
    enableMacSigning: false,
  });
  assert.equal(plan.action, "skip");
});

test("skips when codesign is unavailable on the build host", () => {
  const plan = resolveMacAdhocCodesignPlan({
    electronPlatformName: "darwin",
    hostPlatform: "linux",
    enableMacSigning: false,
  });
  assert.equal(plan.action, "skip");
});

test("codesign args sign and verify", () => {
  assert.deepEqual(buildMacAdhocCodesignArgs("/tmp/App.app"), [
    "--force",
    "--deep",
    "--sign",
    "-",
    "/tmp/App.app",
  ]);
  // 自校验必须与 Squirrel.Mac 的结构校验等价：strict 校验 bundle 密封资源。
  assert.deepEqual(
    buildMacAdhocCodesignArgs("/tmp/App.app", { verify: true }),
    ["--verify", "--strict", "/tmp/App.app"],
  );
});
