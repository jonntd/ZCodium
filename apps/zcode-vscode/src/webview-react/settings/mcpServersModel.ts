/**
 * settings/mcpServersModel.ts — MCP 设置面板的纯模型（T08，P1-8）。
 *
 * - settings 形状：`gode.mcp.servers: object[]`，字段对齐
 *   @zcode/shared 的 zcodeProtocolMcpServerSchema（stdio: name/command/args/env；
 *   http/sse: name/type/url/headers）——字段级校验在会话参数面（CLI），settings 面
 *   只做结构归一（与 host normalizeMcpServersForSettings 同口径）；
 * - 状态：mcp/list（connect/status 两 mode）经 services zcode-agent 频道
 *   listMcpServerStatuses（mcp-status lane）查询，这里做投影；
 * - 降级口径（PRD P1-8.3）：运行中不可动态增删，写回仅落 settings，UI 必须呈现
 *   「MCP 运行中不可动态增删，改动后需重建会话生效」提示。
 *
 * 纯函数模块：vitest 直测（test/workspacePreferences.test.ts）。
 */

import { sessionAllowlistRule } from "../../approvals/approvalService";

/** stdio/http-sse 两形态的最小编辑形状（面板表单面；schema 已知的多余字段经 preserved 原样保留）。 */
export interface EditableMcpServer {
  name: string;
  /** stdio：命令；http/sse：URL。 */
  commandOrUrl: string;
  transport: "stdio" | "http" | "sse";
  /** stdio: args；http/sse: 忽略（headers 面板暂不编辑，经 preserved 原样保留）。 */
  args: string[];
  /**
   * 表单外的既有 settings 字段（stdio: env/cwd/scope/isolation/protocolVersion/alwaysLoad/timeoutMs；
   * http/sse: headers/oauth/scope/isolation/protocolVersion/alwaysLoad/timeoutMs）。
   * 写回时原样合并。修复依据：此前 fromEditableServer 无条件回写空 env/headers，
   * 经 container.updateMcpServers → writeGodeSetting("mcp.servers") 整体覆盖，
   * 用户既有配置在面板一次保存后全部丢失（与注释「多余字段原样保留」相反）。
   */
  preserved?: Record<string, unknown>;
}

export const MCP_SERVER_NAME_LIMIT = 64;
/** settings 建议上限（协议未硬限；防御手改/批量粘贴）。 */
export const MCP_SERVERS_LIMIT = 64;

/** 未知对象 → 可编辑形状；无法识别的字段缺失回落空值（面板可修）；schema 已知的表单外字段进 preserved。 */
export function toEditableServer(raw: unknown): EditableMcpServer {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const name = typeof record.name === "string" ? record.name : "";
  if (typeof record.type === "string" && (record.type === "http" || record.type === "sse")) {
    return {
      name,
      transport: record.type,
      commandOrUrl: typeof record.url === "string" ? record.url : "",
      args: [],
      preserved: pickPreservedFields(record, record.type),
    };
  }
  return {
    name,
    transport: "stdio",
    commandOrUrl: typeof record.command === "string" ? record.command : "",
    args: Array.isArray(record.args)
      ? record.args.filter((arg): arg is string => typeof arg === "string")
      : [],
    preserved: pickPreservedFields(record, "stdio"),
  };
}

/**
 * stdio/http-sse 各自的 preserved 字段集（对齐 zcodeProtocolMcpServerSchema）。
 * 写回 schema 是 .strict()：两形态互斥字段与未知字段不能携带，否则 CLI 整条拒绝，
 * 因此 stdio 不保留 headers/type/url，http/sse 不保留 env/command/args，未知字段一律丢弃。
 */
const PRESERVED_STDIO_KEYS = [
  "env",
  "cwd",
  "scope",
  "isolation",
  "protocolVersion",
  "alwaysLoad",
  "timeoutMs",
] as const;
const PRESERVED_HTTP_KEYS = [
  "headers",
  "oauth",
  "scope",
  "isolation",
  "protocolVersion",
  "alwaysLoad",
  "timeoutMs",
] as const;

/** entry 校验（对齐 zcodeProtocolMcpEntrySchema：{name 非空字符串, value 字符串}）。 */
function isMcpEntry(entry: unknown): boolean {
  if (typeof entry !== "object" || entry === null) return false;
  const record = entry as Record<string, unknown>;
  return (
    typeof record.name === "string" &&
    record.name.length > 0 &&
    typeof record.value === "string"
  );
}

