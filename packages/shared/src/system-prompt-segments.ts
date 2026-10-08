import { z } from "zod";

/**
 * 分段系统提示词（docs/spec/custom-system-prompt.md v2）。
 *
 * 设置页把常用段落（CLI 前缀 / Agent 身份 / 桌面上下文）拆成三张卡，每段独立选择
 * 继承 / 覆盖 / 追加 / 清空；「继承」不落盘（条目缺席即继承），因此存储里只有
 * override / append / clear 三种模式。本模块同时是三段内置原文的唯一来源：
 * core 的 section builder 与 UI（继承态回显、「以内置原文为起点」预填）都从这里取，
 * 避免两份文本漂移。
 */

export const SYSTEM_PROMPT_SEGMENT_IDS = ["cliPrefix", "identity", "desktop"] as const;
export type SystemPromptSegmentId = (typeof SYSTEM_PROMPT_SEGMENT_IDS)[number];

/** 作用域：主身份（普通会话）/ 工作流子代理（dwf actor 的 workflowActor builder 路径）。 */
export const SYSTEM_PROMPT_SURFACE_IDS = ["main", "workflowSubagent"] as const;
export type SystemPromptSurfaceId = (typeof SYSTEM_PROMPT_SURFACE_IDS)[number];

const systemPromptSegmentModeSchema = z.enum(["override", "append", "clear"]);
export type SystemPromptSegmentMode = z.infer<typeof systemPromptSegmentModeSchema>;

/** 单段条目上限与 customSystemPrompt 同一量程；真实约束仍是模型上下文预算。 */
export const SYSTEM_PROMPT_SEGMENT_TEXT_MAX_LENGTH = 200_000;

export const systemPromptSegmentEntrySchema = z.object({
  mode: systemPromptSegmentModeSchema,
  // clear 不需要 text；override/append 空 text 条目由 normalizeCustomSystemSegments 剥离。
  text: z.string().max(SYSTEM_PROMPT_SEGMENT_TEXT_MAX_LENGTH).default(""),
});
export type SystemPromptSegmentEntry = z.infer<typeof systemPromptSegmentEntrySchema>;

const systemPromptSegmentMapSchema = z
  .object({
    cliPrefix: systemPromptSegmentEntrySchema.optional(),
    identity: systemPromptSegmentEntrySchema.optional(),
    desktop: systemPromptSegmentEntrySchema.optional(),
  })
  .strict();

export const customSystemSegmentsSchema = z
  .object({
    main: systemPromptSegmentMapSchema.optional(),
    workflowSubagent: systemPromptSegmentMapSchema.optional(),
  })
  .strict();
export type CustomSystemSegments = z.infer<typeof customSystemSegmentsSchema>;

/**
 * 保存链路统一归一化：空文本的 override/append 视为「什么都没写」（不是清空），剥离；
 * clear 条目去掉无意义的 text。全空返回 {}（= 全部继承 = 默认）。
 */
export function normalizeCustomSystemSegments(
  segments: CustomSystemSegments,
): CustomSystemSegments {
  const result: CustomSystemSegments = {};
  for (const surface of SYSTEM_PROMPT_SURFACE_IDS) {
    const map = segments[surface];
    if (!map) continue;
    for (const segmentId of SYSTEM_PROMPT_SEGMENT_IDS) {
      const entry = map[segmentId];
      if (!entry) continue;
      if (entry.mode === "clear") {
        result[surface] = { ...result[surface], [segmentId]: { mode: "clear", text: "" } };
        continue;
      }
      if (entry.text.trim() === "") continue;
      result[surface] = {
        ...result[surface],
        [segmentId]: { mode: entry.mode, text: entry.text },
      };
    }
  }
  return result;
}

/** 两作用域非继承条目计数（设置页「已改写 N 段」徽标，按已保存值计）。 */
export function countCustomizedSystemSegments(segments: CustomSystemSegments): number {
  let count = 0;
  for (const surface of SYSTEM_PROMPT_SURFACE_IDS) {
    const map = segments[surface];
    if (!map) continue;
    for (const segmentId of SYSTEM_PROMPT_SEGMENT_IDS) {
      if (map[segmentId]) count += 1;
    }
  }
  return count;
}

