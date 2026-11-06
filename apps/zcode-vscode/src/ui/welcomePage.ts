/**
 * welcomePage — onboarding 引导面（T13，P1-10.2 / P1-10.3；架构 §5.1
 * 「welcomePage 保留扩展为 onboarding」，§3.1 CLI 未找到 → 显示 welcomePage/onboarding）。
 *
 * 本文件是纯层（不 import vscode，与 runtimeController.ts 同风格）：
 * - 内容模型：3 步上手卡（ONBOARDING_STEPS）、Claude 导入入口（组4 面板
 *   `import-claude-sessions` 的命令面引用，不改其文件）、capabilities 降级说明
 *   （P1-10.3，复用 webview 侧 CAPABILITY_UNSUPPORTED_HINT 单一文案源）；
 * - 引导态投影：projectOnboardingState（CLI 探测结果 → 引导卡条目）；
 * - 呈现器：WelcomePage（端口注入——诊断日志、信息条、卡面、面板显出、重新检测），
 *   vscode 落地由 container.ts 装配（对接其既有 [cli] 诊断日志语义）。
 *
 * vitest 直测：test/welcomePage.test.ts。
 */

import { CAPABILITY_UNSUPPORTED_HINT } from "../webview-react/capabilities";

// ── CLI 引导文案（container.ts [cli] 诊断行的同源文案；P0-1 引导语义） ──

/** container.ts CLI 未找到时写入诊断的同源日志行（文案变更须同步该处语义）。 */
export const CLI_NOT_FOUND_LOG =
  "[cli] 未找到 zcodium CLI：侧栏将呈现引导（安装后点击「重新检测」或执行 ZCodium: 重启 Agent）";

/** CLI 未找到时的安装引导（信息条正文；「重新检测」为操作项）。 */
export const CLI_NOT_FOUND_GUIDANCE =
  "未找到 zcodium CLI：模型调用由 CLI 承担（zcodium app-server --stdio）。" +
  "请安装 CLI，或在设置 code.cliPath 指定绝对路径；" +
  "安装后点击「重新检测」，或执行命令 ZCodium: 重启 Agent 进程。";

// ── 3 步上手卡（P1-10.2） ──

export interface OnboardingStep {
  id: "install" | "chat" | "configure";
  title: string;
  detail: string;
}

export const ONBOARDING_STEPS: readonly OnboardingStep[] = [
  {
    id: "install",
    title: "第 1 步 · 安装 zcodium CLI",
    detail:
      "模型调用由 CLI 承担（zcodium app-server --stdio，扩展经 @zcode/services 进程管理拉起）。" +
      "PATH 中有 zcodium 即可，或在设置 code.cliPath 指定绝对路径。",
  },
  {
    id: "chat",
    title: "第 2 步 · 打开侧栏开始对话",
    detail:
      "Activity Bar「Gode Agent」侧栏输入框直接提问；@ 引用文件与选区；" +
      "模型 / 协作模式 / 思考深度在会话头部切换；顶部按钮切换或删除会话" +
      "（多根工作区每个 folder 独立会话，ZCodium: 切换工作区聚焦 folder）。",
  },
  {
    id: "configure",
    title: "第 3 步 · 按需配置与导入",
    detail:
      "权限 allowlist / denylist、MCP 服务器、附加目录在设置面板维护" +
      "（改动后需重建会话生效）；Claude Code 历史可一键导入" +
      "（ZCodium: 导入 Claude 会话，检测 ~/.claude/projects，原文件不删除）。",
  },
];

// ── Claude 导入入口（P1-10.2/P1-12：引用组4 导入面板，不改其文件） ──

export const CLAUDE_IMPORT_ENTRY = {
  /** 组4 导入面板的 open-panel 词（src/webview-react/import/ImportClaudeSessions.tsx）。 */
  panel: "import-claude-sessions",
  /** 面板打开的命令面（container.registerCommands 登记，contributes.commands）。 */
  commandId: "code.importClaudeSessions",
  label: "导入 Claude Code 会话",
  note: "检测 ~/.claude/projects 下可导入历史；解析与导入由 services zcode-task 频道承担，原文件不删除。仅桌面环境可用。",
} as const;

