/**
 * header/sessionCommandPort.tsx — 顶栏面板的共享 v4 会话数据面（T10）。
 *
 * 面板（modelSelect/usage/subagents）与对话区共享同一条 workspace connection：
 * 经 @zcode/ui 的 workspaceConnectionRegistry（acquireWorkspaceConnection，refCount +
 * 30s keep-warm）+ V4PaneConversationProvider 挂树后 useV4Conversation 拿 layer/
 * sendCommand，per-session 投影经 layer.acquire(store) 读 snapshot（revision/model/
 * phase/usage）。
 *
 * CAS 命令纪律（command.ts:259-267,326-342）：
 * - switchModelConfig / switchCollaborationMode ∈ COMMANDS_REQUIRING_BASE_REVISION：
 *   信封必带 baseRevision = 当前投影 revision（信封经 ui commandFactory 构造，缺省就地抛）；
 * - compact ∉ CAS（command.ts:165-167）：idle 立即执行、busy/held 入 FIFO，
 *   **不携带 baseRevision**（见 header/compactAction.ts）。
 */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import {
  V4PaneConversationProvider,
  useV4Conversation,
} from "@/v4/V4ConversationContext.js";
import { useConversationProjection } from "@/v4/useConversationProjection.js";
import type { SessionLease } from "@/v4/sessionDataLayer.js";

/** pane scope（本地 workspace，无 remoteSessionId/workspaceIdentity）。 */
export interface SessionScope {
  workspacePath: string;
}

/** 顶栏面板的树包装：接入与对话区同一条共享连接（registry 复用，不另建 transport）。 */
export function SessionCommandScope({
  workspacePath,
  children,
}: SessionScope & { children: ReactNode }) {
  return (
    <V4PaneConversationProvider scope={{ workspacePath }}>{children}</V4PaneConversationProvider>
  );
}

/** 租用当前会话的投影 store（mount 即订阅，unmount 释放；与 SubagentDrilldown 同模式）。 */
export function useSessionLease(sessionId: string | null): SessionLease | null {
  const { layer } = useV4Conversation();
  const [lease, setLease] = useState<SessionLease | null>(null);
  useEffect(() => {
    if (!sessionId) {
      setLease(null);
      return;
    }
    const nextLease = layer.acquire(sessionId);
    setLease(nextLease);
    return () => nextLease.release();
  }, [layer, sessionId]);
  return lease;
}

/** 当前会话投影（草稿态返回 null snapshot）。 */
export function useSessionSnapshot(sessionId: string | null): ConversationSnapshot | null {
  const lease = useSessionLease(sessionId);
  const state = useConversationProjection(lease);
  return state.snapshot;
}

export interface SwitchCommandResult {
  ok: boolean;
  /** rejected/stale 的用户可读面（stale → 提示重试，CAS baseRevision 落后）。 */
  message: string;
}

/**
 * v4 命令发送面：CAS 命令（switchModelConfig/switchCollaborationMode）自动携带
 * baseRevision = 发送瞬间的投影 revision（SessionPane dispatchCommand 同纪律）；
 * ACK 非 accepted/duplicate/noop 时返回失败文案。UI 回滚以 snapshot 投影为准
 * （权威状态随 revision 跳变/resync 收敛，P1-11.2 失败回滚）。
 */
export function useSessionCommandDispatcher(sessionId: string | null) {
  const { sendCommand } = useV4Conversation();
  const snapshot = useSessionSnapshot(sessionId);
  return useCallback(
    async (
      type: "switchModelConfig" | "switchCollaborationMode",
      payload: Record<string, string>,
    ): Promise<SwitchCommandResult> => {
      if (!sessionId) return { ok: false, message: "草稿会话暂不支持切换（先发送首条消息）" };
      if (!snapshot) return { ok: false, message: "会话投影未就绪" };
      // CAS：baseRevision 必须取发送瞬间的投影 revision；createCommandEnvelope 对
      // CAS 命令缺 baseRevision 直接抛（客户端编程错误就地暴露）。
      const envelope = createCommandEnvelope({
        type,
        payload: payload as never,
        sessionId,
        baseRevision: snapshot.revision,
      });
      const ack = await sendCommand(envelope, { projectId: null });
      if (ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop") {
        return { ok: true, message: "" };
      }
      if (ack.status === "stale") {
        return { ok: false, message: "会话已更新（revision 变化），请重试" };
      }
      return {
        ok: false,
        message: `切换被拒绝：${ack.reasonCode ?? ack.status}${ack.message ? `（${ack.message}）` : ""}`,
      };
    },
    [sendCommand, sessionId, snapshot],
  );
}
