/**
 * 推荐模板（codex_ui 还原说明 §15：「✧ 推荐模板（1）」）。
 *
 * 只作用于「主身份 → Agent 身份」：以「覆盖」整段应用，等用户显式保存。
 * 工作流子代理的身份段是参数化段（运行时注入 persona 与工作流契约），拿模板去
 * 覆盖会静默删掉注入部分，因此**不提供**模板入口（见 spec custom-system-prompt v2）。
 */
export interface RecommendedSystemPromptTemplate {
  id: string;
  body: string;
}

export const RECOMMENDED_IDENTITY_TEMPLATES: readonly RecommendedSystemPromptTemplate[] = [
  {
    id: "engineering-charter",
    body: [
      "You are an interactive coding agent that helps users with software engineering tasks.",
      "",
      "# 工程章程（全局指令）",
      "",
      "- 先读懂再动手：改动前先阅读相关代码与文档，确认并遵循仓库现有约定。",
      "- 小步前进：每个逻辑单元独立可验证；提交信息遵循仓库现有风格。",
      "- 证据优先：结论必须基于实际运行结果；测试失败要如实报告，不掩盖、不跳过。",
      "- 保守副作用：不删除、不覆盖未经确认的内容；破坏性操作先征求确认。",
      "- 说明取舍：关键决策用一句话给出理由与被否决的备选方案。",
    ].join("\n"),
  },
];
