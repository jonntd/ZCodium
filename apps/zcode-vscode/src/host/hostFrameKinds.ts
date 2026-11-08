/**
 * Host 帧协议集中定义（src/host 独占，T02/⑤）。
 *
 * - 帧型全集（HostFrameKind）的 wire 判定在 src/bridge/wire.ts（内核层，host 帧解析面）；
 * - 本模块是 host 侧的**载荷形状唯一定义处**：chatPanel 可见性帧生产（T02/⑦）、
 *   RuntimeController 进程换代横幅（P1-6）、T09 诊断下发、组1 命令的 open-panel 指令
 *   均按这里的形状生产，组3/4 按形状消费。
 */

export type HostFrameKindValue =
  | "theme"
  | "locale"
  | "workspace"
  | "visibility"
  | "diagnostics"
  | "restart"
  | "open-panel"
  | "composer-insert"
  | "session-switch"
  | "full-ui-url"
  | "capabilities"
  | "session-tabs";

/** host 帧型全集（与 src/bridge/wire.ts 的 HostFrameKind 判定一字不差；测试锁定）。 */
export const HOST_FRAME_KINDS: readonly HostFrameKindValue[] = [
  "theme",
  "locale",
  "workspace",
  "visibility",
  "diagnostics",
  "restart",
  "open-panel",
  "composer-insert",
  "session-switch",
  "full-ui-url",
  "capabilities",
  "session-tabs",
];

/** visibility 帧：chatPanel onDidChangeVisibility 生产（webview 隐藏时暂停渲染）。 */
export interface VisibilityHostFramePayload {
  visible: boolean;
}

/** diagnostics 帧：code.sendDiagnostics 两档下发（T09 host 半）。 */
export interface DiagnosticsHostFramePayload {
  /** 两档：仅错误 / 错误+警告（与 QuickPick 文案、composer 预填标题一字一致）。 */
  tier: "errors" | "all";
  /** 按 file 路径聚合的诊断（severity: 0=Error 1=Warning 2=Info 3=Hint）。 */
  items: Array<{
    path: string;
    severity: number;
    message: string;
    source?: string;
    startLine: number;
    startCharacter: number;
  }>;
  errorCount: number;
  generatedAt: number;
}

/**
 * workspace 帧：hostCommands「新建会话/切换工作区」与 container 工作区/设置变化
 * 事件的唯一载荷形状（组3/4 webview 按此处消费）。
 */
export type WorkspaceHostFramePayload =
  | { kind: "new-session" }
  | { kind: "workspace-focused"; folder: string }
  | {
      kind: "workspace-changed";
      folders: string[];
      activeFolder: string | null;
    }
  | { kind: "settings-changed" };

/** restart 帧：进程换代编排横幅（P1-6：换代→横幅→自动恢复→失败降级）。 */
export interface RestartHostFramePayload {
  workspaceKey: string;
  /** 自动恢复成功的会话。 */
  restored: string[];
  /** 恢复失败明细（失败降级：diagnostics.log + 状态栏 crashed，不静默）。 */
  failures: Array<{ folder: string; sessionId: string; error: string }>;
}

/** open-panel 帧：命令面驱动的面板打开指令（组1 命令 → 组3/4 消费）。 */
export interface OpenPanelHostFramePayload {
  /** instructions / session-params / usage / subagents / import-claude-sessions。 */
  panel: string;
}

// ── diagnostics 帧（T09 host 半） ───────────────────────────

/** 诊断条目原始面（vscode.languages.getDiagnostics 的投影形状；纯层可测）。 */
export interface DiagnosticsSourceEntry {
  path: string;
  /** DiagnosticSeverity：0=Error 1=Warning 2=Information 3=Hint。 */
  severity: number;
  message: string;
  source?: string;
  startLine: number;
  startCharacter: number;
}

export const DIAGNOSTIC_SEVERITY_ERROR = 0;
export const DIAGNOSTIC_SEVERITY_WARNING = 1;

