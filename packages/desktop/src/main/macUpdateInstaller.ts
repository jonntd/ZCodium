// macOS 直替换更新安装器。背景与行为规则见 docs/spec/macos-direct-swap-update.md。
//
// Squirrel.Mac 用“运行中应用的 designated requirement”校验新包；旧版未密封安装的主程序
// 是 linker 自带 adhoc 签名，隐式要求是 cdhash 精确匹配，任何新包都无法满足（3.14.6 的
// adhoc 密封包在真机上报 SQRLCodeSignatureErrorDomain 实证）。因此 mac 安装不走 Squirrel：
// electron-updater 完成下载与 sha512 校验后，这里负责解压、自检、同卷 rename 替换。
// 本模块不引入 electron：bundle 路径、当前版本等由调用方传入，保持可独立测试。

import { execFile } from "node:child_process";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { resolveMacDirectSwapPlan } from "./macUpdateInstallerPlan.js";

const execFileAsync = promisify(execFile);

const DITTO_BIN = "/usr/bin/ditto";
const PLUTIL_BIN = "/usr/bin/plutil";
const CODESIGN_BIN = "/usr/bin/codesign";

const STAGING_DIR_PREFIX = ".zcode-update-staging-";
const BACKUP_DIR_SUFFIX = ".update-backup-";

export interface MacBundleSwapOptions {
  targetVersion: string;
  updateZipPath: string | null;
  isPackaged: boolean;
  currentVersion: string;
  /** 当前运行应用的 .app bundle 绝对路径（调用方从 process.resourcesPath 推导）。 */
  bundlePath: string | null;
  /** 当前主程序完整路径（process.execPath），替换后按同目录结构定位新主程序。 */
  execPath: string;
}

export type MacBundleSwapResult = { ok: true; execPath: string } | { ok: false; reason: string };

interface StagedAppBundle {
  appPath: string;
  bundleIdentifier: string;
  shortVersion: string;
}

async function runCommand(command: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    // ditto/plutil/codesign 输出都很小；限制一下避免异常时撑爆内存。
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.toString().trim();
}

async function readPlistRawValue(plistPath: string, key: string): Promise<string> {
  return runCommand(PLUTIL_BIN, ["-extract", key, "raw", "-o", "-", plistPath]);
}

/** 从 zip 解压产物里定位 .app bundle 并读取用于自检的关键 plist 字段。 */
async function locateStagedAppBundle(stagingDir: string): Promise<StagedAppBundle | null> {
  const entries = await readdir(stagingDir);
  for (const entry of entries) {
    if (!entry.endsWith(".app")) {
      continue;
    }
    const appPath = path.join(stagingDir, entry);
    const infoPlistPath = path.join(appPath, "Contents", "Info.plist");
    const infoPlistStat = await stat(infoPlistPath).catch(() => null);
    if (!infoPlistStat?.isFile()) {
      continue;
    }
    const bundleIdentifier = await readPlistRawValue(infoPlistPath, "CFBundleIdentifier");
    const shortVersion = await readPlistRawValue(infoPlistPath, "CFBundleShortVersionString");
    return { appPath, bundleIdentifier, shortVersion };
  }
  return null;
}

/**
 * 用同卷 rename 完成替换：旧 bundle 挪到备份位，新 bundle 挪到原位。
 * rename 是原子操作且不影响运行中进程（旧 inode 由运行进程继续持有）；
 * 第二步失败时把备份挪回原位，保证应用始终完整可用。
 */
async function swapAppBundle(
  bundlePath: string,
  stagedAppPath: string,
): Promise<{ ok: true; backupPath: string } | { ok: false; reason: string }> {
  const backupPath = `${bundlePath}${BACKUP_DIR_SUFFIX}${Date.now()}`;
  await rename(bundlePath, backupPath);
  try {
    await rename(stagedAppPath, bundlePath);
  } catch (error) {
    try {
      await rename(backupPath, bundlePath);
    } catch (restoreError) {
      return {
        ok: false,
        reason: `swap rename failed (${String(error)}); restore backup failed (${String(restoreError)}); backup kept at ${backupPath}`,
      };
    }
    return { ok: false, reason: `swap rename failed, old bundle restored: ${String(error)}` };
  }
  return { ok: true, backupPath };
}

