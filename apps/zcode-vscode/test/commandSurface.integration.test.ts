/**
 * 命令面集成测试（L2）：真实 registerEditorCommands + 真实 HostRuntime + 内存 webview
 * 连接，把命令面从「源码形状断言」（contributesConsistency）升级为行为断言。
 *
 * 装配（同 container.editorPushFrame 的双通道口径）：
 *   mock vscode（内存命令注册表 + window/workspace stub）
 *     → registerEditorCommands(deps)                （命令注册与处理逻辑全真实）
 *     → pushFrame: composer-insert → pushToActiveHostFrame；session-switch → 广播
 *     → HostRuntime attach 两个内存 webview 连接（sidebar 先、editor 后 = 最近活动 editor）。
 *
 * 锁定：
 * 1. 16 条编辑器命令全部注册；
 * 2. gode.addToContext：composer-insert 定向投给最近活动连接 + hasChatSurface 开窗门控
 *   （2026-11-19「加入上下文弹新窗」缺陷的行为级回归）；
 * 3. gode.addFileToContext：目录 → directory mention 帧；
 * 4. gode.pickSession：session-switch 广播（双页同显是有意设计）；
 * 5. gode.stop → zcodeTaskService.stopGeneration 调用面。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import * as vscode from "vscode";

// ── vscode mock：全部可变状态经 vi.hoisted（vi.mock 工厂在静态 import 期执行，
//    模块级 const 会 TDZ；vi.fn 也须在此创建）──
const {
  commandRegistry,
  infoMessages,
  statusMessages,
  windowState,
  createQuickPick,
  showInformationMessage,
  setStatusBarMessage,
  fsStat,
  fsReadDirectory,
  fsReadFile,
  MockUri,
  MockRange,
} = vi.hoisted(() => {
  class MockUri {
    readonly fsPath: string;
    constructor(fsPath: string) {
      this.fsPath = fsPath;
    }
    toString(): string {
      return `file://${this.fsPath}`;
    }
    static file(fsPath: string): MockUri {
      return new MockUri(fsPath);
    }
  }
  class MockRange {
    constructor(
      readonly start: { line: number; character: number },
      readonly end: { line: number; character: number },
    ) {}
  }
  return {
    commandRegistry: new Map<string, (...args: unknown[]) => unknown>(),
    infoMessages: [] as string[],
    statusMessages: [] as string[],
    windowState: { activeTextEditor: undefined as unknown },
    createQuickPick: vi.fn(),
    showInformationMessage: vi.fn((message: string) => infoMessages.push(message)),
    setStatusBarMessage: vi.fn((message: string) => statusMessages.push(message)),
    fsStat: vi.fn(),
    fsReadDirectory: vi.fn(),
    fsReadFile: vi.fn(),
    MockUri,
    MockRange,
  };
});

vi.mock("vscode", () => ({
  Uri: MockUri,
  Range: MockRange,
  Position: class {},
  commands: {
    registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
      commandRegistry.set(id, fn);
      return { dispose: () => commandRegistry.delete(id) };
    },
    executeCommand: (id: string, ...args: unknown[]) => {
      const fn = commandRegistry.get(id);
      if (!fn) throw new Error(`命令未注册: ${id}`);
      return Promise.resolve(fn(...args));
    },
  },
  window: {
    // 活动编辑器是运行时可变状态：getter 读 hoisted windowState（同一引用才可断言）。
    get activeTextEditor() {
      return windowState.activeTextEditor;
    },
    set activeTextEditor(value: unknown) {
      windowState.activeTextEditor = value;
    },
    showInformationMessage,
    setStatusBarMessage,
    createQuickPick,
  },
  workspace: {
    getWorkspaceFolder: (uri: { fsPath: string }) =>
      uri.fsPath.startsWith("/w/") || uri.fsPath === "/w"
        ? { uri: MockUri.file("/w") }
        : undefined,
    asRelativePath: (uri: { fsPath: string }) => uri.fsPath.replace("/w/", ""),
    fs: { stat: fsStat, readFile: fsReadFile, readDirectory: fsReadDirectory },
  },
  languages: { getDiagnostics: () => [] },
  FileType: { File: 1, Directory: 2 },
}));

// ── 被测对象与装配 ──
import {
  registerEditorCommands,
  type EditorCommandDependencies,
} from "../src/features/editorCommands";
import { HostRuntime } from "../src/host/hostRuntime";
import { createExposurePolicy } from "../src/host/serviceAssembly";
import { ServiceCollection } from "@zcode/services";
import { HostSettingsBridge, normalizeSettingsSnapshot } from "../src/host/hostSettingsBridge";

type HostFrameRecord = { t: string; kind?: string; payload?: unknown };

function makeRuntimeWithConnections(): {
  runtime: HostRuntime;
  editorFrames: HostFrameRecord[];
  sidebarFrames: HostFrameRecord[];
} {
  const runtime = new HostRuntime({
    services: new ServiceCollection(),
    exposurePolicy: createExposurePolicy(["zcode-agent"]),
    platformMethods: new Map(),
    settingsBridge: new HostSettingsBridge(() => normalizeSettingsSnapshot({})),
  });
  const editorFrames: HostFrameRecord[] = [];
  const sidebarFrames: HostFrameRecord[] = [];
  // attach 顺序即「最近活动」：侧栏先、编辑器后（还原真实场景——用户先开侧栏，
  // 后聚焦编辑器页签；composer-insert 应投给眼前的 editor 页）。
  runtime.attachWebview("gode.chat", {
    postMessage: (message: unknown) => sidebarFrames.push(message as HostFrameRecord),
  });
  runtime.attachWebview("gode.chat.editor", {
    postMessage: (message: unknown) => editorFrames.push(message as HostFrameRecord),
  });
  runtime.handleWebviewMessage("gode.chat", { t: "plat-evt", event: "notifyRendererReady" });
  runtime.handleWebviewMessage("gode.chat.editor", { t: "plat-evt", event: "notifyRendererReady" });
  return { runtime, editorFrames, sidebarFrames };
}

const EDITOR_COMMAND_IDS = [
  "gode.quickEdit",
  "gode.sendTerminalSelection",
  "gode.generateCommitMessage",
  "gode.reviewChanges",
  "gode.pickSession",
  "gode.codeAction",
  "gode.addRangeToChat",
  "gode.fixDiagnostics",
  "gode.explainSelection",
  "gode.fixSelection",
  "gode.refactorSelection",
  "gode.writeTests",
  "gode.addToContext",
  "gode.showEditorLogs",
  "gode.addFileToContext",
  "gode.stop",
] as const;

function buildDeps(
  runtime: HostRuntime,
  state: { hasChatSurface: boolean },
  fakeServices: { stopGeneration: ReturnType<typeof vi.fn>; listSessions: ReturnType<typeof vi.fn> },
): EditorCommandDependencies {
  return {
    getWorkspacePath: () => "/w",
    currentSessionId: () => "sess-1",
    pushFrame: (kind, payload) => {
      if (kind === "composer-insert") {
        runtime.pushToActiveHostFrame(kind, payload);
      } else {
        runtime.pushHostFrame(kind, payload);
      }
    },
    generateText: vi.fn().mockResolvedValue(""),
    quickEditProvider: {} as never,
    runWithServices: (run) =>
      run({
        zcodeAgentService: { listSessions: fakeServices.listSessions },
        zcodeTaskService: { stopGeneration: fakeServices.stopGeneration },
      } as never),
    hasChatSurface: () => state.hasChatSurface,
  };
}

/** 活动编辑器 stub：client.ts 10-11 行选区。 */
function stubActiveEditor(): void {
  const document = {
    uri: MockUri.file("/w/src/client.ts"),
    getText: (range: { start: { line: number }; end: { line: number } }) =>
      range.start.line === range.end.line ? "const x = 1;" : "const x = 1;\nconst y = 2;",
    lineCount: 20,
  };
  windowState.activeTextEditor = {
    document,
    selection: new MockRange({ line: 9, character: 0 }, { line: 10, character: 8 }),
  };
}

