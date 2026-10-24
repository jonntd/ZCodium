// v6「官方形态」UI 的 SSR 断言（spec vps-relay-bridge.md §19）：
// 主面 = 开关 + 中继地址；密钥（roomKey / channelKey）不出现任何输入框，
// 高级设置只提供「重置密钥」。渲染用 renderToStaticMarkup（effects 不跑，
// 轮询/保存行为由 Main 侧集成测试与真机验证覆盖）。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RemoteRelayStatus } from "@zcode/shared";
import { RemoteRelayConfigForm } from "@/RemoteRelayConfigForm.js";
import { RemoteRelayAccessPanel } from "@/RemoteRelayAccessPanel.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: (descriptor: { id: string }) => descriptor.id,
    },
    locale: "en-US",
  }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    remoteRelayGetStatus: vi.fn(async () => STATUS),
    remoteRelayStart: vi.fn(async () => STATUS),
    remoteRelayStop: vi.fn(async () => STATUS),
    remoteRelaySetConfig: vi.fn(async () => STATUS),
  }),
}));

const STATUS: RemoteRelayStatus = {
  configured: true,
  running: true,
  connected: true,
  source: "file",
  e2ee: true,
  slots: 3,
  lanShareUrl: "http://192.168.1.10:3180/?token=k#e",
  publicShareUrl: null,
  windowId: null,
  lanAddresses: ["192.168.1.10"],
  configFilePath: "/tmp/remote-relay.json",
  fileConfig: {
    url: "ws://192.168.1.10:3180",
    roomKey: "k".repeat(43),
    channelKey: "c".repeat(43),
    e2ee: true,
    slots: 3,
  },
};

describe("RemoteRelayConfigForm（v6.1 极简高级设置）", () => {
  const html = renderToStaticMarkup(
    createElement(RemoteRelayConfigForm, { status: STATUS, onSaved: () => {}, defaultOpen: true }),
  );

  it("高级设置只剩密钥说明 + 低频项指引，没有任何部署字段输入框", () => {
    // 密钥本体（含 password 输入形态）一律不上屏：值只随链接分发
    expect(html).not.toContain("settings.remoteRelay.roomKey");
    expect(html).not.toContain("settings.remoteRelay.channelKey");
    expect(html).not.toContain("k".repeat(43));
    expect(html).not.toContain("c".repeat(43));
    expect(html).not.toContain('type="password"');
    // 低频部署项（公开地址/槽位/工作区/自启/E2EE 开关）全部移出 UI
    expect(html).not.toContain("settings.remoteRelay.slots");
    expect(html).not.toContain("settings.remoteRelay.workspace");
    expect(html).not.toContain("settings.remoteRelay.autoStart");
    expect(html).not.toContain("settings.remoteRelay.publicUrl");
    expect(html).not.toContain("settings.remoteRelay.saveHint");
    // 保留：低频项指引 + 配置文件路径 + 重置密钥
    expect(html).toContain("settings.remoteRelay.lowFreqHint");
    expect(html).toContain("settings.remoteRelay.configDescription");
    expect(html).toContain("settings.remoteRelay.rotateKeys");
    // 没有独立「保存」按钮（地址在主卡失焦落盘、重置密钥即点即存）
    expect(html).not.toContain("settings.remoteRelay.save\"");
  });
});

describe("RemoteRelayAccessPanel（v6 官方形态）", () => {
  const html = renderToStaticMarkup(createElement(RemoteRelayAccessPanel));

  it("主面有开关（role=switch）与中继地址输入框", () => {
    expect(html).toContain('role="switch"');
    expect(html).toContain('placeholder="192.168.1.10:3180"');
    // 协议分段（明文 / TLS）仍在主面；启停语义只由开关承载（start/stop 仅出现在
    // 开关的 aria-label，不再有独立按钮）。
    expect(html).toContain("settings.remoteRelay.scenarioLan");
    expect(html).toContain("settings.remoteRelay.scenarioPublic");
    expect((html.match(/role="switch"/g) ?? []).length).toBe(1);
  });
});
