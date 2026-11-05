/**
 * HostSettingsBridge — zcodium.* settings → 会话 create/resume 参数（架构 §2.1 / P1-3）。
 *
 * 纯模块（无 vscode import）：设置快照由注入的读取函数提供，便于 vitest 直测。
 *
 * 关键语义（P1-3.2）：**resume 必须携带 toolAllowlist/toolDenylist**（协议注释：
 * resume 不带会绕过约束）——resolveResumeParams 恒带回两列表，缺失即 Bug。
 */

/** 归一化后的权限规则（`Tool` 与 `Tool(args)` 形式与 CLI --disallowed-tools 一致）。 */
export interface ToolRuleSet {
  toolAllowlist: string[];
  toolDenylist: string[];
}

export interface HostSettingsSnapshot extends ToolRuleSet {
  /** MCP 服务器配置（字段对齐 zcodeProtocolMcpServerSchema，原样透传）。 */
  mcpServers: unknown[];
  /** 附加可访问目录（协议上限 256）。 */
  additionalDirectories: string[];
  /** 会话模式（build/plan/edit/guarded/yolo/auto）。 */
  mode: string;
  /** 模型选择 "providerId/modelId"，空串 = CLI 默认。 */
  rawModel: string;
}

export const ADDITIONAL_DIRECTORIES_LIMIT = 256;

/** 归一化工具规则列表：去空白、去空项；`Tool(args)` 形式原样保留。 */
export function normalizeToolRules(rules: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const rule of rules) {
    if (typeof rule !== "string") continue;
    const trimmed = rule.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/** 归一化附加目录：去空白、去空项、去重，超 256 截断（协议上限）。 */
export function normalizeAdditionalDirectories(dirs: readonly unknown[]): string[] {
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (typeof dir !== "string") continue;
    const trimmed = dir.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen].slice(0, ADDITIONAL_DIRECTORIES_LIMIT);
}

/** settings 快照 → 归一化快照（非法项剔除，防御 settings 手改）。 */
export function normalizeSettingsSnapshot(raw: Partial<HostSettingsSnapshot>): HostSettingsSnapshot {
  const mode =
    typeof raw.mode === "string" &&
    ["build", "plan", "edit", "guarded", "yolo", "auto"].includes(raw.mode)
      ? raw.mode
      : "build";
  return {
    toolAllowlist: normalizeToolRules(raw.toolAllowlist ?? []),
    toolDenylist: normalizeToolRules(raw.toolDenylist ?? []),
    mcpServers: Array.isArray(raw.mcpServers) ? raw.mcpServers : [],
    additionalDirectories: normalizeAdditionalDirectories(raw.additionalDirectories ?? []),
    mode,
    rawModel: typeof raw.rawModel === "string" ? raw.rawModel.trim() : "",
  };
}

