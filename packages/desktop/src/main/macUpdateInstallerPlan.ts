// macOS 直替换更新安装的决策矩阵（纯函数，禁止引入 electron 运行时）。
// 背景与行为规则见 docs/spec/macos-direct-swap-update.md：
// Squirrel 用“运行中应用的 designated requirement”校验新包，旧版未密封安装的隐式要求
// 是 cdhash 精确匹配，任何新包都无法满足；mac 安装改为解压→自检→重命名替换。

import semver from "semver";

export type MacDirectSwapSkipReason =
  | "non-darwin-platform"
  | "not-packaged-runtime"
  | "missing-app-bundle"
  | "missing-update-zip"
  | "update-version-not-newer";

export interface MacDirectSwapPlanInput {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  currentVersion: string;
  targetVersion: string;
  appBundlePath: string | null;
  updateZipPath: string | null;
}

export type MacDirectSwapPlan =
  | { action: "swap" }
  | { action: "skip"; reason: MacDirectSwapSkipReason };

export interface MacDirectSwapStep {
  kind:
    | "extract"
    | "verify-plist"
    | "verify-codesign"
    | "backup-rename"
    | "swap-rename"
    | "verify-exec";
  command: string;
  args: string[];
}

// electron-updater 只比较 semver；这里与 autoUpdater.ts 的 isVersionGreaterThan 保持同一
// 归一化口径，版本非法时退化为字符串不等比较。
function normalizeVersionForCompare(version: string): string | null {
  return semver.valid(semver.coerce(version.trim()));
}

function isTargetVersionNewer(targetVersion: string, currentVersion: string): boolean {
  const target = normalizeVersionForCompare(targetVersion);
  const current = normalizeVersionForCompare(currentVersion);
  if (target && current) {
    return semver.gt(target, current);
  }
  return targetVersion.trim() !== currentVersion.trim();
}

export function resolveMacDirectSwapPlan(input: MacDirectSwapPlanInput): MacDirectSwapPlan {
  if (input.platform !== "darwin") {
    return { action: "skip", reason: "non-darwin-platform" };
  }
  if (!input.isPackaged) {
    return { action: "skip", reason: "not-packaged-runtime" };
  }
  if (!input.appBundlePath) {
    return { action: "skip", reason: "missing-app-bundle" };
  }
  if (!input.updateZipPath) {
    return { action: "skip", reason: "missing-update-zip" };
  }
  if (!isTargetVersionNewer(input.targetVersion, input.currentVersion)) {
    return { action: "skip", reason: "update-version-not-newer" };
  }
  return { action: "swap" };
}
