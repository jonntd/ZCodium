import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS } from "@zcode/shared";
import {
  BUILTIN_SYSTEM_PROMPT_WORKFLOW_ACTOR_IDENTITY,
  buildBuiltinWorkflowActorIdentityPrompt,
} from "@zcode/shared";
import { createContextBuilder } from "../src/context/builder.js";
import type { ContextBuilderConfig } from "../src/context/types.js";
import type { EnvInfo } from "../src/runtime/deps.js";

// 分段系统提示词（docs/spec/custom-system-prompt.md v2）在 builder 层的验收语义：
// 1) 只改写被编辑的那一段，其余段（含全部动态段）照常构建——这是与 v1 整段替换的核心差异；
// 2) inherit（条目缺席）等价于内置拼装；
// 3) clear 让该段不进入 system prompt，但不影响其他段；
// 4) workflowSubagent 作用域只作用于 workflowActor 身份段，main 三段对它不生效；
// 5) v1 customSystemPrompt 非空时整体压过分段配置。

const ENV_INFO: EnvInfo = {
  cwd: "/repo",
  platform: "darwin",
  shell: "/bin/zsh",
  osVersion: "macOS 15.1",
  nodeVersion: "24.2.0",
  isGitRepository: true,
  gitBranch: "main",
  gitStatus: "clean",
};

function buildConfig(overrides: Partial<ContextBuilderConfig> = {}): ContextBuilderConfig {
  return {
    workingDirectory: "/repo",
    envInfo: ENV_INFO,
    currentDate: "2026-10-06",
    ...overrides,
  };
}

function systemSections(config: ContextBuilderConfig) {
  return createContextBuilder(config)
    .build()
    .sections.filter((section) => section.injectionTarget === "system");
}

function systemSources(config: ContextBuilderConfig): string[] {
  return systemSections(config).map((section) => section.source);
}

function sectionContent(config: ContextBuilderConfig, source: string): string | undefined {
  return systemSections(config).find((section) => section.source === source)?.content;
}

test("builder: 无分段配置时与内置拼装一致", () => {
  const sources = systemSources(buildConfig());
  assert.ok(sources.includes("cli_prefix"));
  assert.ok(sources.includes("identity"));
  assert.ok(sources.includes("env_info"));
});

test("builder: 单段覆盖只改该段，动态段照常构建（与 v1 整段替换的核心差异）", () => {
  const config = buildConfig({
    customSystemSegments: { main: { cliPrefix: { mode: "override", text: "You are a pirate." } } },
  });
  assert.equal(sectionContent(config, "cli_prefix"), "You are a pirate.");
  // identity 与全部动态段不受影响。
  assert.equal(sectionContent(config, "identity"), BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS.identity);
  assert.ok(systemSources(config).includes("env_info"));
});

test("builder: 追加 = 内置原文 + 空行 + 用户文本", () => {
  const config = buildConfig({
    customSystemSegments: { main: { identity: { mode: "append", text: "Extra rule." } } },
  });
  assert.equal(
    sectionContent(config, "identity"),
    `${BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS.identity}\n\nExtra rule.`,
  );
});

test("builder: 清空让该段退出 system prompt，其他段不受影响", () => {
  const config = buildConfig({
    customSystemSegments: { main: { cliPrefix: { mode: "clear", text: "" } } },
  });
  const sources = systemSources(config);
  assert.ok(!sources.includes("cli_prefix"));
  assert.ok(sources.includes("identity"));
  assert.ok(sources.includes("env_info"));
});

test("builder: 桌面上下文注入门保留——非 desktop surface 不注入，desktop surface 才注入", () => {
  const segments = { main: { desktop: { mode: "override" as const, text: "Desktop only." } } };
  const nonDesktop = buildConfig({ customSystemSegments: segments, presentationSurface: "cli" });
  assert.ok(!systemSources(nonDesktop).includes("desktop_context"));

  const desktop = buildConfig({
    customSystemSegments: segments,
    presentationSurface: "zcode_desktop",
  });
  assert.equal(sectionContent(desktop, "desktop_context"), "Desktop only.");
});

test("builder: 桌面上下文清空后 desktop surface 也不再注入该段", () => {
  const config = buildConfig({
    customSystemSegments: { main: { desktop: { mode: "clear", text: "" } } },
    presentationSurface: "zcode_desktop",
  });
  assert.ok(!systemSources(config).includes("desktop_context"));
});

test("builder: workflowSubagent 追加作用在 workflowActor 身份段（persona 之后）", () => {
  const config = buildConfig({
    workflowActor: { name: "actor", persona: "Persona text." },
    customSystemSegments: {
      workflowSubagent: { identity: { mode: "append", text: "Extra." } },
    },
  });
  const content = sectionContent(config, "workflow_actor_identity");
  assert.ok(content?.includes("Persona text."));
  assert.ok(content?.endsWith("\n\nExtra."));
});

test("builder: workflowSubagent 清空则不构建身份段，其余段照常", () => {
  const config = buildConfig({
    workflowActor: { name: "actor", persona: "Persona text." },
    customSystemSegments: { workflowSubagent: { identity: { mode: "clear", text: "" } } },
  });
  const sources = systemSources(config);
  assert.ok(!sources.includes("workflow_actor_identity"));
  assert.ok(sources.includes("env_info"));
});

test("builder: main 作用域对 workflowActor 不生效", () => {
  const config = buildConfig({
    workflowActor: { name: "actor", persona: "Persona text." },
    customSystemSegments: { main: { cliPrefix: { mode: "clear", text: "" } } },
  });
  const content = sectionContent(config, "workflow_actor_identity");
  assert.ok(content?.includes("Persona text."));
});

test("builder: workflowActor 身份段文本与 shared 模板同源（core 只加 section 元数据）", () => {
  // 无 persona 的形态必须与设置页「工作流子代理」页签回显的模板逐字一致。
  assert.equal(
    sectionContent(buildConfig({ workflowActor: {} }), "workflow_actor_identity"),
    BUILTIN_SYSTEM_PROMPT_WORKFLOW_ACTOR_IDENTITY,
  );
  // 带角色名时同样走 shared 的同一个实现。
  assert.equal(
    sectionContent(buildConfig({ workflowActor: { name: "actor" } }), "workflow_actor_identity"),
    buildBuiltinWorkflowActorIdentityPrompt({ name: "actor" }),
  );
});

test("builder: v1 customSystemPrompt 非空时整体压过分段配置", () => {
  const config = buildConfig({
    customSystemPrompt: "You are a pirate.",
    customSystemSegments: { main: { cliPrefix: { mode: "override", text: "ignored" } } },
  });
  const sources = systemSources(config);
  assert.ok(sources.includes("custom_system_prompt"));
  // v1 保留 CLI 前缀（只替换 stable 身份段），分段对它的改写被整体忽略。
  assert.equal(sectionContent(config, "cli_prefix"), BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS.cliPrefix);
  assert.ok(!sources.includes("identity"));
});
