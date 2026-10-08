import { z } from "zod";
import { customSystemSegmentsSchema } from "./system-prompt-segments.js";

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
    // 分段系统提示词（docs/spec/custom-system-prompt.md v2）。多窗口广播双方同版本
    // 分发，optional 即可；缺席 = 从未使用过分段，{} = 已全部恢复继承。
    customSystemSegments: customSystemSegmentsSchema.optional(),
    // 回复语言（docs/spec/response-language.md）：default("") 兼容旧发送方，空串 = 跟随用户消息。
    language: z.string().max(64).default(""),
  })
  .strict();

export type AppRuntimePreferencesChangedBroadcastPayload = z.infer<
  typeof appRuntimePreferencesChangedBroadcastPayloadSchema
>;
