import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function readSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

/**
 * 侧栏行按钮「打开文件面板」接线回归锁（docs/spec/sidebar-file-viewer.md §2 入口 B）。
 *
 * 背景：merge 11f63dc7 拉上游时把 WorkspaceShellLayout 传给 WorkspaceSidebar 的
 * `onOpenSidePaneFiles={handleOpenFiles}` 弄丢了。该 prop 是可选的，typecheck 与既有
 * 测试都不覆盖 ⇒ 按钮静默消失，用户报「打开文件面板失效了」。这里锁死完整链路：
 * App 组装跨工作区回调 → ShellLayout 下发 → WorkspaceSidebar 消费。
 */
describe("侧栏「打开文件面板」接线（入口 B）", () => {
  it("ShellLayout 把 handleOpenFiles 下发给 WorkspaceSidebar", () => {
    const shell = readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");
    expect(shell).toContain("onOpenSidePaneFiles={handleOpenFiles}");
  });

  it("App 把跨工作区回调作为 handleOpenFiles 传入 ShellLayout", () => {
    const app = readSource("packages/ui/src/App.tsx");
    expect(app).toContain("handleOpenFiles={handleOpenSidePaneFilesForWorkspace}");
  });

  it("WorkspaceSidebar 消费 prop 并按 tab 上下文调用", () => {
    const sidebar = readSource("packages/ui/src/WorkspaceSidebar.tsx");
    expect(sidebar).toContain("onOpenSidePaneFiles?.(tab.workspacePath, tab.workspaceIdentity)");
  });
});
