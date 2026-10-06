import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";
import { appRuntimePreferencesChangedBroadcastPayloadSchema } from "../src/app-runtime-preferences.js";
import {
  zcodeProtocolMethods,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeWorkspaceUpdateSystemPromptParamsSchema,
  zcodeWorkspaceUpdateSystemPromptResultSchema,
} from "../src/zcode-protocol/index.js";

// 自定义系统提示词（docs/spec/custom-system-prompt.md）：
// AppSettings 是唯一持久化事实源；协议层只做形状与量程校验。
// 关键边界：空串合法（"恢复默认"必须能显式穿越 RPC，undefined 会被丢弃）。

test("appSettings: 缺字段时按内置默认处理", () => {
  const parsed = appSettingsSchema.parse({ locale: "zh-CN" });
  assert.equal(parsed.customSystemPrompt, undefined);
});

test("appSettings: 空串合法（恢复默认的显式载体），非空原样保留", () => {
  assert.equal(appSettingsSchema.parse({ customSystemPrompt: "" }).customSystemPrompt, "");
  assert.equal(
    appSettingsSchema.parse({ customSystemPrompt: "You are a pirate." }).customSystemPrompt,
    "You are a pirate.",
  );
});

test("appSettingsPatch: 超过 200_000 字符被拒绝", () => {
  assert.equal(
    appSettingsPatchSchema.safeParse({ customSystemPrompt: "a".repeat(200_001) }).success,
    false,
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({ customSystemPrompt: "a".repeat(200_000) }).success,
    true,
  );
});

test("broadcast: 旧发送方缺字段时 default('') 补齐，strict 不拒绝", () => {
  const parsed = appRuntimePreferencesChangedBroadcastPayloadSchema.parse({
    askUserQuestionAutoResolutionEnabled: true,
  });
  assert.equal(parsed.customSystemPrompt, "");
});

test("broadcast: 空串保留，不会折叠丢失", () => {
  const parsed = appRuntimePreferencesChangedBroadcastPayloadSchema.parse({
    askUserQuestionAutoResolutionEnabled: true,
    customSystemPrompt: "",
  });
  assert.equal(parsed.customSystemPrompt, "");
});

const WORKSPACE = { workspaceKey: "w1", workspacePath: "/repo" };

test("protocol: updateSystemPrompt 参数允许空串、拒绝超长", () => {
  assert.equal(
    zcodeWorkspaceUpdateSystemPromptParamsSchema.safeParse({
      workspace: WORKSPACE,
      systemPrompt: "",
    }).success,
    true,
  );
  assert.equal(
    zcodeWorkspaceUpdateSystemPromptParamsSchema.safeParse({
      workspace: WORKSPACE,
      systemPrompt: "a".repeat(200_001),
    }).success,
    false,
  );
  assert.equal(zcodeProtocolMethods.workspaceUpdateSystemPrompt, "workspace/updateSystemPrompt");
});

test("protocol: result 回显归一化值与会话计数", () => {
  const parsed = zcodeWorkspaceUpdateSystemPromptResultSchema.parse({
    workspace: WORKSPACE,
    systemPrompt: "",
    updatedSessionCount: 2,
  });
  assert.equal(parsed.systemPrompt, "");
  assert.equal(parsed.updatedSessionCount, 2);
});

test("protocol: 会话运行时偏好缺 customSystemPrompt 字段时旧 Host 兼容", () => {
  const parsed = zcodeSessionRuntimePreferencesResultSchema.parse({
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: false,
    askUserQuestionAutoResolutionEnabled: true,
  });
  assert.equal(parsed.customSystemPrompt, undefined);
});
