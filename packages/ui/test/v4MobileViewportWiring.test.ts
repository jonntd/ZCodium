import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * 手机视口信号接线回归锁（docs/spec/web-remote-ui-parity.md §2.1-C1/C2）。
 *
 * 背景：composerAutoFocus / shouldOfferSideSlashCommand 两个纯函数早就写了「移动端不
 * 自动聚焦」「移动端不提供 /side」，但调用点把 isMobileViewport 写死 false——中继页
 * （路线 A，唯一交付路径）因此照桌面上弹软键盘、照发 /side。strict 视口钩子
 * useIsMobileTextInputViewport（767px + hover:none + pointer:coarse）在
 * lib/mobileTextInput.ts，composer 早已自用；这里锁死调用点接的是真信号而非字面量。
 * 桌面窄窗（hover:hover + pointer:fine）不会误判，故无桌面回归。
 */
describe("手机视口信号接线（C1/C2）", () => {
  it("composer 自动聚焦接 strict 视口钩子，不再写死 false", () => {
    const composer = readSource("packages/ui/src/v4/ConversationComposer.tsx");
    expect(composer).not.toContain("isMobileViewport: false");
    expect(composer).toContain("isMobileViewport: isMobileTextInputViewport");
  });

  it("composer 把远控标记与视口信号传给模型工具条（submenu 宽度适配复活）", () => {
    const composer = readSource("packages/ui/src/v4/ConversationComposer.tsx");
    expect(composer).toContain("isWebRemoteControl={isWebRemoteControl}");
    expect(composer).toContain("isMobileViewport={isMobileTextInputViewport}");
  });

  it("SessionPane 用同源钩子供 /side 门禁与状态面板浮层方向", () => {
    const pane = readSource("packages/ui/src/v4/SessionPane.tsx");
    expect(pane).not.toContain("isMobileViewport: false");
    expect(pane).toContain("useIsMobileTextInputViewport()");
    expect(pane).toContain("isMobileViewport: isMobileTextInputViewport");
    // 状态面板需要同时知道「在远控页」与「手机视口」才会改纵向浮层。
    expect(pane).toContain("isWebRemoteControl={compactForRemoteControl}");
  });
});
