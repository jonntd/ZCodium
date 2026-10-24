import type {
  ActiveWorkSummary,
  ConversationRow,
  PendingInteraction,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 等待用户操作时，弹窗/问答卡已经是唯一进度反馈，不能再显示 loading。
 * 这里只识别权限确认与 AskUserQuestion；ExitPlanMode 等其它 userInput 语义保持独立。
 * 软门禁后 workspaceHookReview 不再阻塞聊天。
 */
export function hasChatLoadingBlockingInteraction(
  interactions: readonly PendingInteraction[],
): boolean {
  return interactions.some(
    (interaction) =>
      interaction.payload.kind === "permission" ||
      (interaction.payload.kind === "userInput" &&
        interaction.payload.toolName === "AskUserQuestion"),
  );
}

export function hasChatLoadingBlockingActiveWork(
  activeWorks: readonly ActiveWorkSummary[],
): boolean {
  return activeWorks.some((work) => work.kind === "compact" || work.kind === "goalVerifier");
}

function hasChatLoadingBlockingMaintenanceRow(rows: readonly ConversationRow[]): boolean {
  return rows.some(
    (row) =>
      row.kind === "timelineMarker" &&
      ((row.marker.type === "compact" && row.marker.status === "running") ||
        (row.marker.type === "goalVerify" && row.marker.outcome === "running")),
  );
}

export function shouldShowTurnChatLoading({
  blockedByActiveWork,
  blockedByInteraction,
  isLastTurn,
  isRunning,
  rows,
}: {
  blockedByActiveWork: boolean;
  blockedByInteraction: boolean;
  isLastTurn: boolean;
  isRunning: boolean;
  rows: readonly ConversationRow[];
}): boolean {
  if (!isLastTurn || !isRunning || blockedByActiveWork || blockedByInteraction) {
    return false;
  }

  // pendingInteractions / activeWorks 是权威事实源，但恢复或乱序窗口
  // 可能先只有行状态；行级 fallback 避免权限、compact、goal verifier 已出现时
  // 底部 loading 短暂闪回。
  return (
    !rows.some((row) => row.kind === "toolCall" && row.status === "pendingApproval") &&
    !hasChatLoadingBlockingMaintenanceRow(rows)
  );
}

/**
 * 运行中的「仍在工作」反馈已由状态胶囊承载（AssistantHistoryStatus → working pill，
 * docs/spec/assistant-working-status-pill.md），胶囊可见时尾部裸 ChatLoading 是重复状态。
 * apiRetry 状态有自己的显示阈值（第 3 次起），不经过这条规则，保持独立。
 */
export function shouldShowTurnChatLoadingWithRunningPill(options: {
  showLoading: boolean;
  hasRunningWorkSegment: boolean;
}): boolean {
  return options.showLoading && !options.hasRunningWorkSegment;
}

/**
 * 贴底兜底：胶囊挂在运行轮 work history 头部（消息层普通文档流），长对话里会被上方历史
 * 与持续增长的本轮工作行顶出视口。运行中胶囊行已改为 sticky 吸顶
 * （`resolveAssistantHistoryStatusStickyClass`），本轮内任意滚动位置都可见；因此这枚
 * dock 上方按钮只负责「本轮整体已滚出视口」这一种情况。
 *
 * `backToBottomVisible` 仍保留：贴底时内容末端就在眼前，不需要额外的回跳入口。
 * `workingPillInViewport` 由 IntersectionObserver 提供（不读滚动几何、不参与跟随判定），
 * 让吸顶胶囊可见时不再重复渲染同一状态控件。
 */
export function shouldShowTimelineWorkingPillChip(options: {
  showLoading: boolean;
  backToBottomVisible: boolean;
  workingPillInViewport: boolean;
}): boolean {
  return options.backToBottomVisible && options.showLoading && !options.workingPillInViewport;
}
