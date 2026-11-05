/**
 * import/ImportClaudeSessions.tsx — Claude 会话导入面板（T11，P1-12）。
 *
 * 复用 @zcode/ui 的 useClaudeSessionMigration（hooks/useClaudeSessionMigration.ts）：
 * 扫描/导入全走 services zcode-task 频道（scanImportableClaudeSessions /
 * importClaudeSessions，扩展宿主进程读 ~/.claude/projects——§9 核实项 4 的证据面）。
 * isDesktop 门开启（vscodePlatformService.isDesktop=true，H7）；web 场景由 hook 的
 * supportState 与本面板的引导态共同拦截。
 *
 * 需要 TabStoreProvider（hook 内 useTabStoreApi）；由 index.tsx 在装配树外层挂载。
 */

import { useCallback, useEffect, useState } from "react";
import type { ZCodeImportableSessionCandidate } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useClaudeSessionMigration } from "@/hooks/useClaudeSessionMigration.js";
import {
  buildImportRequest,
  formatCandidateRows,
  mapImportResult,
  projectClaudeImportSupport,
  type ClaudeCandidateRow,
  type ClaudeImportOutcome,
} from "./onboarding";

export interface ImportClaudeSessionsProps {
  /** 当前 workspace（hook 的「仅当前 workspace」筛选口径；多根筛选经 hook 内部态）。 */
  workspacePath: string | null;
  isDesktop: boolean;
  /** 导入成功后打开新会话（App onSessionCreated 同路径）。 */
  onOpenSession?: (sessionId: string) => void;
  onClose?: () => void;
}

export function ImportClaudeSessions({
  workspacePath,
  isDesktop,
  onOpenSession,
  onClose,
}: ImportClaudeSessionsProps) {
  const migration = useClaudeSessionMigration({
    workspacePath,
    ...(isDesktop ? { isDesktop: true } : { isDesktop: false }),
  });
  const [lastOutcome, setLastOutcome] = useState<ClaudeImportOutcome | null>(null);
  const [importSummary, setImportSummary] = useState<string | null>(null);
  // hook 不暴露「已扫描」态；本地跟踪（挂载扫描/手动重扫都置位）。
  const [hasScanned, setHasScanned] = useState(false);

  const support = projectClaudeImportSupport({
    isDesktop,
    candidates:
      migration.candidates.length > 0 || hasScanned || migration.scanError
        ? migration.candidates
        : null,
    scanError: migration.scanError,
  });

  const rows: ClaudeCandidateRow[] = support.detected
    ? formatCandidateRows(migration.candidates as readonly ZCodeImportableSessionCandidate[])
    : [];

  const handleImport = useCallback(async () => {
    const result = await migration.importSelectedSessions();
    const outcome = mapImportResult(result);
    setLastOutcome(outcome);
    setImportSummary(outcome.summary);
    if (outcome.openSessionId) onOpenSession?.(outcome.openSessionId);
  }, [migration, onOpenSession]);

  // 面板展开即扫描一次（检测引导的主动面；失败呈现可读错误，不静默）。
  // 门（isDesktop）或 scan 回调（扫描参数变化时重建）变化时各扫一次；手动「重新扫描」走按钮。
  useEffect(() => {
    if (!isDesktop) return;
    void migration.scan().then(() => setHasScanned(true));
  }, [isDesktop, migration.scan]);

  const handleRescan = useCallback(() => {
    void migration.scan().then(() => setHasScanned(true));
  }, [migration]);

  return (
    <div
      data-testid="import-claude-sessions"
      className="border-t border-card-border bg-card px-2 py-1 text-ui-xs"
    >
      <div className="flex items-center gap-1">
        <span>导入 Claude Code 会话</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 enabled:cursor-pointer"
          disabled={!support.supported}
          onClick={handleRescan}
        >
          重新扫描
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
      {support.guidance ? (
        <div className="px-0 py-1 text-foreground-subtle" data-testid="claude-import-guidance">
          {support.guidance}
        </div>
      ) : null}
      {rows.length > 0 ? (
        <ul className="max-h-48 overflow-auto pb-1" data-testid="claude-candidate-rows">
          {rows.map((row) => (
            <li key={row.sessionId} className="flex items-center gap-1">
              <label className="flex min-w-0 flex-1 items-center gap-1">
                <input
                  type="checkbox"
                  checked={migration.selectedSessionIds.includes(row.sessionId)}
                  onChange={() => migration.toggleSessionSelection(row.sessionId)}
                />
                <span className="min-w-0 flex-1 truncate" title={row.sourcePath}>
                  {row.title}
                </span>
                <span className="shrink-0 text-foreground-subtle">
                  {row.updatedAtLabel} · {row.workspacePath}
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {rows.length > 0 ? (
        <div className="flex gap-1 pb-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 enabled:cursor-pointer"
            onClick={() => migration.selectAllSessions()}
          >
            全选
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 enabled:cursor-pointer"
            onClick={() => migration.clearSelectedSessions()}
          >
            清空
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 enabled:cursor-pointer"
            disabled={migration.selectedSessionIds.length === 0 || migration.isImporting}
            onClick={() => void handleImport()}
          >
            导入选中（{migration.selectedSessionIds.length}）
          </Button>
        </div>
      ) : null}
      {migration.isImporting ? <div className="pb-1 text-foreground-subtle">导入中…</div> : null}
      {importSummary !== null ? (
        <div className="pb-1" data-testid="claude-import-summary">
          {importSummary}
        </div>
      ) : null}
      {lastOutcome && lastOutcome.issues.length > 0 ? (
        <ul className="pb-1 text-foreground-subtle" data-testid="claude-import-issues">
          {lastOutcome.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      ) : null}
      {migration.importError ? (
        <div className="pb-1 text-foreground-subtle">导入失败：{migration.importError}</div>
      ) : null}
    </div>
  );
}
