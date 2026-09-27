import assert from "node:assert/strict";
import test from "node:test";
import zhCN from "../src/i18n/locales/zh-CN.js";
import enUS from "../src/i18n/locales/en-US.js";

// 右侧面板文件浏览器 tab（docs/spec/sidebar-file-viewer.md）：
// tab 条标题、"+" 菜单与 Command Center 类型标签共用 sidePane.files 文案，
// 两个 locale 必须同时存在，缺失会在 tab 条上裸露 message id。

test("中英文 locale 均定义右侧面板文件 tab 文案", () => {
  assert.equal(zhCN["sidePane.files"], "文件");
  assert.equal(enUS["sidePane.files"], "Files");
});

test("中英文 locale 均定义左侧行按钮打开文件面板的文案", () => {
  assert.equal(zhCN["workspaceSidebar.openSidePaneFiles"], "打开文件面板");
  assert.equal(enUS["workspaceSidebar.openSidePaneFiles"], "Open files panel");
});
