import { zcodeWorkspaceUpdateLanguagePreferenceParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 回复语言（docs/spec/response-language.md）：声明模型回复的首选语言。
 * 空串/空白 = 跟随用户消息（undefined，不注入提示）。
 * 与删除保护/分段系统提示词同构：进程级缓存供 inherit 源会话兜底继承，并立即应用到
 * 已有 session；新建会话的权威来源是 session runtime preferences 反向请求。
 */
export async function updateLanguagePreference(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateLanguagePreferenceParamsSchema, rawParams);
  // host 层保留原文，这里统一 trim；空白串与空串一样视为"跟随用户消息"（undefined），
  // 否则缓存里会留下一个永远不生效的语言声明。
  const normalized = params.language.trim();
  context.appRuntimePreferences.language = normalized || undefined;

  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    if (!record.app.updateLanguage) continue;
    record.app.updateLanguage(normalized || undefined);
    record.language = normalized || undefined;
    updatedSessionCount += 1;
  }

  return {
    workspace: params.workspace,
    // 回显归一化值：空串表示已回到"跟随用户消息"，host 不需要重复实现 trim 规则。
    language: normalized,
    updatedSessionCount,
  };
}
