import assert from "node:assert/strict";
import test from "node:test";
import enUS from "../src/i18n/locales/en-US.js";
import faIR from "../src/i18n/locales/fa.js";
import zhCN from "../src/i18n/locales/zh-CN.js";

// Web 远控页（`packages/web/src/main.tsx`）的「启动失败页」与「断线提示」渲染在 `Root`
// 之外（React 接管前就失败 / 不能卸载用户界面），此前用
// `/^zh\b/i.test(navigator.language)` 手判中英、完全绕过 i18n —— 这是「中继页 UI 与
// 桌面 App 不一致」的典型来源，见 docs/spec/web-remote-ui-parity.md §P0-2。
//
// 现在这两处改走下面 4 条词条。**任何一份 locale 漏掉，对应语言会直接显示 key 本身**
// （不报错、不 fallback），而 `pnpm typecheck` 抓不到 —— 所以这里锁一遍。
//
// 为什么只锁这 4 条、不做「三份 map 全量 key 对齐」：仓库当前存在既有漂移
// （实测 2026-10-09：fa-IR 缺 77 条、zh-CN 缺 `settings.memory.viewer.disabled`），
// 全量对齐断言会直接红，属于另一个议题，不在本次改动范围内。
const WEB_REMOTE_KEYS = [
  "webBootstrap.failed",
  "webConnectionLost.replaced",
  "webConnectionLost.disconnected",
  "webConnectionLost.reconnect",
] as const;

const LOCALES: Record<string, Record<string, string>> = {
  "zh-CN": zhCN as unknown as Record<string, string>,
  "en-US": enUS as unknown as Record<string, string>,
  "fa-IR": faIR as unknown as Record<string, string>,
};

test("Web 远控页文案：三份 locale 都定义了启动失败页 / 断线提示词条", () => {
  for (const [locale, messages] of Object.entries(LOCALES)) {
    for (const key of WEB_REMOTE_KEYS) {
      const value = messages[key];
      assert.ok(
        typeof value === "string" && value.trim().length > 0,
        `${locale} 缺少或为空: ${key}`,
      );
    }
  }
});
