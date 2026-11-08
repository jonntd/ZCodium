/**
 * applyFileRewind 的 v4 命令信封构造（headless）。
 *
 * applyFileRewind 是 CAS 命令（COMMANDS_REQUIRING_BASE_REVISION，command.ts:326）：
 * 信封必带 baseRevision + baseLogEpoch，由 ChangesTracker 从帧流水位提供。
 * 宿主与 webview 是两个独立 clientId（服务端幂等表按 clientId 区分提交端），
 * 宿主侧 clientId 由容器持久化注入，不在本文件存储。
 */

import { COMMANDS_REQUIRING_BASE_REVISION, type CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { uuidv7 } from "@zcode/shared";

export interface ApplyFileRewindEnvelopeInput {
  sessionId: string;
  target: { rowId: number; entityId: string };
  /** artifact 原始路径（rawPath）；缺席 = 整轮撤销。 */
  paths?: readonly string[];
  baseRevision: number | undefined;
  baseLogEpoch: string | undefined;
  clientId: string;
  /** 注入时钟（测试确定性）；生产传 Date.now()。 */
  now: number;
}

export function buildApplyFileRewindEnvelope(
  input: ApplyFileRewindEnvelopeInput,
): CommandEnvelope {
  // CAS 命令缺水位 = 帧流尚未就绪，调用方（service）应先等待快照；这里 fail-fast。
  if (COMMANDS_REQUIRING_BASE_REVISION.has("applyFileRewind")) {
    if (input.baseRevision === undefined || !input.baseLogEpoch) {
      throw new Error("applyFileRewind 需要 baseRevision/baseLogEpoch（帧流未就绪）");
    }
  }
  return {
    commandId: uuidv7(input.now),
    clientId: input.clientId,
    sessionId: input.sessionId,
    baseRevision: input.baseRevision,
    baseLogEpoch: input.baseLogEpoch,
    type: "applyFileRewind",
    payload: input.paths?.length
      ? { target: input.target, paths: [...input.paths] }
      : { target: input.target },
    issuedAt: input.now,
  };
}