describe("命令面集成：registerEditorCommands → HostRuntime 帧", () => {
  let runtime: HostRuntime;
  let editorFrames: HostFrameRecord[];
  let sidebarFrames: HostFrameRecord[];
  let state: { hasChatSurface: boolean };
  const fakeServices = {
    stopGeneration: vi.fn(),
    listSessions: vi.fn(),
  };

  beforeEach(() => {
    commandRegistry.clear();
    infoMessages.length = 0;
    statusMessages.length = 0;
    windowState.activeTextEditor = undefined;
    createQuickPick.mockReset();
    fakeServices.stopGeneration.mockReset();
    fakeServices.listSessions.mockReset();
    fsStat.mockReset();
    fsReadDirectory.mockReset();
    fsReadFile.mockReset();
    ({ runtime, editorFrames, sidebarFrames } = makeRuntimeWithConnections());
    state = { hasChatSurface: true };
    // registerCommand 返回的 Disposable 仅供插件订阅语境 dispose；测试进程内保持注册。
    void registerEditorCommands(buildDeps(runtime, state, fakeServices));
    // gode.openChat 属 hostCommands（container 注册）：这里以 spy 代位，专测门控。
    commandRegistry.set("gode.openChat", vi.fn());
  });

  it("16 条编辑器命令全部注册（命令面完整性）", () => {
    const missing = EDITOR_COMMAND_IDS.filter((id) => !commandRegistry.has(id));
    expect(missing).toEqual([]);
  });

  it("gode.addToContext：composer-insert 定向投给最近活动连接（editor），侧栏不收", async () => {
    stubActiveEditor();

    await vscode.commands.executeCommand("gode.addToContext");

    const insert = editorFrames.find((frame) => frame.kind === "composer-insert");
    expect(insert).toBeTruthy();
    const payload = insert!.payload as { mentions: Array<{ id: string }>; mode: string };
    expect(payload.mode).toBe("prepend-if-missing");
    expect(payload.mentions[0]!.id).toContain("/w/src/client.ts:10-11");
    expect(sidebarFrames.find((frame) => frame.kind === "composer-insert")).toBeUndefined();
  });

  it("gode.addToContext：已有对话面（hasChatSurface=true）不执行 gode.openChat", async () => {
    stubActiveEditor();

    await vscode.commands.executeCommand("gode.addToContext");

    expect(commandRegistry.get("gode.openChat")).not.toHaveBeenCalled();
  });

  it("gode.addToContext：一个对话面都没有时才走 gode.openChat（门控路径）", async () => {
    state.hasChatSurface = false;
    stubActiveEditor();

    await vscode.commands.executeCommand("gode.addToContext");

    expect(commandRegistry.get("gode.openChat")).toHaveBeenCalledTimes(1);
    // 本 harness 连接仍就绪 → 帧照常定向投递；「无就绪连接 → pending 队列」由
    // hostBridge.test.ts 的队列用例单独覆盖。
  });

  it("gode.addToContext：无活动编辑器 → 明确提示，不发帧", async () => {
    await vscode.commands.executeCommand("gode.addToContext");

    expect(infoMessages).toContain("先打开一个文件。");
    expect(editorFrames.find((frame) => frame.kind === "composer-insert")).toBeUndefined();
  });

  it("gode.addRangeToChat：payload 范围 → 选区 mention 帧", async () => {
    const document = {
      uri: MockUri.file("/w/src/client.ts"),
      getText: () => "const x = 1;",
    };
    const range = new MockRange({ line: 4, character: 0 }, { line: 4, character: 10 });

    await vscode.commands.executeCommand("gode.addRangeToChat", { document, range });

    const insert = editorFrames.find((frame) => frame.kind === "composer-insert");
    const payload = insert!.payload as { mentions: Array<{ data: { startLine: number } }> };
    expect(payload.mentions[0]!.data.startLine).toBe(5);
  });

  it("gode.addFileToContext：目录 uri（编辑器标题入口）→ directory mention 帧", async () => {
    fsStat.mockResolvedValue({ size: 0, type: 2 });
    fsReadDirectory.mockResolvedValue([
      ["utils", 2],
      ["client.ts", 1],
    ]);

    await vscode.commands.executeCommand(
      "gode.addFileToContext",
      MockUri.file("/w/src"),
      [MockUri.file("/w/src")],
    );

    const insert = editorFrames.find((frame) => frame.kind === "composer-insert");
    const payload = insert!.payload as {
      mentions: Array<{ value: string; data: { kind: string } }>;
    };
    expect(payload.mentions[0]!.data.kind).toBe("directory");
    expect(payload.mentions[0]!.value).toBe("src/");
  });

  it("gode.pickSession：选中会话 → session-switch 广播（双连接都收，有意设计）", async () => {
    fakeServices.listSessions.mockResolvedValue([
      { sessionId: "sess-9", title: "历史会话" },
    ]);
    createQuickPick.mockImplementation(() => {
      const acceptListeners: Array<() => void> = [];
      const picker = {
        title: "",
        placeholder: "",
        matchOnDescription: false,
        busy: false,
        items: [] as Array<{ sessionId: string; label: string }>,
        selectedItems: [] as Array<{ sessionId: string }>,
        show: () => {
          // 数据到达 items 替换完成后，模拟用户回车 accept
          setImmediate(() => {
            picker.selectedItems = [picker.items[0]!];
            acceptListeners.forEach((fn) => fn());
          });
        },
        hide: () => {},
        dispose: () => {},
        onDidAccept: (fn: () => void) => acceptListeners.push(fn),
        onDidHide: () => {},
      };
      return picker;
    });

    await vscode.commands.executeCommand("gode.pickSession");
    // accept 走 setImmediate：让出微任务队列等待结算
    await new Promise((resolve) => setTimeout(resolve, 20));

    const switchFrames = [
      ...editorFrames.filter((frame) => frame.kind === "session-switch"),
      ...sidebarFrames.filter((frame) => frame.kind === "session-switch"),
    ];
    expect(switchFrames.length).toBe(2);
    expect(
      switchFrames.every(
        (frame) => (frame.payload as { sessionId: string }).sessionId === "sess-9",
      ),
    ).toBe(true);
    expect(statusMessages.some((message) => message.includes("sess-9"))).toBe(true);
  });

  it("gode.stop → zcodeTaskService.stopGeneration（taskId/workspacePath 调用面）", async () => {
    fakeServices.stopGeneration.mockResolvedValue({});

    await vscode.commands.executeCommand("gode.stop");

    expect(fakeServices.stopGeneration).toHaveBeenCalledWith({
      taskId: "sess-1",
      workspacePath: "/w",
    });
  });
});
