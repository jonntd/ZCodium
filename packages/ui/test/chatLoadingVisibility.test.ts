import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldShowTimelineWorkingPillChip,
  shouldShowTurnChatLoadingWithRunningPill,
} from "../src/v4/chatLoadingVisibility.js";
import {
  CONVERSATION_WORKING_STATUS_PILL_ELAPSED_MESSAGE_ID,
  CONVERSATION_WORKING_STATUS_PILL_STATUS_MESSAGE_ID,
  CONVERSATION_WORKING_STATUS_PILL_STICKY_CLASS,
  buildConversationWorkingStatusPillModel,
  resolveAssistantHistoryStatusStickyClass,
} from "../src/v4/conversationWorkingStatusPillModel.js";

// 运行中工作状态胶囊（docs/spec/assistant-working-status-pill.md §4）：
// 胶囊承载「工作中 + 用时」后，尾部裸 ChatLoading 只在胶囊缺席时兜底；
// 胶囊自身的模型负责 i18n id 与「时长缺失不渲染用时段」的边界；
// 离屏兜底规则（胶囊被长对话顶出视口时的贴底按钮）也在同一条可见性边界内。
test("运行中胶囊可见时抑制尾部 ChatLoading，避免双状态", () => {
  assert.equal(
    shouldShowTurnChatLoadingWithRunningPill({
      showLoading: true,
      hasRunningWorkSegment: true,
    }),
    false,
  );
});

test("无运行中 segment（timelineOnly、后台流、未建轮）时 ChatLoading 兜底照旧", () => {
  assert.equal(
    shouldShowTurnChatLoadingWithRunningPill({
      showLoading: true,
      hasRunningWorkSegment: false,
    }),
    true,
  );
  assert.equal(
    shouldShowTurnChatLoadingWithRunningPill({
      showLoading: false,
      hasRunningWorkSegment: false,
    }),
    false,
  );
  assert.equal(
    shouldShowTurnChatLoadingWithRunningPill({
      showLoading: false,
      hasRunningWorkSegment: true,
    }),
    false,
  );
});

test("胶囊模型：有时长渲染用时段，缺失时只保留状态词", () => {
  const withDuration = buildConversationWorkingStatusPillModel({
    durationLabel: "1 分 5 秒",
  });
  assert.equal(withDuration.statusMessageId, CONVERSATION_WORKING_STATUS_PILL_STATUS_MESSAGE_ID);
  assert.equal(withDuration.elapsedMessageId, CONVERSATION_WORKING_STATUS_PILL_ELAPSED_MESSAGE_ID);

  const withoutDuration = buildConversationWorkingStatusPillModel({
    durationLabel: null,
  });
  assert.equal(withoutDuration.statusMessageId, CONVERSATION_WORKING_STATUS_PILL_STATUS_MESSAGE_ID);
  assert.equal(withoutDuration.elapsedMessageId, null);
});

// 离屏兜底（docs/spec/assistant-working-status-pill.md「离屏兜底」）：胶囊行吸顶后，
// 本轮内任意滚动位置都能看到「工作中 + 用时」；只有本轮整体滚出视口时，才在 dock 上方
// 补一枚入口。判据是胶囊本体的可见性（IntersectionObserver），不是滚动距离。

test("离底 + 会话运行中 + 胶囊已滚出视口 → 贴底兜底按钮出现", () => {
  assert.equal(
    shouldShowTimelineWorkingPillChip({
      showLoading: true,
      backToBottomVisible: true,
      workingPillInViewport: false,
    }),
    true,
  );
});

test("吸顶胶囊仍在视口内 → 不重复渲染兜底", () => {
  // 回归：吸顶后用户在「本轮内部」上滚时胶囊仍贴在顶部可见，
  // 此时再显示 dock 上方按钮就会出现两个同义状态控件。
  assert.equal(
    shouldShowTimelineWorkingPillChip({
      showLoading: true,
      backToBottomVisible: true,
      workingPillInViewport: true,
    }),
    false,
  );
});

test("贴底 / 会话已终态 → 贴底兜底按钮缺席", () => {
  // 贴底时内容末端就在眼前，兜底按钮会说同一件事。
  assert.equal(
    shouldShowTimelineWorkingPillChip({
      showLoading: true,
      backToBottomVisible: false,
      workingPillInViewport: false,
    }),
    false,
  );
  // 会话已终态：没有「工作中」可表达，按钮不得滞留成多余控件。
  assert.equal(
    shouldShowTimelineWorkingPillChip({
      showLoading: false,
      backToBottomVisible: true,
      workingPillInViewport: false,
    }),
    false,
  );
});

// 吸顶规则：胶囊挂在本轮工作历史头部，工作行持续追加会把它向上顶出视口；
// 运行中吸顶才能保证「工作中 + 用时」在本轮内始终可见，完成/中断回归普通文档流。
test("运行中胶囊行吸顶，完成/中断与无状态不吸顶", () => {
  assert.equal(
    resolveAssistantHistoryStatusStickyClass("running"),
    CONVERSATION_WORKING_STATUS_PILL_STICKY_CLASS,
  );
  assert.equal(resolveAssistantHistoryStatusStickyClass("completed"), "");
  assert.equal(resolveAssistantHistoryStatusStickyClass("interrupted"), "");
  assert.equal(resolveAssistantHistoryStatusStickyClass(undefined), "");
});
