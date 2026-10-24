import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app } from "electron";
import { HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import {
  canonicalizeCuaHelperInstallerOptions,
  createCuaHelperInstaller,
  type CuaHelperInstaller,
  type CuaHelperInstallerOptions,
} from "@zcode/services/node";
import { resolvePlatformKeyForPackagedApp } from "../../scripts/target-platform.mjs";
import {
  defaultDevCuaHelperRootCandidates,
  readCuaHelperBuildIdFromPlist,
  resolveDevCuaHelperAppPath,
} from "./desktopCuaHelperBundledPath.js";
import { applyBundledCuaHelperTrustEnv } from "./desktopCuaHelperTrustEnv.js";

type InstallerFactory = (options: CuaHelperInstallerOptions) => CuaHelperInstaller;

export { normalizeCuaHelperArch, normalizeCuaHelperArchs } from "@zcode/services/node";

export interface DesktopCuaHelperInstallerOptions extends Pick<
  CuaHelperInstallerOptions,
  "env" | "logger"
> {
  bundledHelperAppPath?: string;
  platform?: NodeJS.Platform | string;
  isPackaged?: boolean;
  resourcesPath?: string;
}

export function resolvePackagedCuaHelperAppPath(
  options: Pick<DesktopCuaHelperInstallerOptions, "platform" | "isPackaged" | "resourcesPath"> = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const isPackaged = options.isPackaged ?? app.isPackaged;
  const resourcesPath =
    options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const normalizedResourcesPath = resourcesPath?.trim();
  return platform === "darwin" && isPackaged && normalizedResourcesPath
    ? join(normalizedResourcesPath, "cua-helper", HELPER_APP_NAME)
    : undefined;
}

export function createDesktopCuaHelperInstaller(
  options: DesktopCuaHelperInstallerOptions,
  createInstaller: InstallerFactory = createCuaHelperInstaller,
): CuaHelperInstaller {
  const isPackaged = options.isPackaged ?? app.isPackaged;
  // 修复（2026-10-24 回归，docs/spec/cua-runtime-builtin.md §C）：dev 态此前落到这里时
  // bundledAppPath 恒 undefined（resolvePackagedCuaHelperAppPath 只认打包态 resourcesPath），
  // installer plan 退化为 download 源；installed 件 plist 版本（3.14.x）与 dev plan 版本
  // （0.0.0）判不匹配即触发重装 → 回退官方 dev CDN 下载 → fork 不可达 → onboarding
  // （设置页授权引导 / 拖拽浮窗）整体失败。这里补上与 host env 注入同源的 staged 解析，
  // 让 main 侧安装链（openCuaPermissionOnboarding / prepareCuaHelperPermissionDrag）与
  // host 侧 getStatus 链使用同一份 bundled 源与 buildId 配对。
  const devBundledAppPath =
    (options.platform ?? process.platform) === "darwin" && !isPackaged
      ? resolveDevCuaHelperAppPath({
          envOverride: options.env.ZCODE_CUA_BUNDLED_HELPER_APP_PATH?.trim() || undefined,
          zcodeHome: options.env.ZCODE_HOME?.trim() || join(homedir(), ".zcodium"),
          platformKey: resolvePlatformKeyForPackagedApp(),
          rootCandidates: defaultDevCuaHelperRootCandidates(process.cwd(), import.meta.dirname),
          existsSyncImpl: existsSync,
        })
      : undefined;
  const bundledAppPath =
    options.bundledHelperAppPath ?? resolvePackagedCuaHelperAppPath(options) ?? devBundledAppPath;
  // dev 期望值 pin（与 buildHostProcessEnv 对 host env 的注入同构）：staged 件是官方 stock
  // bundle id（dev.zcode.cua-helper），而 dev 变体 plan 默认期望 dev.zcode.cua-helper.dev；
  // vendor 内嵌期望 buildId 也是上游字面量。main 自己的安装链没有这两条 env 就会在
  // "bundle id/build id does not match" 上 fail-closed（2026-10-24 实测第二段）。
  const devBundledBuildId = devBundledAppPath
    ? readCuaHelperBuildIdFromPlist(devBundledAppPath)
    : undefined;
  const devEnvPins = devBundledAppPath
    ? {
        ZCODE_CUA_HELPER_BUNDLE_ID: "dev.zcode.cua-helper",
        ...(devBundledBuildId ? { ZCODE_CUA_HELPER_BUILD_ID: devBundledBuildId } : {}),
      }
    : {};
  // 信任门 env 决策抽到零依赖纯函数（docs/spec/cua-runtime-builtin.md §B 偏离第三条）：fork 的
  // 随包 helper 是 patched+adhoc 变体，打包态必须确定性置 "1" 走 local_dev_unsigned，而不是上游
  // 的 delete（delete 会让 onboarding 链在干净机器上被严格验证 fail-closed 拒收，修复于 2026-09-29）。
  const env = applyBundledCuaHelperTrustEnv({ ...options.env, ...devEnvPins }, bundledAppPath);
  return createInstaller(
    canonicalizeCuaHelperInstallerOptions({
      env,
      logger: options.logger,
      bundledAppPath,
    }),
  );
}
