/**
 * 编辑器标签打开时的布局副作用契约（缺陷回归 2026-11-08）。
 *
 * 用户实测：点开对话后**资源管理器（主侧栏）被一起关掉**。根因是收栏兜底
 * （对抗 IDE 对 agent webview 的自动展开）里连 `workbench.action.closeSidebar`
 * 一起调用了——主侧栏是用户自己的文件树，与 agent 面板无关，绝不该被我们关。
 *
 * 本测试用假 webview panel 真跑 create()/openNew()，断言：
 * 1) 收栏只发 closeAuxiliaryBar，绝不发 closeSidebar；
 * 2) 侧栏对话面板可见（用户自己打开着）时，收栏整体让位（一个命令都不发）。
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const executeCommand = vi.fn().mockResolvedValue(undefined);
const createWebviewPanel = vi.fn();

vi.mock("vscode", () => ({
  Uri: {
    joinPath: (...parts: Array<{ fsPath?: string } | string>) => ({
      fsPath: parts.map((part) => (typeof part === "string" ? part : (part.fsPath ?? ""))).join("/"),
      path: "",
      toString: () => "file:///stub",
    }),
  },
  ViewColumn: { Active: -1, Beside: -2, One: 1 },
  env: { language: "zh-cn" },
  window: {
    activeColorTheme: { kind: 2 },
    createOutputChannel: () => ({ appendLine: () => {}, show: () => {} }),
    createWebviewPanel,
  },
  workspace: { workspaceFolders: undefined },
  commands: { executeCommand },
}));

const { ChatEditorPanel, cancelSidePanelsCollapse } = await import("../src/ui/chatEditorPanel");

function makePanel() {
  return {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview://stub",
      asWebviewUri: () => "vscode-webview://stub/asset",
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
    },
    onDidChangeViewState: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
    onDidChangeViewStateListeners: [],
    reveal: vi.fn(),
    dispose: vi.fn(),
    title: "",
    viewColumn: -2,
    visible: true,
  };
}

function makeHostRuntime() {
  return {
    attachWebview: vi.fn(),
    detachWebview: vi.fn(),
    handleWebviewMessage: vi.fn(),
  };
}

const extensionUri = { fsPath: "/ext" } as never;

beforeEach(() => {
  executeCommand.mockClear();
  createWebviewPanel.mockReset();
  createWebviewPanel.mockImplementation(() => makePanel());
  cancelSidePanelsCollapse();
  vi.useFakeTimers();
});

afterEach(() => {
  cancelSidePanelsCollapse();
  vi.useRealTimers();
});

describe("打开对话标签时的布局副作用", () => {
  it("收栏只关辅助侧栏，绝不关主侧栏（资源管理器）", async () => {
    const panel = new ChatEditorPanel(extensionUri, makeHostRuntime() as never, () => null, () => false);
    panel.openNew();
    await vi.advanceTimersByTimeAsync(400);

    const issued = executeCommand.mock.calls.map((call) => call[0]);
    expect(issued).toContain("workbench.action.closeAuxiliaryBar");
    expect(issued).not.toContain("workbench.action.closeSidebar");
  });

  it("侧栏对话面板可见（用户自己打开着）→ 收栏整体让位，一个命令都不发", async () => {
    const panel = new ChatEditorPanel(extensionUri, makeHostRuntime() as never, () => null, () => true);
    panel.openNew();
    await vi.advanceTimersByTimeAsync(4_000);

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("单飞去重：窗口内重复 reveal 不叠加多轮收栏", async () => {
    const panel = new ChatEditorPanel(extensionUri, makeHostRuntime() as never, () => null, () => false);
    panel.reveal();
    panel.reveal();
    panel.openNew();
    await vi.advanceTimersByTimeAsync(400);

    // 一轮窗口 = 4 个重试点，但都只发 closeAuxiliaryBar（幂等），不会重复叠加。
    const issued = executeCommand.mock.calls.map((call) => call[0]);
    expect(issued.filter((id) => id === "workbench.action.closeSidebar")).toHaveLength(0);
    expect(issued.length).toBeLessThanOrEqual(4);
  });
});
