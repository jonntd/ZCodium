/**
 * settings/McpSettingsPanel.tsx — MCP 设置面板（T08，P1-8/P1-3）。
 *
 * - MCP servers CRUD（读：plat getWorkspaceSettings；写：plat updateMcpServers，
 *   写回仅落 zcodium.mcp.servers，PRD 降级口径提示一字不差呈现）；
 * - mcp/list 运行状态：services zcode-agent 频道 listMcpServerStatuses（mode:"status"，
 *   mcp-status lane，与主 agent 进程隔离），手动刷新（P1-8.2）；
 * - 权限规则编辑：plat updatePermissionRules（allowlist/denylist 整体写回）；
 * - 「本次会话允许」写回：审批卡 pending permission 投影（共享 projection）→
 *   plat appendSessionAllowlist（P0-8 持久化面，保存前确认语义由显式按钮承担）；
 * - 「改动后需重建会话生效」提示：所有写回面共用（host 应答 requiresSessionRebuild）。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { ZCodeMcpListResult } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import {
  SessionCommandScope,
  useSessionSnapshot,
} from "../header/sessionCommandPort";
import {
  MCP_SESSION_REBUILD_HINT,
  appendServer,
  normalizeServersForSettings,
  normalizeWorkspaceSettingsSnapshot,
  projectPendingPermissions,
  removeServerAt,
  statusLabel,
  summarizeStatuses,
  toEditableServer,
  updateServerAt,
  type EditableMcpServer,
  type McpStatusSnapshot,
  type PendingPermissionSummary,
  type SessionAllowlistWriteBack,
} from "./mcpServersModel";

/** plat 调用面（PlatformRpcClient 或等价注入物）。 */
export interface PlatPort {
  call<T>(method: string, ...args: unknown[]): Promise<T>;
}

export interface McpSettingsPanelProps {
  plat: PlatPort;
  services: IServiceAccessor;
  workspacePath: string;
  /** 当前会话（草稿态 null：隐藏「会话允许」写回区）。 */
  sessionId: string | null;
  /** 共享 projection 的 pending permission 投影（注入面；缺省由面板自订阅共享投影）。 */
  pendingPermissions?: readonly PendingPermissionSummary[];
  onClose?: () => void;
}

export function McpSettingsPanel(props: McpSettingsPanelProps) {
  // 关闭态 = 一行 MCP 状态条（PRD §6 的「● N connected」）；展开 = 完整 CRUD/权限面板。
  const [open, setOpen] = useState(false);
  return (
    <SessionCommandScope workspacePath={props.workspacePath}>
      <McpSettingsInner {...props} open={open} onToggleOpen={setOpen} />
    </SessionCommandScope>
  );
}

