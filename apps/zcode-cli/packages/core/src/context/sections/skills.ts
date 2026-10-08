// ============================================================
// Skills Section Builder
// ============================================================

import type { SkillLoadOutcome, SkillMetadata } from "@zcode/contracts";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

const DEFAULT_SKILL_METADATA_BUDGET = 20_000;
const MAX_DESCRIPTION_CHARS = 250;

interface SkillsSectionOptions {
  outcome: SkillLoadOutcome;
  metadataBudget?: number;
}

export function buildSkillsSection(options: SkillsSectionOptions): ContextSection | null {
  if (options.outcome.skills.length === 0) {
    return null;
  }

  const content = buildSkillsContent(
    options.outcome.skills,
    options.metadataBudget ?? DEFAULT_SKILL_METADATA_BUDGET,
  );

  return {
    name: "Skills",
    source: "skills",
    injectionTarget: "meta_user",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildSkillsContent(skills: SkillMetadata[], budget: number): string {
  const lines = [
    "The following skills are available for use with the Skill tool:",
    "",
  ];

  const sortedSkills = [...skills].sort((a, b) =>
    skillDisplayName(a).localeCompare(skillDisplayName(b)),
  );
  const skillLines = sortedSkills.map((skill) => formatSkillLine(skill, MAX_DESCRIPTION_CHARS));
  const full = [...lines, ...skillLines].join("\n");
  if (full.length <= budget) {
    return full;
  }

  // 降级不是全丢：whenToUse 是模型判断「该不该用」的最关键信号，
  // 保留一个短前缀，description 与 file 细节才允许丢弃。
  const namesOnly = sortedSkills.map(
    (skill) =>
      `- ${skillDisplayName(skill)}${bareAliasSuffix(skill)}${downgradedWhenToUse(skill)} (file: ${skill.path})`,
  );
  return [...lines, ...namesOnly].join("\n");
}

const DOWNGRADED_WHEN_TO_USE_MAX_CHARS = 100;

function downgradedWhenToUse(skill: SkillMetadata): string {
  if (!skill.whenToUse) {
    return "";
  }
  const trimmed = skill.whenToUse.trim();
  const text =
    trimmed.length > DOWNGRADED_WHEN_TO_USE_MAX_CHARS
      ? `${trimmed.slice(0, DOWNGRADED_WHEN_TO_USE_MAX_CHARS - 1)}...`
      : trimmed;
  return `: ${text}`;
}

function formatSkillLine(skill: SkillMetadata, maxDescriptionChars: number): string {
  const description = skill.whenToUse
    ? `${skill.description} - ${skill.whenToUse}`
    : skill.description;
  const trimmed =
    description.length > maxDescriptionChars
      ? `${description.slice(0, maxDescriptionChars - 1)}...`
      : description;
  return `- ${skillDisplayName(skill)}: ${trimmed}${bareAliasSuffix(skill)} (file: ${skill.path})`;
}

function skillDisplayName(skill: SkillMetadata): string {
  return skill.qualifiedName ?? skill.name;
}

function bareAliasSuffix(skill: SkillMetadata): string {
  return skill.qualifiedName && skill.qualifiedName !== skill.name
    ? ` (also loadable as ${skill.name})`
    : "";
}
