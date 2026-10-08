// ============================================================
// Workflow Actor Identity Section Builder
// ============================================================
//
// 动态工作流子代理（workflow child）的身份段。
//
// 它替换的是交互式的 Agent Identity（「You are an interactive ZCode agent that helps
// users」）：子代理的读者是脚本，不是人。它**不**替换基座的其他段——安全 IMPORTANT 行与
// `# Harness` 块从 identity 逐字复用，memory / skills / 项目指令由 builder 照常追加。
// 作者写的 persona 叠加在开场句之后、契约之前：角色比通用规则更靠前、更醒目，但开场句先把
// 「你是谁的谁、输出给谁」说死，persona 不能推翻它。
//
// 契约曾按 persona 的工具档位分支；实盘里零工具的 GLM 子代理被
// 「Ground every claim in something you read or ran」逼着去读目录、跑命令，而它没有这些工具，
// 于是发出一个退化的 `escalate("placeholder")`。修法是**把工具面说死**：子代理先知道自己有什么，
// 再被告知证据从哪来。工具档位退场后，
// 每个子代理都有完整工作工具集，契约回到一份文本；「说死工具面」的原则不变。
//
// ⚠ 文本本体（开场句 + 契约）已下沉到 `@zcode/shared` 的 `system-prompt-segments.ts`：
// 设置页的「工作流子代理」页签要回显同一份模板，而 shared 不能反向依赖 core。
// 本文件只负责把文本包成 section 元数据。

import { buildBuiltinWorkflowActorIdentityPrompt } from "@zcode/shared";
import type { ContextSection, WorkflowActorContext } from "../types.js";
import { estimateTokens } from "../utils.js";

export function buildWorkflowActorIdentitySection(actor: WorkflowActorContext): ContextSection {
  const content = buildBuiltinWorkflowActorIdentityPrompt(actor);
  return {
    name: "Workflow Actor Identity",
    source: "workflow_actor_identity",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
