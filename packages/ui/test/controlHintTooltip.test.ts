import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ControlHintTooltip } from "@/ControlHintTooltip.js";
import { Button } from "@/components/ui/button.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

// 用 import.meta.url 锚定（不用 process.cwd()）：单包 `pnpm --filter @zcode/ui` 的 cwd
// 是包根，cwd 相对路径会读不到文件（2026-11-22 实测 ENOENT）。
const CONTROL_HINT_SOURCE = new URL("../src/ControlHintTooltip.tsx", import.meta.url);
const TOOLTIP_SOURCE = new URL("../src/components/ui/tooltip.tsx", import.meta.url);

describe("ControlHintTooltip", () => {
  it("uses sm typography for tooltip copy and xs typography for shortcuts", () => {
    const tooltipSource = readFileSync(TOOLTIP_SOURCE, "utf8");
    const controlHintSource = readFileSync(CONTROL_HINT_SOURCE, "utf8");

    expect(tooltipSource).toContain("text-ui-sm text-tooltip-foreground");
    expect(tooltipSource).not.toContain("text-ui-base text-tooltip-foreground");
    expect(controlHintSource).not.toContain("text-ui-base");
    expect(controlHintSource).toContain("text-ui-xs font-medium text-tooltip-tag-foreground");
  });

  it("only creates a Radix tooltip provider for standalone tooltip instances", () => {
    const source = readFileSync(CONTROL_HINT_SOURCE, "utf8");

    // 共享 Provider 统一放在 Root（见 Root.tsx）。这里只允许 `standalone` 逃生舱各自建一个，
    // 因此断言的是"Provider 必须被 standalone 门控"，而不是"源码里不许出现 Provider"——
    // 后者会把 standalone 这个有意的能力一并禁掉。
    expect(source).toContain("standalone ? <TooltipProvider>{tooltip}</TooltipProvider> : tooltip");
    // 2026-11-22 re-baseline：SidebarTooltipProvider（侧栏共享 Provider，snappy 参数
    // delayDuration/skipDelayDuration/disableHoverableContent）是第二个**命名**共享实例。
    // 计数锁死为「standalone 逃生舱 + SidebarTooltipProvider」两个面——再出现任何新
    // Provider 实例都算退化（大会话里每条消息动作各建一个 Provider，Radix 上下文树
    // 被放大到消息数量级，正是本用例要挡住的）。
    expect(source.match(/<TooltipProvider>/g)).toHaveLength(1);
    expect(source.match(/<TooltipProvider delayDuration/g)).toHaveLength(1);
    expect(source.match(/<\/TooltipProvider>/g)).toHaveLength(2);

    // 承重项：默认必须是 false。一旦默认值翻转，大会话里每条消息动作都会各建一个
    // Provider，Radix 上下文树被放大到消息数量级——这正是本用例要挡住的退化。
    expect(source).toContain("standalone = false");
  });

  it("keeps the composed trigger ref stable across Radix asChild renders", () => {
    const source = readFileSync(CONTROL_HINT_SOURCE, "utf8");

    expect(source).not.toContain("ref: composeRefs(");
    expect(source).toContain("const composedTriggerRef = useCallback(");
    expect(source).toContain("[childRef, triggerRef]");
  });

  it("keeps long localized titles visible within the viewport", () => {
    const source = readFileSync(CONTROL_HINT_SOURCE, "utf8");

    expect(source).toContain("max-w-[min(28rem,calc(100vw-1rem))]");
    expect(source).toContain("whitespace-pre-line break-words");
    expect(source).not.toContain("font-medium whitespace-nowrap text-tooltip-foreground");
  });

  it("renders an icon button trigger without falling back to a nested Radix button", () => {
    const html = renderToStaticMarkup(
      createElement(
        TooltipProvider,
        null,
        createElement(
          ControlHintTooltip,
          { title: "Send", shortcut: "Enter" },
          createElement(
            Button,
            { type: "submit", size: "icon-lg", "aria-label": "Send" },
            createElement("span", { "aria-hidden": true }, "↑"),
            createElement("span", { className: "sr-only" }, "Send"),
          ),
        ),
      ),
    );

    expect(html).toMatch(/^<button[^>]*data-slot="tooltip-trigger"/);
    expect(html).not.toContain('<span data-slot="tooltip-trigger"');
    expect(html).toContain('aria-label="Send"');
    expect(html).toContain('type="submit"');
  });
});
