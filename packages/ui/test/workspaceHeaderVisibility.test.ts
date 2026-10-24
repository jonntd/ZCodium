import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { shouldRenderWorkspaceHeaderForMainView } from "@/app-shell/workspaceHeaderVisibility.js";

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("shouldRenderWorkspaceHeaderForMainView", () => {
  it("only excludes main views that bring their own breadcrumb and drag strip", () => {
    expect(shouldRenderWorkspaceHeaderForMainView("chat")).toBe(true);
    expect(shouldRenderWorkspaceHeaderForMainView("automations")).toBe(false);
    expect(shouldRenderWorkspaceHeaderForMainView("plugin-store")).toBe(false);
  });

  it("keeps the header on web relay pages in draft state", () => {
    // 回归锁（docs/spec/web-remote-ui-parity.md §2.1-A1）：壳层曾以
    // 「有 active task 或是桌面」决定头部存亡，中继页草稿态因此整个丢掉工作区头部。
    // 现在 isDesktop / activeTaskId 不再是条件；桌面 chrome 由 WorkspaceHeader 内部裁剪。
    const layout = readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");
    expect(layout).not.toContain("activeTaskId !== null || isDesktop");
    expect(layout).toContain("shouldRenderWorkspaceHeaderForMainView(workspaceMainView)");
  });
});
