import { zcodeWorkspaceUpdateSystemPromptParamsSchema } from "@zcode/shared";
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
