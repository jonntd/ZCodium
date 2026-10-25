import {
  buildHelperOpenArgs,
  createCuaHelperInstaller,
  defaultCuaHelperVerifierDependencies,
  type CuaHelperInstaller,
  type CuaHelperInstallerOptions,
  type HelperLaunchSpec,
} from "@zcode/zcode-cua/broker/server";

type CuaHelperInstallerFactory = (options: CuaHelperInstallerOptions) => CuaHelperInstaller;

/**
 * macOS `lipo -archs` 对 Intel 二进制返回 `x86_64`，而 Node 的运行时架构名是 `x64`。
 * 两者表示同一架构；如果直接比较字符串，合法的 Intel Helper 会被误判为不可用。
 */
export function normalizeCuaHelperArch(rawArch: string): string {
  switch (rawArch.trim().toLowerCase()) {
    case "amd64":
    case "x86_64":
    case "x64":
      return "x64";
    case "aarch64":
    case "arm64":
      return "arm64";
    default:
      return rawArch.trim();
  }
}

export function normalizeCuaHelperArchs(archs: readonly string[]): string[] {
  return [...new Set(archs.map(normalizeCuaHelperArch).filter(Boolean))];
}

export function canonicalizeCuaHelperInstallerOptions(
  options: CuaHelperInstallerOptions,
): CuaHelperInstallerOptions {
  const readExecutableArchs =
    options.dependencies?.readExecutableArchs ??
    defaultCuaHelperVerifierDependencies.readExecutableArchs;
  return {
    ...options,
    dependencies: {
      ...options.dependencies,
      readExecutableArchs: async (executablePath) =>
        normalizeCuaHelperArchs(await readExecutableArchs(executablePath)),
    },
  };
}

export function createCanonicalCuaHelperInstaller(
  options: CuaHelperInstallerOptions,
  createInstaller: CuaHelperInstallerFactory = createCuaHelperInstaller,
): CuaHelperInstaller {
  return createInstaller(canonicalizeCuaHelperInstallerOptions(options));
}

export interface CuaStatusLaunchOpenArgsSpec {
  appPath: string;
  socketPath: string;
  exitLogPath: string;
}

export interface BuildCuaStatusLaunchOpenArgsOptions extends CuaStatusLaunchOpenArgsSpec {
  /** 供测试注入 spy；生产路径恒为 vendor buildHelperOpenArgs。 */
  buildOpenArgs?: (spec: HelperLaunchSpec, launcherPid?: number) => string[];
}

/**
 * 设置页权限状态查询链（node.ts launchStandaloneCuaHelperForStatus）的 Helper 启动 argv。
 *
 * 一对 local-dev escape 标志**无条件**携带，与 vendor 的 launchHelperApp（SDK 懒启动
 * 与托管 host start 共用）同口径。为什么不能按 isCuaLocalDevelopmentRuntime 门控：
 * helper 的 broker peer 三道门对 same-uid 对端的唯一放行口是
 * `--allow-external-broker-client-local-dev` 且 SEA 内嵌 dev policy 允许（helper 侧
 * 「仅显式 … 才放行 same-uid 对端」注释）；fork 随包 helper 是 patch+adhoc 变体（内嵌
 * 门已翻真），而打包态 host bundle 的 isCuaLocalDevelopmentRuntime 编译期折叠恒 false
 * （docs/spec/cua-runtime-builtin.md §C）——按 dev 门传参会让这条链成为全链路唯一漏传点，
 * helper 正常启动监听但拒绝自家 host 的每个连接（exit log 连篇 "peer verification
 * failed"，90s 后 startup-claim-timeout 自杀），getStatus 永不可用，设置页冷启动无缓存
 * 时永久停在「正在验证… + 未知」（2026-10-25 打包态真机实锤）。
 *
 * 标志本身无授权力：stock helper 内嵌门为 false 时忽略未知 argv（vendor launchHelperApp
 * 同注释），仅 fork 补丁件消费，与 spec §B 的信任模型偏离一致。
 */
export function buildCuaStatusLaunchOpenArgs(
  options: BuildCuaStatusLaunchOpenArgsOptions,
): string[] {
  const { appPath, socketPath, exitLogPath, buildOpenArgs = buildHelperOpenArgs } = options;
  return buildOpenArgs({
    appPath,
    socketPath,
    exitLogPath,
    allowUnsignedLauncherLocalDev: true,
    allowExternalBrokerClientLocalDev: true,
  });
}
