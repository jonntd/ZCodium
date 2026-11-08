/**
 * 侧栏视图可见性契约（缺陷回归 2026-11-08）。
 *
 * 用户实测：打开着对话标签时点活动栏 Gode 图标 → 侧栏对话面板弹出后**秒关**。
 * 根因是原「侧栏可见跳板」：view 一旦可见就 reveal 编辑器标签，而 reveal() 内部
 * 挂了多点延迟收栏（对抗 IDE 对 agent webview 的自动展开），于是把用户**自己点开
 * 的**面板 350ms 后关掉。修复后：可见性不产生任何跳转/命令调用，视图留下。
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
}

function makeView(visible: boolean): FakeView {
  const noop = () => ({ dispose: () => {} });
  return {
    visible,
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview://stub",
      asWebviewUri: () => "vscode-webview://stub/asset",
      onDidReceiveMessage: noop,
    },
    onDidDispose: noop,
    onDidChangeVisibility: noop,
    show: vi.fn(),
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

describe("侧栏视图可见性：不跳转、不自关", () => {
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
  });

  it("视图不可见 / 后续变为可见同样不触发命令", () => {
    executeCommand.mockClear();
    const hostRuntime = makeHostRuntime();
    const panel = new ChatPanel(extensionUri, hostRuntime as never, () => null);
    const view = makeView(false);
    panel.resolveWebviewView(view as never);
    expect(executeCommand).not.toHaveBeenCalled();
  });

  it("源码不再保留可见性跳板（防止把收栏副作用重新挂回可见性）", () => {
    const source = readFileSync(
      join(__dirname, "..", "src", "ui", "chatPanel.ts"),
      "utf8",
    );
    expect(source).not.toContain("onVisible");
    expect(source).not.toContain("onDidChangeVisibility");
    expect(source).not.toContain("scheduleSidePanelsCollapse");
  });

  it("container 不再向 ChatPanel 注入跳转回调", () => {
    const container = readFileSync(
      join(__dirname, "..", "src", "container.ts"),
      "utf8",
    );
    const call = container.match(/new ChatPanel\(([\s\S]*?)\);/);
    expect(call).not.toBeNull();
    expect(call![1]).not.toContain("chatEditorPanel.reveal");
  });
});
