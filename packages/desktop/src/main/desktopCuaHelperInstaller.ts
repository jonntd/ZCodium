import { join } from "node:path";
import { app } from "electron";
import { HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";
import {
  canonicalizeCuaHelperInstallerOptions,
  createCuaHelperInstaller,
  type CuaHelperInstaller,
  type CuaHelperInstallerOptions,
} from "@zcode/services/node";
import { applyBundledCuaHelperTrustEnv } from "./desktopCuaHelperTrustEnv.js";

type InstallerFactory = (options: CuaHelperInstallerOptions) => CuaHelperInstaller;

export { normalizeCuaHelperArch, normalizeCuaHelperArchs } from "@zcode/services/node";

interface DesktopCuaHelperInstallerOptions extends Pick<
  CuaHelperInstallerOptions,
  "env" | "logger"
> {
  bundledHelperAppPath?: string;
  platform?: NodeJS.Platform | string;
  isPackaged?: boolean;
  resourcesPath?: string;
}

function resolvePackagedCuaHelperAppPath(
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
  const bundledAppPath = options.bundledHelperAppPath ?? resolvePackagedCuaHelperAppPath(options);
  // 信任门 env 决策抽到零依赖纯函数（docs/spec/cua-runtime-builtin.md §B 偏离第三条）：fork 的
  // 随包 helper 是 patched+adhoc 变体，打包态必须确定性置 "1" 走 local_dev_unsigned，而不是上游
  // 的 delete（delete 会让 onboarding 链在干净机器上被严格验证 fail-closed 拒收，修复于 2026-09-29）。
  const env = applyBundledCuaHelperTrustEnv({ ...options.env }, bundledAppPath);
  return createInstaller(
    canonicalizeCuaHelperInstallerOptions({
      env,
      logger: options.logger,
      bundledAppPath,
    }),
  );
}
