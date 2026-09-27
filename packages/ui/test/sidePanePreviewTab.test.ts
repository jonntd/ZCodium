import assert from "node:assert/strict";
import test from "node:test";
import type { CodeViewerSource } from "../src/lib/codeViewer.js";
import { buildFileCompareDiffSource } from "../src/workspace-file-tree/fileCompare.js";
import {
  activateFilesSidePane,
  closeFilesTabPreview,
  getCodeViewerPreviewTabId,
  getVisibleSidePaneTabs,
  openCodeViewerSidePane,
  openCodeViewerSidePanes,
  openFilesTabPreview,
  pinCodeViewerSidePaneTab,
  stampSidePaneTabsOwnership,
  type CodeViewerSidePaneTab,
  type FilesSidePaneTab,
  type WorkspaceSidePaneState,
} from "../src/lib/workspaceSidePane.js";

// 右侧面板预览标签（docs/spec/side-pane-file-preview.md）：
// 文件树单击 = preview 意图，占用同 owner 唯一、可被替换的预览槽；
// 双击/右键打开/钉住 = open 意图，转正为普通标签。
// 消息内链接与 assistant 产物批量打开缺省 open，语义保持不变。

function fileSource(path: string, title?: string): CodeViewerSource {
  return { type: "file", title: title ?? path, path };
}

function codeViewerTabs(state: WorkspaceSidePaneState | null): CodeViewerSidePaneTab[] {
  assert.ok(state);
  return state.tabs.filter((tab): tab is CodeViewerSidePaneTab => tab.type === "code-viewer");
}

function previewTabs(state: WorkspaceSidePaneState): CodeViewerSidePaneTab[] {
  return codeViewerTabs(state).filter((tab) => tab.preview === true);
}

test("连续单击不同文件只占用一张预览标签并原位替换", () => {
  let state = openCodeViewerSidePane(null, fileSource("/repo/a.ts"), null, "preview");
  assert.equal(codeViewerTabs(state).length, 1);
  const previewId = previewTabs(state)[0]!.id;
  assert.equal(previewId, getCodeViewerPreviewTabId(null));
  assert.equal(state.activeTabId, previewId);

  state = openCodeViewerSidePane(state, fileSource("/repo/b.ts"), null, "preview");
  assert.equal(codeViewerTabs(state).length, 1, "第二次预览不应追加新标签");
  assert.equal(previewTabs(state)[0]!.id, previewId, "预览槽 id 保持不变");
  assert.equal(previewTabs(state)[0]!.source.path, "/repo/b.ts", "内容替换为新文件");
  assert.equal(state.activeTabId, previewId);
});

test("单击已在普通标签中打开的文件时激活普通标签且预览槽不变", () => {
  let state = openCodeViewerSidePane(null, fileSource("/repo/a.ts"), null, "open");
  const normalTabId = state.activeTabId;
  state = openCodeViewerSidePane(state, fileSource("/repo/b.ts"), null, "preview");
  assert.equal(previewTabs(state).length, 1);

  state = openCodeViewerSidePane(state, fileSource("/repo/a.ts"), null, "preview");
  assert.equal(state.activeTabId, normalTabId, "应激活已有普通标签");
  assert.equal(codeViewerTabs(state).length, 2, "不新增标签");
});

test("双击（intent=open）把预览标签就地转正", () => {
  let state = openCodeViewerSidePane(null, fileSource("/repo/a.ts"), null, "preview");
  const previewId = state.activeTabId;

  state = openCodeViewerSidePane(state, fileSource("/repo/a.ts"), null, "open");
  assert.equal(codeViewerTabs(state).length, 1, "转正不新增标签");
  assert.equal(state.activeTabId, "code-viewer:file:/repo/a.ts");
  assert.notEqual(state.activeTabId, previewId, "id 换回 sourceKey 稳定 id");
  assert.equal(previewTabs(state).length, 0, "预览槽已消失");

  // 转正后再预览其它文件，新预览槽与普通标签并存。
  state = openCodeViewerSidePane(state, fileSource("/repo/b.ts"), null, "preview");
  assert.equal(codeViewerTabs(state).length, 2);
  assert.equal(previewTabs(state).length, 1);
});

