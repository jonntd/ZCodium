/**
 * header/compactAction.ts — 压缩上下文动作（T10，P1-14）。
 *
 * 协议口径（zcode-protocol-v4/command.ts:165-167）：
 * 「compact 是输入型维护命令：idle 时立即执行，busy/held 时进入 FIFO。因为 admission
 * 与当前 revision 无关，不走 CAS；sourceCommandId 提供幂等边界。」
 * → 信封 **不携带 baseRevision**（与 switchModelConfig/switchCollaborationMode 的
 * CAS 纪律相对）；busy 侧的入队语义由 CLI admission 承担，客户端零分支。
 *
 * 纯函数模块：vitest 直测（test/switchCommands.test.ts）。
 */

import { createCommandEnvelope } from "@/v4/commandFactory.js";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

/** compact 信封（sessionId 可为 null——草稿态无压缩面，调用方先 gate）。 */
export function buildCompactEnvelope(sessionId: string): CommandEnvelope {
  // 不带 baseRevision：compact 非 CAS（带上了反而违背协议纪律，见文件头）。
  return createCommandEnvelope({
    type: "compact",
    payload: {},
    sessionId,
  });
}

export interface CompactActionOutcome {
  ok: boolean;
  /** 用户可读面：执行中 / 已入队 / 被拒绝原因。 */
  message: string;
  /** busy 入队（FIFO）与 idle 立即执行在 ACK 上同 accepted，客户端不区分。 */
  queued: boolean;
}

/** ACK → 用户面：accepted/noop = 已受理（idle 立即执行或 busy 入队）；其余给拒绝原因。 */
export function interpretCompactAck(ack: CommandAck): CompactActionOutcome {
  if (ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop") {
    return { ok: true, message: "压缩已受理（空闲时立即执行，执行中则排队）", queued: true };
  }
  if (ack.reasonCode === "compactOperationLock") {
    return { ok: false, message: "已有压缩在进行，请等待完成", queued: false };
  }
  if (ack.reasonCode === "activeTurn") {
    return { ok: false, message: "当前 turn 执行中，此 CLI 版本不支持排队压缩", queued: false };
  }
  return {
    ok: false,
    message: `压缩被拒绝：${ack.reasonCode ?? ack.status}${ack.message ? `（${ack.message}）` : ""}`,
    queued: false,
  };
}

/** compact 可用性（snapshot.availability.compact 的面板投影；缺席视为可用，交由 CLI 裁决）。 */
export function isCompactAllowed(snapshot: {
  availability?: { compact?: { allowed: boolean; reasonCode?: string } } | null;
} | null | undefined): boolean {
  const availability = snapshot?.availability?.compact;
  if (!availability) return true;
  return availability.allowed;
}
