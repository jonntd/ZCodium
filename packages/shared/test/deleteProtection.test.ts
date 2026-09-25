import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";
import { appRuntimePreferencesChangedBroadcastPayloadSchema } from "../src/app-runtime-preferences.js";
import {
  DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  zcodeProtocolMethods,
  zcodeSessionRuntimePreferencesResultSchema,
  zcodeWorkspaceUpdateDeleteProtectionPreferencesParamsSchema,
  zcodeWorkspaceUpdateDeleteProtectionPreferencesResultSchema,
} from "../src/zcode-protocol/index.js";

// 删除保护/批量删除审批（docs/spec/delete-protection.md §2/§3）：
// AppSettings 是唯一持久化事实源；协议层只做形状与量程校验。

test("appSettings: 旧配置缺字段时删除保护按默认值（开启 + 阈值 50）", () => {
  const parsed = appSettingsSchema.parse({ locale: "zh-CN" });
  assert.equal(parsed.deleteProtectionEnabled, true);
  assert.equal(parsed.batchDeleteApprovalThreshold, 50);
});

test("appSettings: 用户显式关闭/改阈值时保留原值", () => {
  const parsed = appSettingsSchema.parse({
    deleteProtectionEnabled: false,
    batchDeleteApprovalThreshold: 3,
  });
  assert.equal(parsed.deleteProtectionEnabled, false);
  assert.equal(parsed.batchDeleteApprovalThreshold, 3);
});

test("appSettingsPatch: 阈值必须是 1..10000 的整数", () => {
  assert.equal(
    appSettingsPatchSchema.safeParse({ batchDeleteApprovalThreshold: 0 }).success,
    false,
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({ batchDeleteApprovalThreshold: 10001 }).success,
    false,
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({ batchDeleteApprovalThreshold: 1.5 }).success,
    false,
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({ batchDeleteApprovalThreshold: "50" }).success,
    false,
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({ batchDeleteApprovalThreshold: 50 }).success,
    true,
  );
  assert.equal(appSettingsPatchSchema.safeParse({ deleteProtectionEnabled: false }).success, true);
});

test("跨窗口广播: 旧窗口 payload 缺新字段时按默认值补齐，未知字段拒绝", () => {
  const legacy = appRuntimePreferencesChangedBroadcastPayloadSchema.parse({
    askUserQuestionAutoResolutionEnabled: true,
    modelIoFullRetentionEnabled: false,
  });
  assert.equal(legacy.deleteProtectionEnabled, true);
  assert.equal(legacy.batchDeleteApprovalThreshold, 50);

  const current = appRuntimePreferencesChangedBroadcastPayloadSchema.parse({
    askUserQuestionAutoResolutionEnabled: false,
    modelIoFullRetentionEnabled: true,
    deleteProtectionEnabled: false,
    batchDeleteApprovalThreshold: 10,
  });
  assert.equal(current.deleteProtectionEnabled, false);
  assert.equal(current.batchDeleteApprovalThreshold, 10);

  assert.equal(
    appRuntimePreferencesChangedBroadcastPayloadSchema.safeParse({
      askUserQuestionAutoResolutionEnabled: true,
      extra: 1,
    }).success,
    false,
  );
});

test("协议: 运行时偏好结果对旧 Host（无 deleteProtection 字段）保持兼容", () => {
  const oldHost = zcodeSessionRuntimePreferencesResultSchema.parse({
    nativeSearchEnhancementsEnabled: true,
    askUserQuestionAutoResolutionEnabled: true,
    modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
  });
  assert.equal(oldHost.deleteProtection, undefined);

  const newHost = zcodeSessionRuntimePreferencesResultSchema.parse({
    nativeSearchEnhancementsEnabled: true,
    askUserQuestionAutoResolutionEnabled: true,
    modelContextBudgetStrategy: DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY,
    deleteProtection: { deleteProtectionEnabled: false, batchDeleteApprovalThreshold: 2 },
  });
  assert.deepEqual(newHost.deleteProtection, {
    deleteProtectionEnabled: false,
    batchDeleteApprovalThreshold: 2,
  });
});

test("协议: 删除保护更新方法的 params/result 形状与量程", () => {
  const params = zcodeWorkspaceUpdateDeleteProtectionPreferencesParamsSchema.safeParse({
    workspace: { workspaceKey: "k", workspacePath: "/tmp/ws" },
    preferences: { deleteProtectionEnabled: true, batchDeleteApprovalThreshold: 50 },
  });
  assert.equal(params.success, true);

  assert.equal(
    zcodeWorkspaceUpdateDeleteProtectionPreferencesParamsSchema.safeParse({
      workspace: { workspaceKey: "k", workspacePath: "/tmp/ws" },
      preferences: { deleteProtectionEnabled: true, batchDeleteApprovalThreshold: 0 },
    }).success,
    false,
  );
  assert.equal(
    zcodeWorkspaceUpdateDeleteProtectionPreferencesParamsSchema.safeParse({
      workspace: { workspaceKey: "k", workspacePath: "/tmp/ws" },
      preferences: { deleteProtectionEnabled: true, batchDeleteApprovalThreshold: 50, extra: 1 },
    }).success,
    false,
  );

  const result = zcodeWorkspaceUpdateDeleteProtectionPreferencesResultSchema.safeParse({
    workspace: { workspaceKey: "k", workspacePath: "/tmp/ws" },
    deleteProtectionEnabled: true,
    batchDeleteApprovalThreshold: 50,
    updatedSessionCount: 2,
  });
  assert.equal(result.success, true);
});

test("协议: 删除保护方法名已注册", () => {
  assert.equal(
    zcodeProtocolMethods.workspaceUpdateDeleteProtectionPreferences,
    "workspace/updateDeleteProtectionPreferences",
  );
});