test("钉住预览标签后同文件再次预览会被普通标签复用", () => {
  let state = openCodeViewerSidePane(null, fileSource("/repo/a.ts"), null, "preview");
  const previewId = state.activeTabId;

  state = pinCodeViewerSidePaneTab(state, previewId);
  assert.equal(state.activeTabId, "code-viewer:file:/repo/a.ts");
  assert.equal(previewTabs(state).length, 0);

  state = openCodeViewerSidePane(state, fileSource("/repo/a.ts"), null, "preview");
  assert.equal(codeViewerTabs(state).length, 1, "命中普通标签直接复用");
  assert.equal(state.activeTabId, "code-viewer:file:/repo/a.ts");
  assert.equal(previewTabs(state).length, 0);
});

test("转正时同源普通标签已存在则合并且标签总数不增", () => {
  // 预览槽与同源普通标签并存只可能来自旧持久化状态（正常链路里 open 意图
  // 命中预览标签会先转正）；这里手工构造并存态，验证钉住时合并收敛。
  const previewTab: CodeViewerSidePaneTab = {
    id: getCodeViewerPreviewTabId(null),
    type: "code-viewer",
    openedAt: 1,
    source: fileSource("/repo/a.ts"),
    sourceKey: "file:/repo/a.ts",
    preview: true,
  };
  const normalTab: CodeViewerSidePaneTab = {
    id: "code-viewer:file:/repo/a.ts",
    type: "code-viewer",
    openedAt: 2,
    source: fileSource("/repo/a.ts"),
    sourceKey: "file:/repo/a.ts",
  };
  let state: WorkspaceSidePaneState = {
    tabs: [previewTab, normalTab],
    activeTabId: previewTab.id,
  };

  state = pinCodeViewerSidePaneTab(state, previewTab.id);
  assert.equal(codeViewerTabs(state).length, 1, "预览槽被合并移除");
  assert.equal(state.activeTabId, "code-viewer:file:/repo/a.ts");
  assert.equal(previewTabs(state).length, 0);
});

test("缺省 intent（消息链接语义）打开普通标签且不影响已有预览槽", () => {
  let state = openCodeViewerSidePane(null, fileSource("/repo/a.ts"), null, "preview");
  state = openCodeViewerSidePane(state, fileSource("/repo/b.ts"));
  assert.equal(codeViewerTabs(state).length, 2, "缺省 open 追加普通标签");
  assert.equal(previewTabs(state).length, 1, "预览槽不被占用");
  assert.equal(state.activeTabId, "code-viewer:file:/repo/b.ts");
});

test("assistant 产物批量打开不受预览槽影响", () => {
  let state = openCodeViewerSidePane(null, fileSource("/repo/a.ts"), null, "preview");
  state = openCodeViewerSidePanes(
    state,
    [fileSource("/repo/gen-1.png"), fileSource("/repo/gen-2.png")],
    null,
    0,
  );
  assert.equal(previewTabs(state).length, 1, "批量打开只产生普通标签");
  assert.equal(codeViewerTabs(state).length, 3);
});

