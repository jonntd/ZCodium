/**
 * 「审查 / 打开」按钮无响应的回归锁定。
 *
 * 真机表现：改动卡片默认折叠；展开后文件行把路径/+/-/审查/打开挤在同一行，
 * 窄侧栏里按钮被裁切；且 diff 源缺席时整行与按钮 disabled，点击静默 return false。
 * 本测试用纯函数覆盖「点击必有结果」，用源码契约锁定「按钮始终可见」的布局，
 * 不依赖 jsdom/React 渲染环境，可在 CI 稳定跑。
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  buildChangeSummaryFilePreviewSource,
  openChangeSummaryDiffViewer,
  resolveChangeSummaryViewerSource,
} from "../../../packages/ui/src/messageChangeSummaryPreview";

const UI_ROOT = resolve(__dirname, "../../../packages/ui/src");
const panelSource = readFileSync(resolve(UI_ROOT, "MessageChangeSummaryPanel.tsx"), "utf8");

const fileSource = buildChangeSummaryFilePreviewSource({
  path: "/ws/demo.ts",
  relativePath: "demo.ts",
  workspacePath: "/ws",
});

describe("改动卡片：点击始终有结果", () => {
  it("diff 源存在时优先展示改动前后", () => {
    const diffSource = { type: "file" as const, title: "demo.ts", path: "/ws/demo.ts" };
    expect(resolveChangeSummaryViewerSource(diffSource, fileSource)).toBe(diffSource);
  });

  it("diff 源缺席时降级为文件源，点击真的触发 onOpenCodeViewer", () => {
    const resolved = resolveChangeSummaryViewerSource(undefined, fileSource);
    expect(resolved).toBe(fileSource);
    const onOpen = vi.fn();
    expect(openChangeSummaryDiffViewer(resolved, onOpen)).toBe(true);
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(fileSource);
  });

  it("对照：undefined 源会静默返回 false（这正是修复前「无响应」的来源）", () => {
    const onOpen = vi.fn();
    expect(openChangeSummaryDiffViewer(undefined, onOpen)).toBe(false);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("组件确实走了降级解析，而不是继续禁用按钮", () => {
    expect(panelSource).toContain("resolveChangeSummaryViewerSource(");
    expect(panelSource).toContain("disabled={!canOpenViewer}");
    expect(panelSource).not.toContain("disabled={!canOpenDiff}");
  });
});

describe("改动卡片：窄侧栏布局与操作路径", () => {
  it("单文件改动自动展开，不把入口藏在折叠里", () => {
    expect(panelSource).toContain("autoExpandDone");
    expect(panelSource).toContain("turnSummary.fileCount === 1");
    expect(panelSource).toContain("setIsFileListOpen(true)");
  });

  it("文件信息与按钮分列两行，按钮不再被长路径挤掉", () => {
    expect(panelSource).toContain("flex w-full flex-col gap-1.5 px-2 py-2");
    expect(panelSource).toContain("flex w-full shrink-0 items-center justify-end gap-1.5");
    expect(panelSource).toContain("flex w-full min-w-0 items-center justify-between gap-2");
  });

  it("降级时按钮文案切到「在编辑器中打开」并给出提示", () => {
    expect(panelSource).toContain('id: "chat.changeSummary.openInEditor"');
    expect(panelSource).toContain('id: "chat.changeSummary.diffUnavailable"');
    expect(panelSource).toContain("reviewHint");
  });
});
