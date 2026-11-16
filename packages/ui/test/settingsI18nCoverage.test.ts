import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 设置页（Scope 分组 / 远端「用户」/ MCP 信任与失败态）文案的主 locale 覆盖钉子。
 *
 * Bug 原因：settings-scope 分组菜单与 workspace MCP 信任确认框合流时只同步了 ja/ko/ru 的
 * 文案，en-US / zh-CN 缺失，英文与中文界面直接渲染原始 key（如 "settings.scope.deviceOffline"）。
 * 这里按使用点（McpSettingsSection / HooksSection / SubagentsSection / settings-scope ui /
 * settingsSourceWorkspace 相邻页面）钉住这批 key，后续新增文案若再漏主 locale 会在本用例失败。
 */
const REQUIRED_KEYS = [
  // settings-scope：设备分组与离线 / 连接中提示
  "settings.scope.localDevice",
  "settings.scope.deviceOffline",
  "settings.scope.deviceConnecting",
  "settings.machine.unknownRemote",
  // workspace MCP 信任确认与状态
  "settings.mcp.trust.title",
  "settings.mcp.trust.revokeTitle",
  "settings.mcp.trust.description",
  "settings.mcp.trust.action",
  "settings.mcp.trust.revoke",
  "settings.mcp.trust.pending",
  "settings.mcp.trust.trusted",
  "settings.mcp.trust.failed",
  // MCP 配置加载失败态与开关落盘失败提示
  "settings.mcp.configLoadFailed",
  "settings.mcp.persistFailed",
  // 数据同步入口
  "settings.mcp.remoteSync.open",
  "settings.skills.remoteSync.open",
] as const;

describe("settings pages i18n coverage (primary locales)", () => {
  for (const locale of ["en-US", "zh-CN"] as const) {
    it(`covers required settings keys in ${locale}`, () => {
      const content = readFileSync(
        new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url),
        "utf-8",
      );
      const missing = REQUIRED_KEYS.filter((key) => !content.includes(`"${key}"`));
      expect(missing).toEqual([]);
    });
  }

  it("trust title placeholders keep the {name} interpolation", () => {
    for (const locale of ["en-US", "zh-CN"] as const) {
      const content = readFileSync(
        new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url),
        "utf-8",
      );
      for (const key of ["settings.mcp.trust.title", "settings.mcp.trust.revokeTitle"]) {
        expect(content).toMatch(new RegExp(`"${key}": "[^"]*\\{name\\}`));
      }
    }
  });
});
