import assert from "node:assert/strict";
import test from "node:test";
import { shouldShowTurnChatLoadingWithRunningPill } from "../src/v4/chatLoadingVisibility.js";
import {
  CONVERSATION_WORKING_STATUS_PILL_ELAPSED_MESSAGE_ID,
  CONVERSATION_WORKING_STATUS_PILL_STATUS_MESSAGE_ID,
  buildConversationWorkingStatusPillModel,
} from "../src/v4/conversationWorkingStatusPillModel.js";

// 运行中工作状态胶囊（docs/spec/assistant-working-status-pill.md §4）：
// 胶囊承载「工作中 + 用时」后，尾部裸 ChatLoading 只在胶囊缺席时兜底；
// 胶囊自身的模型负责 i18n id 与「时长缺失不渲染用时段」的边界。

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