/** 安装已下载（electron-updater 已 sha512 校验）的 mac 更新 zip：解压 → 自检 → 替换。 */
export async function installMacUpdateBundleSwap(
  options: MacBundleSwapOptions,
): Promise<MacBundleSwapResult> {
  const plan = resolveMacDirectSwapPlan({
    platform: process.platform,
    isPackaged: options.isPackaged,
    currentVersion: options.currentVersion,
    targetVersion: options.targetVersion,
    appBundlePath: options.bundlePath,
    updateZipPath: options.updateZipPath,
  });
  if (plan.action === "skip") {
    return { ok: false, reason: plan.reason };
  }
  const bundlePath = options.bundlePath as string;
  const updateZipPath = options.updateZipPath as string;
  const bundleDir = path.dirname(bundlePath);
  const stagingDir = path.join(bundleDir, `${STAGING_DIR_PREFIX}${process.pid}-${Date.now()}`);

  try {
    await mkdir(stagingDir, { recursive: true });
    // ditto 解压保留权限与元数据，zip 内 .app 位于根目录。
    await runCommand(DITTO_BIN, ["-x", "-k", updateZipPath, stagingDir]);

    const staged = await locateStagedAppBundle(stagingDir);
    if (!staged) {
      return { ok: false, reason: "no .app bundle found in update zip" };
    }

    // 自检 1/3：bundle id 必须与当前应用一致，防止把别的应用替换进来。
    const currentBundleIdentifier = await readPlistRawValue(
      path.join(bundlePath, "Contents", "Info.plist"),
      "CFBundleIdentifier",
    );
    if (staged.bundleIdentifier !== currentBundleIdentifier) {
      return {
        ok: false,
        reason: `bundle identifier mismatch: staged=${staged.bundleIdentifier} current=${currentBundleIdentifier}`,
      };
    }

    // 自检 2/3：版本必须与 feed 声明的目标版本一致，防止替换进错误构建。
    if (staged.shortVersion !== options.targetVersion.trim()) {
      return {
        ok: false,
        reason: `staged version mismatch: staged=${staged.shortVersion} target=${options.targetVersion}`,
      };
    }

    // 自检 3/3：密封自洽校验（密封由 afterPack 的 adhoc 兜底签名保证，见
    // docs/spec/macos-adhoc-codesign.md）。不校验 designated requirement——
    // 正是它对旧版安装不可满足，才改用直替换。
    await runCommand(CODESIGN_BIN, ["--verify", "--strict", staged.appPath]);

    const swapResult = await swapAppBundle(bundlePath, staged.appPath);
    if (!swapResult.ok) {
      return swapResult;
    }

    const newExecPath = path.join(bundlePath, "Contents", "MacOS", path.basename(options.execPath));
    const newExecStat = await stat(newExecPath).catch(() => null);
    if (!newExecStat?.isFile()) {
      // 主程序缺失说明 zip 结构异常；回滚备份并报失败。
      await rename(swapResult.backupPath, bundlePath).catch(() => undefined);
      return { ok: false, reason: `new executable missing after swap: ${newExecPath}` };
    }

    return { ok: true, execPath: newExecPath };
  } catch (error) {
    return { ok: false, reason: String(error) };
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** 启动期清理上一次更新留下的备份与暂存目录（运行到这里说明上次替换后的应用已能启动）。 */
export async function cleanupStaleMacUpdateArtifacts(bundlePath: string): Promise<void> {
  const bundleDir = path.dirname(bundlePath);
  const bundleName = path.basename(bundlePath);
  const entries = await readdir(bundleDir).catch(() => []);
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.startsWith(STAGING_DIR_PREFIX) ||
          (entry.startsWith(bundleName) && entry.includes(BACKUP_DIR_SUFFIX)),
      )
      .map((entry) =>
        rm(path.join(bundleDir, entry), { recursive: true, force: true }).catch(() => undefined),
      ),
  );
}

/** 由打包运行时的 process.resourcesPath 推导当前 .app bundle 路径；非 mac 包结构返回 null。 */
export function resolveMacAppBundlePathFromResources(resourcesPath: unknown): string | null {
  // 非 Electron 运行时（单测/node 脚本）没有 resourcesPath，返回 null 让上层按 skip 处理。
  if (typeof resourcesPath !== "string" || resourcesPath.length === 0) {
    return null;
  }
  // resourcesPath = <bundle>/Contents/Resources → 上两级即 bundle。
  const bundlePath = path.dirname(path.dirname(resourcesPath));
  if (path.basename(bundlePath).endsWith(".app")) {
    return bundlePath;
  }
  return null;
}
