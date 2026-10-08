import assert from "node:assert/strict";
import test from "node:test";
import { BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS } from "@zcode/shared";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";
import fa from "../src/i18n/locales/fa.js";
import {
  MAX_SYSTEM_PROMPT_SEGMENT_LENGTH,
  canonicalizeSystemPromptSegments,
  countSavedSystemPromptSegments,
  createAllOverrideMainDraft,
  createEmptySystemPromptDraft,
  createSystemPromptDraftFromSaved,
  hasOverLimitSystemPromptSegment,
  isSystemPromptDraftDirty,
  resolveLegacySystemPromptMigration,
  resolveSystemPromptSaveMessageId,
  serializeSystemPromptDraft,
  type SystemPromptDraft,
} from "../src/settings/systemPromptDraft.js";

// 设置页「系统提示词」分段编辑器的纯决策规则（docs/spec/custom-system-prompt.md v2）。
// 钉住的都是容易写反的点：继承不落盘、空文本覆盖 ≠ 清空、dirty 不因 trim/键序误判、
// v1 整段字段的一次性迁移幂等。

test("序列化：继承不落盘，只有覆盖/追加/清空进结果", () => {
  const draft = createEmptySystemPromptDraft();
  draft.main.cliPrefix = { mode: "override", text: "prefix" };
  draft.main.desktop = { mode: "clear", text: "" };
  assert.deepEqual(serializeSystemPromptDraft(draft), {
    main: {
      cliPrefix: { mode: "override", text: "prefix" },
      desktop: { mode: "clear", text: "" },
    },
  });
});

test("序列化：空白文本的覆盖/追加等同「什么都没写」，不会被当成清空", () => {
  const draft = createEmptySystemPromptDraft();
  draft.main.identity = { mode: "override", text: "   \n " };
  draft.main.cliPrefix = { mode: "append", text: "" };
  assert.deepEqual(serializeSystemPromptDraft(draft), {});
});

test("序列化：文本原样保留（内置身份原文以空行开头，trim 会破坏逐字一致）", () => {
  const draft = createEmptySystemPromptDraft();
  draft.workflowSubagent.identity = { mode: "append", text: "\npersona extra" };
  draft.main.desktop = { mode: "clear", text: "遗留文本" };
  assert.deepEqual(serializeSystemPromptDraft(draft), {
    main: { desktop: { mode: "clear", text: "" } },
    workflowSubagent: { identity: { mode: "append", text: "\npersona extra" } },
  });
});

test("dirty：未编辑为 false，改模式/改文本为 true", () => {
  const saved = { main: { identity: { mode: "override" as const, text: "x" } } };
  const untouched = createSystemPromptDraftFromSaved(saved);
  assert.equal(isSystemPromptDraftDirty(untouched, saved), false);

  const changedText: SystemPromptDraft = {
    ...untouched,
    main: { ...untouched.main, identity: { mode: "override", text: "y" } },
  };
  assert.equal(isSystemPromptDraftDirty(changedText, saved), true);

  const changedMode: SystemPromptDraft = {
    ...untouched,
    main: { ...untouched.main, identity: { mode: "append", text: "x" } },
  };
  assert.equal(isSystemPromptDraftDirty(changedMode, saved), true);
});

test("dirty：两侧都走 canonicalize——键序不同不产生假 dirty", () => {
  // 已保存值键序与 canonical 顺序相反。
  const saved = {
    workflowSubagent: { identity: { mode: "override" as const, text: "y" } },
    main: { identity: { mode: "override" as const, text: "x" } },
  };
  const draft = createEmptySystemPromptDraft();
  draft.main.identity = { mode: "override", text: "x" };
  draft.workflowSubagent.identity = { mode: "override", text: "y" };
  assert.equal(isSystemPromptDraftDirty(draft, saved), false);
  assert.deepEqual(canonicalizeSystemPromptSegments(saved), {
    main: { identity: { mode: "override", text: "x" } },
    workflowSubagent: { identity: { mode: "override", text: "y" } },
  });
});

test("dirty：空白文本的覆盖条目等同未改写（不是清空，也不算 dirty）", () => {
  const draft = createEmptySystemPromptDraft();
  draft.main.identity = { mode: "override", text: "   " };
  assert.equal(isSystemPromptDraftDirty(draft, undefined), false);
});

test("徽标计数：按已保存值统计两作用域非继承条目", () => {
  assert.equal(countSavedSystemPromptSegments(undefined), 0);
  assert.equal(countSavedSystemPromptSegments({}), 0);
  assert.equal(
    countSavedSystemPromptSegments({
      main: { cliPrefix: { mode: "clear", text: "" }, identity: { mode: "override", text: "x" } },
      workflowSubagent: { identity: { mode: "append", text: "y" } },
    }),
    3,
  );
});