test("预览槽按 owner 隔离，互不替换", () => {
  // 生产提交路径（commitOpenedSidePaneState）在提交时统一冻结 ownerTaskId；
  // 测试里用 stampSidePaneTabsOwnership 模拟同一时序。
  let state = openCodeViewerSidePane(null, fileSource("/repo/a.ts"), "task-1", "preview");
  state = stampSidePaneTabsOwnership(state, { ownerTaskId: "task-1", workspaceKey: null });
  state = openCodeViewerSidePane(state, fileSource("/repo/b.ts"), "task-2", "preview");
  state = stampSidePaneTabsOwnership(state, { ownerTaskId: "task-2", workspaceKey: null });
  assert.equal(previewTabs(state).length, 2, "不同 owner 各有一张预览槽");

  state = openCodeViewerSidePane(state, fileSource("/repo/c.ts"), "task-1", "preview");
  state = stampSidePaneTabsOwnership(state, { ownerTaskId: "task-1", workspaceKey: null });
  assert.equal(previewTabs(state).length, 2, "task-1 的替换不影响 task-2");

  const visible = getVisibleSidePaneTabs(state.tabs, {
    workspaceKey: null,
    ownerTaskId: "task-2",
  });
  assert.deepEqual(
    visible.map((tab) => (tab as CodeViewerSidePaneTab).source.path),
    ["/repo/b.ts"],
    "owner 可见性过滤只看到自己的预览槽",
  );
});

test("无法去重的 source（sourceKey=null）不进入预览槽", () => {
  const untitled: CodeViewerSource = {
    type: "text",
    title: "untitled",
    content: "snippet",
    language: "typescript",
  };
  const state = openCodeViewerSidePane(null, untitled, null, "preview");
  assert.equal(previewTabs(state).length, 0, "按普通标签处理");
  assert.equal(codeViewerTabs(state).length, 1);
});

test("钉住非预览标签或未知 id 时原样返回", () => {
  const state = openCodeViewerSidePane(null, fileSource("/repo/a.ts"), null, "open");
  assert.equal(pinCodeViewerSidePaneTab(state, state.activeTabId), state);
  assert.equal(pinCodeViewerSidePaneTab(state, "not-exist"), state);
  assert.equal(pinCodeViewerSidePaneTab(null, "not-exist"), null);
});

test("中英文 locale 均定义预览标签钉住文案", async () => {
  const [{ default: zhCN }, { default: enUS }] = await Promise.all([
    import("../src/i18n/locales/zh-CN.js"),
    import("../src/i18n/locales/en-US.js"),
  ]);
  assert.equal(zhCN["sidePane.pinTab"], "钉住标签");
  assert.equal(enUS["sidePane.pinTab"], "Pin tab");
});

// files tab 分栏浏览（spec: docs/spec/side-pane-file-preview.md §7）

function filesTabOf(state: WorkspaceSidePaneState): FilesSidePaneTab {
  const tab = state.tabs.find((t): t is FilesSidePaneTab => t.id === "files");
  assert.ok(tab, "files tab 应存在");
  return tab;
}

function stateWithFilesTab(): WorkspaceSidePaneState {
  return { tabs: [{ id: "files", type: "files", openedAt: 1 }], activeTabId: "files" };
}

test("分栏浏览：openFilesTabPreview 设置/替换内嵌预览且不动激活标签", () => {
  let state: WorkspaceSidePaneState = {
    ...stateWithFilesTab(),
    tabs: [
      { id: "files", type: "files", openedAt: 1 },
      {
        id: "code-viewer:file:/repo/a.ts",
        type: "code-viewer",
        openedAt: 2,
        source: fileSource("/repo/a.ts"),
        sourceKey: "file:/repo/a.ts",
      },
    ],
    activeTabId: "code-viewer:file:/repo/a.ts",
  };

  state = openFilesTabPreview(state, fileSource("/repo/a.ts"))!;
  assert.equal(filesTabOf(state).previewSource?.path, "/repo/a.ts");
  assert.equal(state.activeTabId, "code-viewer:file:/repo/a.ts", "不切换激活标签");

  state = openFilesTabPreview(state, fileSource("/repo/b.ts"))!;
  assert.equal(filesTabOf(state).previewSource?.path, "/repo/b.ts", "原位替换");
  assert.equal(codeViewerTabs(state).length, 1, "不新增 code-viewer 标签");
});

