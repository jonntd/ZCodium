/**
 * 侧栏视图可见性契约（缺陷回归 2026-11-08）。
 *
 * 用户实测 1：打开着对话标签时点活动栏 Gode 图标 → 侧栏对话面板弹出后**秒关**。
 * 用户实测 2：点同一个图标 → 布局被"最大化"清掉（其他 tab / 资源管理器不见）。
 * 根因同一族：原「侧栏可见跳板」：view 一旦可见就 reveal 编辑器标签，而 reveal()
 * 内部挂了多点延迟收栏（closeAuxiliaryBar + **closeSidebar**，对抗 IDE 对 agent
 * webview 的自动展开），于是把用户**自己点开的**面板与主侧栏（资源管理器）一起关掉。
 *
 * 修复后：可见性不产生任何命令调用，只记录状态；收栏兜底只收辅助栏，且侧栏对话
 * 可见时整体让位。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const executeCommand = vi.fn();

vi.mock("vscode", () => ({
  Uri: {
    joinPath: (...parts: Array<{ fsPath?: string; path?: string } | string>) => ({
      fsPath: parts.map((part) => (typeof part === "string" ? part : (part.fsPath ?? ""))).join("/"),
      path: "",
      toString: () => "file:///stub",
    }),
  },
  env: { language: "zh-cn" },
  window: { activeColorTheme: { kind: 2 } },
  workspace: { workspaceFolders: undefined },
  commands: { executeCommand },
}));

const { ChatPanel, CHAT_VIEW_ID } = await import("../src/ui/chatPanel");

interface FakeView {
  visible: boolean;
  webview: {
    options: unknown;
    html: string;
    cspSource: string;
    asWebviewUri: (uri: unknown) => string;
    onDidReceiveMessage: (handler: (message: unknown) => void) => { dispose: () => void };
  };
  onDidDispose: (handler: () => void) => { dispose: () => void };
  onDidChangeVisibility: (handler: () => void) => { dispose: () => void };
  show: (preserveFocus?: boolean) => void;
  /** 测试用：手动触发可见性回调。 */
  fireVisibility: () => void;
  /** 测试用：手动触发 dispose 回调。 */
  fireDispose: () => void;
}

function makeView(visible: boolean): FakeView {
  let visibilityHandler: (() => void) | null = null;
  let disposeHandler: (() => void) | null = null;
  return {
    visible,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview://stub",
      asWebviewUri: () => "vscode-webview://stub/asset",
      onDidReceiveMessage: () => ({ dispose: () => {} }),
    },
    onDidDispose: (handler) => {
      disposeHandler = handler;
      return { dispose: () => {} };
    },
    onDidChangeVisibility: (handler) => {
      visibilityHandler = handler;
      return { dispose: () => {} };
    },
    show: vi.fn(),
    fireVisibility: () => visibilityHandler?.(),
    fireDispose: () => disposeHandler?.(),
  };
}

function makeHostRuntime() {
  return {
    handleWebviewMessage: vi.fn(),
    attachWebview: vi.fn(),
    detachWebview: vi.fn(),
  };
}

const extensionUri = { fsPath: "/ext" } as never;

describe("侧栏视图可见性：不跳转、不自关、不关资源管理器", () => {
  it("视图可见时不执行任何命令（不做跳转、不触发收栏）", () => {
    executeCommand.mockClear();
    const hostRuntime = makeHostRuntime();
    const panel = new ChatPanel(extensionUri, hostRuntime as never, () => null);
    const view = makeView(true);

    panel.resolveWebviewView(view as never);

    // 关键断言：可见即 resolve 时，宿主不应收到 closeSidebar / closeAuxiliaryBar
    // （收栏是 reveal() 的副作用），也不应有任何其它命令调用。
    expect(executeCommand).not.toHaveBeenCalled();
    expect(view.show).not.toHaveBeenCalled();
    // 桥接仍建立（侧栏对话照常可用）。
    expect(hostRuntime.attachWebview).toHaveBeenCalledWith(CHAT_VIEW_ID, view.webview);
    // HTML 已注入（视图真的是可用对话面，而不是被跳转顶掉的空壳）。
    expect(view.webview.html).toContain("zcode-bootstrap");
    // 可见性状态自证（只给收栏兜底做避让判断，不产生命令）。
    expect(panel.isViewVisible()).toBe(true);
  });

  it("视图隐藏 / 后续可见性变化同样不触发命令", () => {
    executeCommand.mockClear();
    const hostRuntime = makeHostRuntime();
    const panel = new ChatPanel(extensionUri, hostRuntime as never, () => null);
    const view = makeView(false);
    panel.resolveWebviewView(view as never);
    expect(panel.isViewVisible()).toBe(false);

    view.visible = true;
    view.fireVisibility();
    expect(panel.isViewVisible()).toBe(true);

    view.visible = false;
    view.fireVisibility();
    expect(panel.isViewVisible()).toBe(false);

    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("dispose 后可见性回落（避免收栏兜底读到过期状态）", () => {
    const hostRuntime = makeHostRuntime();
    const panel = new ChatPanel(extensionUri, hostRuntime as never, () => null);
    const view = makeView(true);
    panel.resolveWebviewView(view as never);
    expect(panel.isViewVisible()).toBe(true);
    view.fireDispose();
    expect(panel.isViewVisible()).toBe(false);
    expect(hostRuntime.detachWebview).toHaveBeenCalledWith(CHAT_VIEW_ID);
  });

  it("源码不再保留可见性跳板，且收栏绝不关主侧栏", () => {
    const source = readFileSync(join(__dirname, "..", "src", "ui", "chatPanel.ts"), "utf8");
    expect(source).not.toContain("onVisible");
    expect(source).not.toContain("scheduleSidePanelsCollapse");
    const editorPanel = readFileSync(
      join(__dirname, "..", "src", "ui", "chatEditorPanel.ts"),
      "utf8",
    );
    expect(editorPanel).not.toContain("workbench.action.closeSidebar");
  });

  it("container 不再向 ChatPanel 注入跳转回调，但把可见性喂给收栏兜底", () => {
    const container = readFileSync(join(__dirname, "..", "src", "container.ts"), "utf8");
    const call = container.match(/new ChatPanel\(([\s\S]*?)\);/);
    expect(call).not.toBeNull();
    expect(call![1]).not.toContain("chatEditorPanel.reveal");
    expect(container).toContain("() => chatPanel.isViewVisible()");
  });
});
