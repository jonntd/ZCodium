import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { WorkspacePurposeSection } from "@/WorkspaceSidebar/WorkspacePurposeSection.js";

vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: { role: "button", tabIndex: 0 },
    listeners: {},
    setActivatorNodeRef: vi.fn(),
    setNodeRef: vi.fn(),
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: { Transform: { toString: vi.fn() } },
}));

function renderSection(open: boolean) {
  return renderToStaticMarkup(
    createElement(
      WorkspacePurposeSection,
      {
        title: "Projects",
        open,
        onOpenChange: vi.fn(),
        action: createElement("button", { "data-testid": "section-action" }, "Add"),
        testId: "purpose-section",
        sortableId: "projects",
        dragHandleLabel: "Move Projects section",
      },
      createElement("div", { "data-testid": "section-content" }, "Details"),
    ),
  );
}

describe("WorkspacePurposeSection", () => {
  it("renders the expanded state with content and a down chevron", () => {
    const html = renderSection(true);

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('data-purpose-section-chevron="expanded"');
    expect(html).toContain('data-testid="section-content"');
  });

  it("renders the collapsed state with a right chevron and hidden content", () => {
    const html = renderSection(false);

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('data-purpose-section-chevron="collapsed"');
    expect(html).not.toContain('data-testid="section-content"');
  });

  it("keeps the action outside the collapse trigger and exposes accessible visibility fallbacks", () => {
    const html = renderSection(true);
    const triggerEndIndex = html.indexOf("</button>");
    const actionIndex = html.indexOf('data-testid="section-action"');

    expect(triggerEndIndex).toBeGreaterThan(-1);
    expect(actionIndex).toBeGreaterThan(triggerEndIndex);
    // 2026-11-22 re-baseline：拖拽把手与折叠触发器合一——整个标题按钮即把手
    // （data-purpose-section-drag-trigger + dnd listeners），独立把手元素已删。
    expect(html).toContain('data-purpose-section-drag-trigger="projects"');
    // 无障碍文案从 aria-label 改为 aria-description（拖拽语义由 dnd-kit attributes 提供）。
    expect(html).toContain('aria-description="Move Projects section"');
    expect(html).toContain("touch-none");
    expect(html).toContain("group-hover/purpose-section:opacity-100");
    expect(html).toContain("group-focus-within/purpose-section:opacity-100");
    expect(html).toContain("has-[[data-state=open]]:opacity-100");
    expect(html).toContain("[@media(hover:none)]:opacity-100");
  });

  it("uses the same typography as the pinned section title", () => {
    const html = renderSection(true);

    expect(html).toContain("text-ui-base font-medium text-foreground-subtlest");
    expect(html).not.toContain("text-ui-xs");
  });
});
