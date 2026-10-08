import {
  normalizeCustomSystemSegments,
  zcodeWorkspaceUpdateSystemPromptParamsSchema,
  zcodeWorkspaceUpdateSystemSegmentsParamsSchema,
} from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 自定义系统提示词（docs/spec/custom-system-prompt.md）：整段替换会话的 stable 身份段并
 * 跳过动态 system 段（context builder 既有契约）。空串 = 恢复内置默认。
 * 与删除保护同构：进程级缓存供 inherit 源会话兜底继承，并立即应用到已有 session，
 * 避免新旧任务行为分裂；新建会话的权威来源是 session runtime preferences 反向请求。
 */
export async function updateSystemPromptPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateSystemPromptParamsSchema, rawParams);
  // host 层保留原文，这里统一 trim；空白串与空串一样视为"恢复默认"（undefined），
  // 否则缓存里会留下一段永远不生效的空白提示词。
  const normalized = params.systemPrompt.trim();
  context.appRuntimePreferences.customSystemPrompt = normalized || undefined;

  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    if (!record.app.updateSystemPrompt) continue;
    record.app.updateSystemPrompt(normalized || undefined);
    record.customSystemPrompt = normalized || undefined;
    updatedSessionCount += 1;
  }

  return {
    workspace: params.workspace,
    // 回显归一化值：空串表示已回到内置默认，host 不需要重复实现 trim 规则。
    systemPrompt: normalized,
    updatedSessionCount,
  };
}

/**
 * 分段系统提示词（docs/spec/custom-system-prompt.md v2）：三段常用段落各自
 * 继承/覆盖/追加/清空，两作用域（main / workflowSubagent）。
 *
 * 与 v1 的差异只在载荷形状：归一化在 handler 内做（剥离空文本 override/append、clear 去 text），
 * 之后写进程缓存 + 遍历活动 session 双写。**空对象 = 全部恢复继承**，是显式可传的合法值，
 * 因此不能像 customSystemPrompt 那样折叠成 undefined——它必须真的清掉旧值。
 */
export async function updateSystemSegmentsPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateSystemSegmentsParamsSchema, rawParams);
  const normalized = normalizeCustomSystemSegments(params.segments);
  // 空对象仍要写缓存（而非删除字段）：它表示「已全部恢复继承」，是 host 已知的状态，
  // 与「从未使用」（缺席）不同——新建 CLI client 需要拿到清空态才不会复用旧进程缓存。
  context.appRuntimePreferences.customSystemSegments = normalized;

  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    if (!record.app.updateSystemSegments) continue;
    record.app.updateSystemSegments(normalized);
    record.customSystemSegments = normalized;
    updatedSessionCount += 1;
  }

  return {
    workspace: params.workspace,
    // 回显归一化值：host 不需要重复实现剥离规则。
    segments: normalized,
    updatedSessionCount,
  };
}
