/**
 * Host 服务装配（架构 §2.1 / T02）。
 *
 * 对照桌面 host 装配范式：`@zcode/services/node` 的 `createLocalServices` 是官方宿主装配入口
 * （desktop host 即此模式）。插件作为 VS Code 扩展宿主进程内的 host：
 *
 * - 数据根（DB / 凭据 / 会话库）最终口径为共享：生产装配不设 override，
 *   createLocalServices 全部持久化路径经 getZCodeDataRootDir() 回落 services
 *   默认根 `$HOME/.zcodium`，与桌面端、完整界面 server 同根共享
 *   （docs/architecture.md §7.9；M2 起退役了早期「隔离到插件 globalStorage」口径）。
 *   传 `dataRootDir` 时经 `setDataRootPathOverride` 重定向（必须在装配前设置），
 *   仅供 dev/测试隔离。
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
  // 首启迁移向导 / 设置同步（Root 迁移向导全步骤走 settings-sync；漏放行即 1000ms 超时，
  // 与桌面 windowHostAttachmentRpcPolicy 的历史教训同型）
  "settings-sync",
  "skill-sync",
  "mcp-sync",
  "plugin-sync",
  // 登录 / 凭据 / 分享 / 订阅 / 反馈（Root UI 装配面）
  "oauth",
  "credential",
  "conversation-share",
  "coding-plan-subscription",
  "feedback",
  "bots",
  "off-peak-task",
  "project",
  "remote-projects",
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
   * 数据根目录（DB/凭据/会话库落盘位置）。
   *
   * 最终口径（docs/architecture.md §7.9）：生产装配**不传**——回落 services 默认
   * 数据根 `$HOME/.zcodium`，与桌面端、完整界面 server 共享（container.ts 服务装配
   * 注释为现场记录）。传入时经 `setDataRootPathOverride` 重定向（必须先于装配），
   * 仅供 dev/测试隔离场景。
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
