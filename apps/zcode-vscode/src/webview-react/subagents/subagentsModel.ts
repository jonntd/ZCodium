/**
 * subagents/subagentsModel.ts — 子代理面板的纯投影（T11，P1-15）。
 *
 * 数据面：
 * - 运行中：conversation snapshot.subagents（runningSubagentSummary：running/waiting/blocked
 *   三态 + endedTotal 目录数）；
 * - 已结束：IZCodeAgentService.listSessionSubagents（cursor query，agentService 侧转发
 *   session/subagents）；
 * - 子代理定义目录：subagents 频道（serviceAssembly.ts 白名单已暴露）。
 * 纯函数模块：vitest 直测（test/claudeImport.test.ts 附带投影断言）。
 */

/** runningSubagentSummary 的面板投影面。 */
export interface RunningSubagentRow {
  childSessionId: string;
  title: string;
  subagentType: string;
  status: "running" | "waiting" | "blocked";
}

/** 子代理状态展示文案（P1-15：running/waiting/blocked/ended）。 */
export function subagentStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "运行中";
    case "waiting":
      return "等待中";
    case "blocked":
      return "被阻塞";
    case "ended":
    case "success":
      return "已结束";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "lost":
      return "失联";
    default:
      return status;
  }
}

/** snapshot.subagents → 面板投影（旧快照缺字段 = 空投影）。 */
export function projectSubagentProjection(raw: unknown): {
  running: RunningSubagentRow[];
  endedTotal: number;
} {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const runningRaw = Array.isArray(record.running) ? record.running : [];
  const running = runningRaw
    .map((entry): RunningSubagentRow | null => {
      const item = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
      if (typeof item.childSessionId !== "string" || !item.childSessionId) return null;
      const status =
        item.status === "waiting" || item.status === "blocked" ? item.status : "running";
      return {
        childSessionId: item.childSessionId,
        title: typeof item.title === "string" && item.title ? item.title : item.childSessionId,
        subagentType: typeof item.subagentType === "string" ? item.subagentType : "",
        status,
      };
    })
    .filter((row): row is RunningSubagentRow => row !== null);
  return {
    running,
    endedTotal:
      typeof record.endedTotal === "number" && Number.isFinite(record.endedTotal)
        ? Math.max(0, Math.trunc(record.endedTotal))
        : 0,
  };
}

/** listSessionSubagents 结果（sessionSubagentsResult 投影面：仅取面板用到的行）。 */
export interface EndedSubagentRow {
  childSessionId?: string;
  sessionId: string;
  title: string;
  statusLabel: string;
}

/**
 * ended 查询结果的宽容投影：listSessionSubagents 的 result.ended.items（主键
 * childSessionId；终态 success/failed/cancelled/lost）+ 兼容扁平数组形状。
 * 标题/状态缺失时回退主键（UI 不崩，P1-15 列表语义保底）。
 */
export function projectEndedSubagents(raw: unknown): EndedSubagentRow[] {
  const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
  const ended = record.ended;
  const rows = Array.isArray(ended)
    ? ended
    : typeof ended === "object" && ended !== null && Array.isArray((ended as Record<string, unknown>).items)
      ? ((ended as Record<string, unknown>).items as unknown[])
      : Array.isArray(record.subagents)
        ? record.subagents
        : [];
  return rows
    .map((entry): EndedSubagentRow | null => {
      const item = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
      const sessionId =
        typeof item.childSessionId === "string" && item.childSessionId
          ? item.childSessionId
          : typeof item.sessionId === "string"
            ? item.sessionId
            : "";
      if (!sessionId) return null;
      return {
        ...(typeof item.childSessionId === "string" ? { childSessionId: item.childSessionId } : {}),
        sessionId,
        title:
          typeof item.title === "string" && item.title
            ? item.title
            : typeof item.agentId === "string" && item.agentId
              ? item.agentId
              : sessionId,
        statusLabel:
          typeof item.status === "string" ? subagentStatusLabel(item.status) : "已结束",
      };
    })
    .filter((row): row is EndedSubagentRow => row !== null);
}
