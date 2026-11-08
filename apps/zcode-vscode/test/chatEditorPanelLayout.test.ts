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
  workspace: {
    workspaceFolders: undefined,
    // gode.chat.openBeside 默认 false（= 首次打开不 split）。
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
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
  onDidChangeViewState: (handler: (event: { webviewPanel: FakePanel }) => void) => {
    dispose: () => void;
  };
  onDidDispose: (handler: () => void) => { dispose: () => void };
  reveal: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  title: string;
  viewColumn: number;
  visible: boolean;
  active: boolean;
  /** 测试用：模拟 IDE 销毁该面板（关掉承载它的栏）。 */
  fireDispose: () => void;
  /** 测试用：模拟该面板获得焦点（并排布局下多页同时 visible 时只有一个是 active）。 */
  fireActive: () => void;
}

function makePanel(visible = true): FakePanel {
  let disposeHandler: (() => void) | null = null;
  let viewStateHandler: ((event: { webviewPanel: FakePanel }) => void) | null = null;
  const panel: FakePanel = {
    webview: {
      options: {},
      html: "",
      cspSource: "vscode-webview://stub",
      asWebviewUri: () => "vscode-webview://stub/asset",
      onDidReceiveMessage: () => ({ dispose: () => {} }),
      postMessage: () => Promise.resolve(true),
    },
    onDidChangeViewState: (handler) => {
      viewStateHandler = handler;
      return { dispose: () => {} };
    },
    onDidDispose: (handler) => {
      disposeHandler = handler;
      return { dispose: () => {} };
    },
    reveal: vi.fn(),
    dispose: vi.fn(),
    title: "",
    viewColumn: -2,
    visible,
    active: visible,
    fireDispose: () => disposeHandler?.(),
    fireActive: () => {
      panel.active = true;
      viewStateHandler?.({ webviewPanel: panel });
    },
  };
  return panel;
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

  it("并排布局下多页同时可见：以最近获得焦点的页为准，不投给最旧的那页", () => {
    const { panel } = newPanel();
    const created: FakePanel[] = [];
    createWebviewPanel.mockImplementation(() => {
      const fake = makePanel();
      created.push(fake);
      return fake;
    });

    panel.openNew(); // gode.chat.editor
    panel.openNew(); // gode.chat.editor.2（新建即焦点页）
    // 两个页签在各自编辑器组里都 visible；旧实现只按插入序取第一个 → 命中 .1。
    expect(panel.activeConnectionId()).toBe("gode.chat.editor.2");

    // 用户点回第一页：投递目标必须跟着走（否则"新建会话"会清掉另一页）。
    created[0]!.fireActive();
    expect(panel.activeConnectionId()).toBe("gode.chat.editor");
    expect(panel.reveal().created).toBe(false);
  });

  it("首次打开不新建编辑器组（不把用户单组布局改成两组）", () => {
    const { panel } = newPanel();
    createWebviewPanel.mockImplementation(() => makePanel());

    panel.openNew();
    // 第三参 = showOptions：viewColumn 必须是 Active（-1），不是 Beside（-2）。
    expect(createWebviewPanel.mock.calls[0]![2]).toMatchObject({ viewColumn: -1 });
  });

  it("已有页签时新页签跟随它所在的组（尊重用户拖动/拆分后的位置）", () => {
    const { panel } = newPanel();
    const created: FakePanel[] = [];
    createWebviewPanel.mockImplementation(() => {
      const fake = makePanel();
      created.push(fake);
      return fake;
    });

    panel.openNew();
    // 用户把第一页拖到第 2 组。
    created[0]!.viewColumn = 2;
    panel.openNew();
    expect(createWebviewPanel.mock.calls[1]![2]).toMatchObject({ viewColumn: 2 });
  });

  it("标签 UI 上行只认编辑器页签连接（相似 id 不被误当成页签）", () => {
    const { panel } = newPanel();
    const created: FakePanel[] = [];
    createWebviewPanel.mockImplementation(() => {
      const fake = makePanel();
      created.push(fake);
      return fake;
    });

    panel.openNew();
    panel.handleEditorTabUi("gode.chat.editor", { title: "会话 A", busy: false });
    expect(created[0]!.title).toBe("会话 A");

    // 前缀相同但不是页签连接（未来新增的非对话 webview）：不得改任何面板标题。
    panel.handleEditorTabUi("gode.chat.editor-preview", { title: "不该出现", busy: false });
    expect(created[0]!.title).toBe("会话 A");
  });
});
