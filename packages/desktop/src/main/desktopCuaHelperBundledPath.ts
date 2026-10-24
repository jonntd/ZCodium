// dev 态 CUA Helper bundled 源解析（纯函数，无 electron 依赖）。
//
// 为什么独立成模块：desktopRuntimeEnv（host env 注入）与 desktopCuaHelperInstaller
// （main 侧 onboarding/拖拽安装链）必须共用同一候选顺序。2026-10-24 回归：此前只有
// host env 注入走该解析，main 自己的 installer 在 dev 态 bundledHelperAppPath 恒
// undefined → plan 落 download 源；installed 件 CFBundleVersion（3.14.x）与 dev plan
// 版本（0.0.0）判不匹配即触发重装 → 回退官方 dev CDN（studio.zcode-ai.com:12345），
// fork 不可达 → onboarding 返回 "unavailable (install/verification failed)"，系统
// 设置页与拖拽浮窗均不出现。两条链在此收敛为单一事实源，防止再次漂移。
import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { DEV_HELPER_APP_NAME, HELPER_APP_NAME } from "@zcode/zcode-cua/broker/helperConstants";

export interface ResolveDevCuaHelperAppPathOptions {
  envOverride?: string;
  zcodeHome: string;
  platformKey: string;
  /** staged 补丁件候选根（bundled-cua-helper 目录的父级），调用方按 cwd/产物位置绑定。 */
  rootCandidates: string[];
  existsSyncImpl: (path: string) => boolean;
}

export function defaultDevCuaHelperRootCandidates(cwd: string, dirname: string): string[] {
  // dev 启动 cwd 可能是仓库根或 packages/desktop；最后兜 main 产物自身的相对位置。
  return [
    join(cwd, "bundled-cua-helper"),
    join(cwd, "packages", "desktop", "bundled-cua-helper"),
    join(dirname, "../../bundled-cua-helper"),
  ];
}

// 顺序约束（986c692）：staged 补丁件必须排在 zcode home 既有安装之前。staged 指向
// home 旧副本会自我覆盖，且可能带着 stock 信任门字面量死在 launcher/token 门。
export function resolveDevCuaHelperAppPath({
  envOverride,
  zcodeHome,
  platformKey,
  rootCandidates,
  existsSyncImpl,
}: ResolveDevCuaHelperAppPathOptions): string | undefined {
  const candidates = [
    envOverride,
    ...rootCandidates.map((root) => join(root, platformKey, HELPER_APP_NAME)),
    join(zcodeHome, "computer-use", "dev", DEV_HELPER_APP_NAME),
    join(zcodeHome, "computer-use", HELPER_APP_NAME),
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => existsSyncImpl(candidate));
}

// 读 helper 自身 Info.plist 的 ZCodeCUAHelperBuildId（vendor verify 用同一来源做
// buildId 匹配）。二进制 plist 必须走 plutil。desktopRuntimeEnv（host env 注入）与
// desktopCuaHelperInstaller（main 侧安装链）都必须用同一实读值钉住期望 buildId：
// vendor 内嵌期望值是上游某次发布的字面量，与本机 staged 件不一定一致。
export function readCuaHelperBuildIdFromPlist(helperAppPath: string): string | undefined {
  try {
    const result = spawnSync(
      "/usr/bin/plutil",
      [
        "-extract",
        "ZCodeCUAHelperBuildId",
        "raw",
        "-o",
        "-",
        "--",
        join(helperAppPath, "Contents", "Info.plist"),
      ],
      { encoding: "utf-8" },
    );
    const buildId = String(result.stdout ?? "").trim();
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(buildId) ? buildId : undefined;
  } catch {
    return undefined;
  }
}