/** 解析 "providerId/modelId" 为协议 modelSelection；无法解析返回 undefined。 */
export function parseModelSelection(
  raw: string,
): { providerId: string; modelId: string } | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { providerId: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

export interface SessionCreateParams {
  workspace: { path: string };
  /** 协议目标面（ZCodeAgentWorkspaceTarget）：createSession 直接消费。 */
  workspacePath: string;
  toolAllowlist: string[];
  toolDenylist: string[];
  mcpServers: unknown[];
  additionalDirectories: string[];
  config: {
    mode: string;
    /** settings 的 "providerId/modelId" 解析结果；无法解析时缺省（CLI 默认模型）。 */
    modelSelection?: { providerId: string; modelId: string };
  };
}

export interface SessionResumeParams extends ToolRuleSet {
  sessionId: string;
  /** 协议目标面（ZCodeAgentSessionTarget）：resumeSession 直接消费。 */
  workspacePath: string;
  mcpServers: unknown[];
  additionalDirectories: string[];
}

/** 设置变更订阅面（vscode onDidChangeConfiguration 返回 Disposable；测试用函数/同步触发）。 */
export type SettingsChangeSubscriber = (handler: () => void) => unknown;

export class HostSettingsBridge {
  constructor(
    private readonly readSettings: () => HostSettingsSnapshot,
    private readonly onDidChange?: SettingsChangeSubscriber,
  ) {}

  /** 订阅设置变更（extension 侧转发给 webview / 会话重建提示）。 */
  subscribe(handler: () => void): () => void {
    const result = this.onDidChange?.(handler);
    if (typeof result === "function") return result as () => void;
    return () => {
      (result as { dispose?(): void } | undefined)?.dispose?.();
    };
  }

  /** 会话创建参数（P1-16.1 参数面；MCP 必须随 create 一次性进入）。 */
  resolveCreateParams(folder: string): SessionCreateParams {
    const snapshot = normalizeSettingsSnapshot(this.readSettings());
    const modelSelection = parseModelSelection(snapshot.rawModel);
    return {
      workspace: { path: folder },
      workspacePath: folder,
      toolAllowlist: snapshot.toolAllowlist,
      toolDenylist: snapshot.toolDenylist,
      mcpServers: snapshot.mcpServers,
      additionalDirectories: snapshot.additionalDirectories,
      config: {
        mode: snapshot.mode,
        ...(modelSelection ? { modelSelection } : {}),
      },
    };
  }

  /**
   * 会话恢复参数：**必须**带回 allowlist/denylist（P1-3.2）+ mcpServers +
   * additionalDirectories（P1-6.3 冷恢复沿用工具面约束）。
   */
  resolveResumeParams(sessionId: string, folder: string): SessionResumeParams {
    const snapshot = normalizeSettingsSnapshot(this.readSettings());
    return {
      sessionId,
      workspacePath: folder,
      toolAllowlist: snapshot.toolAllowlist,
      toolDenylist: snapshot.toolDenylist,
      mcpServers: snapshot.mcpServers,
      additionalDirectories: snapshot.additionalDirectories,
    };
  }

  /**
   * 每次 spawn 的工具面旗标快照（P1-3：settings 变更 = 下次 spawn 生效）。
   * ZCodeAgentCommandResolver 每次 spawn 都会调用（services 进程管理保证），
   * host 侧把快照经 buildToolRuleFlags 编译为 --allowed-tools / --disallowed-tools argv。
   */
  resolveSpawnToolFlags(): { toolAllowlist: string[]; toolDenylist: string[] } {
    const snapshot = normalizeSettingsSnapshot(this.readSettings());
    return { toolAllowlist: snapshot.toolAllowlist, toolDenylist: snapshot.toolDenylist };
  }
}

/**
 * 工具面旗标 → spawn argv 后缀（纯函数，hostBridge/settingsBridge 测试锁定形状）。
 * 规则形式 `Tool` / `Tool(args)` 与 CLI --disallowed-tools 一致（本文件头部语义）；
 * 空列表不注入旗标（CLI 缺省=全量工具面）。
 */
export function buildToolRuleFlags(rules: {
  toolAllowlist: readonly string[];
  toolDenylist: readonly string[];
}): string[] {
  const args: string[] = [];
  if (rules.toolAllowlist.length > 0) {
    args.push("--allowed-tools", rules.toolAllowlist.join(","));
  }
  if (rules.toolDenylist.length > 0) {
    args.push("--disallowed-tools", rules.toolDenylist.join(","));
  }
  return args;
}

/**
 * Agent spawn 的协议服务模式基底 argv：zcodium CLI 的 `app-server` 是显式 positional，
 * `--stdio` 进入 app-server 协议服务模式（apps/zcode-cli arguments.ts 同款判定）。
 * services 进程管理对 resolver 产物 `args` 原样使用、不做任何合并；桌面默认 resolver
 * （resolveDefaultZCodeAgentCommand）同样以 ["app-server", "--stdio"] 为基底——
 * 自定义 resolver 只返回工具旗标（或空 argv）会裸拉 CLI，永远进不了协议服务模式。
 */
export const ZCODE_AGENT_SERVER_BASE_ARGS: readonly string[] = ["app-server", "--stdio"];

/**
 * 自定义 resolver 产物：CLI 路径 + app-server 基底 argv + 工具面旗标（顺序固定）。
 * nodeScript=true（内置 bundle，JS 入口）时经宿主自带 Node 运行：`process.execPath` +
 * `ELECTRON_RUN_AS_NODE=1`——桌面端 bundled resolver 同款形态
 * （services/zcodeAgentProcessManager.resolveBundledWorkspaceZCodeAgentCommand）。
 * 纯函数（settingsBridge 测试锁定 argv 形状）。
 */
export function resolveZcodeAgentSpawnCommand(
  cliPath: string,
  rules: { toolAllowlist: readonly string[]; toolDenylist: readonly string[] },
  options?: { nodeScript?: boolean },
): { command: string; args: string[]; env?: Record<string, string> } {
  if (options?.nodeScript === true) {
    return {
      command: process.execPath,
      args: [cliPath, ...ZCODE_AGENT_SERVER_BASE_ARGS, ...buildToolRuleFlags(rules)],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    };
  }
  return {
    command: cliPath,
    args: [...ZCODE_AGENT_SERVER_BASE_ARGS, ...buildToolRuleFlags(rules)],
  };
}

/**
 * allowlist 写回归一化（「本次会话允许」settings 写回，P0-8）：
 * 既有规则 + 新规则合并 → normalizeToolRules 去空白/去空 → 去重。
 */
export function mergeAllowlistRules(
  existing: readonly unknown[],
  appended: readonly string[],
): string[] {
  const merged = normalizeToolRules([...existing, ...appended]);
  return [...new Set(merged)];
}