test("保存提示语：全部继承 = 已恢复默认，否则 = 已保存", () => {
  assert.equal(resolveSystemPromptSaveMessageId({}), "settings.systemPromptRestored");
  assert.equal(
    resolveSystemPromptSaveMessageId({ main: { identity: { mode: "override", text: "x" } } }),
    "settings.systemPromptSaved",
  );
});

test("超限拦截：单段 > 200_000 才为 true", () => {
  const draft = createEmptySystemPromptDraft();
  draft.main.identity = { mode: "override", text: "a".repeat(MAX_SYSTEM_PROMPT_SEGMENT_LENGTH) };
  assert.equal(hasOverLimitSystemPromptSegment(draft), false);
  draft.main.identity = {
    mode: "override",
    text: "a".repeat(MAX_SYSTEM_PROMPT_SEGMENT_LENGTH + 1),
  };
  assert.equal(hasOverLimitSystemPromptSegment(draft), true);
});

test("v1 迁移：旧整段字段非空 → main.identity 覆盖 + 清空旧字段", () => {
  const migration = resolveLegacySystemPromptMigration("You are a pirate.", undefined);
  assert.deepEqual(migration, {
    customSystemSegments: { main: { identity: { mode: "override", text: "You are a pirate." } } },
    customSystemPrompt: "",
  });
});

test("v1 迁移：空白/缺席 → null（幂等，迁移后旧字段为空串）", () => {
  assert.equal(resolveLegacySystemPromptMigration(undefined, undefined), null);
  assert.equal(resolveLegacySystemPromptMigration("", undefined), null);
  assert.equal(resolveLegacySystemPromptMigration("   ", undefined), null);
});

test("v1 迁移：两字段同在时保留已有分段条目，只补 main.identity", () => {
  const migration = resolveLegacySystemPromptMigration("legacy", {
    main: { cliPrefix: { mode: "clear", text: "" } },
  });
  assert.deepEqual(migration?.customSystemSegments, {
    main: {
      cliPrefix: { mode: "clear", text: "" },
      identity: { mode: "override", text: "legacy" },
    },
  });
});

test("全部改为自定义：只改主身份三段并预填内置原文，工作流子代理段不参与", () => {
  const draft = createAllOverrideMainDraft(BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS);
  assert.deepEqual(serializeSystemPromptDraft(draft), {
    main: {
      cliPrefix: { mode: "override", text: BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS.cliPrefix },
      identity: { mode: "override", text: BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS.identity },
      desktop: { mode: "override", text: BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS.desktop },
    },
  });
});

test("长度上限与 shared schema 同一量程", () => {
  assert.equal(MAX_SYSTEM_PROMPT_SEGMENT_LENGTH, 200_000);
});

test("三语言 locale 均定义分段编辑器全部文案", () => {
  const keys = [
    "settings.systemPrompt",
    "settings.systemPromptDescription",
    "settings.systemPromptCustomizedCount",
    "settings.systemPromptRestoreAll",
    "settings.systemPromptAllToCustom",
    "settings.systemPrompt.tab.main",
    "settings.systemPrompt.tab.workflowSubagent",
    "settings.systemPrompt.mainHint",
    "settings.systemPrompt.workflowHint",
    "settings.systemPrompt.segment.cliPrefix",
    "settings.systemPrompt.segment.identity",
    "settings.systemPrompt.segment.desktop",
    "settings.systemPrompt.systemMessage",
    "settings.systemPrompt.conditionalInjection",
    "settings.systemPrompt.stableSegmentHint",
    "settings.systemPrompt.modeLabel",
    "settings.systemPrompt.mode.inherit",
    "settings.systemPrompt.mode.override",
    "settings.systemPrompt.mode.append",
    "settings.systemPrompt.mode.clear",
    "settings.systemPrompt.clearedHint",
    "settings.systemPrompt.appendPlaceholder",
    "settings.systemPrompt.overridePlaceholder",
    "settings.systemPromptApplyHint",
    "settings.systemPromptSave",
    "settings.systemPromptSaved",
    "settings.systemPromptRestored",
    "settings.systemPromptSaveFailed",
    "settings.systemPromptOverLimit",
  ];
  for (const key of keys) {
    assert.ok(zhCN[key], `zh-CN 缺 ${key}`);
    assert.ok(enUS[key], `en-US 缺 ${key}`);
    assert.ok(fa[key], `fa 缺 ${key}`);
  }
});
