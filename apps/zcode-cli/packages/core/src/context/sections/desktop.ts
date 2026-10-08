import { BUILTIN_SYSTEM_PROMPT_DESKTOP_CONTEXT } from "@zcode/shared";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

export function buildDesktopContextSection(): ContextSection {
  // 内置原文的唯一来源在 shared（docs/spec/custom-system-prompt.md v2）：
  // 设置页「桌面上下文」卡的继承态回显与预填读同一份，注入门仍在本 builder 的调用点。
  return createDesktopSection(
    "ZCode Desktop Context",
    "desktop_context",
    BUILTIN_SYSTEM_PROMPT_DESKTOP_CONTEXT,
  );
}

function createDesktopSection(
  name: string,
  source: ContextSection["source"],
  content: string,
): ContextSection {
  return {
    name,
    source,
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
