// 继续按钮（patcher-parity spec §4）的纯决策逻辑：填入文案的拼接、与 submit()
// 对齐的可用门禁、以及发送被拒绝时是否回滚合成文案。无宿主依赖，可单测。
import type { ConversationComposerSendResult } from "@/v4/ConversationComposer.js";

/** 按钮填入的「继续」与当前草稿的拼接规则：已有草稿按单个空格追加，不丢原文。 */
export function buildComposerContinueText(
  currentDraft: string,
  continueText: string,
): string {
  const draft = currentDraft.trim();
  return draft ? `${draft} ${continueText}` : continueText;
}

export interface ComposerContinueGateInput {
  disabled: boolean;
  /** composer 自身有提交在途（pending）；busy/running 不在其列——生成中排队正是该按钮的用途。 */
  pending: boolean;
  /** 与发送键同一路由门禁（权限锁定等 reject 态）。 */
  routingAllowsSend: boolean;
  /** Submission 配置就绪（模型/模式已冻结）。 */
  submissionReady: boolean;
  /** 附件全部就绪；存在未就绪附件时 submit() 会在填入后静默拒绝。 */
  attachmentsReady: boolean;
}

/**
 * 继续按钮的启用条件 = 发送键 `canSend` 去掉「有草稿可发」一项——「继续」文案由
 * 按钮自身提供，其余门禁必须与 submit() 的准入完全一致。
 *
 * Bugfix：按钮此前只判 `disabled`。submit() 对 `pending` / `submissionReady` /
 * `attachmentsReady` / 路由拒绝的早期 return 会把已经填入的「继续」连同草稿
 * store 一起留在输入框：点击没有任何发送效果，却留下无人输入过的文案
 * （典型触发：ACK 未回就连点按钮、模型选择未就绪、附件上传未完成）。
 */
export function canComposerContinueSend(input: ComposerContinueGateInput): boolean {
  return (
    !input.disabled &&
    !input.pending &&
    input.routingAllowsSend &&
    input.submissionReady &&
    input.attachmentsReady
  );
}

/** submit() 的结果；`rejected` 覆盖准入前的早期 return 与未捕获异常。 */
export type ComposerSubmitOutcome =
  | ConversationComposerSendResult
  | "rejected"
  | "failed";

/**
 * 非 `sent` 时是否把「继续」回滚到点击前的正文。
 *
 * 「继续」是按钮合成的动作文案，不是用户草稿：发送被拒绝或失败时若原地保留，
 * 输入框和持久化草稿都会残留它，下次进入会话还会被恢复。`confirmationRequired`
 * 是唯一例外——队列确认框的两个按钮基于已填入的正文重新 submit，此时回滚会
 * 让确认动作提交空文本。
 */
export function shouldRollbackComposerContinueDraft(
  outcome: ComposerSubmitOutcome | undefined,
): boolean {
  return outcome !== undefined && outcome !== "sent" && outcome !== "confirmationRequired";
}
