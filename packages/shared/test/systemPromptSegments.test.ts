import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";
import { appRuntimePreferencesChangedBroadcastPayloadSchema } from "../src/app-runtime-preferences.js";
import {
  BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS,
  SYSTEM_PROMPT_SEGMENT_IDS,
  SYSTEM_PROMPT_SEGMENT_TEXT_MAX_LENGTH,
  countCustomizedSystemSegments,
  customSystemSegmentsSchema,
  normalizeCustomSystemSegments,
} from "../src/system-prompt-segments.js";
import {
  zcodeProtocolMethods,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeWorkspaceUpdateSystemSegmentsParamsSchema,
  zcodeWorkspaceUpdateSystemSegmentsResultSchema,
} from "../src/zcode-protocol/index.js";

// 分段系统提示词（docs/spec/custom-system-prompt.md v2）：
// 关键边界——「继承」不落盘（条目缺席）、空文本的 override/append 不是清空（剥离）、
// `{}` 是「已全部恢复继承」的合法显式值（必须能穿越 RPC 与广播）。

const WORKSPACE = { workspaceKey: "w1", workspacePath: "/repo" };

test("schema: 空对象合法（= 全部继承），未知段 id 被拒绝", () => {
  assert.equal(customSystemSegmentsSchema.safeParse({}).success, true);
  assert.equal(
    customSystemSegmentsSchema.safeParse({ main: { unknown: { mode: "clear" } } }).success,
    false,
  );
});

test("schema: mode 只接受 override/append/clear（inherit 不落盘）", () => {
  assert.equal(
    customSystemSegmentsSchema.safeParse({ main: { identity: { mode: "inherit" } } }).success,
    false,
  );
  assert.equal(
    customSystemSegmentsSchema.safeParse({ main: { identity: { mode: "clear", text: "" } } })
      .success,
    true,
  );
});

test("schema: 单段文本上限 200_000", () => {
  assert.equal(SYSTEM_PROMPT_SEGMENT_TEXT_MAX_LENGTH, 200_000);
  assert.equal(
    customSystemSegmentsSchema.safeParse({
      main: { identity: { mode: "override", text: "a".repeat(200_001) } },
    }).success,
    false,
  );
  assert.equal(
    customSystemSegmentsSchema.safeParse({
      main: { identity: { mode: "override", text: "a".repeat(200_000) } },
    }).success,
    true,
  );
});

test("normalize: 空文本 override/append 被剥离（不是清空），clear 去 text", () => {
  const normalized = normalizeCustomSystemSegments({
    main: {
      cliPrefix: { mode: "override", text: "   " },
      identity: { mode: "append", text: "extra" },
      desktop: { mode: "clear", text: "ignored" },
    },
  });
  assert.deepEqual(normalized, {
    main: {
      identity: { mode: "append", text: "extra" },
      desktop: { mode: "clear", text: "" },
    },
  });
});

test("normalize: 全空返回 {}（= 全部继承）", () => {
  assert.deepEqual(normalizeCustomSystemSegments({}), {});
  assert.deepEqual(
    normalizeCustomSystemSegments({ main: { identity: { mode: "override", text: "\n" } } }),
    {},
  );
});

test("count: 两作用域合计非继承条目", () => {
  assert.equal(countCustomizedSystemSegments({}), 0);
  assert.equal(
    countCustomizedSystemSegments({
      main: { identity: { mode: "override", text: "x" } },
      workflowSubagent: { identity: { mode: "append", text: "y" } },
    }),
    2,
  );
});

test("builtin: 三段内置原文均非空且覆盖全部段 id", () => {
  for (const segmentId of SYSTEM_PROMPT_SEGMENT_IDS) {
    assert.ok(BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS[segmentId].length > 0, `缺内置原文 ${segmentId}`);
  }
});

test("appSettings: 分段字段进存储 schema（否则写盘被 strip、开关回弹）", () => {
  assert.equal(appSettingsSchema.parse({ locale: "zh-CN" }).customSystemSegments, undefined);
  const parsed = appSettingsSchema.parse({
    customSystemSegments: { main: { identity: { mode: "override", text: "x" } } },
  });
  assert.deepEqual(parsed.customSystemSegments, {
    main: { identity: { mode: "override", text: "x" } },
  });
  assert.equal(
    appSettingsPatchSchema.safeParse({ customSystemSegments: { main: { unknown: {} } } }).success,
    false,
  );
});

test("broadcast: 分段字段缺席保持 undefined，{} 原样保留", () => {
  const withoutField = appRuntimePreferencesChangedBroadcastPayloadSchema.parse({
    askUserQuestionAutoResolutionEnabled: true,
  });
  assert.equal(withoutField.customSystemSegments, undefined);
  const withEmpty = appRuntimePreferencesChangedBroadcastPayloadSchema.parse({
    askUserQuestionAutoResolutionEnabled: true,
    customSystemSegments: {},
  });
  assert.deepEqual(withEmpty.customSystemSegments, {});
});

test("protocol: updateSystemSegments 参数允许空对象、拒绝未知段", () => {
  assert.equal(
    zcodeWorkspaceUpdateSystemSegmentsParamsSchema.safeParse({ workspace: WORKSPACE, segments: {} })
      .success,
    true,
  );
  assert.equal(
    zcodeWorkspaceUpdateSystemSegmentsParamsSchema.safeParse({
      workspace: WORKSPACE,
      segments: { main: { nope: { mode: "clear" } } },
    }).success,
    false,
  );
  assert.equal(
    zcodeProtocolMethods.workspaceUpdateSystemSegments,
    "workspace/updateSystemSegments",
  );
});

test("protocol: result 回显归一化分段与会话计数", () => {
  const parsed = zcodeWorkspaceUpdateSystemSegmentsResultSchema.parse({
    workspace: WORKSPACE,
    segments: {},
    updatedSessionCount: 3,
  });
  assert.deepEqual(parsed.segments, {});
  assert.equal(parsed.updatedSessionCount, 3);
});

test("protocol: 会话运行时偏好缺分段字段时旧 Host 兼容", () => {
  const parsed = zcodeSessionRuntimePreferencesResultSchema.parse({
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: true,
  });
  assert.equal(parsed.customSystemSegments, undefined);
});
