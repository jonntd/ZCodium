import {
  BUILTIN_MODEL_PROVIDER_IDS,
  isStartPlanModelProviderId,
  type UsageEntitlementSnapshot,
} from "@zcode/shared";
import type {
  GlmQuotaBannerBusinessCode,
  StartPlanConcurrentLimitBannerReason,
} from "@/lib/providerBusinessError.js";
import type { McpUnavailableNotice } from "@/v4/mcpUnavailableBannerNotice.js";

import {
  allBucketsExhausted,
  bucketMatchesModel,
  getActiveModelBuckets,
} from "@/v4/startPlanQuotaBuckets.js";

export type SessionQuotaBannerKind =
  | "model-exhausted"
  | "daily-exhausted"
  | "concurrent-limit"
  | "provider-limited"
  | "mcp-quota-exhausted"
  | "mcp-plan-required";

export interface SessionQuotaBannerState {
  visible: boolean;
  kind: SessionQuotaBannerKind | null;
  concurrentLimitBusinessCode: "3008" | "3009" | "3010" | null;
  concurrentLimitReason: StartPlanConcurrentLimitBannerReason | null;
  providerLimitedBusinessCode: GlmQuotaBannerBusinessCode | null;
  providerLimitedMessage: string | null;
  modelName: string | null;
  /** 官方 Server MCP 提示专用：出问题的 MCP server 名，用于文案点名。 */
  mcpServerName: string | null;
  /** 官方 Server MCP 提示专用：产生该事实的 tool row，参与去重键。 */
  mcpNoticeRowId: number | null;
  remainingTokens: number | null;
  remainingPercent: number | null;
  dismissible: boolean;
  blocksSubmit: boolean;
  priority: number;
}

const HIDDEN_SESSION_QUOTA_BANNER_STATE: SessionQuotaBannerState = {
  visible: false,
  kind: null,
  concurrentLimitBusinessCode: null,
  concurrentLimitReason: null,
  providerLimitedBusinessCode: null,
  providerLimitedMessage: null,
  modelName: null,
  mcpServerName: null,
  mcpNoticeRowId: null,
  remainingTokens: null,
  remainingPercent: null,
  dismissible: false,
  blocksSubmit: false,
  priority: 0,
};

