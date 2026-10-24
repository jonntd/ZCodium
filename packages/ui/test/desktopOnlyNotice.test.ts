import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DesktopOnlyNotice } from "@/DesktopOnlyNotice.js";

const labels: Record<string, string> = {
  "common.desktopOnly": "Desktop only",
  "workspaceHeader.help.desktopOnly":
    "Export logs, resource manager, updates and About are available on desktop only",
  "settings.browser.desktopOnly": "Browser data can only be managed on the desktop app.",
};

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }) => labels[descriptor.id] ?? descriptor.id,
    },
    locale: "en-US",
  }),
}));

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * B 类降级说明（docs/spec/web-remote-ui-parity.md §2.2-B）：桌面专属能力在 Web/中继页
 * 不再静默消失，统一用 DesktopOnlyNotice 交代。默认文案 `common.desktopOnly`，
 * 具体能力由调用方传 messageId；两种形态共享同一视觉语言。
 */
describe("DesktopOnlyNotice", () => {
  it("默认 block 形态：语义 role=note + 设置页先例的视觉", () => {
    const html = renderToStaticMarkup(createElement(DesktopOnlyNotice));
    expect(html).toContain('role="note"');
    expect(html).toContain('data-variant="block"');
    expect(html).toContain("Desktop only");
    expect(html).toContain("rounded-lg border");
  });

  it("menu 形态：无边框、弱化文字，可传自定义文案", () => {
    const html = renderToStaticMarkup(
      createElement(DesktopOnlyNotice, {
        variant: "menu",
        messageId: "workspaceHeader.help.desktopOnly",
      }),
    );
    expect(html).toContain('data-variant="menu"');
    expect(html).toContain("Export logs");
    expect(html).not.toContain("rounded-lg border");
  });

  it("帮助菜单 Web 分支与浏览器设置页都走统一组件", () => {
    // 帮助菜单：Web 端曾把导出日志/资源管理器/更新/关于整块静默隐藏。
    const help = readSource("packages/ui/src/WorkspaceHelpMenuButton.tsx");
    expect(help).toContain('messageId="workspaceHeader.help.desktopOnly"');
    // 浏览器设置页：先例的内联手写块已收敛进组件，防止再长出一份平行样式。
    const browser = readSource("packages/ui/src/settings/BrowserSettingsSection.tsx");
    expect(browser).toContain('messageId="settings.browser.desktopOnly"');
    expect(browser).not.toContain("rounded-lg border border-border bg-surface px-4 py-3");
  });
});
