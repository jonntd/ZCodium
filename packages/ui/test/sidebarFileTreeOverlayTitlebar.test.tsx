// @vitest-environment jsdom
// 回归：左侧「查看文件」文件树覆盖层与 macOS 红绿灯（关闭/最小化）重叠。
// 根因：ProjectSidebar 顶部有 h-12 [app-region:drag] 标题栏拖拽条让出红绿灯区域，
// 覆盖层 absolute inset-0 顶到窗口上沿且头部只有 pt-3，「返回任务」按钮被红绿灯盖住。
// 修复：覆盖层与侧栏共用 SIDEBAR_TITLEBAR_STRIP_CLASS，文件树渲染在拖拽条之下。
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SIDEBAR_TITLEBAR_STRIP_CLASS } from "@/project-sidebar/sidebarTitlebarStrip.js";
import type { ProjectSidebarProps } from "@/project-sidebar/contract.js";
import { WorkspaceSidebar } from "@/WorkspaceSidebar.js";

vi.mock("@/project-sidebar/index.js", async () => {
  // 只取真实的让位常量，断言与实现共用同一信源；ProjectSidebar 以桩件替代。
  const { SIDEBAR_TITLEBAR_STRIP_CLASS: stripClass } =
    await import("@/project-sidebar/sidebarTitlebarStrip.js");
  return {
    SIDEBAR_TITLEBAR_STRIP_CLASS: stripClass,
    ProjectSidebar: (props: { onOpenFileManager?: (target: unknown) => void }) =>
      createElement("button", {
        "data-testid": "mock-open-files",
        type: "button",
        onClick: () => props.onOpenFileManager?.({ workspacePath: "/tmp/ws", workspaceName: "ws" }),
      }),
  };
});
vi.mock("@/WorkspaceFileTree.js", () => ({
  WorkspaceFileTree: () => createElement("div", { "data-testid": "mock-file-tree" }),
}));

function renderSidebar(props: Partial<ProjectSidebarProps>) {
  return render(createElement(WorkspaceSidebar, props as ProjectSidebarProps));
}

afterEach(cleanup);

describe("WorkspaceSidebar 文件树覆盖层标题栏让位（macOS 红绿灯）", () => {
  it("覆盖层先渲染标题栏拖拽条，文件树渲染在其下方", () => {
    renderSidebar({});
    fireEvent.click(screen.getByTestId("mock-open-files"));
    const overlay = screen.getByTestId("sidebar-file-tree-overlay");
    const strip = overlay.firstElementChild as HTMLElement;
    expect(strip.className).toContain(SIDEBAR_TITLEBAR_STRIP_CLASS);
    const tree = within(overlay).getByTestId("mock-file-tree");
    expect(strip.nextElementSibling?.contains(tree)).toBe(true);
  });

  it("手机远控与侧栏行为一致：拖拽条带 max-md:hidden", () => {
    renderSidebar({ isWebRemoteControl: true });
    fireEvent.click(screen.getByTestId("mock-open-files"));
    const strip = screen.getByTestId("sidebar-file-tree-overlay").firstElementChild as HTMLElement;
    expect(strip.className).toContain("max-md:hidden");
  });
});
