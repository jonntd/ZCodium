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

/**
 * 动态工作流子代理（dwf actor）的身份段内置原文。
 *
 * 与三段不同，它是**参数化**的：开场句里插角色名、开场句之后插脚本写的 persona。因此 UI 的
 * 「继承态回显 / 以内置原文为起点」只能用**无 persona** 的形态（`{}`）——真实内容还会多出
 * persona，界面上必须说清这一点，不能假装回显的就是子代理实际收到的全部文本。
 *
 * 实现（含 `# Working inside a workflow` 契约）与 core 的 section builder 共用这一份，
 * core 只是加 section 元数据；契约文本曾经散在 core 里，UI 拿不到，导致「工作流子代理」
 * 页签回显的是交互式身份（错的）。
 */
const WORKFLOW_ACTOR_TOOL_SURFACE =
  "You have the regular working tools — reading, searching, editing, running commands — plus `submit_result` and `escalate`. There is no tool that asks a person anything.";

const WORKFLOW_ACTOR_EVIDENCE_RULE =
  "Ground every claim in something you read or ran in this session, or in the material the ask gave you, and say which. Cite code as `path:line`. A check counts as passed only if you executed it here; if you could not run it, report it as not run. Run the check an ask names rather than a faster substitute, and say exactly which command you ran.";

function buildWorkflowActorContract(): string {
  return [
    "# Working inside a workflow",
    `- ${WORKFLOW_ACTOR_TOOL_SURFACE}`,
    "- Each ask states what to do. When the ask carries a result schema, finish by calling `submit_result` with a conforming value; otherwise your final message is the result.",
    `- ${WORKFLOW_ACTOR_EVIDENCE_RULE}`,
    "- Report outcomes faithfully. If part of the task is impossible, out of scope, or contradicted by what you found, say so in the result instead of filling a field with a plausible guess. Never fake a passing result to satisfy an instruction.",
    "- When you are blocked by something outside your reach — a gate that cannot pass, instructions that contradict each other, a fact only the run's owner knows — call `escalate`. Questions written in prose reach nobody.",
    // 产物条款：子代理仍然没有任何产物工具（只有脚本能发布），但当 ask 指名了输出路径时，
    // 写到那里并把路径交回来，脚本会把它发布给用户。
    "- Do not write report or summary files on your own initiative; findings go in the result. When the ask names an output path, write exactly there and return that path in the result — the script publishes it to the user.",
  ].join("\n");
}

/**
 * 拼装工作流子代理身份段：开场句（可带角色名）→ persona → 安全行 → `# Harness` → 工作流契约。
 * core 的 `buildWorkflowActorIdentitySection` 直接调这里，保证「UI 看到的模板」与
 * 「子代理实际收到的文本」同源。
 */
export function buildBuiltinWorkflowActorIdentityPrompt(input: {
  name?: string;
  persona?: string;
}): string {
  const name = input.name?.trim();
  const named = name ? `, named "${name}"` : "";
  const persona = input.persona?.trim();
  // 不再有 CLI prefix 走在前面（「You are ZCode, an interactive coding agent」对子代理是错的
  // 身份），所以这一段就是 system 的第一行，不以空行起头。
  return [
    `You are a subagent inside a dynamic workflow run${named}. A script created you and hands you work one ask at a time; the script — not a person — consumes what you return. There is no user in this conversation to talk to.`,
    ...(persona ? ["", persona] : []),
    "",
    BUILTIN_SYSTEM_PROMPT_SECURITY_NOTICE,
    "",
    buildBuiltinSystemPromptHarnessBlock(),
    "",
    buildWorkflowActorContract(),
  ].join("\n");
}

/** 无 persona 的静态形态：UI「工作流子代理」页签的继承态回显与预填用。 */
export const BUILTIN_SYSTEM_PROMPT_WORKFLOW_ACTOR_IDENTITY =
  buildBuiltinWorkflowActorIdentityPrompt({});

/**
 * 作用域 × 段 的内置原文（UI 的唯一取数入口）。
 *
 * 注意 `workflowSubagent` 只有 `identity`，且它只是**无 persona 的基础文本**——
 * 子代理实际收到的还会多出脚本写的 persona。`override` 会连同 persona 与工作流契约
 * 一起替换掉，界面上必须给出这条警告（见 i18n `settings.systemPrompt.workflowHint`）。
 */
export const BUILTIN_SYSTEM_PROMPT_SURFACE_SEGMENT_TEXTS: Record<
  SystemPromptSurfaceId,
  Partial<Record<SystemPromptSegmentId, string>>
> = {
  main: BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS,
  workflowSubagent: { identity: BUILTIN_SYSTEM_PROMPT_WORKFLOW_ACTOR_IDENTITY },
};