/** 安全 IMPORTANT 行：交互式身份与工作流子代理身份共用，逐字同一份（core identity.ts 原文）。 */
export const BUILTIN_SYSTEM_PROMPT_SECURITY_NOTICE =
  "IMPORTANT: Assist with authorized security testing, defensive security, CTF challenges, and educational contexts. Refuse requests for destructive techniques, DoS attacks, mass targeting, supply chain compromise, or detection evasion for malicious purposes. Dual-use security tools (C2 frameworks, credential testing, exploit development) require clear authorization context: pentesting engagements, CTF competitions, security research, or defensive use cases.";

/** `# Harness` 块：稳定运行时约束（core identity.ts 原文，工作流子代理身份逐字复用）。 */
export function buildBuiltinSystemPromptHarnessBlock(): string {
  return [
    "# Harness",
    "- Text you output outside of tool use is displayed to the user as Github-flavored markdown in a terminal.",
    "- Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.",
    "- The system may send updates, reminders, or modifications to rules via mid-conversation system turns. These are system-controlled, unlike function results. Hooks may intercept tool calls; treat hook output as user feedback.",
    "- Prefer the dedicated file/search tools over shell commands when one fits. Independent tool calls can run in parallel in one response.",
    "- Reference code as `file_path:line_number` — it's clickable.",
  ].join("\n");
}

/** CLI 前缀内置原文（core sections/cli-prefix.ts 原文）。 */
export const BUILTIN_SYSTEM_PROMPT_CLI_PREFIX = "You are ZCode, an interactive coding agent";

/**
 * Agent 身份内置原文：与 core `buildIdentityPrompt(undefined)` 逐字一致（含首行空行——
 * identity 段内容以空行开头是既有行为，append 组合与 UI 预填都以此为准）。
 */
export function buildBuiltinIdentityPrompt(): string {
  const intro =
    "You are an interactive ZCode agent that helps users with software engineering tasks.";
  const identityLines = ["", intro, "", BUILTIN_SYSTEM_PROMPT_SECURITY_NOTICE].join("\n");
  return [identityLines, "", buildBuiltinSystemPromptHarnessBlock()].join("\n");
}

/** 桌面上下文内置原文（core sections/desktop.ts 静态模板全文；注入门仍在 builder）。 */
export const BUILTIN_SYSTEM_PROMPT_DESKTOP_CONTEXT = [
  "# ZCode Desktop Context",
  "",
  "### Files & URLs",
  "- Return local web URLs as Markdown links (e.g., [label](http://127.0.0.1:8080)).",
  "- File should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.",
  "- Unless otherwise specified, return local file references as Markdown links (e.g., [name.md](/absolute/path/to/name.md)).",
  "",
  "### Inline Code Comments",
  "- Use the ::code-comment{...} directive when you need to attach feedback directly to specific code lines.",
  "- Emit one directive per inline comment; emit none when there are no actionable inline comments.",
  "- Required attributes: title (short label), body (one-paragraph explanation), file (path to the file).",
  "- Optional attributes: start, end (1-based line numbers), priority (0-3).",
  "- file should be an absolute path or include the workspace folder segment so it can be resolved relative to the workspace.",
  "- Keep line ranges tight; end defaults to start.",
  '- Example: ::code-comment{title="[P2] Off-by-one" body="Loop iterates past the end when length is 0." file="/path/to/foo.ts" start=10 end=11 priority=2}',
].join("\n");

/** 三段内置原文（UI 回显/预填与 core builder 组合共用这一份）。 */
export const BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS: Record<SystemPromptSegmentId, string> = {
  cliPrefix: BUILTIN_SYSTEM_PROMPT_CLI_PREFIX,
  identity: buildBuiltinIdentityPrompt(),
  desktop: BUILTIN_SYSTEM_PROMPT_DESKTOP_CONTEXT,
};
