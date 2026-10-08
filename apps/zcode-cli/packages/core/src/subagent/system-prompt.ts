import type { EnvInfo, Model } from "@zcode/contracts";
import { isEnvInfoGitRepository } from "../context/sections/env-info.js";
import {
  BEHAVIORAL_CONTRACT_LEAD_WITH_OUTCOME,
  BEHAVIORAL_CONTRACT_REPORT_FAITHFULLY,
} from "../prompts/behavioral-contract.js";

export interface SubagentEnvironmentContextOptions {
  agentPrompt: string;
  envInfo: EnvInfo;
  model?: Model;
  language?: string;
}

export function buildSubagentCommonNotes(): string {
  return [
    "Notes:",
    "- Agent threads always have their cwd reset between bash calls, as a result please only use absolute file paths.",
    "- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.",
    "- For clear communication with the user the assistant MUST avoid using emojis.",
    '- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.',
    "- Do NOT Write report/summary/findings/analysis .md files. Return findings directly as your final assistant message — the parent agent reads your text output, not files you create.",
    // 子代理此前没有行为契约（主 Agent 的 Dynamic Behavior 段不进入子代理 prompt）；
    // 这两条是其中对委派任务最关键的最小集，与 compact 等一次性 prompt 共用常量防漂移。
    `- ${BEHAVIORAL_CONTRACT_LEAD_WITH_OUTCOME}`,
    `- ${BEHAVIORAL_CONTRACT_REPORT_FAITHFULLY}`,
  ].join("\n");
}

export function buildSubagentEnvironmentContext(
  options: SubagentEnvironmentContextOptions,
): string {
  const { envInfo, model, language } = options;
  const modelLine = model
    ? [`You are powered by the model named ${model.providerId}/${model.modelId}.`]
    : [];

  const inGitRepo = isEnvInfoGitRepository(envInfo);
  // 子代理此前不知道分支与工作树状态（G11）：被派回来改代码时无法对照快照，
  // 长会话里尤其容易拿旧状态当现状。只给 branch + 单词状态，完整 status lines
  // 仍归主 Agent 的 system_context 段（2k 截断），避免子代理 prompt 膨胀。
  const gitLines = inGitRepo
    ? [
        ...(envInfo.gitBranch ? [`Git branch: ${envInfo.gitBranch}`] : []),
        `Git status: ${envInfo.gitStatus ?? "unknown"}`,
      ]
    : [];

  return [
    "Here is useful information about the environment you are running in:",
    "<env>",
    `Working directory: ${envInfo.cwd}`,
    `Is directory a git repo: ${inGitRepo ? "Yes" : "No"}`,
    ...gitLines,
    `Platform: ${envInfo.platform}`,
    `Shell: ${envInfo.shell}`,
    `OS Version: ${envInfo.osVersion}`,
    // 与主 Agent env_info 同源：runtime config 的 language 偏好此前对子代理无效。
    ...(language?.trim() ? [`Preferred response language: ${language.trim()}`] : []),
    "</env>",
    ...modelLine,
  ].join("\n");
}
