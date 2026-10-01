import assert from "node:assert/strict";
import test from "node:test";
import { resolveSidebarTogglePresentation } from "../src/desktopTopOverlayModel.js";

// 「切换侧边栏」按钮的三端呈现（docs/spec/sidebar-toggle-button.md）：
// 按钮在所有平台都必须有可见入口；平台间只允许「图标 vs logo 悬停」的形态差异。
// Web 入口（packages/web/src/main.tsx）不传任何平台标志，桌面渲染器显式传 isDesktop。

test("Web 端（平台标志缺省）与 macOS 一致展示图标按钮", () => {
  assert.equal(resolveSidebarTogglePresentation({}), "icon");
  assert.equal(
    resolveSidebarTogglePresentation({ isDesktop: false, isMacDesktop: false }),
    "icon",
    "显式 false 与缺省语义一致",
  );
  assert.equal(resolveSidebarTogglePresentation({ isDesktop: true, isMacDesktop: true }), "icon");
});

test("Windows / Linux 桌面保持 logo 悬停形态", () => {
  assert.equal(resolveSidebarTogglePresentation({ isDesktop: true, isWindowsDesktop: true }), "logo-hover");
  assert.equal(
    resolveSidebarTogglePresentation({ isDesktop: true, isMacDesktop: false, isWindowsDesktop: false }),
    "logo-hover",
    "isDesktop 且非 mac/win 即 Linux 桌面",
  );
});
