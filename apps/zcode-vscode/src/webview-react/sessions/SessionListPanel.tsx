/**
 * SessionListPanel — 会话列表面板 webview 半（T06；P1-1/P1-2）。
 *
 * - 数据源 = 组2 zcode-session 频道（IZCodeSessionService.listSessions，桥白名单频道），
 *   per-folder 拉取后按最近活动排序并标注归属（P1-2.2）；
 * - 失败降级为 per-folder 最近会话 ID 列表（P1-1.1，UI 不崩；键表经 plat
 *   getLatestSessionIdByFolder 注入）；
 * - turn 进行中禁切（P1-1.3，App 下发 turnRunning）；
 * - 移除（P1-1.4 真删除）：二次确认（webview confirm）→ 本地列表移除 → onRemove
 *   （App 走 v4 deleteSession 命令面 + notifySessionDeleted 清 host 键）；CLI 拒绝时
 *   呈现原因并降级为仅从列表移除。已移除集合在本面板生命周期内过滤轮询重建的
 *   entries，避免 5s 轮询把已移除条目复活。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { folderLabel } from "./folderSelector";
import {
  SESSION_SWITCH_DISABLED_HINT,
  degradeToLatestIdEntries,
  isSessionSwitchDisabled,
  projectSessionEntries,
  removeSessionFromList,
  sessionStatusLabel,
  type SessionListEntry,
} from "./sessionListModel";

const SESSION_LIST_LIMIT = 50;
/** 面板展开期间的活性轮询间隔（listSessions 快照的 turn 态保鲜；P1-1.3 禁切数据源）。 */
const SESSION_LIST_POLL_MS = 5_000;
/** 缺省 per-folder 最近会话表（模块级常量，避免每渲染新建对象改变回调身份）。 */
const EMPTY_LATEST: Readonly<Record<string, string | undefined>> = {};

export interface SessionListPanelProps {
  /** 当前 workspace folders（fsPath）。 */
  folders: readonly string[];
  sessionId: string | null;
  /** turn 进行中外部信号（可选；缺省由 listSessions 活跃会话 status 推导）。 */
  turnRunning?: boolean;
  /** 桥服务面（zcode-session 频道消费）。 */
  services: IServiceAccessor;
  /** per-folder 最近会话（host workspace 帧/bootstrap 收敛；降级列表与标注用）。 */
  latestSessionIdByFolder?: Readonly<Record<string, string | undefined>>; // 默认 EMPTY_LATEST
  onSwitch: (entry: SessionListEntry) => void;
  /**
   * 移除回调（App 负责 v4 deleteSession 真删除 + notifySessionDeleted 清 host 键）。
   * 返回 CLI 拒绝/不可用原因（null = 真删除成功），面板据此呈现降级说明。
   */
  onRemove: (entry: SessionListEntry) => void | Promise<string | null>;
  onPickFolder?: () => void;
  onClose?: () => void;
}

