/**
 * Composer 提示词增强（统一链路版）。
 *
 * 原为 desktop main 进程旁路（IPlatformService.enhancePromptDraft + 渠道评分），
 * 2026-09-28 起迁移到与生成提交消息一致的统一执行链路：
 * UI → prompt-assist 服务 RPC → PromptEnhanceGenerator → Agent runtime
 * generateWorkspaceText（querySource="prompt_enhance"，跟随会话模型）。
 * 契约见 docs/spec/prompt-enhance-unified.md。
 */

export interface PromptEnhanceDraftRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  /** composer 当前草稿原文 */
  text: string;
}

export interface PromptEnhanceDraftResult {
  /** 增强后的提示词；unchanged 时为原文透传 */
  text: string;
  /** 短输入直判命中：未调用模型，text 为原文（渲染层提示后保留草稿） */
  unchanged?: boolean;
}
