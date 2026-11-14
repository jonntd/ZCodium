import { z } from "zod";
import { customSystemSegmentsSchema } from "./system-prompt-segments.js";

export const appToolSearchModeSchema = z.enum(["auto", "local", "off"]);
export type AppToolSearchMode = z.infer<typeof appToolSearchModeSchema>;
/**
 * App 设置缺省的 ToolSearch 模式：设置 schema、Host 偏好响应与设置页初始显示都读这一处。
 * 独立 CLI 不读 App 设置，默认值另行定义；旧 Host 协议响应缺字段时仍按 off 解析。
 */
export const DEFAULT_APP_TOOL_SEARCH_MODE: AppToolSearchMode = "off";

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
    pluginAutoRecommendationEnabled: z.boolean().default(false),
  })
  .strict();

export type AppRuntimePreferencesChangedBroadcastPayload = z.infer<
  typeof appRuntimePreferencesChangedBroadcastPayloadSchema
>;