/**
 * 各 preserved 字段的最轻量形状校验（对齐 zcodeProtocolMcpServerSchema 的枚举/类型）：
 * 畸形值原样带回会让 CLI 按 strict 校验整条拒绝，故只保留能过校验的值。
 */
function isPreservableValue(key: string, value: unknown): boolean {
  switch (key) {
    case "cwd":
      return typeof value === "string" && value.length > 0;
    case "scope":
      return value === "user" || value === "workspace";
    case "isolation":
      return value === "session" || value === "workspace";
    case "protocolVersion":
      return value === "legacy" || value === "auto" || value === "2026-07-28";
    case "alwaysLoad":
      return typeof value === "boolean";
    case "timeoutMs":
      return typeof value === "number" && Number.isInteger(value) && value > 0;
    case "oauth":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return false;
  }
}

/** 从既有 settings 记录里挑出表单外、能过形状校验的字段（无则返回 undefined，保持对象精简）。 */
function pickPreservedFields(
  record: Record<string, unknown>,
  transport: "stdio" | "http" | "sse",
): Record<string, unknown> | undefined {
  const keys = transport === "stdio" ? PRESERVED_STDIO_KEYS : PRESERVED_HTTP_KEYS;
  const preserved: Record<string, unknown> = {};
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) continue;
    if (key === "env" || key === "headers") {
      // schema 必填数组：逐条过滤畸形 entry，保留能过校验的条目（全有或全无会连合法条目一起丢）
      preserved[key] = Array.isArray(value) ? value.filter(isMcpEntry) : [];
      continue;
    }
    if (isPreservableValue(key, value)) {
      preserved[key] = value;
    }
  }
  return Object.keys(preserved).length > 0 ? preserved : undefined;
}

/**
 * 面板行 → settings 载荷：stdio 形态丢弃 type/url，http/sse 形态丢弃 command/args；
 * preserved 原样合并（表单字段优先），env/headers 为 schema 必填数组，缺失回落空数组。
 */
export function fromEditableServer(server: EditableMcpServer): Record<string, unknown> {
  const name = server.name.trim().slice(0, MCP_SERVER_NAME_LIMIT);
  const preserved = server.preserved ?? {};
  if (server.transport === "stdio") {
    return {
      ...preserved,
      name,
      command: server.commandOrUrl.trim(),
      args: server.args.map((arg) => arg.trim()).filter(Boolean),
      env: Array.isArray(preserved.env) ? preserved.env : [],
    };
  }
  return {
    ...preserved,
    name,
    type: server.transport,
    url: server.commandOrUrl.trim(),
    headers: Array.isArray(preserved.headers) ? preserved.headers : [],
  };
}

/** 写回归一化（对齐 host normalizeMcpServersForSettings：只留对象条目 + 上限截断）。 */
export function normalizeServersForSettings(
  servers: readonly EditableMcpServer[],
): unknown[] {
  return servers
    .filter((server) => server.name.trim() && server.commandOrUrl.trim())
    .slice(0, MCP_SERVERS_LIMIT)
    .map(fromEditableServer);
}

/** CRUD：更新一行（按下标定位）。 */
export function updateServerAt(
  servers: readonly EditableMcpServer[],
  index: number,
  patch: Partial<EditableMcpServer>,
): EditableMcpServer[] {
  return servers.map((server, i) => (i === index ? { ...server, ...patch } : server));
}

/** CRUD：追加空行（stdio 默认形态）。 */
export function appendServer(servers: readonly EditableMcpServer[]): EditableMcpServer[] {
  if (servers.length >= MCP_SERVERS_LIMIT) return [...servers];
  return [...servers, { name: "", transport: "stdio", commandOrUrl: "", args: [] }];
}

/** CRUD：删除一行。 */
export function removeServerAt(
  servers: readonly EditableMcpServer[],
  index: number,
): EditableMcpServer[] {
  return servers.filter((_, i) => i !== index);
}

/** mcp/list 状态快照形状（@zcode/shared zcodeMcpServerStatusSnapshotSchema 投影面）。 */
export interface McpStatusSnapshot {
  status: string;
  transport: string;
  toolCount: number;
  error?: string;
}

