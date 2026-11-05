/**
 * usage/usageModel.ts — 用量累计面板的纯投影（T10，P1-7）。
 *
 * 数据面：
 * - 每帧累计：conversation snapshot.usage.cumulative（input/output/cacheRead/cacheWrite）
 *   随投影帧自动更新（turn.completed 的 usage 聚合投影）；
 * - 会话权威总量：v4/conversation/usage（IZCodeAgentService.getTaskTokenUsage，
 *   agentService 侧转发；含 modelRequestCount/modelErrorCount/缓存细分）。
 * 纯函数模块：vitest 直测（test/switchCommands.test.ts 附带覆盖投影片）。
 */

/** v4ConversationUsageResult 的投影面（@zcode/shared schema 推导形状）。 */
export interface ConversationUsageResult {
  sessionId: string;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  modelRequestCount: number;
  modelErrorCount: number;
}

/** snapshot.usage 的面板投影面（容忍旧快照缺字段）。 */
export interface SnapshotUsageProjection {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  contextUsedTokens: number | null;
  contextMaxTokens: number | null;
}

/** snapshot.usage → 面板投影（旧快照缺 contextWindow 时上下文行隐藏）。 */
export function projectSnapshotUsage(usage: unknown): SnapshotUsageProjection {
  const record = typeof usage === "object" && usage !== null ? (usage as Record<string, unknown>) : {};
  const cumulative =
    typeof record.cumulative === "object" && record.cumulative !== null
      ? (record.cumulative as Record<string, unknown>)
      : {};
  const contextWindow =
    typeof record.contextWindow === "object" && record.contextWindow !== null
      ? (record.contextWindow as Record<string, unknown>)
      : null;
  return {
    inputTokens: asNonNegativeInt(cumulative.inputTokens),
    outputTokens: asNonNegativeInt(cumulative.outputTokens),
    cacheReadTokens: asNonNegativeInt(cumulative.cacheReadTokens),
    cacheWriteTokens: asNonNegativeInt(cumulative.cacheWriteTokens),
    contextUsedTokens: contextWindow ? asNonNegativeInt(contextWindow.usedTokens) : null,
    contextMaxTokens: contextWindow ? asNonNegativeInt(contextWindow.maxTokens) : null,
  };
}

/** 总量查询结果 → 面板投影（字段同名透传；防御缺省）。 */
export function projectConversationUsage(raw: unknown): ConversationUsageResult | null {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  if (typeof record.sessionId !== "string" || !record.sessionId) return null;
  return {
    sessionId: record.sessionId,
    totalTokens: asNonNegativeInt(record.totalTokens),
    inputTokens: asNonNegativeInt(record.inputTokens),
    outputTokens: asNonNegativeInt(record.outputTokens),
    reasoningTokens: asNonNegativeInt(record.reasoningTokens),
    cacheCreationTokens: asNonNegativeInt(record.cacheCreationTokens),
    cacheReadTokens: asNonNegativeInt(record.cacheReadTokens),
    modelRequestCount: asNonNegativeInt(record.modelRequestCount),
    modelErrorCount: asNonNegativeInt(record.modelErrorCount),
  };
}

/** 紧凑摘要（面板关闭态的一行）：`Σ 输入 1.2k · 输出 3.4k · 缓存 200`。 */
export function compactUsageSummary(projection: SnapshotUsageProjection): string {
  return `Σ 输入 ${formatTokens(projection.inputTokens)} · 输出 ${formatTokens(projection.outputTokens)} · 缓存 ${formatTokens(
    projection.cacheReadTokens + projection.cacheWriteTokens,
  )}`;
}

/** 上下文窗口占比文案（无窗口数据返回 null）。 */
export function contextWindowSummary(projection: SnapshotUsageProjection): string | null {
  if (projection.contextMaxTokens === null || projection.contextMaxTokens <= 0) return null;
  const used = projection.contextUsedTokens ?? 0;
  const percent = Math.min(100, Math.round((used / projection.contextMaxTokens) * 100));
  return `上下文 ${formatTokens(used)}/${formatTokens(projection.contextMaxTokens)}（${percent}%）`;
}

/** token 数人读格式（k 缩写，<1000 原样）。 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1000) return String(Math.trunc(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** 每轮用量行（P1-7.1：turn.completed 事件 → 消息流尾部/面板明细的每轮行投影）。 */
export interface TurnUsageRow {
  /** 事件序号（readSessionEvents 的 seq；行序按事件时间升序）。 */
  seq: number;
  turnId: string | null;
  tokenCount: number;
  toolCallCount: number;
  durationMs: number;
  resultType: string;
  /** 缓存命中（turn.completed.cacheStats；缺席 = null）。 */
  cacheHit: boolean | null;
  cacheReadTokens: number | null;
}

/**
 * readSessionEvents 返回的事件列表 → 每轮用量行（P1-7.1）。
 * 只取 type === "turn.completed" 的载荷（tokenCount/duration/toolCallCount/cacheStats）；
 * payload 缺席或形状不符的条目跳过，不抛错。
 */
export function projectTurnUsageRows(events: readonly unknown[]): TurnUsageRow[] {
  const rows: TurnUsageRow[] = [];
  for (const event of events) {
    const record = typeof event === "object" && event !== null ? (event as Record<string, unknown>) : {};
    if (record.type !== "turn.completed") continue;
    const payload =
      typeof record.payload === "object" && record.payload !== null
        ? (record.payload as Record<string, unknown>)
        : null;
    if (!payload) continue;
    const cacheStats =
      typeof payload.cacheStats === "object" && payload.cacheStats !== null
        ? (payload.cacheStats as Record<string, unknown>)
        : null;
    rows.push({
      seq: asNonNegativeInt(record.seq),
      turnId: typeof record.turnId === "string" ? record.turnId : null,
      tokenCount: asNonNegativeInt(payload.tokenCount),
      toolCallCount: asNonNegativeInt(payload.toolCallCount),
      durationMs: asNonNegativeInt(payload.duration),
      resultType: typeof payload.resultType === "string" ? payload.resultType : "success",
      cacheHit: cacheStats && typeof cacheStats.lastCacheHit === "boolean" ? cacheStats.lastCacheHit : null,
      cacheReadTokens:
        cacheStats && typeof cacheStats.cacheReadTokens === "number"
          ? asNonNegativeInt(cacheStats.cacheReadTokens)
          : null,
    });
  }
  return rows.sort((left, right) => left.seq - right.seq);
}

/** 每轮用量行 → 可读文案（面板明细行）。 */
export function formatTurnUsageRow(row: TurnUsageRow): string {
  const cache =
    row.cacheHit === null
      ? ""
      : ` · 缓存${row.cacheHit ? "命中" : "未命中"}${row.cacheReadTokens ? ` ${formatTokens(row.cacheReadTokens)}` : ""}`;
  const suffix = row.resultType !== "success" ? ` · ${row.resultType}` : "";
  return (
    `tokens ${formatTokens(row.tokenCount)} · 工具 ${row.toolCallCount} 次 · ` +
    `${(row.durationMs / 1000).toFixed(1)}s${cache}${suffix}`
  );
}

function asNonNegativeInt(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}
