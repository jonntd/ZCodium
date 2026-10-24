import assert from "node:assert/strict";
import test from "node:test";
import {
  buildComposerContinueText,
  canComposerContinueSend,
  shouldRollbackComposerContinueDraft,
} from "../src/v4/composer/composerContinueAction.js";

// 继续按钮（docs/spec/patcher-parity.md §4）的纯决策逻辑。

test("空草稿 / 纯空白草稿只填入「继续」", () => {
  assert.equal(buildComposerContinueText("", "继续"), "继续");
  assert.equal(buildComposerContinueText("   \n ", "继续"), "继续");
});

test("已有草稿按单个空格追加，不丢原文也不重复空格", () => {
  assert.equal(buildComposerContinueText("改一下登录页", "继续"), "改一下登录页 继续");
  assert.equal(buildComposerContinueText("改一下登录页 ", "继续"), "改一下登录页 继续");
  assert.equal(buildComposerContinueText("改一下登录页\n", "继续"), "改一下登录页 继续");
});

test("启用门禁与 submit() 准入一致：空草稿不是禁用理由", () => {
  // 生成中点「继续」：无草稿可发（hasDraftToSubmit=false）但必须可点，
  // 否则该按钮在唯一典型场景下永远 disabled。
  assert.equal(
    canComposerContinueSend({
      disabled: false,
      pending: false,
      routingAllowsSend: true,
      submissionReady: true,
      attachmentsReady: true,
    }),
    true,
  );
});

test("禁用态：disabled / 在途提交 / Submission 未就绪 / 附件未就绪 / 路由拒绝", () => {
  const base = {
    disabled: false,
    pending: false,
    routingAllowsSend: true,
    submissionReady: true,
    attachmentsReady: true,
  };
  // ACK 未回就连点：submit() 对 pendingRef 早期 return，填入即残留（回归用例）。
  assert.equal(canComposerContinueSend({ ...base, pending: true }), false);
  assert.equal(canComposerContinueSend({ ...base, disabled: true }), false);
  assert.equal(canComposerContinueSend({ ...base, submissionReady: false }), false);
  assert.equal(canComposerContinueSend({ ...base, attachmentsReady: false }), false);
  assert.equal(canComposerContinueSend({ ...base, routingAllowsSend: false }), false);
});

test("busy/running 不在门禁内：生成中排队正是该按钮的用途", () => {
  // 门禁入参没有会话 busy 项（canStop 只影响发送/停止键切换）；唯一的负项是
  // composer 自身 pending——与 submit() 的 pendingRef 守卫一一对应。
  const base = {
    disabled: false,
    pending: false,
    routingAllowsSend: true,
    submissionReady: true,
    attachmentsReady: true,
  };
  assert.equal(canComposerContinueSend(base), true);
});

test("回滚判定：仅 sent 与 confirmationRequired 保留合成文案", () => {
  assert.equal(shouldRollbackComposerContinueDraft("sent"), false);
  // 队列确认框基于已填入正文重新 submit，回滚会让确认动作提交空文本。
  assert.equal(shouldRollbackComposerContinueDraft("confirmationRequired"), false);
  assert.equal(shouldRollbackComposerContinueDraft("blocked"), true);
  // submit() 准入前的早期 return（rejected）与未捕获异常（failed）同样必须回滚。
  assert.equal(shouldRollbackComposerContinueDraft("rejected"), true);
  assert.equal(shouldRollbackComposerContinueDraft("failed"), true);
  // 无结果（未知）时不改动编辑器，避免误吃用户等待期间新输入的正文。
  assert.equal(shouldRollbackComposerContinueDraft(undefined), false);
});
