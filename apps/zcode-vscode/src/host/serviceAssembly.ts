/**
 * Host 服务装配（架构 §2.1 / T02）。
 *
 * 对照桌面 host 装配范式：`@zcode/services/node` 的 `createLocalServices` 是官方宿主装配入口
 * （desktop host 即此模式）。插件作为 VS Code 扩展宿主进程内的 host：
 *
 * - 数据根（DB / 凭据 / 会话库）经 `setDataRootPathOverride` 指向插件 globalStorage，
 *   与桌面端 ~/.zcode 隔离（§9 核实项 2 的落地结论：createLocalServices 全部持久化
 *   路径经 getZCodeDataRootDir() 解析，override 必须在装配前设置）。
 * - Agent 进程命令经 `zcodeAgentCommandResolver` 注入（cliLocator 保留改造：CliInfo → 命令）。
 * - `ServiceExposurePolicy.allowedChannels` 只向 webview 暴露插件用频道白名单（§8 R3），
 *   杜绝 webview 侧触达终端/进程采样等高危服务面。
 */

import { ServiceCollection, type ServiceExposurePolicy } from "@zcode/services";
import {
  createLocalServices,
  disposeServiceResourcesAndWait,
  setDataRootPathOverride,
  type ZCodeAgentCommandResolver,
} from "@zcode/services/node";

/** 插件向 webview 暴露的服务频道白名单（§8 R3：agent/sessions/file/settings/task/broadcast 等）。 */
export const DEFAULT_EXPOSED_CHANNELS: readonly string[] = [
  // 对话核心
  "zcode-agent",
  "zcode-session",
  "zcode-task",
  "subagents",
  "usage-stats",
  // 文件 / 设置 / 广播（UI 装配面必需）
  // 注意：terminal / process 属 §8 R3 高危服务面，默认绝不向 webview 暴露。
  "file",
  "media-preview",
  "setting",
  "broadcast",
  "file-watcher",
  "system",
  // 模型 / provider 面（模型切换 P1-11）
  "model-selection",
  "provider-settings",
  // 工作流 / 技能 / 命令（UI 装配面按需）
  "commands",
  "hooks",
  "memory",
  "output-style",
  "prompt-attachment-transfer",
  "prompt-assist",
  "skills",
  "plugins",
  "plugin-management",
  "task-groups",
  "onboarding-record",
  "client-config",
  "client-scenes",
  "git",
  "git-checkpoint",
];

/** 构建默认的暴露策略（测试可传入更窄白名单）。 */
export function createExposurePolicy(
  allowedChannels: readonly string[] = DEFAULT_EXPOSED_CHANNELS,
): ServiceExposurePolicy {
  return { allowedChannels: new Set(allowedChannels) };
}

export interface PluginServiceAssemblyOptions {
  /**
   * 数据根目录（DB/凭据/会话库落盘位置）。必须指向插件 globalStorage，
   * 缺省时回落 services 默认数据根（仅测试场景允许）。
   */
  dataRootDir?: string;
  /** Agent 进程命令解析器（cliLocator → CliInfo → spawn 命令）。 */
  zcodeAgentCommandResolver?: ZCodeAgentCommandResolver;
  /** Agent 进程 spawn cwd 兜底（工作区目录不可用时）。 */
  zcodeAgentSpawnFallbackCwd?: string;
  /** 内置 Provider 配置文件物理路径（createLocalServices 必填）。 */
  zcodeBuiltinProviderConfigFilePath: string;
  /** 频道白名单（缺省 DEFAULT_EXPOSED_CHANNELS）。 */
  allowedChannels?: readonly string[];
}

export interface PluginServiceAssembly {
  services: ServiceCollection;
  exposurePolicy: ServiceExposurePolicy;
  /** 串行释放全部托管资源（Agent 进程树、DB 句柄、文件监视等）。 */
  dispose(): Promise<void>;
}

/**
 * 装配插件 host 的本地服务集合。
 * 失败时抛出明确错误（§8 R3：启动失败 → 明确错误横幅 + 诊断输出，不静默）。
 */
export function createPluginServices(
  options: PluginServiceAssemblyOptions,
): PluginServiceAssembly {
  // 数据根 override 必须先于 createLocalServices（paths.ts 的解析全部读该 override）。
  if (options.dataRootDir) {
    setDataRootPathOverride(options.dataRootDir);
  }
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath: options.zcodeBuiltinProviderConfigFilePath,
    zcodeAgentCommandResolver: options.zcodeAgentCommandResolver,
    ...(options.zcodeAgentSpawnFallbackCwd
      ? { zcodeAgentSpawnFallbackCwd: options.zcodeAgentSpawnFallbackCwd }
      : {}),
  });
  const exposurePolicy = createExposurePolicy(options.allowedChannels);
  return {
    services,
    exposurePolicy,
    async dispose(): Promise<void> {
      await disposeServiceResourcesAndWait(services);
    },
  };
}

/**
 * 内置 Provider 配置文件的默认物理路径：`<globalStorage>/provider/builtin.json`。
 * 首次激活时由 extension 侧写入一份最小 Release（见 EMPTY_ZCODE_BUILTIN_RELEASE_JSON）。
 */
export function builtinProviderConfigPath(globalStorageDir: string): string {
  return `${globalStorageDir}/provider/builtin.json`;
}

/**
 * 内置 Provider 配置的最小 Release（schemaVersion/revision/config，与
 * provider-node zcode-builtin-release.ts releaseSchema 严格解码对齐，test/providerConfigSeed.test.ts 锁定）。
 * services 未传 zcodeBuiltinActiveFilePath 时该文件同时充当 Bundled 与 Active——
 * 读取方按 Release schema 严格解码后回落 Bundled，因此内容禁止是 "{}"（解码失败，
 * providerConfigRuntime.start() 抛错并阻断 Agent spawn env 构建）。
 */
export const EMPTY_ZCODE_BUILTIN_RELEASE_JSON = JSON.stringify({
  schemaVersion: 1,
  revision: 0,
  config: {
    providerConfigRules: { templateRules: [], providerRules: [] },
    modelConfigRules: {
      modelRules: [],
      modelApiRules: [],
      providerSiteRules: [],
      templateModelRules: [],
      builtinProviderModelRules: [],
    },
  },
});
