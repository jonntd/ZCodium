/**
 * subagents/SubagentsPanel.tsx — 子代理面板（T11，P1-15）。
 *
 * - 运行中子代理：共享 projection 的 snapshot.subagents（running/waiting/blocked +
 *   endedTotal，随帧自动更新）；
 * - 已结束列表：IZCodeAgentService.listSessionSubagents（session/subagents cursor query）；
 * - 点开子代理：SubagentDrilldown（@zcode/ui）装配——面板内即 V4PaneConversationProvider
 *   子树，useV4Conversation().layer.acquire(childSessionId) 订阅其输出投影；
 * - 子代理定义目录：subagents 频道（ISubagentsService.list，serviceAssembly 白名单已暴露）
 *   的只读列表（编辑面归 ui SettingsPage 范畴，本期不展开）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useServices } from "@/hooks/useServices.js";
import { SubagentDrilldown } from "@/v4/SubagentDrilldown.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import {
  SessionCommandScope,
  useSessionSnapshot,
} from "../header/sessionCommandPort";
import {
  projectEndedSubagents,
  projectSubagentProjection,
  subagentStatusLabel,
  type EndedSubagentRow,
} from "./subagentsModel";

export interface SubagentsPanelProps {
  workspacePath: string;
  sessionId: string | null;
  onClose?: () => void;
}

export function SubagentsPanel(props: SubagentsPanelProps): React.ReactNode {
  return (
    <SessionCommandScope workspacePath={props.workspacePath}>
      <SubagentsInner {...props} />
    </SessionCommandScope>
  );
}

function SubagentsInner({ workspacePath, sessionId, onClose }: SubagentsPanelProps) {
  const { zcodeAgentService } = useServices();
  const snapshot = useSessionSnapshot(sessionId);
  const projection = useMemo(() => projectSubagentProjection(snapshot?.subagents), [snapshot]);
  const [ended, setEnded] = useState<EndedSubagentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [drilldownChildId, setDrilldownChildId] = useState<string | null>(null);

  const refreshEnded = useCallback(async () => {
    if (!sessionId) return;
    setError(null);
    try {
      const result = await zcodeAgentService.listSessionSubagents({
        sessionId,
        workspacePath,
        endedLimit: 20,
      });
      setEnded(projectEndedSubagents(result));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [sessionId, zcodeAgentService]);

  useEffect(() => {
    void refreshEnded();
  }, [refreshEnded]);

  // SubagentDrilldown 的行渲染上下文：面板只有最小事实面（theme/codePreviewSettings 恒定，
  // workspacePath/sessionId 是本面板属性；引用稳定由 useMemo 保证）。
  const drilldownContext = useMemo<ConversationRowRenderContext>(
    () => ({
      workspacePath,
      theme: "system",
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
      sessionId,
      rootSessionId: sessionId,
    }),
    [workspacePath, sessionId],
  );

  return (
    <div
      data-testid="subagents-panel"
      className="border-t border-card-border bg-card px-2 py-1 text-ui-xs"
    >
      <div className="flex items-center gap-1">
        <span>子代理</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 enabled:cursor-pointer"
          disabled={!sessionId}
          onClick={() => void refreshEnded()}
        >
          刷新
        </Button>
        {onClose ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 enabled:cursor-pointer"
            onClick={onClose}
          >
            收起
          </Button>
        ) : null}
      </div>
      {!sessionId ? (
        <div className="pb-1 text-foreground-subtle">草稿会话暂无子代理</div>
      ) : (
        <>
          {projection.running.length === 0 ? (
            <div className="pb-1 text-foreground-subtle">当前无运行中子代理</div>
          ) : (
            <ul className="pb-1" data-testid="subagent-running-rows">
              {projection.running.map((row) => (
                <li key={row.childSessionId} className="flex items-center gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-6 min-w-0 flex-1 justify-start px-2 enabled:cursor-pointer"
                    onClick={() =>
                      setDrilldownChildId((current) =>
                        current === row.childSessionId ? null : row.childSessionId,
                      )
                    }
                  >
                    <span className="truncate">{row.title}</span>
                    <span className="ml-2 shrink-0 text-foreground-subtle">
                      {subagentStatusLabel(row.status)}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="pb-1 text-foreground-subtle">
            已结束 {projection.endedTotal}
            {ended.length > 0 ? `（最近 ${ended.length}）` : ""}
          </div>
          {ended.length > 0 ? (
            <ul className="pb-1" data-testid="subagent-ended-rows">
              {ended.map((row) => (
                <li key={row.sessionId} className="flex items-center gap-1">
                  <span className="min-w-0 flex-1 truncate" title={row.sessionId}>
                    {row.title}
                  </span>
                  <span className="shrink-0 text-foreground-subtle">{row.statusLabel}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {error ? <div className="pb-1 text-foreground-subtle">查询失败：{error}</div> : null}
          {drilldownChildId ? (
            <div className="border-t border-card-border pt-1" data-testid="subagent-drilldown">
              <SubagentDrilldown childSessionId={drilldownChildId} context={drilldownContext} />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
