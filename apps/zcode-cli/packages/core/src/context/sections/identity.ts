// ============================================================
// Identity Section Builder
// ============================================================

import {
  BUILTIN_SYSTEM_PROMPT_SECURITY_NOTICE,
  buildBuiltinSystemPromptHarnessBlock,
} from "@zcode/shared";
import type { ContextSection } from "../types.js";
import type { OutputStylePromptConfig } from "../types.js";
import { estimateTokens } from "../utils.js";

// 安全行与 `# Harness` 块的内置原文唯一来源在 shared
// （docs/spec/custom-system-prompt.md v2）：UI 的继承态回显、core 的两条身份路径、
// 工作流子代理身份共用同一份文本。
const SECURITY_NOTICE = BUILTIN_SYSTEM_PROMPT_SECURITY_NOTICE;

/** 安全 IMPORTANT 行：交互式身份与工作流子代理身份共用，逐字同一份。 */
export function buildSecurityNotice(): string {
  return SECURITY_NOTICE;
}

/**
 * `# Harness` 块：稳定运行时约束，不属于 output style 可替换的 coding instructions，
 * 也是工作流子代理身份（sections/workflow-actor.ts）逐字复用的那一段。
 */
export function buildHarnessBlock(): string {
  return buildBuiltinSystemPromptHarnessBlock();
}

function buildIdentityPrompt(outputStyle?: OutputStylePromptConfig): string {
  const intro = outputStyle
    ? "You respond to the user according to the active Output Style below while using ZCode's tools and instructions."
    : "You are an interactive ZCode agent that helps users with software engineering tasks.";

  const identityLines = ["", intro, "", SECURITY_NOTICE].join("\n");

  return [identityLines, "", buildHarnessBlock()].join("\n");
}

export function buildIdentitySection(outputStyle?: OutputStylePromptConfig): ContextSection {
  const content = buildIdentityPrompt(outputStyle);

  return {
    name: "Agent Identity",
    source: "identity",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