// ── capabilities 降级说明（P1-10.3：成文进引导面） ──

/** 能力降级说明（引导卡固定呈现；文案源与 webview 侧标注对齐）。 */
export const CAPABILITY_DEGRADATION_NOTES: readonly string[] = [
  `hello.capabilities 缺失（旧 CLI / 握手未达）时，依赖能力位的入口隐藏并标注「${CAPABILITY_UNSUPPORTED_HINT}」，不做部分猜测。`,
  "二进制帧能力缺失时传输退化为 base64 文本帧，并在链路上给出降级提示。",
  "MCP 服务器 / 权限规则 / 附加目录随会话 create/resume 一次性下发：运行中不热更新，改动后需重建会话生效。",
  "Claude 会话导入仅在桌面环境可用（需读取本机 ~/.claude/projects）。",
  "老 CLI（无 v4）握手失败：呈现「请升级 CLI」引导，不做 legacy 全功能兜底。",
];

// ── 文档引用（docs/contract-check.md 等成文档；只引用不改） ──

export interface OnboardingDoc {
  path: string;
  summary: string;
}

export const ONBOARDING_DOCS: readonly OnboardingDoc[] = [
  {
    path: "docs/contract-check.md",
    summary: "桥 wire schema、@zcode/shared 版本锁定关系与 v4 协议命令面消费清单。",
  },
  {
    path: "src/CONTRACT.md",
    summary: "模块契约与治理约束（依赖方向、公开入口、禁止事项）。",
  },
  {
    path: "test/e2e.checklist.md",
    summary: "端到端真机回归清单（发布验收 DoD）。",
  },
];

// ── 引导卡条目与引导态投影 ──

/** 引导卡条目（宿主 QuickPick 面呈现；action 由呈现器分发）。 */
export interface WelcomeCardItem {
  label: string;
  detail?: string;
  action: string;
}

/** 卡面动作词（呈现器分发表；step-* 为说明项，选中即关闭）。 */
export const WELCOME_CARD_ACTIONS = {
  recheckCli: "recheck-cli",
  openClaudeImport: "open-claude-import",
} as const;

export interface OnboardingInput {
  /** CLI 探测结果（null = 未找到，P0-1 引导语义）。 */
  cli: { path: string; version?: string } | null;
  /** 桌面能力位（H7，Claude 导入门；缺省按桌面处理，容器注入 vscode env 实况）。 */
  isDesktop?: boolean;
}

export interface OnboardingState {
  steps: readonly OnboardingStep[];
  cliMissing: boolean;
  /** CLI 未找到时的安装引导（null = CLI 就绪不展示）。 */
  cliGuidance: string | null;
  degradationNotes: readonly string[];
  claudeImport: {
    supported: boolean;
    label: string;
    commandId: string;
    panel: string;
    note: string;
  };
  docs: readonly OnboardingDoc[];
  /** 引导卡条目：3 步卡 + CLI 缺失时的「重新检测」项 + Claude 导入入口项。 */
  card: readonly WelcomeCardItem[];
}

/**
 * CLI 探测结果 + 桌面位 → onboarding 引导态（P1-10.2）。
 * 纯投影：不读设置、不做探测（由容器注入实况）。
 */
export function projectOnboardingState(params: OnboardingInput): OnboardingState {
  const cliMissing = params.cli === null;
  const isDesktop = params.isDesktop ?? true;
  const card: WelcomeCardItem[] = ONBOARDING_STEPS.map((step) => ({
    label: step.title,
    detail: step.detail,
    action: `step-${step.id}`,
  }));
  if (cliMissing) {
    card.push({
      label: "重新检测 CLI",
      detail: "重跑 CLI 探测（settings code.cliPath 优先，随后 PATH）；找到后重置 Agent 运行时。",
      action: WELCOME_CARD_ACTIONS.recheckCli,
    });
  }
  card.push({
    label: CLAUDE_IMPORT_ENTRY.label,
    detail: isDesktop
      ? CLAUDE_IMPORT_ENTRY.note
      : `${CLAUDE_IMPORT_ENTRY.note}（当前环境不可用：仅桌面可读本机 ~/.claude/projects）`,
    action: WELCOME_CARD_ACTIONS.openClaudeImport,
  });
  return {
    steps: ONBOARDING_STEPS,
    cliMissing,
    cliGuidance: cliMissing ? CLI_NOT_FOUND_GUIDANCE : null,
    degradationNotes: CAPABILITY_DEGRADATION_NOTES,
    claudeImport: {
      supported: isDesktop,
      label: CLAUDE_IMPORT_ENTRY.label,
      commandId: CLAUDE_IMPORT_ENTRY.commandId,
      panel: CLAUDE_IMPORT_ENTRY.panel,
      note: CLAUDE_IMPORT_ENTRY.note,
    },
    docs: ONBOARDING_DOCS,
    card,
  };
}

