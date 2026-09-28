// macOS 无证书打包的 adhoc 兜底签名。
// 依据 docs/spec/macos-adhoc-codesign.md：
// ZCodium fork 没有 Apple 开发者证书，electron-builder 的 mac.identity 为 null 时
// 会完全跳过签名，产物 .app 只有内部二进制自带的 linker adhoc 签名，bundle 级
// _CodeSignature/CodeResources 缺失。Squirrel.Mac 在自动更新下载完成后会立刻对
// 解包出的新 .app 做 SecStaticCodeCheckValidity 校验，未签名 bundle 直接报
// SQRLCodeSignatureErrorDomain -1（"code has no resources but signature indicates
// they must be present"），更新永远装不上（2026-09-28 线上日志确诊）。
// 这里对产物做 codesign --force --deep --sign - 的 adhoc 签名，使 zip/dmg 里的
// .app 具有自洽的 bundle 签名；Electron 内嵌 Squirrel fork 对 adhoc 应用按
// bundle identifier 匹配校验，adhoc→adhoc 更新可通过。
// 钩子必须挂在 afterPack 末尾：identity:null 时 electron-builder 不会触发
// afterSign 钩子（app-builder-lib 明确打日志 skipping afterSign hook），而
// afterPack 前段的 asar 重写会破坏先做的签名。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../../../scripts/spawn-command.mjs";

const CODESIGN_BINARY = "/usr/bin/codesign";

/**
 * 纯决策函数：给定打包上下文判断是否执行 adhoc 兜底签名。
 * 返回 { action: "sign" } 或 { action: "skip", reason }，便于单测覆盖。
 */
export function resolveMacAdhocCodesignPlan({
  electronPlatformName,
  hostPlatform = process.platform,
  enableMacSigning = false,
} = {}) {
  if (electronPlatformName !== "darwin") {
    return {
      action: "skip",
      reason: `target platform is ${electronPlatformName}, not darwin`,
    };
  }
  if (hostPlatform !== "darwin") {
    return {
      action: "skip",
      reason: `codesign is only available on macOS, host is ${hostPlatform}`,
    };
  }
  if (enableMacSigning) {
    // 真实证书签名已启用：让位给 electron-builder 的 Developer ID 签名链路，
    // 避免 adhoc 结果与后续签名互相覆盖。
    return { action: "skip", reason: "real certificate signing is enabled" };
  }
  return { action: "sign" };
}

/**
 * 生成 codesign 命令参数。单独导出以便单测断言，不在此处执行。
 */
export function buildMacAdhocCodesignArgs(appPath, { verify = false } = {}) {
  return verify
    ? ["--verify", "--strict", appPath]
    : ["--force", "--deep", "--sign", "-", appPath];
}

function resolvePackagedMacAppPath(context) {
  const appOutDir = context?.appOutDir;
  if (!appOutDir) {
    throw new Error("[adhoc-codesign] afterPack context is missing appOutDir");
  }
  const productFilename = context.packager?.appInfo?.productFilename;
  if (!productFilename) {
    throw new Error(
      "[adhoc-codesign] afterPack context is missing packager.appInfo.productFilename",
    );
  }
  const appPath = join(appOutDir, `${productFilename}.app`);
  if (!existsSync(appPath)) {
    throw new Error(`[adhoc-codesign] packaged app not found: ${appPath}`);
  }
  return appPath;
}

/**
 * afterPack 末尾调用：对打好的 .app 做 adhoc 签名并自校验。
 * 签名或校验失败都会抛错中断打包（fail-fast），防止发出 Squirrel 校验不过的产物。
 */
export async function adhocCodesignMacApp(
  context,
  { enableMacSigning = false } = {},
) {
  const plan = resolveMacAdhocCodesignPlan({
    electronPlatformName: context?.electronPlatformName,
    enableMacSigning,
  });
  if (plan.action === "skip") {
    console.log(`[afterPack] mac adhoc codesign skipped: ${plan.reason}`);
    return { action: "skip", reason: plan.reason };
  }

  const appPath = resolvePackagedMacAppPath(context);
  console.log(`[afterPack] mac adhoc codesign start: ${appPath}`);
  runCommand(CODESIGN_BINARY, buildMacAdhocCodesignArgs(appPath));
  // 自校验等价于 Squirrel.Mac 的结构校验入口（SecStaticCodeCheckValidity 对 bundle
  // 的最外层密封资源检查），必须通过，否则本轮产物在自动更新链路仍然装不上。
  runCommand(
    CODESIGN_BINARY,
    buildMacAdhocCodesignArgs(appPath, { verify: true }),
  );
  console.log(`[afterPack] mac adhoc codesign end: ${appPath}`);
  return { action: "sign", appPath };
}
