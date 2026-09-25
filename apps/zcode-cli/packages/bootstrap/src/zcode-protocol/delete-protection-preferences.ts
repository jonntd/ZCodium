import { zcodeWorkspaceUpdateDeleteProtectionPreferencesParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 删除保护/批量删除审批（docs/spec/delete-protection.md §3）：
 * 进程级缓存供未来 session 继承，并立即应用到已有 session，避免新旧任务行为分裂。
 */
export async function updateDeleteProtectionPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(
    zcodeWorkspaceUpdateDeleteProtectionPreferencesParamsSchema,
    rawParams,
  );
  const preferences = params.preferences;
  context.appRuntimePreferences.deleteProtectionEnabled = preferences.deleteProtectionEnabled;
  context.appRuntimePreferences.batchDeleteApprovalThreshold =
    preferences.batchDeleteApprovalThreshold;

  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    if (!record.app.updateDeleteProtection) continue;
    record.app.updateDeleteProtection(preferences);
    updatedSessionCount += 1;
  }

  return {
    workspace: params.workspace,
    deleteProtectionEnabled: preferences.deleteProtectionEnabled,
    batchDeleteApprovalThreshold: preferences.batchDeleteApprovalThreshold,
    updatedSessionCount,
  };
}