// ── 呈现器（端口注入；vscode 落地在 container.ts） ──

/** 宿主端口（container.ts 用 vscode API 落地；纯层只依赖本接口）。 */
export interface WelcomePagePorts {
  /** 诊断出口（对接 container 既有 [cli] 日志语义）。 */
  log(message: string): void;
  /** 信息条（CLI 未找到引导）；返回选中的动作按钮文案（undefined = 关闭）。 */
  showInformation(message: string, actions: readonly string[]): Promise<string | undefined>;
  /** 引导卡面（3 步上手卡）；返回选中条目的 action（undefined = 关闭）。 */
  showCard(items: readonly WelcomeCardItem[]): Promise<string | undefined>;
  /** 侧栏对话面显出。 */
  revealChat(): void;
  /** 组4 Claude 导入面板打开（open-panel 帧 + 面板显出；不改组4 文件）。 */
  revealClaudeImportPanel(): void;
  /** 诊断输出显出（查看日志动作）。 */
  showLogs(): void;
  /** 重新检测 CLI（重跑探测；找到后由容器重置 Agent 运行时）。 */
  recheckCli(): Promise<boolean>;
}

/** CLI 未找到信息条的动作按钮（顺序与 presentCliMissing 分发一致）。 */
export const CLI_MISSING_ACTIONS = ["重新检测", "3 步上手", "查看日志"] as const;

export class WelcomePage {
  constructor(private readonly ports: WelcomePagePorts) {}

  /**
   * CLI 未找到引导（P0-1 / P1-10.2）：信息条呈现安装指引 + 「重新检测」入口。
   * 检测事实本身由容器写入诊断（CLI_NOT_FOUND_LOG 同源行），本方法不重复记录。
   */
  async presentCliMissing(): Promise<void> {
    const choice = await this.ports.showInformation(CLI_NOT_FOUND_GUIDANCE, CLI_MISSING_ACTIONS);
    if (choice === CLI_MISSING_ACTIONS[0]) await this.recheck();
    else if (choice === CLI_MISSING_ACTIONS[1]) await this.presentOnboarding({ cli: null });
    else if (choice === CLI_MISSING_ACTIONS[2]) this.ports.showLogs();
  }

  /**
   * onboarding 3 步上手卡（P1-10.2）：先显出侧栏，再呈现卡面
   * （3 步说明项 + CLI 缺失时的「重新检测」项 + Claude 导入入口项）。
   */
  async presentOnboarding(input: OnboardingInput): Promise<void> {
    const state = projectOnboardingState(input);
    this.ports.revealChat();
    const picked = await this.ports.showCard(state.card);
    if (picked === WELCOME_CARD_ACTIONS.recheckCli) await this.recheck();
    else if (picked === WELCOME_CARD_ACTIONS.openClaudeImport)
      this.ports.revealClaudeImportPanel();
  }

  /** 「重新检测」：重跑 CLI 探测；结果写入诊断（对接 [cli] 日志语义），返回是否找到。 */
  async recheck(): Promise<boolean> {
    const found = await this.ports.recheckCli();
    if (found) {
      this.ports.log("[cli] 重新检测：已找到 zcodium CLI，Agent 运行时已重置（下次对话重拉）");
    } else {
      this.ports.log("[cli] 重新检测：仍未找到 zcodium CLI（检查 PATH 或设置 code.cliPath）");
    }
    return found;
  }
}
