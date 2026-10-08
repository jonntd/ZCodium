import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentContextBuilder } from "../src/subagent/context-builder.js";
import { buildSubagentCommonNotes } from "../src/subagent/system-prompt.js";
import { createContextBuilder } from "../src/context/builder.js";
import { buildRequestUserContextSection } from "../src/context/sections/request-user-context.js";
import { buildSkillsSection } from "../src/context/sections/skills.js";
import type { ContextBuilderConfig } from "../src/context/types.js";
import type { EnvInfo } from "../src/runtime/deps.js";
import type { SkillLoadOutcome } from "@zcode/contracts";

// 系统提示词覆盖面审计（2026-10-08）落地的四个补缺：
// 1) language 接进 env_info（此前是死配置：config 存在、重建一次、毫无效果）；
// 2) 项目指令（AGENTS.md）缺失时的兜底提示；
// 3) 子代理最小行为契约（先给结论 + 失败如实说）；
// 4) skills 超预算降级时保留 whenToUse 短前缀。

const ENV_INFO: EnvInfo = {
  cwd: "/repo",
  platform: "darwin",
  shell: "/bin/zsh",
  osVersion: "macOS 15.1",
  isGitRepository: false,
};

function buildConfig(overrides: Partial<ContextBuilderConfig> = {}): ContextBuilderConfig {
  return {
    workingDirectory: "/repo",
    envInfo: ENV_INFO,
    currentDate: "2026-10-08",
    ...overrides,
  };
}

function sectionContent(config: ContextBuilderConfig, source: string): string | undefined {
  return createContextBuilder(config)
    .build()
    .sections.find((section) => section.source === source)?.content;
}

test("builder: config.language 进 env_info（死配置修复）", () => {
  const withLanguage = sectionContent(buildConfig({ language: "zh-CN" }), "env_info");
  assert.ok(withLanguage?.includes("Preferred response language: zh-CN"));

  const withoutLanguage = sectionContent(buildConfig(), "env_info");
  assert.ok(!withoutLanguage?.includes("Preferred response language"));
});

test("builder: language 只作偏好声明，空白值不产生空行", () => {
  const blank = sectionContent(buildConfig({ language: "   " }), "env_info");
  assert.ok(!blank?.includes("Preferred response language"));
});

test("builder: 无 AGENTS.md 时出现探测兜底提示", () => {
  const fallback = sectionContent(buildConfig(), "request_user_context");
  assert.ok(fallback?.includes("No workspace instruction file"));
  assert.ok(fallback?.includes("discover them yourself"));
});

test("builder: 有 AGENTS.md 时不出兜底提示", () => {
  const content = sectionContent(
    buildConfig({
      userInstructions: {
        filePath: "/repo/AGENTS.md",
        fileName: "AGENTS.md",
        content: "# 核心原则\n- 先写 spec",
        bytesRead: 16,
        sizeBytes: 16,
        truncated: false,
      },
    }),
    "request_user_context",
  );
  assert.ok(content?.includes("核心原则"));
  assert.ok(!content?.includes("No workspace instruction file"));
});

test("builder: 只有记忆索引时兜底提示与记忆并存", () => {
  const content = sectionContent(
    buildConfig({ memoryRoot: "/repo/.workbuddy-ai/memory", memoryIndexContent: "- [x](x.md)" }),
    "request_user_context",
  );
  assert.ok(content?.includes("No workspace instruction file"));
  assert.ok(content?.includes("MEMORY.md"));
});

test("request_user_context: 截断的项目指令也不触发兜底（内容仍在）", () => {
  const section = buildRequestUserContextSection({
    userInstructions: {
      filePath: "/repo/AGENTS.md",
      fileName: "AGENTS.md",
      content: "partial",
      bytesRead: 7,
      sizeBytes: 9999,
      truncated: true,
    },
  });
  assert.ok(section?.content.includes("[File truncated: AGENTS.md]"));
  assert.ok(!section?.content.includes("No workspace instruction file"));
});

test("subagent: 公共 notes 含最小行为契约", () => {
  const notes = buildSubagentCommonNotes();
  assert.ok(notes.includes("Lead with the outcome"));
  assert.ok(notes.includes("Report outcomes faithfully"));
});

test("subagent: 行为契约进入子代理 system prompt", () => {
  const result = createSubagentContextBuilder({
    agentPrompt: "You are an Explore agent.",
    envInfo: ENV_INFO,
    currentDate: "2026-10-08",
  }).build();
  const notesMessage = result.systemMessages
    .map((message) => message.content)
    .join("\n");
  assert.ok(notesMessage.includes("Lead with the outcome"));
  assert.ok(notesMessage.includes("Report outcomes faithfully"));
});

const SKILL: SkillLoadOutcome = {
  skills: [
    {
      name: "alpha",
      description: "Does alpha things",
      whenToUse: "Use when alpha is required by the task at hand",
      path: "/skills/alpha/SKILL.md",
      directory: "/skills/alpha",
      rootPath: "/skills",
    },
    {
      name: "beta",
      description: "Does beta things",
      path: "/skills/beta/SKILL.md",
      directory: "/skills/beta",
      rootPath: "/skills",
    },
  ],
  diagnostics: [],
  totalDiscovered: 2,
};

test("skills: 正常预算下完整输出", () => {
  const content = buildSkillsSection({ outcome: SKILL, metadataBudget: 10_000 })?.content ?? "";
  assert.ok(content.includes("Does alpha things"));
  assert.ok(content.includes("Use when alpha is required"));
});

test("skills: 超预算降级保留 whenToUse 短前缀（不全丢）", () => {
  const content = buildSkillsSection({ outcome: SKILL, metadataBudget: 100 })?.content ?? "";
  assert.ok(!content.includes("Does alpha things"), "description 允许丢弃");
  assert.ok(
    content.includes("alpha: Use when alpha is required by the task at hand"),
    "whenToUse 必须保留",
  );
  // 无 whenToUse 的技能降级行不带冒号尾巴。
  assert.ok(content.includes("beta (file: /skills/beta/SKILL.md)"));
});

test("skills: 降级时超长 whenToUse 截断到 100 字符", () => {
  const outcome: SkillLoadOutcome = {
    skills: [
      {
        ...SKILL.skills[0]!,
        whenToUse: `Use ${"x".repeat(200)}`,
      },
    ],
    diagnostics: [],
    totalDiscovered: 1,
  };
  const content = buildSkillsSection({ outcome, metadataBudget: 50 })?.content ?? "";
  assert.ok(content.includes(`alpha: Use ${"x".repeat(95)}...`));
});
