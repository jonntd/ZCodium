/**
 * runQuickEdit（编辑器内一次性改写）回归测试：
 *
 * 1. 应用改写用**生成期捕获的选区**并校验原文未变——预览期间文档被编辑时
 *    拒绝应用，不再按过期位置盲替换（审查 medium 修复）；
 * 2. 决策后关闭本次打开的 diff 页签（按 TabInputTextDiff before/after URI 定位），
 *    不再关「当前活动编辑器」——非模态通知决策期焦点漂移会关掉用户正开着的文件
 *    （审查 medium 修复）。
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const {
  showInputBox,
  showInformationMessage,
  showWarningMessage,
  showErrorMessage,
  setStatusBarMessage,
  executeCommand,
  applyEdit,
  tabGroupsClose,
  withProgress,
  tabState,
} = vi.hoisted(() => ({
  showInputBox: vi.fn(),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
  setStatusBarMessage: vi.fn(),
  executeCommand: vi.fn(),
  applyEdit: vi.fn(),
  tabGroupsClose: vi.fn(),
  withProgress: vi.fn(),
  // 本次 diff 的 before/after URI（contentProvider.set 注入；tabGroups.all 惰性组装）
  tabState: { before: undefined as unknown, after: undefined as unknown },
}));

vi.mock("vscode", () => ({
  window: {
    get activeTextEditor() {
      return currentEditor;
    },
    showInputBox,
    showInformationMessage,
    showWarningMessage,
    showErrorMessage,
    setStatusBarMessage,
    withProgress,
    get tabGroups() {
      const all =
        tabState.before !== undefined && tabState.after !== undefined
          ? [{ tabs: [{ input: { original: tabState.before, modified: tabState.after } }] }]
          : [];
      return { all, close: tabGroupsClose };
    },
  },
  commands: { executeCommand },
  workspace: { applyEdit, asRelativePath: () => "src/a.ts" },
  Uri: { parse: (value: string) => ({ toString: () => value, path: value }) },
  WorkspaceEdit: class {
    readonly replaces: Array<{ range: unknown; text: string }> = [];
    replace(_uri: unknown, range: unknown, text: string): void {
      this.replaces.push({ range, text });
    }
  },
  ProgressLocation: { SourceControl: 1 },
}));

import { runQuickEdit, type QuickEditDeps } from "../src/features/quickEdit";
import type { QuickEditContentProvider } from "../src/features/quickEdit";

/** 编辑器 mock 的可变句柄（用例间切换）。 */
let currentEditor: {
  selection: { isEmpty: boolean; start: { line: number }; end: { line: number } };
  document: { uri: unknown; languageId: string; getText: () => string };
} | undefined;

const CAPTURED_RANGE = {
  isEmpty: false,
  start: { line: 4, character: 0 },
  end: { line: 6, character: 0 },
};

/** 依次返回预设值：第 1 次 = 生成期取原文，第 2 次 = 应用期一致性校验。 */
function makeEditor(getTextReturns: string[]): typeof currentEditor {
  let calls = 0;
  return {
    selection: CAPTURED_RANGE,
    document: {
      uri: { fsPath: "/repo/src/a.ts" },
      languageId: "typescript",
      getText: () => {
        const value = getTextReturns[Math.min(calls, getTextReturns.length - 1)] ?? "";
        calls += 1;
        return value;
      },
    },
  };
}

function makeDeps(rewritten: string): QuickEditDeps {
  const set = vi.fn((uri: unknown) => {
    // 第一次 set = before URI；第二次 = after URI → tabGroups.all 惰性组装出
    // 与本次 diff 完全匹配的页签（nonce 由被测函数生成，测试无法预知）。
    if (tabState.before === undefined) tabState.before = uri;
    else tabState.after = uri;
  });
  const contentProvider = { set } as unknown as QuickEditContentProvider;
  return {
    generateText: vi.fn(async () => rewritten),
    contentProvider,
  };
}

describe("runQuickEdit：应用选区一致性 + 关 diff 页签", () => {
  beforeEach(() => {
    currentEditor = undefined;
    tabState.before = undefined;
    tabState.after = undefined;
    showInputBox.mockReset().mockResolvedValue("改成 early return");
    showInformationMessage.mockReset().mockResolvedValue("应用");
    showWarningMessage.mockReset();
    showErrorMessage.mockReset();
    setStatusBarMessage.mockReset();
    executeCommand.mockReset().mockResolvedValue(undefined);
    applyEdit.mockReset().mockResolvedValue(true);
    tabGroupsClose.mockReset();
    withProgress
      .mockReset()
      .mockImplementation(async (_opts: unknown, fn: (p: unknown, t: unknown) => unknown) =>
        fn({}, { onCancellationRequested: () => undefined }),
      );
  });

  it("预览期间文档已变更：拒绝应用（不按过期位置盲替换）", async () => {
    currentEditor = makeEditor(["const a = 1;", "const a = 2; // 用户改过了"]);
    const deps = makeDeps("REWRITTEN");

    await runQuickEdit(deps);

    expect(applyEdit).not.toHaveBeenCalled();
    expect(showErrorMessage).toHaveBeenCalledWith(
      "文档在预览期间已变更，本次改写未应用（请重新发起改写）。",
    );
    expect(tabGroupsClose).not.toHaveBeenCalled();
  });

  it("原文未变：用生成期捕获的选区替换，并关闭本次 diff 页签", async () => {
    currentEditor = makeEditor(["const a = 1;"]);
    const deps = makeDeps("REWRITTEN");

    await runQuickEdit(deps);

    expect(applyEdit).toHaveBeenCalledTimes(1);
    const edit = applyEdit.mock.calls[0]?.[0] as {
      replaces: Array<{ range: unknown; text: string }>;
    };
    expect(edit.replaces).toEqual([{ range: CAPTURED_RANGE, text: "REWRITTEN" }]);
    // 关闭的是本次 diff 页签（TabInputTextDiff 定位），不是「当前活动编辑器」
    expect(tabGroupsClose).toHaveBeenCalledTimes(1);
    expect(executeCommand).not.toHaveBeenCalledWith("workbench.action.closeActiveEditor");
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it("放弃：关闭本次 diff 页签，不执行 closeActiveEditor、不落 WorkspaceEdit", async () => {
    currentEditor = makeEditor(["const a = 1;"]);
    const deps = makeDeps("REWRITTEN");
    showInformationMessage.mockResolvedValue("放弃");

    await runQuickEdit(deps);

    expect(applyEdit).not.toHaveBeenCalled();
    expect(tabGroupsClose).toHaveBeenCalledTimes(1);
    expect(executeCommand).not.toHaveBeenCalledWith("workbench.action.closeActiveEditor");
  });

  it("页签不在（如已被用户手动关闭）：关闭路径静默跳过不崩", async () => {
    currentEditor = makeEditor(["const a = 1;"]);
    const deps = makeDeps("REWRITTEN");
    showInformationMessage.mockResolvedValue("放弃");
    // 不注入 diff URI → tabGroups.all 为空数组
    (deps.contentProvider.set as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      () => undefined,
    );

    await runQuickEdit(deps);

    expect(tabGroupsClose).not.toHaveBeenCalled();
    expect(showErrorMessage).not.toHaveBeenCalled();
  });
});
