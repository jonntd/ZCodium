/**
 * usage/usagePanel.tsx — 用量面板（T10，P1-7；layout.tsx 的 usage 槽位承载）。
 *
 * - 关闭态：一行累计摘要（snapshot.usage.cumulative 随投影帧自动更新）；
 * - 展开态：累计细分 + 上下文窗口占比 + 「权威总量」刷新
 *   （v4/conversation/usage 经 services zcodeAgentService.getTaskTokenUsage）；
 * - 每轮用量行（P1-7.1，可折叠）：turn.completed 事件（usage+cacheStats）经
 *   readSessionEvents 拉取投影为每轮行，随「刷新总量」更新。
 */

import { useCallback, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useServices } from "@/hooks/useServices.js";
import {
  SessionCommandScope,
  useSessionSnapshot,
} from "../header/sessionCommandPort";
import {
  compactUsageSummary,
  contextWindowSummary,
  formatTokens,
  formatTurnUsageRow,
  projectConversationUsage,
  projectSnapshotUsage,
  projectTurnUsageRows,
  type ConversationUsageResult,
  type TurnUsageRow,
} from "./usageModel";

export interface UsagePanelProps {
  workspacePath: string;
  sessionId: string | null;
  /** 展开态（open-panel "usage" 命令与面板内切换共同驱动；index.tsx 装配持有）。 */
  open: boolean;
  onToggle: (open: boolean) => void;
}

export function UsagePanel(props: UsagePanelProps): React.ReactNode {
  if (!props.open) {
    return <UsageSummaryBar {...props} />;
  }
  return (
    <SessionCommandScope workspacePath={props.workspacePath}>
      <UsageDetail {...props} />
    </SessionCommandScope>
  );
}

function UsageSummaryBar({ workspacePath, sessionId, onToggle }: UsagePanelProps) {
  return (
    <SessionCommandScope workspacePath={workspacePath}>
      <UsageSummary sessionId={sessionId} onToggle={onToggle} />
    </SessionCommandScope>
  );
}

function UsageSummary({ sessionId, onToggle }: { sessionId: string | null; onToggle: (open: boolean) => void }) {
  const snapshot = useSessionSnapshot(sessionId);
  const projection = projectSnapshotUsage(snapshot?.usage);
  return (
    <div
      data-testid="usage-summary-bar"
      className="flex items-center gap-1 border-t border-card-border px-2 py-1 text-ui-xs"
    >
      <span className="text-foreground-subtle">{compactUsageSummary(projection)}</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 enabled:cursor-pointer"
        data-testid="usage-expand"
        onClick={() => onToggle(true)}
      >
        用量 ▾
      </Button>
    </div>
  );
}

function UsageDetail({ workspacePath, sessionId, onToggle }: UsagePanelProps) {
  const { zcodeAgentService } = useServices();
  const snapshot = useSessionSnapshot(sessionId);
  const projection = projectSnapshotUsage(snapshot?.usage);
  const [authoritative, setAuthoritative] = useState<ConversationUsageResult | null>(null);
  const [turns, setTurns] = useState<TurnUsageRow[]>([]);
  const [turnsOpen, setTurnsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    setError(null);
    try {
      // 权威总量 + 每轮用量行（P1-7.1：turn.completed 的 usage/cacheStats）一并刷新。
      const [usage, events] = await Promise.all([
        zcodeAgentService.getTaskTokenUsage({ sessionId, workspacePath }),
        zcodeAgentService
          .readSessionEvents({ sessionId, workspacePath, limit: 200 })
          .catch(() => []),
      ]);
      setAuthoritative(projectConversationUsage(usage));
      setTurns(projectTurnUsageRows(events ?? []));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId, workspacePath, zcodeAgentService]);

  return (
    <div
      data-testid="usage-panel"
      className="border-t border-card-border bg-card px-2 py-1 text-ui-xs"
    >
      <div className="flex items-center gap-1">
        <span>用量（会话累计）</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 enabled:cursor-pointer"
          disabled={!sessionId}
          onClick={() => void refresh()}
        >
          刷新总量
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-2 enabled:cursor-pointer"
          onClick={() => onToggle(false)}
        >
          收起
        </Button>
      </div>
      <ul className="pb-1" data-testid="usage-rows">
        <li>输入 {formatTokens(projection.inputTokens)}</li>
        <li>输出 {formatTokens(projection.outputTokens)}</li>
        <li>
          缓存 读取 {formatTokens(projection.cacheReadTokens)} / 写入 {formatTokens(projection.cacheWriteTokens)}
        </li>
        {contextWindowSummary(projection) ? <li>{contextWindowSummary(projection)}</li> : null}
        {authoritative ? (
          <li data-testid="usage-authoritative">
            权威总量（v4/conversation/usage）：total {formatTokens(authoritative.totalTokens)}（推理{" "}
            {formatTokens(authoritative.reasoningTokens)}；请求 {authoritative.modelRequestCount} 次
            {authoritative.modelErrorCount > 0 ? `，错误 ${authoritative.modelErrorCount}` : ""}）
          </li>
        ) : null}
      </ul>
      {/* P1-7.1 每轮用量行（可折叠）：数据源 turn.completed 的 usage/cacheStats。 */}
      <div className="pb-1" data-testid="usage-turns">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 enabled:cursor-pointer"
          disabled={!sessionId}
          data-testid="usage-turns-toggle"
          onClick={() => {
            setTurnsOpen((open) => !open);
            // 每次展开都刷新（复核 medium：turn.completed 落地后用户展开即可见最新每轮行，
            // 不依赖空态首拉；面板收起期间不产生后台轮询）。
            if (!turnsOpen) void refresh();
          }}
        >
          每轮用量 {turnsOpen ? "▴" : "▾"}
        </Button>
        {turnsOpen ? (
          turns.length === 0 ? (
            <div className="px-2 pb-1 text-foreground-subtle">
              {loading ? "读取中…" : "暂无已完成 turn 的用量事件（完成一轮后重新展开即更新）"}
            </div>
          ) : (
            <ul className="max-h-40 overflow-auto px-2 pb-1 text-foreground-subtle">
              {turns.map((row, index) => (
                <li key={row.turnId ?? row.seq} data-testid="usage-turn-row">
                  第 {index + 1} 轮：{formatTurnUsageRow(row)}
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
      {error ? <div className="pb-1 text-foreground-subtle">总量查询失败：{error}</div> : null}
    </div>
  );
}