export function SessionListPanel({
  folders,
  sessionId,
  turnRunning,
  services,
  latestSessionIdByFolder = EMPTY_LATEST,
  onSwitch,
  onRemove,
  onPickFolder,
  onClose,
}: SessionListPanelProps) {
  const [entries, setEntries] = useState<SessionListEntry[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [removeNotice, setRemoveNotice] = useState<string | null>(null);
  /** 本面板生命周期内「已移除」集合（ref：轮询闭包稳定读取；M19 防轮询复活）。 */
  const removedIdsRef = useRef<ReadonlySet<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    const collected: SessionListEntry[] = [];
    const failures: string[] = [];
    for (const folder of folders) {
      try {
        const infos = await services.zcodeSessionService.listSessions({
          workspacePath: folder,
          limit: SESSION_LIST_LIMIT,
        });
        collected.push(...projectSessionEntries(infos ?? [], folder, sessionId));
      } catch (error) {
        failures.push(
          `${folderLabel(folder)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (collected.length === 0 && failures.length > 0) {
      // 降级：per-folder 最近会话 ID 列表（P1-1.1）。
      collected.push(...degradeToLatestIdEntries(latestSessionIdByFolder, sessionId));
    }
    // 已移除集合过滤：真删除成功的条目不会回列表；降级（删除被拒）时也不复活展示。
    setEntries(collected.filter((entry) => !removedIdsRef.current.has(entry.sessionId)));
    setErrors(failures);
    setLoading(false);
  }, [folders, services, sessionId, latestSessionIdByFolder]);

  useEffect(() => {
    void refresh();
    // 面板展开期间轮询保鲜（运行中会话状态 → 禁切判定）。
    const timer = window.setInterval(() => void refresh(), SESSION_LIST_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  // turn 进行中判定（P1-1.3）：外部信号优先，否则取活跃会话的 listSessions status。
  const derivedTurnRunning = entries.some(
    (entry) => entry.sessionId === sessionId && entry.status === "running",
  );
  const switchDisabled = isSessionSwitchDisabled(turnRunning ?? derivedTurnRunning);

  return (
    <div
      data-testid="session-list-panel"
      className="shrink-0 border-b border-card-border bg-card text-ui-xs"
    >
      <div className="flex items-center gap-1 px-2 py-1">
        <span className="text-foreground-subtle">会话列表</span>
        {onPickFolder ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 enabled:cursor-pointer"
            onClick={onPickFolder}
          >
            切换 folder
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 enabled:cursor-pointer"
          onClick={() => void refresh()}
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
      {switchDisabled ? (
        <div className="px-3 pb-1 text-warning" data-testid="session-switch-disabled-hint">
          {SESSION_SWITCH_DISABLED_HINT}
        </div>
      ) : null}
      {errors.length > 0 ? (
        <div
          className="px-3 pb-1 text-foreground-subtle"
          data-testid="session-list-errors"
          title={errors.join("；")}
        >
          {/* 原始错误（如控制面泳道空闲回收的 "process manager is disposed"）不直接怼给用户：
              呈现可读口径，细节进 title 悬浮，点「刷新」重试（getClient 会透明重新拉起）。 */}
          会话列表暂不可用（Agent 控制面未就绪），可点「刷新」重试
        </div>
      ) : null}
      {removeNotice ? (
        <div className="px-3 pb-1 text-warning" data-testid="session-remove-notice">
          {removeNotice}
        </div>
      ) : null}
      {loading && entries.length === 0 ? (
        <div className="px-3 py-2 text-foreground-subtle">加载中…</div>
      ) : null}
      {!loading && entries.length === 0 ? (
        <div className="px-3 py-2 text-foreground-subtle">暂无历史会话</div>
      ) : null}
      <ul className="max-h-64 overflow-auto pb-1">
        {entries.map((entry) => (
          <li key={`${entry.folder}:${entry.sessionId}`} className="flex items-center gap-1 px-2 py-0.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 min-w-0 flex-1 justify-start px-2 enabled:cursor-pointer"
              disabled={switchDisabled}
              title={`${entry.title}（${sessionStatusLabel(entry.status)}）`}
              onClick={() => onSwitch(entry)}
            >
              <span className="truncate">{entry.title}</span>
              <span className="ml-2 shrink-0 text-foreground-subtle">
                {sessionStatusLabel(entry.status)} · {folderLabel(entry.folder)}
              </span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 enabled:cursor-pointer"
              title="删除会话（v4 deleteSession 真删除；CLI 拒绝时仅从列表移除并呈现原因）"
              onClick={() => {
                if (!window.confirm(`删除会话「${entry.title}」？真删除走 v4 deleteSession（本地会话数据随之删除）。`)) {
                  return;
                }
                setEntries((current) => removeSessionFromList(current, entry.sessionId));
                removedIdsRef.current = new Set(removedIdsRef.current).add(entry.sessionId);
                void Promise.resolve(onRemove(entry)).then((reason) => {
                  // onRemove 可返回 void（旧签名回调）；仅字符串原因呈现降级说明。
                  setRemoveNotice(typeof reason === "string" ? reason : null);
                });
              }}
            >
              删除
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 面板本地移除（App 持有列表态时复用；与 onRemove 回调配对）。 */
export function removeEntry(entries: readonly SessionListEntry[], sessionId: string): SessionListEntry[] {
  return removeSessionFromList(entries, sessionId);
}
