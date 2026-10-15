import { BUILTIN_SYSTEM_PROMPT_DESKTOP_CONTEXT } from "@zcode/shared";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

/**
 * 「未提供可视化目录」时内置原文里的那一行。Gen UI 段是**参数化**的：只有运行时才知道会话的
 * 可写目录，所以 shared 里的内置原文回显的是这个无目录形态，运行时按目录替换该行。设置页必须
 * 按同一约定说明「真实内容还会多出目录与技能提示」。
 */
const GEN_UI_UNAVAILABLE_LINE =
  "- No visualization output directory is supplied; inline Gen UI is unavailable.";

function buildGenUiAvailableLines(genUiOutputDirectory: string): string[] {
  return [
    "- This Desktop host supports Gen UI: completed assistant references to HTML fragments in the supplied session directory render inline, including on remote executors.",
    `- Writable, durable visualization directory for this session: ${JSON.stringify(genUiOutputDirectory)}. Save inline fragments here, outside the project. Other paths cannot be rendered.`,
    "- Use the independent visualize skill for authoring instructions, styles and the restricted window.zcode bridge. Load the skill before generating an interactive view.",
  ];
}

export function buildDesktopContextSection(genUiOutputDirectory?: string): ContextSection {
  // 内置原文的唯一来源在 shared（docs/spec/custom-system-prompt.md v2）：设置页「桌面上下文」
  // 卡的继承态回显与预填读同一份，注入门仍在本 builder 的调用点。带目录时只把「无目录」那一行
  // 换成真实的 Gen UI 说明，其余文本保持与 shared 一致。
  const content = genUiOutputDirectory
    ? BUILTIN_SYSTEM_PROMPT_DESKTOP_CONTEXT.replace(
        GEN_UI_UNAVAILABLE_LINE,
        buildGenUiAvailableLines(genUiOutputDirectory).join("\n"),
      )
    : BUILTIN_SYSTEM_PROMPT_DESKTOP_CONTEXT;
  return createDesktopSection("ZCode Desktop Context", "desktop_context", content);
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
