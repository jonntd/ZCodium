// 输入框工具栏统计胶囊的纯派生逻辑（zcode-patcher --tps-footer 原生版）。
// 只依赖 conversation snapshot 的行与 usage 形状，独立于 React，便于单测。
// 口径与补丁版一致：CJK 1 字≈1 token、其余 4 字符≈1 token；
// 首 token = 首个内容行 createdAt − turnHeader.startedAt。

import type {
  AssistantTextRow,
  ConversationRow,
  ReasoningRow,
  TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";

export const STREAM_WINDOW_MS = 4000;

/** token 粗估：CJK 字符 1 字 ≈ 1 token，其余 4 字符 ≈ 1 token（与补丁版口径一致）。 */
export function estimateTokens(text: string): number {
  let count = 0;
  for (let index = 0; index < text.length; index += 1) {
    count += text.charCodeAt(index) > 0x2e7f ? 1 : 0.25;
  }
  return Math.round(count);
}

function isContentRow(row: ConversationRow): row is AssistantTextRow | ReasoningRow {
  return row.kind === "assistantText" || row.kind === "reasoning";
}

export interface TurnStats {
  /** 所属 product turnId——同一轮内跨行稳定（rowId 会随新行追加漂移，不能作键）。 */
  turnId: string;
  startedAt: number | null;
  endedAt: number | null;
  streaming: boolean;
  firstContentAt: number | null;
  lastContentAt: number | null;
  textTokens: number;
  /** 结束轮的 precise out（usage.cumulative 相对轮起点基线差）；由展示组件写回。 */
  preciseOutputTokens?: number;
}

/**
 * 聚合「当前轮」（窗口最后一行所属 turn）的派生指标。
 *
 * 不以 turnHeader 在场为前提：长 agentic 轮的 header 会被滚出 rows 窗口，靠它定位
 * 会让统计随窗口漂移时有时无。header 在场时用其 startedAt/endedAt/state；缺席时
 * streaming 由内容行的 streaming 态判定，endedAt 以最后内容行 createdAt 近似。
 */
export function resolveLatestTurnStats(rows: readonly ConversationRow[]): TurnStats | null {
  if (rows.length === 0) return null;
  let turnId: string | null = null;
  let header: TurnHeaderRow | undefined;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    if (turnId === null && row.turnId) {
      turnId = row.turnId;
    }
    if (turnId !== null && row.kind === "turnHeader" && row.turnId === turnId) {
      header = row;
      break;
    }
  }
  if (turnId === null) return null;
  let firstContentAt: number | null = null;
  let lastContentAt: number | null = null;
  let text = "";
  let contentStreaming = false;
  for (const row of rows) {
    if (row.turnId !== turnId || !isContentRow(row)) continue;
    if (row.text) text += row.text;
    if (row.state === "streaming") contentStreaming = true;
    if (row.createdAt != null) {
      if (firstContentAt === null || row.createdAt < firstContentAt) firstContentAt = row.createdAt;
      if (lastContentAt === null || row.createdAt > lastContentAt) lastContentAt = row.createdAt;
    }
  }
  const streaming = header ? header.state === "running" : contentStreaming;
  return {
    turnId,
    startedAt: header?.startedAt ?? firstContentAt,
    endedAt: header?.endedAt ?? (streaming ? null : lastContentAt),
    streaming,
    firstContentAt,
    lastContentAt,
    textTokens: estimateTokens(text),
  };
}

export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}
