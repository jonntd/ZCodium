import assert from "node:assert/strict";
import test from "node:test";
import { createContextBuilder } from "../src/context/builder.js";
import type { ContextBuilderConfig } from "../src/context/types.js";
import type { EnvInfo } from "../src/runtime/deps.js";

// 自定义系统提示词（docs/spec/custom-system-prompt.md）在 builder 层的验收语义：
// 1) 非空 customSystemPrompt 整段替换 stable 身份段，并跳过全部动态 system 段
//    （env info / session guidance / memory 等），meta_user（AGENTS.md / 日期）保留；
// 2) 还原（undefined/空白）回到内置拼装：identity + env info 重新出现。

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

function buildConfig(customSystemPrompt?: string): ContextBuilderConfig {
  return {
    workingDirectory: "/repo",
    envInfo: ENV_INFO,
    currentDate: "2026-10-06",
    ...(customSystemPrompt === undefined ? {} : { customSystemPrompt }),
  };
}

function systemSectionSources(config: ContextBuilderConfig) {
  return createContextBuilder(config)
    .build()
    .sections.filter((section) => section.injectionTarget === "system")
    .map((section) => section.source);
}

test("builder: 无 customSystemPrompt 时使用内置身份段并包含环境信息", () => {
  const sources = systemSectionSources(buildConfig());
  assert.ok(sources.includes("identity"));
  assert.ok(sources.includes("env_info"));
});

test("builder: 非空 customSystemPrompt 整段替换并跳过动态 system 段", () => {
  const sources = systemSectionSources(buildConfig("You are a pirate."));
  assert.ok(sources.includes("custom_system_prompt"));
  assert.ok(!sources.includes("identity"));
  // 动态段随替换一并跳过（builder 既有契约，不是本功能新增行为）。
  assert.ok(!sources.includes("env_info"));
});

test("builder: 还原（undefined）后回到内置拼装", () => {
  const sources = systemSectionSources(buildConfig(undefined));
  assert.ok(!sources.includes("custom_system_prompt"));
  assert.ok(sources.includes("identity"));
  assert.ok(sources.includes("env_info"));
});

test("builder: 空白提示词视同还原，不产生空 section", () => {
  const sources = systemSectionSources(buildConfig("   \n  "));
  assert.ok(!sources.includes("custom_system_prompt"));
  assert.ok(sources.includes("identity"));
});
