/**
 * 对话编辑器面板的**布局零副作用**契约（缺陷回归 2026-11-08）。
 *
 * 用户实测：点标题栏的「+（新建会话）」会**多出一个 Gode 对话标签**。
 * 根因不在 + 命令本身（它只回草稿态 + reveal），而在 reveal() 里挂的「收栏兜底」：
 * 它发 `workbench.action.closeAuxiliaryBar`，而我们的对话 WebviewPanel **就承载在
 * 辅助栏里**——关栏 = 销毁自己的面板 → `onDidDispose` 把 panel 从存活表摘掉 →
 * 下一次点 + 找不到页签只能 `create()`，于是"点一下就多一个标签"。
 * 日志实证：13:10:37 断开 gode.chat.editor → 13:10:41 连接 .2 → 13:10:47 连接 .3。
 *
 * 本测试用假 webview panel 真跑 create()/reveal()/openNew()，断言：
 * 1) 面板生命周期内**一条布局命令都不发**（closeAuxiliaryBar / closeSidebar / setPartHidden）；
 * 2) reveal() 复用存活页签，绝不重复 create；
 * 3) 新建页签只由 openNew（状态栏「新建页签」按钮）触发，且有上限保护；
 * 4) activeConnectionId() 与 reveal 选中同一块面板（定向投递不投错页）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const { ChatEditorPanel, MAX_CHAT_EDITOR_TABS } = await import("../src/ui/chatEditorPanel");

interface FakePanel {
  webview: {
    options: unknown;
    html: string;
    cspSource: string;
    asWebviewUri: () => string;
    onDidReceiveMessage: () => { dispose: () => void };
    postMessage: () => Promise<boolean>;
  };
  onDidChangeViewState: () => { dispose: () => void };
  onDidDispose: (handler: () => void) => { dispose: () => void };
  reveal: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  title: string;
  viewColumn: number;
  visible: boolean;
  /** 测试用：模拟 IDE 销毁该面板（关掉承载它的栏）。 */
  fireDispose: () => void;
}

function makePanel(visible = true): FakePanel {
  let disposeHandler: (() => void) | null = null;
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
    onDidDispose: (handler) => {
      disposeHandler = handler;
      return { dispose: () => {} };
    },
    reveal: vi.fn(),
    dispose: vi.fn(),
    title: "",
    viewColumn: -2,
    visible,
    fireDispose: () => disposeHandler?.(),
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
});

function newPanel(hostRuntime = makeHostRuntime()) {
  return {
    panel: new ChatEditorPanel(extensionUri, hostRuntime as never, () => null),
    hostRuntime,
  };
}

describe("对话编辑器面板：零布局副作用 + 不重复建标签", () => {
  it("创建/聚焦/销毁全程不发任何布局命令（关辅助栏会毁掉承载自己的栏）", async () => {
    const { panel } = newPanel();
    createWebviewPanel.mockImplementation(() => makePanel());

    panel.openNew();
    panel.reveal();
    panel.reveal();
    panel.dispose();
    await Promise.resolve();

    const issued = executeCommand.mock.calls.map((call) => call[0]);
    expect(issued).toEqual([]);
  });

  it("已存活页签时 reveal 复用，不新建（点 + 不会多出标签）", () => {
    const { panel } = newPanel();
    createWebviewPanel.mockImplementation(() => makePanel());

    const first = panel.openNew();
    expect(first.created).toBe(true);

    for (let i = 0; i < 5; i += 1) {
      expect(panel.reveal().created).toBe(false);
    }
    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
  });

  it("面板被销毁后可重建（此时才有新标签——且只在真的没有存活页签时）", () => {
    const { panel } = newPanel();
    const created: FakePanel[] = [];
    createWebviewPanel.mockImplementation(() => {
      const fake = makePanel();
      created.push(fake);
      return fake;
    });

    panel.openNew();
    expect(createWebviewPanel).toHaveBeenCalledTimes(1);
    // 模拟「外部把面板关掉」（用户拖到新窗口关闭 / IDE 布局回收）。
    created[0]!.fireDispose();
    expect(panel.reveal().created).toBe(true);
    expect(createWebviewPanel).toHaveBeenCalledTimes(2);
  });

  it("activeConnectionId 与 reveal 选中同一块面板；无页签时为 null", () => {
    const { panel } = newPanel();
    const created: FakePanel[] = [];
    createWebviewPanel.mockImplementation(() => {
      const fake = makePanel();
      created.push(fake);
      return fake;
    });

    expect(panel.activeConnectionId()).toBeNull();

    panel.openNew();
    expect(panel.activeConnectionId()).toBe("gode.chat.editor");

    // 多页签：visible 优先（与 reveal 的选中规则一致），都不可见时取最近创建。
    created[0]!.visible = false;
    panel.openNew();
    expect(panel.activeConnectionId()).toBe("gode.chat.editor.2");

    created[1]!.visible = false;
    expect(panel.activeConnectionId()).toBe("gode.chat.editor.2");
  });

  it("openNew 达上限后退化为聚焦，不无限创建 webview 实例", () => {
    const { panel } = newPanel();
    createWebviewPanel.mockImplementation(() => makePanel());

    for (let i = 0; i < MAX_CHAT_EDITOR_TABS; i += 1) panel.openNew();
    expect(createWebviewPanel).toHaveBeenCalledTimes(MAX_CHAT_EDITOR_TABS);

    const overflow = panel.openNew();
    expect(overflow.created).toBe(false);
    expect(createWebviewPanel).toHaveBeenCalledTimes(MAX_CHAT_EDITOR_TABS);
  });
});
