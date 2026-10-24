import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";

describe("DesktopWindowFrame", () => {
  it("uses an opaque root surface on Linux desktop", () => {
    const html = renderToStaticMarkup(
      createElement(
        DesktopWindowFrame,
        {
          title: "ZCode",
          isDesktop: true,
          isMacDesktop: false,
          isWindowsDesktop: false,
        },
        createElement("div", null, "content"),
      ),
    );

    // Bugfix: Linux 没有系统级磨砂材质兜底，根框架不能使用带透明混色的 alt 背景。
    expect(html).toContain("bg-background-win-alt");
    expect(html).not.toContain("bg-background-alt");
    expect(html).toContain('data-desktop-window-frame="true"');
    expect(html).toContain("rounded-[16px]");
    expect(html).toContain("[clip-path:inset(0_round_16px)]");
    expect(html).toContain("platform-linux-window-maximized:[clip-path:inset(0)]");
  });

  it("uses the independent web root surface in the browser shell", () => {
    const html = renderToStaticMarkup(
      createElement(
        DesktopWindowFrame,
        {
          title: "ZCode",
        },
        createElement("div", null, "content"),
      ),
    );

    // Bugfix: Web 端没有 Electron/macOS 的 vibrancy 底层，半透明 alt 背景会直接叠到浏览器底色上。
    // 2026-10 决策（spec web-remote-ui-parity.md §2.1-A5）：Web 不再复用 Windows 的 win-alt，
    // 走独立的 web-alt token，与 Windows 底色解耦。
    expect(html).toContain("bg-background-web-alt");
    expect(html).not.toContain("bg-background-win-alt");
    expect(html).not.toContain("bg-background-alt");
  });
});

it.each([
  { platform: "macOS", isMacDesktop: true, isWindowsDesktop: false, opaque: false },
  { platform: "Windows", isMacDesktop: false, isWindowsDesktop: true, opaque: true },
])(
  "preserves the $platform root background contract",
  ({ isMacDesktop, isWindowsDesktop, opaque }) => {
    const html = renderToStaticMarkup(
      createElement(DesktopWindowFrame, {
        title: "ZCode",
        isDesktop: true,
        isMacDesktop,
        isWindowsDesktop,
        children: createElement("div", null, "content"),
      }),
    );
    expect(html.includes("bg-background-alt")).toBe(!opaque);
    expect(html.includes("bg-background-win-alt")).toBe(opaque);
  },
);
