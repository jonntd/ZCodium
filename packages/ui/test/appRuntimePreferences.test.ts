import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAppRuntimePreferenceSnapshot,
  touchesAppRuntimePreferences,
} from "../src/settings/appRuntimePreferences.js";

// App 设置 → CLI 运行时偏好快照（docs/spec/custom-system-prompt.md 的「settings → preferences
// 映射点」）。host 侧每次都用快照整体替换 `latestAppRuntimePreferences`，新注册的 CLI client
// 再重放它——**漏字段就等于丢值**。这条不变量曾经在 Root 的初始化快照里被破坏过
// （customSystemPrompt / customSystemSegments 缺席），这里钉成回归测试。

test("快照始终携带系统提示词两个字段——settings 为空也给确定值", () => {
  const snapshot = buildAppRuntimePreferenceSnapshot(null);
  assert.equal(snapshot.customSystemPrompt, "");
  assert.deepEqual(snapshot.customSystemSegments, {});
  assert.equal(snapshot.askUserQuestionAutoResolutionEnabled, true);
  assert.equal(snapshot.deleteProtectionEnabled, true);
  assert.equal(snapshot.batchDeleteApprovalThreshold, 50);
});

test("快照保留 settings 里的系统提示词（含清空态 {}）", () => {
  const snapshot = buildAppRuntimePreferenceSnapshot({
    customSystemPrompt: "You are a pirate.",
    customSystemSegments: {},
  } as never);
  assert.equal(snapshot.customSystemPrompt, "You are a pirate.");
  assert.deepEqual(snapshot.customSystemSegments, {});
});

test("patch 覆盖 settings，但未在 patch 里的偏好字段仍从 settings 补齐", () => {
  const snapshot = buildAppRuntimePreferenceSnapshot(
    {
      customSystemPrompt: "saved",
      customSystemSegments: { main: { identity: { mode: "append", text: "x" } } },
      deleteProtectionEnabled: false,
    } as never,
    { customSystemSegments: {} },
  );
  // patch 显式给出的值优先（{} = 全部恢复继承，不能被 settings 的旧值顶掉）。
  assert.deepEqual(snapshot.customSystemSegments, {});
  // 未在 patch 里的字段必须保留 settings 的值，否则会被整体覆盖掉。
  assert.equal(snapshot.customSystemPrompt, "saved");
  assert.equal(snapshot.deleteProtectionEnabled, false);
});

test("触发判定：只有偏好字段才触发同步", () => {
  assert.equal(touchesAppRuntimePreferences({}), false);
  assert.equal(touchesAppRuntimePreferences({ locale: "zh-CN" } as never), false);
  assert.equal(touchesAppRuntimePreferences({ customSystemSegments: {} }), true);
  assert.equal(touchesAppRuntimePreferences({ customSystemPrompt: "" }), true);
  assert.equal(touchesAppRuntimePreferences({ deleteProtectionEnabled: true }), true);
});

test("回复语言：快照恒携带（空串 = 跟随用户消息），清空态可穿越 RPC", () => {
  const empty = buildAppRuntimePreferenceSnapshot(null);
  assert.equal(empty.language, "");

  const saved = buildAppRuntimePreferenceSnapshot({ language: "简体中文" } as never);
  assert.equal(saved.language, "简体中文");

  // 清空态：patch 显式给空串必须优先于 settings 的旧值，否则恢复默认永远送不到 CLI。
  const cleared = buildAppRuntimePreferenceSnapshot({ language: "简体中文" } as never, {
    language: "",
  });
  assert.equal(cleared.language, "");

  // 触发判定：空串也是显式变更（恢复默认），必须触发同步。
  assert.equal(touchesAppRuntimePreferences({ language: "" }), true);
  assert.equal(touchesAppRuntimePreferences({ language: "English" }), true);
});