/**
 * 两档诊断 → diagnostics 帧载荷（T09：仅错误 / 错误+警告）。
 * "errors" 档只保留 Error 级条目；"all" 档保留 Error+Warning（P1-5 两档口径
 * 与 QuickPick/composer 标注一字一致，不混入 Info/Hint）；items 按传入顺序保留。
 */
export function buildDiagnosticsFramePayload(
  tier: "errors" | "all",
  entries: readonly DiagnosticsSourceEntry[],
  generatedAt: number = Date.now(),
): DiagnosticsHostFramePayload {
  const items = entries
    .filter((entry) =>
      tier === "errors"
        ? entry.severity === DIAGNOSTIC_SEVERITY_ERROR
        : entry.severity <= DIAGNOSTIC_SEVERITY_WARNING,
    )
    .map((entry) => ({ ...entry }));
  return {
    tier,
    items,
    errorCount: entries.filter((e) => e.severity === DIAGNOSTIC_SEVERITY_ERROR)
      .length,
    generatedAt,
  };
}

/** composer-insert 帧：M1 编辑器命令（终端送入/审阅改动/Code Action 等）→ composer 预填。 */
export interface ComposerInsertHostFramePayload {
  /** 预填文本；携带 mention 时首段须为 mention.markdown（webview setMention 依赖）。 */
  text: string;
  /**
   * 结构化 mention pill（Claude Code/Augment 口径）：干净文件引用，正文不再塞 XML 块。
   * 形状与 ui ComposerMentionPrefill 结构兼容（postMessage JSON 传输）。
   */
  mention?: {
    id: string;
    category: "files";
    label: string;
    value: string;
    markdown: string;
    description?: string;
    data?: {
      kind: "file" | "directory";
      path: string;
      relativePath: string;
      /** 选区上下文的 1-based 起止行：仅影响 pill 展示文案。 */
      startLine?: number;
      endLine?: number;
    };
  };
  /**
   * 批量 mention（spec: composer-insert-delivery）：N 条上下文合并为一个帧，
   * 避免 store 单槽被连续多帧覆盖；与 mention 互斥，mentions 优先。
   */
  mentions?: Array<NonNullable<ComposerInsertHostFramePayload["mention"]>>;
  /**
   * replace（默认）：指令类命令整体预填；prepend-if-missing：加入上下文 pill
   * 前置且按 mention.id 去重，不覆盖用户正在编辑的草稿。
   */
  mode?: "replace" | "prepend-if-missing";
}

/** session-switch 帧：历史会话命令（pickSession）→ webview 重绑 sessionId（resume）。 */
export interface SessionSwitchHostFramePayload {
  /** 目标会话；null = 回草稿态（持久化会话恢复失败时的纠正帧：UI 订阅失效会话会报 fault.subscribe.sessionNotFound）。 */
  sessionId: string | null;
}

/** full-ui-url 帧：chatPanel full 模式下共享 server 就绪（或失败）后推送 iframe 地址。 */
export interface FullUiUrlHostFramePayload {
  /** server base URL；"" = 启动失败（error 携带原因）。 */
  url: string;
  error?: string;
}

// ── capabilities 帧（T07 capabilities 横切 + FR-A13 残余吸收，closeout-2） ──

/**
 * v4 hello.capabilities 的投影子面（helloMessageSchema hostCapabilitiesSchema 同形子集；
 * wire 数据，故定义在 host 侧载荷唯一定义处，webview 投影层经此消费）。
 */
export interface RuntimeCapabilityFlags {
  /** 原生对话框（桌面 shell 专用；VS Code webview 场景恒 false → 入口隐藏）。 */
  nativeDialogs: boolean;
  /** 本机终端面板。 */
  localTerminal: boolean;
  /** 二进制帧传输（false → base64 文本帧退化链路）。 */
  binaryFrames: boolean;
  /** 压缩协商（none 之外的值表示链路已压缩）。 */
  compression: string;
}

/**
 * capabilities 帧：agent 就绪后 host 探测能力面（helloConversationV4 + 必要时
 * runtime/capabilities 复核）下发的投影数据（架构 architecture-p1.md T07「接线后行为」）。
 */