/** 状态 → 展示文案（P1-8.2：已连接/失败/工具数）。 */
export function statusLabel(snapshot: McpStatusSnapshot): string {
  switch (snapshot.status) {
    case "connected":
      return `已连接（工具 ${snapshot.toolCount}）`;
    case "connecting":
      return "连接中";
    case "disabled":
      return "已禁用";
    case "disconnected":
      return "已断开";
    case "untrusted":
      return "未信任";
    case "failed":
      return `失败${snapshot.error ? `：${snapshot.error}` : ""}`;
    default:
      return snapshot.status;
  }
}

/** 状态聚合：`● N connected / M failed`（PRD MCP 状态条形状）。 */
export function summarizeStatuses(
  statuses: Record<string, McpStatusSnapshot>,
): { connected: number; failed: number; total: number; summary: string } {
  const values = Object.values(statuses);
  const connected = values.filter((value) => value.status === "connected").length;
  const failed = values.filter((value) => value.status === "failed").length;
  return {
    connected,
    failed,
    total: values.length,
    summary: `● ${connected} connected${failed > 0 ? ` / ${failed} failed` : ""}`,
  };
}

/** PRD 降级提示文案（P1-8.3，UI 必须呈现的一字不差口径）。 */
export const MCP_SESSION_REBUILD_HINT =
  "MCP 运行中不可动态增删，改动后需重建会话生效";

/** code.* 设置读面（getWorkspaceSettings plat 方法）的形状。 */
export interface WorkspaceSettingsSnapshot {
  mcpServers: unknown[];
  toolAllowlist: string[];
  toolDenylist: string[];
  additionalDirectories: string[];
  mode: string;
  rawModel: string;
}

/** plat 读面结果 → 快照（host 已归一化；此处再防御一层，防旧 host 缺字段）。 */
export function normalizeWorkspaceSettingsSnapshot(raw: unknown): WorkspaceSettingsSnapshot {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  return {
    mcpServers: Array.isArray(record.mcpServers) ? record.mcpServers : [],
    toolAllowlist: toStringArray(record.toolAllowlist),
    toolDenylist: toStringArray(record.toolDenylist),
    additionalDirectories: toStringArray(record.additionalDirectories),
    mode: typeof record.mode === "string" && record.mode ? record.mode : "build",
    rawModel: typeof record.rawModel === "string" ? record.rawModel : "",
  };
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

// ── 「本次会话允许」写回面（P0-8：组2 appendSessionAllowlist plat 方法的消费侧） ──

/** 审批卡 pending permission 的面板投影（含与 host 同口径的写回规则）。 */
export interface PendingPermissionSummary {
  interactionId: string;
  toolName: string;
  summary: string;
  /** `Tool` / `Tool(args)` 规则（sessionAllowlistRule，与 CLI --disallowed-tools 同语言）。 */
  allowlistRule: string;
  /** 工具 input 原文（appendSessionAllowlist 第二参，host 侧做规则归一化）。 */
  detail: unknown;
  /** 卡上是否带「本次会话允许」（allowAlways）档。 */
  hasSessionAllowOption: boolean;
}

/** v4 pendingInteractions（permission payload）→ 面板投影；非 permission 条目忽略。 */
export function projectPendingPermissions(
  interactions: readonly unknown[],
): PendingPermissionSummary[] {
  const out: PendingPermissionSummary[] = [];
  for (const interaction of interactions) {
    const record =
      typeof interaction === "object" && interaction !== null
        ? (interaction as Record<string, unknown>)
        : {};
    const payload =
      typeof record.payload === "object" && record.payload !== null
        ? (record.payload as Record<string, unknown>)
        : {};
    if (payload.kind !== "permission") continue;
    const toolName = typeof payload.toolName === "string" ? payload.toolName : "";
    if (!toolName) continue;
    const options = Array.isArray(payload.options) ? payload.options : [];
    const hasSessionAllowOption = options.some(
      (option) =>
        typeof option === "object" &&
        option !== null &&
        (option as Record<string, unknown>).kind === "allowAlways",
    );
    out.push({
      interactionId: typeof record.interactionId === "string" ? record.interactionId : "",
      toolName,
      summary: typeof payload.summary === "string" ? payload.summary : "",
      allowlistRule: sessionAllowlistRule(toolName, payload.detail),
      detail: payload.detail,
      hasSessionAllowOption,
    });
  }
  return out;
}

/** 写回后 host 的应答形状（container.ts appendSessionAllowlist 返回面）。 */
export interface SessionAllowlistWriteBack {
  rule: string;
  rules: string[];
  requiresSessionRebuild: boolean;
  message: string;
}

