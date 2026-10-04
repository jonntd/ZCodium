/**
 * 运行中工作状态胶囊的纯模型（docs/spec/assistant-working-status-pill.md）。
 * 胶囊是 workStatus 的呈现层：运行判定与耗时仍由 buildConversationTurnWorkSegments
 * 推导，这里只约定哪些段参与渲染，不持有任何计时状态。
 */

export const CONVERSATION_WORKING_STATUS_PILL_STATUS_MESSAGE_ID =
  "chat.history.workingPill.status" as const;
export const CONVERSATION_WORKING_STATUS_PILL_ELAPSED_MESSAGE_ID =
  "chat.history.workingPill.elapsed" as const;

export interface ConversationWorkingStatusPillModel {
  statusMessageId: typeof CONVERSATION_WORKING_STATUS_PILL_STATUS_MESSAGE_ID;
  /** 时长文案缺失时整段不渲染，避免胶囊里出现空的「用时」。 */
  elapsedMessageId: typeof CONVERSATION_WORKING_STATUS_PILL_ELAPSED_MESSAGE_ID | null;
}

export function buildConversationWorkingStatusPillModel(input: {
  durationLabel: string | null;
}): ConversationWorkingStatusPillModel {
  return {
    statusMessageId: CONVERSATION_WORKING_STATUS_PILL_STATUS_MESSAGE_ID,
    elapsedMessageId: input.durationLabel
      ? CONVERSATION_WORKING_STATUS_PILL_ELAPSED_MESSAGE_ID
      : null,
  };
}
