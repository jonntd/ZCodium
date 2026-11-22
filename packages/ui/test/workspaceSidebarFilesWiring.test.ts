import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// 用 import.meta.url 锚定路径（不用 process.cwd()）：全量套件从仓库根跑、单包
// `pnpm --filter @zcode/ui` 从包根跑，cwd 相对路径会让单包运行读不到文件。
function readSource(path: string): Promise<string> {
  // path 相对仓库根；本文件位于 packages/ui/test/。
  return readFile(new URL(`../../../${path}`, import.meta.url), "utf8");
}

/**
 * 侧栏行按钮「打开文件面板」接线回归锁（docs/spec/sidebar-file-viewer.md §2 入口 B）。
 *
 * 背景：merge 11f63dc7 拉上游时把 WorkspaceShellLayout 传给 WorkspaceSidebar 的
 * `onOpenSidePaneFiles={handleOpenFiles}` 弄丢了。该 prop 是可选的，typecheck 与既有
 * 测试都不覆盖 ⇒ 按钮静默消失，用户报「打开文件面板失效了」。这里锁死完整链路：
 * App 组装跨工作区回调 → ShellLayout 下发 → WorkspaceSidebarItem 消费。
 *
 * 2026-11-22 re-baseline：行级消费随显示层对齐迁入 WorkspaceSidebarItem——调用从
 * `onOpenSidePaneFiles?.(tab.workspacePath, tab.workspaceIdentity)` 收敛为
 * `onOpenSidePaneFiles(tab)`（整 tab 下发，断连/只读 gate 在 item 内统一处理）。
 */
describe("侧栏「打开文件面板」接线（入口 B）", () => {
  it("ShellLayout 把 handleOpenFiles 下发给 WorkspaceSidebar", async () => {
    const shell = await readSource("packages/ui/src/app-shell/WorkspaceShellLayout.tsx");
    expect(shell).toContain("onOpenSidePaneFiles={handleOpenFiles}");
  });

  it("App 把跨工作区回调作为 handleOpenFiles 传入 ShellLayout", async () => {
    const app = await readSource("packages/ui/src/App.tsx");
    expect(app).toContain("handleOpenFiles={handleOpenSidePaneFilesForWorkspace}");
  });

  it("WorkspaceSidebarItem 消费 prop 并按行上下文调用（断连/只读不投递）", async () => {
    const sidebar = await readSource("packages/ui/src/WorkspaceSidebarItem.tsx");
    expect(sidebar).toMatch(
      /\n\s+if \(\s*\n\s+isDisconnectedRemoteWorkspace \|\|\s*\n\s+readOnlyReason \|\|\s*\n\s+!onOpenSidePaneFiles\s*\n\s+\)\s*\{\s*\n\s+return;\s*\n\s+\}\s*\n\s+onOpenSidePaneFiles\(tab\);/,
    );
  });
});