function McpSettingsInner({
  plat,
  services,
  workspacePath,
  sessionId,
  pendingPermissions: pendingPermissionsProp,
  onClose,
  open,
  onToggleOpen,
}: McpSettingsPanelProps & { open: boolean; onToggleOpen: (open: boolean) => void }) {
  // 「本次会话允许」数据源：注入面优先；缺省自订阅共享 projection（与对话区同层）。
  const snapshot = useSessionSnapshot(sessionId);
  const projectedPermissions = useMemo(
    () => projectPendingPermissions(snapshot?.pendingInteractions ?? []),
    [snapshot],
  );
  const pendingPermissions = pendingPermissionsProp ?? projectedPermissions;
  const [servers, setServers] = useState<EditableMcpServer[] | null>(null);
  const [allowlist, setAllowlist] = useState<string[] | null>(null);
  const [denylist, setDenylist] = useState<string[] | null>(null);
  const [writeBack, setWriteBack] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [statuses, setStatuses] = useState<Record<string, McpStatusSnapshot> | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [writtenAllow, setWrittenAllow] = useState<Set<string>>(new Set());

  const refreshSettings = useCallback(async () => {
    try {
      const snapshot = normalizeWorkspaceSettingsSnapshot(
        await plat.call("getWorkspaceSettings"),
      );
      setServers(snapshot.mcpServers.map(toEditableServer));
      setAllowlist(snapshot.toolAllowlist);
      setDenylist(snapshot.toolDenylist);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [plat]);

  useEffect(() => {
    void refreshSettings();
  }, [refreshSettings]);

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const result: ZCodeMcpListResult = await services.zcodeAgentService.listMcpServerStatuses({
        workspacePath,
        mode: "status",
      });
      setStatuses((result?.statuses ?? {}) as Record<string, McpStatusSnapshot>);
    } catch (err) {
      setStatuses(null);
      setStatusError(err instanceof Error ? err.message : String(err));
    } finally {
      setStatusLoading(false);
    }
  }, [services, workspacePath]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const handleSaveServers = useCallback(async () => {
    if (!servers) return;
    try {
      const result = (await plat.call("updateMcpServers", normalizeServersForSettings(servers))) as {
        count: number;
        requiresSessionRebuild: boolean;
        message: string;
      };
      setWriteBack(result.message);
      await refreshSettings();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [plat, servers, refreshSettings]);

  const handleSaveRules = useCallback(
    async (kind: "allowlist" | "denylist", rules: string[]) => {
      try {
        const result = (await plat.call("updatePermissionRules", kind, rules)) as {
          requiresSessionRebuild: boolean;
          message: string;
        };
        setWriteBack(result.message);
        await refreshSettings();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [plat, refreshSettings],
  );

  const handleWriteBackSessionAllow = useCallback(
    async (item: PendingPermissionSummary) => {
      try {
        const result = (await plat.call(
          "appendSessionAllowlist",
          item.toolName,
          item.detail,
        )) as SessionAllowlistWriteBack;
        setWriteBack(result.message);
        setWrittenAllow((current) => new Set(current).add(item.interactionId));
        await refreshSettings();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [plat, refreshSettings],
  );

  const summary = useMemo(
    () => (statuses ? summarizeStatuses(statuses) : null),
    [statuses],
  );
  const visiblePermissions = useMemo(
    () => (pendingPermissions ?? []).filter((item) => !writtenAllow.has(item.interactionId)),
    [pendingPermissions, writtenAllow],
  );

  // 关闭态：一行 MCP 状态条（状态查询仍在挂载时执行，摘要常亮）。
  if (!open) {
    return (
      <div
        data-testid="mcp-status-bar"
        className="flex items-center gap-1 border-t border-card-border px-2 py-1 text-ui-xs"
      >
        <span className="text-foreground-subtle" data-testid="mcp-status-summary">
          {summary ? summary.summary : statusError ? `状态不可用：${statusError}` : "MCP 状态查询中…"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 enabled:cursor-pointer"
          data-testid="mcp-expand"
          onClick={() => onToggleOpen(true)}
        >
          管理 ▾
        </Button>
      </div>
    );
  }

  return (
    <div
      data-testid="mcp-settings-panel"
      className="shrink-0 border-b border-card-border bg-card text-ui-xs"
    >
      <div className="flex items-center gap-1 px-2 py-1">
        <span>MCP 设置</span>
        {summary ? (
          <span className="text-foreground-subtle" data-testid="mcp-status-summary">
            {summary.summary}
          </span>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-2 enabled:cursor-pointer"
          onClick={() => void refreshStatus()}
        >
          刷新状态
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="ml-auto h-6 px-2 enabled:cursor-pointer"
          onClick={onClose ?? (() => onToggleOpen(false))}
        >
          收起
        </Button>
      </div>

      {writeBack ? (
        <div className="px-3 pb-1 text-warning" data-testid="mcp-writeback-hint">
          {writeBack}
        </div>
      ) : null}
      {error ? (
        <div className="px-3 pb-1 text-foreground-subtle" data-testid="mcp-settings-errors">
          {error}
        </div>
      ) : null}
      <div className="px-3 pb-1 text-warning" data-testid="mcp-rebuild-hint">
        {MCP_SESSION_REBUILD_HINT}
      </div>

      {/* mcp/list 状态（P1-8.2） */}
      {statusError ? (
        <div className="px-3 pb-1 text-foreground-subtle">状态查询失败：{statusError}</div>
      ) : null}
      {statusLoading && statuses === null ? (
        <div className="px-3 pb-1 text-foreground-subtle">查询运行状态中…</div>
      ) : null}
      {statuses !== null && Object.keys(statuses).length === 0 ? (
        <div className="px-3 pb-1 text-foreground-subtle">当前无 MCP 服务器状态</div>
      ) : null}
      <ul className="px-3 pb-1">
        {Object.entries(statuses ?? {}).map(([name, snapshot]) => (
          <li key={name} data-testid="mcp-status-row">
            {name}：{statusLabel(snapshot)}
          </li>
        ))}
      </ul>

      {/* servers CRUD（P1-8.1） */}
      {servers === null ? (
        <div className="px-3 pb-1 text-foreground-subtle">读取设置中…</div>
      ) : (
        <div className="px-3 pb-1">
          {servers.map((server, index) => (
            <div key={index} className="mb-1 flex items-center gap-1">
              <Input
                value={server.name}
                placeholder="名称"
                className="h-6 w-32 text-ui-xs"
                onChange={(event) =>
                  setServers(updateServerAt(servers, index, { name: event.target.value }))
                }
              />
              <Select
                value={server.transport}
                onValueChange={(value) =>
                  setServers(
                    updateServerAt(servers, index, {
                      transport: value as EditableMcpServer["transport"],
                    }),
                  )
                }
              >
                <SelectTrigger className="h-6 w-20 text-ui-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stdio">stdio</SelectItem>
                  <SelectItem value="http">http</SelectItem>
                  <SelectItem value="sse">sse</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={server.commandOrUrl}
                placeholder={server.transport === "stdio" ? "命令" : "URL"}
                className="h-6 min-w-0 flex-1 text-ui-xs"
                onChange={(event) =>
                  setServers(
                    updateServerAt(servers, index, { commandOrUrl: event.target.value }),
                  )
                }
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 enabled:cursor-pointer"
                onClick={() => setServers(removeServerAt(servers, index))}
              >
                删除
              </Button>
            </div>
          ))}
          <div className="flex gap-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 enabled:cursor-pointer"
              onClick={() => setServers(appendServer(servers))}
            >
              添加服务器
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 enabled:cursor-pointer"
              onClick={() => void handleSaveServers()}
            >
              保存 MCP 配置
            </Button>
          </div>
        </div>
      )}

      {/* 权限规则编辑（P1-3） */}
      {allowlist !== null && denylist !== null ? (
        <div className="px-3 pb-2">
          <RuleEditor
            label="allowlist 规则（每行一条，Tool 或 Tool(args)）"
            rules={allowlist}
            onChange={setAllowlist}
            onSave={() => void handleSaveRules("allowlist", allowlist)}
          />
          <RuleEditor
            label="denylist 规则（每行一条）"
            rules={denylist}
            onChange={setDenylist}
            onSave={() => void handleSaveRules("denylist", denylist)}
          />
        </div>
      ) : null}

      {/* 「本次会话允许」写回（P0-8 面板侧持久化入口；审批卡自身应答走 CLI） */}
      {sessionId !== null && visiblePermissions.length > 0 ? (
        <div className="px-3 pb-2" data-testid="session-allowlist-section">
          <div className="text-foreground-subtle">待写回的「本次会话允许」（写回 workspace 设置）：</div>
          {visiblePermissions.map((item) => (
            <div key={item.interactionId} className="flex items-center gap-1">
              <span className="min-w-0 flex-1 truncate" title={item.summary}>
                {item.allowlistRule}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 enabled:cursor-pointer"
                onClick={() => void handleWriteBackSessionAllow(item)}
              >
                写入允许规则
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RuleEditor(params: {
  label: string;
  rules: string[];
  onChange: (rules: string[]) => void;
  onSave: () => void;
}) {
  return (
    <div className="mb-1">
      <div className="text-foreground-subtle">{params.label}</div>
      <textarea
        className="h-16 w-full rounded border border-card-border bg-background p-1 font-mono text-ui-xs"
        value={params.rules.join("\n")}
        onChange={(event) =>
          params.onChange(
            event.target.value
              .split("\n")
              .map((line) => line.trim())
              .filter(Boolean),
          )
        }
      />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-6 px-2 enabled:cursor-pointer"
        onClick={params.onSave}
      >
        保存规则
      </Button>
    </div>
  );
}
