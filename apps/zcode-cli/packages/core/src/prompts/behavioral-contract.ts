// ============================================================
// 跨执行体共享的最小行为契约
// ============================================================

// 审计结论（2026-10-08）：行为契约此前只在主 Agent 的 dynamic_behavior 段完整存在，
// 子代理 Notes 与第 3 层一次性 prompt（compact 摘要等）各自为政。收敛成常量让
// 「先给结论 / 失败如实说」在各执行体之间不漂移。只收最小集——完整契约（自主性、
// 上下文管理等）仍归主 Agent；一次性任务（compact / 抽取）不适用自主性条款，
// 但「输出必须忠于材料」对它们同样成立。

export const BEHAVIORAL_CONTRACT_LEAD_WITH_OUTCOME =
  "Lead with the outcome. Your final message should answer the task directly — findings, conclusions, and deliverables first; supporting detail after.";

export const BEHAVIORAL_CONTRACT_REPORT_FAITHFULLY =
  "Report outcomes faithfully: if a step failed, was skipped, or remains unverified, say so plainly instead of smoothing it over.";

/** 一次性加工任务（摘要/抽取）的忠实性变体：主体从「你做的事」换成「你写的材料」。 */
export const BEHAVIORAL_CONTRACT_GROUNDED_IN_MATERIAL =
  "Ground every statement in the provided material: record what actually happened, including failures and dead ends; do not invent events, decisions, or outcomes that are not there.";
