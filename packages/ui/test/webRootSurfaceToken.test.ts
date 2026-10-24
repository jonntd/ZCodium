import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("web root surface token", () => {
  it("defines the independent web root surface token in every theme block", () => {
    // docs/spec/web-remote-ui-parity.md §2.1-A5：中继页不得再复用 Windows 的底色 token。
    // 四个主题段（@theme 默认亮 / .dark / zai-light / zai-dark）缺任一，
    // 对应主题的中继页就会回落到错误底色。
    const styles = readSource("packages/ui/src/styles.css");
    expect(styles).toContain("--color-background-web-alt: var(--color-neutral-200);");
    expect(styles).toContain("--color-background-web-alt: var(--color-neutral-800);");
    expect(styles).toContain("--color-background-web-alt: #ececee;");
    expect(styles).toContain("--color-background-web-alt: #2b2b2b;");
  });

  it("routes the relay page root surface to the web token", () => {
    const frame = readSource("packages/ui/src/DesktopWindowFrame.tsx");
    // Web（!isDesktop）走独立 web token；Windows/Linux 仍走 win-alt；macOS 桌面仍走半透明 alt。
    expect(frame).toContain('!isDesktop\n    ? "bg-background-web-alt"');
    expect(frame).toContain('isWindowsDesktop || isLinuxDesktop\n      ? "bg-background-win-alt"');
    expect(frame).toContain('"bg-background-alt"');
    // 回归锁：中继页不得回到 usesOpaqueRootSurface 的 Windows 共用分支。
    expect(frame).not.toContain("usesOpaqueRootSurface");
  });
});
