// ============================================================
// CLI Prefix Section Builder
// ============================================================

import { BUILTIN_SYSTEM_PROMPT_CLI_PREFIX } from "@zcode/shared";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

// 内置原文的唯一来源在 shared（docs/spec/custom-system-prompt.md v2）：设置页的继承态回显
// 与「以内置原文为起点」预填都读同一份常量，避免 UI 与 core 各写一份而漂移。
const CLI_PREFIX_PROMPT = BUILTIN_SYSTEM_PROMPT_CLI_PREFIX;

export function buildCliPrefixSection(): ContextSection {
  const content = CLI_PREFIX_PROMPT;

  return {
    name: "CLI Prefix",
    source: "cli_prefix",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
