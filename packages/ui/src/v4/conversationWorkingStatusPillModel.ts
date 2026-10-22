/**
 * 运行中工作状态胶囊的纯模型（docs/spec/assistant-working-status-pill.md）。
 * 胶囊是 workStatus 的呈现层：运行判定与耗时仍由 buildConversationTurnWorkSegments
 * 推导，这里只约定哪些段参与渲染，不持有任何计时状态。
 */

import type { ConversationTurnWorkStatus } from "@/v4/conversationTurnWorkSegments.js";

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

/**
 * 运行中胶囊行的吸顶类。胶囊挂在运行轮 work history 头部，本轮工作行随工具调用持续
 * 增长，会把「工作中 + 用时」不断向上顶出视口——只靠离屏兜底按钮覆盖不到「贴底跟随」
 * 这条主路径。吸顶让状态在本轮内始终可见，本轮结束（回归纯文本）即释放。
 * 不透明底色是必需的：工作行会从吸附行下方滚过，透明会让两段文字叠在一起。
 */
export const CONVERSATION_WORKING_STATUS_PILL_STICKY_CLASS = "sticky top-0 z-10 bg-background";

export function resolveAssistantHistoryStatusStickyClass(
  state: ConversationTurnWorkStatus["state"] | undefined,
): string {
  return state === "running" ? CONVERSATION_WORKING_STATUS_PILL_STICKY_CLASS : "";
}
