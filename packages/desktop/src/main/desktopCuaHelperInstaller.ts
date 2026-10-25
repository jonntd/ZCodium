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
  // 期望值 pin（与 buildHostProcessEnv 对 host env 的注入同构；2026-10-25 起 dev/打包两态统一）：
  // - bundle id：dev 变体 plan 默认期望 dev.zcode.cua-helper.dev，而 staged/随包件都是官方
  //   stock id（打包态 vendor 默认本就是 stock id，pin 是同值冗余，统一带上防两条链漂移）；
  // - build id：vendor 内嵌期望值是上游某次发布的字面量，与 staged/随包件的 buildId 无关，
  //   必须从 bundled 件 Info.plist 实读钉住。2026-10-24 的修复只给 dev 算了 pin，打包态
  //   main 安装链（onboarding/拖拽浮窗）没有 buildId pin，verify 对已有安装直接 fail-closed：
  //   "build id pipeline-298526-10bbcea5 does not match pipeline-293504-ab4d5e6b"（真机实锤）。
  //   依赖 vendor env 优先 patch 的放行条件「本地开发运行时或显式 opt-in」：applyBundledCuaHelper
  //   TrustEnv 在打包态确定性置 ALLOW_UNSIGNED_LOCAL=1，opt-in 门恒开，pin 恒生效。
  const bundledBuildId = bundledAppPath
    ? readCuaHelperBuildIdFromPlist(bundledAppPath)
    : undefined;
  const trustEnvPins = bundledAppPath
    ? {
        // fork 改名（2026-10-25，§B）：随包/staged 件的 plist 与二进制常量已 patch 为
        // dev.zcodium.computer，期望值必须同步；vendor 默认值亦已 patch，此处 pin 是双保险。
        ZCODE_CUA_HELPER_BUNDLE_ID: "dev.zcodium.computer",
        ...(bundledBuildId ? { ZCODE_CUA_HELPER_BUILD_ID: bundledBuildId } : {}),
      }
    : {};
  // 信任门 env 决策抽到零依赖纯函数（docs/spec/cua-runtime-builtin.md §B 偏离第三条）：fork 的
  // 随包 helper 是 patched+adhoc 变体，打包态必须确定性置 "1" 走 local_dev_unsigned，而不是上游
  // 的 delete（delete 会让 onboarding 链在干净机器上被严格验证 fail-closed 拒收，修复于 2026-09-29）。
  const env = applyBundledCuaHelperTrustEnv({ ...options.env, ...trustEnvPins }, bundledAppPath);
  return createInstaller(
    canonicalizeCuaHelperInstallerOptions({
      env,
      logger: options.logger,
      bundledAppPath,
    }),
  );
}