test("分栏浏览：files tab 不存在时不隐式创建", () => {
  const state = openCodeViewerSidePane(null, fileSource("/repo/a.ts"), null, "open");
  const next = openFilesTabPreview(state, fileSource("/repo/b.ts"));
  assert.equal(next, state, "原样返回");
  assert.equal(
    next?.tabs.some((tab) => tab.id === "files"),
    false,
  );
});

test("分栏浏览：closeFilesTabPreview 清空预览回到全宽树", () => {
  let state = openFilesTabPreview(stateWithFilesTab(), fileSource("/repo/a.ts"))!;
  assert.ok(filesTabOf(state).previewSource);

  state = closeFilesTabPreview(state)!;
  assert.equal(filesTabOf(state).previewSource, undefined);

  // 幂等：已无预览时原样返回。
  assert.equal(closeFilesTabPreview(state), state);
  assert.equal(closeFilesTabPreview(null), null);
});

test("分栏浏览：activateFilesSidePane 复用既有 tab 保留内嵌预览", () => {
  // 跨工作区切回时 memory 恢复出带 previewSource 的 files tab，
  // 随后经「打开文件面板」按钮触发的挂起打开不能再把它重置成空 tab。
  let state = openFilesTabPreview(stateWithFilesTab(), fileSource("/repo/a.ts"))!;
  state = activateFilesSidePane(state);
  assert.equal(filesTabOf(state).previewSource?.path, "/repo/a.ts", "内嵌预览不被冲掉");
  assert.equal(state.activeTabId, "files");

  // 无 files tab 时正常创建（原语义）。
  const created = activateFilesSidePane({ tabs: [], activeTabId: "" });
  assert.equal(filesTabOf(created).id, "files");
});

test("对比：组装 multi-file-diff source 且同一对文件复用同一标签", () => {
  const scope = { workspacePath: "/repo" };
  const build = () =>
    buildFileCompareDiffSource({
      baseline: { path: "/repo/a.ts", title: "a.ts" },
      target: { path: "/repo/b.ts", title: "b.ts" },
      baselineContent: "export const a = 1;",
      targetContent: "export const b = 2;",
      scope,
    });
  const source = build();
  assert.equal(source.type, "multi-file-diff");
  assert.equal(source.path, "/repo/b.ts");
  assert.equal(source.beforeContent, "export const a = 1;");
  assert.equal(source.afterContent, "export const b = 2;");
  assert.equal(source.title, "a.ts → b.ts");
  assert.equal(source.workspacePath, "/repo");

  // 同一对文件重复对比 → sourceKey（含内容哈希）一致 → 复用同一 diff 标签不重复开。
  const state = openCodeViewerSidePane(null, source, null, "open");
  const again = openCodeViewerSidePane(state, build(), null, "open");
  assert.equal(codeViewerTabs(again).length, 1);
  assert.equal(again.activeTabId, state.activeTabId);

  // 任一侧内容变化 → 新标签（不同 sourceKey）。
  const changed = openCodeViewerSidePane(
    state,
    buildFileCompareDiffSource({
      baseline: { path: "/repo/a.ts", title: "a.ts" },
      target: { path: "/repo/b.ts", title: "b.ts" },
      baselineContent: "export const a = 1;",
      targetContent: "export const b = 3;",
      scope,
    }),
    null,
    "open",
  );
  assert.equal(codeViewerTabs(changed).length, 2);
});

test("分栏浏览：中英文 locale 均定义预览栏动作文案", async () => {
  const [{ default: zhCN }, { default: enUS }] = await Promise.all([
    import("../src/i18n/locales/zh-CN.js"),
    import("../src/i18n/locales/en-US.js"),
  ]);
  assert.equal(zhCN["sidePane.filesPreview.openInTab"], "在标签打开");
  assert.equal(enUS["sidePane.filesPreview.openInTab"], "Open in tab");
  assert.equal(zhCN["sidePane.filesPreview.close"], "关闭预览");
  assert.equal(enUS["sidePane.filesPreview.close"], "Close preview");
});
