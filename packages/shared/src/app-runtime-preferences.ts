import { z } from "zod";

export const APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL = "settings:app-runtime-preferences";
export const ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV = "ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE";

export const appRuntimePreferencesChangedBroadcastPayloadSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    modelIoFullRetentionEnabled: z.boolean().default(false),
    deleteProtectionEnabled: z.boolean().default(true),
    batchDeleteApprovalThreshold: z.number().int().min(1).max(10000).default(50),
    // 自定义系统提示词（docs/spec/custom-system-prompt.md）；default("") 兼容
    // 未携带该字段的旧发送方，空串 = 内置默认。
    customSystemPrompt: z.string().max(200_000).default(""),
  })
  .strict();

export type AppRuntimePreferencesChangedBroadcastPayload = z.infer<
  typeof appRuntimePreferencesChangedBroadcastPayloadSchema
>;
