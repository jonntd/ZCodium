/**
 * 对话数据层接线（T05）。
 *
 * 复用 ui 包现成 `createAgentConversationTransport(IZCodeAgentService, {workspacePath})`
 * ——agentService 是经桥 RPC 的服务代理（createMessagePortServiceConnection(port).services
 * 的 zcodeAgentService），workspacePath 来自 chatPanel 注入的初始帧。
 * 数据层不感知 VS Code 细节：流式帧/审批卡/时间线全部由 ui 包组件族消费。
 */

import type { IZCodeAgentService } from "@zcode/services";
import { createAgentConversationTransport } from "@/v4/agentConversationTransport.js";
import type { ConversationTransport } from "@/v4/transport.js";

export interface ConversationTransportTarget {
  workspacePath: string;
  workspaceIdentity?: string;
}

/**
 * 构造一条 workspace 的 v4 对话传输面（每 workspace 一条，UI 侧按需缓存）。
 * ui 的 useWorkspaceServices 已按 workspaceKey 复用连接；这里只做装配入口收口，
 * 便于 vitest 用 fake agent service 直测全链路（test/integration.hostUi.test.ts）。
 */
export function createConversationTransport(
  agentService: IZCodeAgentService,
  target: ConversationTransportTarget,
): ConversationTransport {
  return createAgentConversationTransport(agentService, {
    workspacePath: target.workspacePath,
    ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
  });
}