function isGlmQuotaBannerProviderId(providerId: string): boolean {
  return (
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    providerId === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

function normalizeProviderLimitedBannerMessage(message: string | null | undefined): string | null {
  const normalizedMessage = message?.trim();
  if (!normalizedMessage) return null;
  const bracketParts = [...normalizedMessage.matchAll(/\[([^\]]*)\]/gu)].map(
    (match) => match[1]?.trim() ?? "",
  );
  return bracketParts.length >= 3 && bracketParts[1] ? bracketParts[1] : normalizedMessage;
}

/**
 * 额度业务错误保持原优先级；Start Plan 耗尽按全部有效桶判断。
 *
 * 旧版「剩余 ≤10% 弹 model-very-low 升级提醒」已按 zcode-patcher「去额度骚扰横幅」
 * 的语义整体移除：低余额不属于需要行动的阻断状态，仅在剩一半时就开始催升级。
 * 额度耗尽（model-exhausted / daily-exhausted）、并发受限、供应商受限与 MCP
 * 通知等真实故障提示全部保留。
 */
export function buildSessionQuotaBannerState(params: {
  activeProviderId: string | null;
  snapshot: UsageEntitlementSnapshot | null;
  modelId: string | null;
  serverQuotaExhausted?: boolean;
  serverConcurrentLimited?: boolean;
  serverConcurrentLimitBusinessCode?: "3008" | "3009" | "3010";
  serverConcurrentLimitReason?: StartPlanConcurrentLimitBannerReason;
  serverProviderLimitedBusinessCode?: GlmQuotaBannerBusinessCode;
  serverProviderLimitedMessage?: string | null;
  /** 官方 Server MCP 在本次会话内被判定不可用的事实（来自 tool row 的结构化标识）。 */
  mcpUnavailableNotice?: McpUnavailableNotice | null;
}): SessionQuotaBannerState {
  if (
    params.serverConcurrentLimited === true &&
    params.activeProviderId &&
    isStartPlanModelProviderId(params.activeProviderId)
  ) {
    return {
      visible: true,
      kind: "concurrent-limit",
      concurrentLimitBusinessCode: params.serverConcurrentLimitBusinessCode ?? null,
      concurrentLimitReason: params.serverConcurrentLimitReason ?? "initial-busy",
      providerLimitedBusinessCode: null,
      providerLimitedMessage: null,
      modelName: params.modelId,
      mcpServerName: null,
      mcpNoticeRowId: null,
      remainingTokens: null,
      remainingPercent: null,
      dismissible: true,
      blocksSubmit: false,
      priority: 60,
    };
  }

  if (
    params.serverQuotaExhausted === true &&
    params.activeProviderId &&
    isStartPlanModelProviderId(params.activeProviderId)
  ) {
    return {
      visible: true,
      kind: "daily-exhausted",
      concurrentLimitBusinessCode: null,
      concurrentLimitReason: null,
      providerLimitedBusinessCode: null,
      providerLimitedMessage: null,
      modelName: null,
      mcpServerName: null,
      mcpNoticeRowId: null,
      remainingTokens: null,
      remainingPercent: 0,
      dismissible: false,
      blocksSubmit: false,
      priority: 50,
    };
  }

  if (
    params.serverProviderLimitedBusinessCode &&
    params.activeProviderId &&
    isGlmQuotaBannerProviderId(params.activeProviderId)
  ) {
    return {
      visible: true,
      kind: "provider-limited",
      concurrentLimitBusinessCode: null,
      concurrentLimitReason: null,
      providerLimitedBusinessCode: params.serverProviderLimitedBusinessCode,
      providerLimitedMessage: normalizeProviderLimitedBannerMessage(
        params.serverProviderLimitedMessage,
      ),
      modelName: params.modelId,
      mcpServerName: null,
      mcpNoticeRowId: null,
      remainingTokens: null,
      remainingPercent: null,
      dismissible: true,
      blocksSubmit: false,
      priority: 45,
    };
  }

  // 官方 Server MCP 不可用（额度耗尽 / 无 Coding Plan）。
  //
  // 位置要求：必须在上面几条服务端业务错误之后（模型侧问题更紧急，不能被 MCP 提示挡住），
  // 且必须在下面那道 Start-Plan-only 早退之前——Coding Plan 会话一定命中那道早退，
  // 放在其后这条分支永远不会生效。
  if (params.mcpUnavailableNotice) {
    const mcpQuotaExhausted = params.mcpUnavailableNotice.code === "quota_exceeded";
    return {
      visible: true,
      kind: mcpQuotaExhausted ? "mcp-quota-exhausted" : "mcp-plan-required",
      concurrentLimitBusinessCode: null,
      concurrentLimitReason: null,
      providerLimitedBusinessCode: null,
      providerLimitedMessage: null,
      modelName: null,
      mcpServerName: params.mcpUnavailableNotice.serverName,
      mcpNoticeRowId: params.mcpUnavailableNotice.rowId,
      remainingTokens: null,
      remainingPercent: null,
      dismissible: true,
      // MCP 不可用不影响模型对话，绝不阻断输入。
      blocksSubmit: false,
      priority: mcpQuotaExhausted ? 6 : 8,
    };
  }

  if (
    !params.activeProviderId ||
    !isStartPlanModelProviderId(params.activeProviderId) ||
    params.snapshot?.provider?.id !== params.activeProviderId
  ) {
    return HIDDEN_SESSION_QUOTA_BANNER_STATE;
  }

  const buckets = getActiveModelBuckets(params.snapshot);
  if (allBucketsExhausted(buckets)) {
    return {
      ...HIDDEN_SESSION_QUOTA_BANNER_STATE,
      visible: true,
      kind: "daily-exhausted",
      remainingTokens: 0,
      remainingPercent: 0,
      priority: 50,
    };
  }
  const modelId = params.modelId?.trim() ?? "";
  const modelBuckets = modelId
    ? buckets.filter((bucket) => bucketMatchesModel(bucket, modelId))
    : [];
  const modelName =
    modelBuckets.flatMap((bucket) => bucket.usageDetails).find((detail) => detail.displayName)
      ?.displayName ?? modelId;
  if (allBucketsExhausted(modelBuckets)) {
    return {
      ...HIDDEN_SESSION_QUOTA_BANNER_STATE,
      visible: true,
      kind: "model-exhausted",
      modelName,
      remainingTokens: 0,
      remainingPercent: 0,
      priority: 40,
    };
  }
  // 旧版在此遍历 modelBuckets、按 ratio≤0.1 产出 model-very-low 升级提醒；
  // 该提醒档已随「去额度骚扰横幅」语义移除，直接隐藏（见函数注释）。
  return HIDDEN_SESSION_QUOTA_BANNER_STATE;
}

export function buildSessionQuotaBannerDismissKey(
  state: SessionQuotaBannerState,
  serverErrorKey?: string | null,
): string | null {
  if (!state.visible || !state.kind) return null;
  return [
    state.kind,
    state.concurrentLimitBusinessCode ?? "",
    state.concurrentLimitReason ?? "",
    state.providerLimitedBusinessCode ?? "",
    state.providerLimitedMessage ?? "",
    state.modelName ?? "",
    // MCP 提示按 server + 具体调用去重：关闭一次后同一次调用不再弹，
    // 之后再有新的失败调用（新 rowId）会重新弹。
    state.mcpServerName ?? "",
    state.mcpNoticeRowId ?? "",
    state.remainingTokens ?? "",
    state.remainingPercent ?? "",
    state.blocksSubmit ? "blocked" : "unblocked",
    serverErrorKey ?? "",
  ].join(":");
}

export function resolveQuotaBannerUpgradeProviderId(providerId: string | null): string | null {
  return providerId;
}

/**
 * 该提示是否应该带升级入口。
 *
 * `mcp-quota-exhausted` 明确不带：今日额度用完只能等自然日重置，升级按钮会让用户以为
 * 花钱就能立刻继续，是误导。权益缺失（`mcp-plan-required`）才是升级能解决的问题。
 */
export function shouldOfferQuotaBannerUpgrade(kind: SessionQuotaBannerKind | null): boolean {
  return kind !== "mcp-quota-exhausted";
}
