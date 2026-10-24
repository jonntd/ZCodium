// v6「官方形态」UI 的 SSR 断言（spec vps-relay-bridge.md §19 / §19.8）：
// 主面 = 开关 + 中继地址 + 链接/二维码；没有高级设置，密钥零展示；
// 唯一的密钥动作是卡片底部的「重置密钥」小字按钮。
// 渲染用 renderToStaticMarkup（effects 不跑，轮询/保存行为由真机验证覆盖）。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RemoteRelayStatus } from "@zcode/shared";
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
  lanShareUrl: null,
  publicShareUrl: "http://203.0.113.10:3180/?token=k#e",
  windowId: null,
  lanAddresses: ["192.168.1.10"],
  configFilePath: "/tmp/remote-relay.json",
  fileConfig: {
    url: "ws://203.0.113.10:3180",
    roomKey: "k".repeat(43),
    channelKey: "c".repeat(43),
    e2ee: true,
    slots: 3,
  },
};

describe("RemoteRelayAccessPanel（v6 官方形态，无高级设置）", () => {
  const html = renderToStaticMarkup(createElement(RemoteRelayAccessPanel));

  it("主面只有开关 + 协议分段 + 地址框，唯一的 switch 是主开关", () => {
    expect(html).toContain('role="switch"');
    expect((html.match(/role="switch"/g) ?? []).length).toBe(1);
    expect(html).toContain('placeholder="192.168.1.10:3180"');
    expect(html).toContain("settings.remoteRelay.scenarioLan");
    expect(html).toContain("settings.remoteRelay.scenarioPublic");
  });

  it("没有高级设置：折叠块/表单字段/保存按钮全部不存在", () => {
    expect(html).not.toContain("settings.remoteRelay.advanced");
    expect(html).not.toContain("settings.remoteRelay.configDescription");
    expect(html).not.toContain("settings.remoteRelay.slots");
    expect(html).not.toContain("settings.remoteRelay.workspace");
    expect(html).not.toContain("settings.remoteRelay.publicUrl");
    expect(html).not.toContain("settings.remoteRelay.saveHint");
  });

  it("密钥零展示（SSR 不跑 effect，重置按钮由 CDP 实机验证）", () => {
    // 密钥本体不出现在任何渲染输出：值只随链接分发
    expect(html).not.toContain("k".repeat(43));
    expect(html).not.toContain("c".repeat(43));
    expect(html).not.toContain('type="password"');
  });
});