export interface CapabilitiesHostFramePayload {
  /**
   * hello.capabilities 收敛结果（webview 侧 capabilitiesFromHello 产物）；null = 能力面
   * 整体缺失（旧 CLI / 形状非法），配合 capabilityMissing 决定 UI 降级呈现。
   */
  capabilities: RuntimeCapabilityFlags | null;
  /**
   * true = 已明确识别为能力缺失（-32601 / 无 code 的 "Method not found"，FR-A13 口径），
   * UI 据此显示「当前 CLI 版本不支持」；false = 暂时不可得（transient），UI 静默不诬告。
   */
  capabilityMissing: boolean;
}

// ── 编辑器标签 UI 上行（plat-evt notifyEditorTabUi） ───────────────

/** 编辑器标签标题上限（超出截断加省略号；IDE 标签本身也会二次截断）。 */
export const EDITOR_TAB_TITLE_MAX_LENGTH = 40;
/** 忙态前缀（Agent streaming/creating/restoring 时显示；静态符号，IDE 标签不支持动画）。 */
export const EDITOR_TAB_BUSY_PREFIX = "● ";

/**
 * webview → host 的编辑器标签 UI 状态（plat-evt "notifyEditorTabUi"；fire-and-forget，
 * 不经白名单——plat-evt 事件面无方法调用语义，host 侧只消费已知事件名）。
 * title=null 表示回退默认标题（草稿态）；host 只接受编辑器形态连接的该事件。
 */
export interface EditorTabUiPayload {
  /** 活动会话的任务标题（首条消息自动截取）；null = 草稿/未知（用默认标题）。 */
  title: string | null;
  /** 活动任务是否运行中（streaming/creating/restoring）。 */
  busy: boolean;
}

/** 宽松解析 webview 上行的标签 UI 载荷；形状非法返回 null（host 丢弃）。 */
export function parseEditorTabUiPayload(payload: unknown): EditorTabUiPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const title =
    record["title"] === null || record["title"] === undefined
      ? null
      : typeof record["title"] === "string" && record["title"].length > 0
        ? record["title"]
        : null;
  return { title, busy: record["busy"] === true };
}

/**
 * 合成编辑器标签标题：忙态前缀 + 会话标题（截断）或默认标题。
 * 纯函数（vitest 直测）；chatEditorPanel 拿结果直接写 panel.title。
 */
export function composeEditorTabTitle(
  baseTitle: string,
  payload: EditorTabUiPayload,
): string {
  const trimmed = payload.title?.trim() ?? "";
  const body =
    trimmed.length > 0
      ? trimmed.length > EDITOR_TAB_TITLE_MAX_LENGTH
        ? `${trimmed.slice(0, EDITOR_TAB_TITLE_MAX_LENGTH)}…`
        : trimmed
      : baseTitle;
  return payload.busy ? `${EDITOR_TAB_BUSY_PREFIX}${body}` : body;
}

// ── session-tabs 帧（多页签会话标签跨页共享） ────────────────────

/** 会话标签快照（webview SessionTab 的 wire 形状；host 侧不 import webview 层）。 */
export interface SessionTabSnapshot {
  id: string;
  title: string;
  sessionId: string | null;
  pinned: boolean;
}

/** session-tabs 帧：host 中继的会话标签全集（晚启动连接补发同一形状）。 */
export interface SessionTabsHostFramePayload {
  tabs: SessionTabSnapshot[];
}

/** 宽松解析标签快照数组（脏数据逐条丢弃，不整体拒绝）。 */
export function parseSessionTabsPayload(payload: unknown): SessionTabSnapshot[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const tabs = (payload as Record<string, unknown>)["tabs"];
  if (!Array.isArray(tabs)) return null;
  const snapshots: SessionTabSnapshot[] = [];
  for (const item of tabs) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    if (typeof record["id"] !== "string" || record["id"].length === 0) continue;
    snapshots.push({
      id: record["id"],
      title: typeof record["title"] === "string" ? record["title"] : "Untitled",
      sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : null,
      pinned: record["pinned"] === true,
    });
  }
  return snapshots;
}
