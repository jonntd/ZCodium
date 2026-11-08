/**
 * Container — 依赖装配与事件接线（v0.2.0 增量重构）。
 *
 * 依赖方向：extension(ui/chatPanel) → host(hostRuntime/serviceAssembly/桥) → @zcode/*。
 * 这里是唯一把所有模块接在一起的地方，extension.ts 保持薄壳。
 *
 * - Agent 传输层由 @zcode/services 承担（zcodeStdioTransport spawn + 进程管理）；
 * - 会话/审批/时间线 UI 由 @zcode/ui 承担（webview React）；
 * - 审批的 VS Code 原生面（diff/危险命令对话框）经 PlatformRpcHandler 的
 *   showDiff/showTextDocument 由 webview 侧路由触发；
 *   「本次会话允许」改为 settings 写回（appendSessionAllowlist，P0-8 写回面），
 *   host 侧不再持有 ApprovalService 实例（其内核类保留，见 approvals/approvalService.ts）。
 */

import type { ExtensionContext } from "vscode";
import { commands, env, languages, Uri, window, workspace } from "vscode";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { CliLocator } from "./cli/cliLocator";
import { createResolveFileDropPathsMethod } from "./host/fileDropPlatformMethod";
import { isPathInsideWorkspace } from "./host/pathContainment";
import {
  createCodeActionEntry,
  registerEditorCommands,
} from "./features/editorCommands";
import { createGenerateText } from "./features/oneShotText";
import { createQuickEditContentProvider } from "./features/quickEdit";
import { GodeCodeActionProvider } from "./features/codeActions";
import { setLogSink } from "./features/logger";
import { primaryWorkspacePath } from "./features/featureConfig";
import { buildDiagnosticsExportContent } from "./ui/diagnosticsBuffer";
import { ChatPanel, CHAT_VIEW_ID } from "./ui/chatPanel";
import { ChatEditorPanel } from "./ui/chatEditorPanel";
import { Diagnostics } from "./ui/diagnostics";
import { DiffViewer } from "./ui/diffViewer";
import { StatusBar } from "./ui/statusBar";
import {
  CLI_NOT_FOUND_LOG,
  WelcomePage,
  type WelcomeCardItem,
} from "./ui/welcomePage";
import { ExtensionStore } from "./store";
import {
  readConfig,
  readHostSettingsSnapshot,
  readGodeSetting,
  writeGodeSetting,
} from "./config";
import {
  IProjectService,
  IZCodeAgentService,
  IZCodeSessionService,
  IZCodeTaskService,
  type IServiceAccessor,
} from "@zcode/services";
import { ensureWorkspaceProjectBinding } from "./features/workspaceProjectBinding";
import {
  HostSettingsBridge,
  mergeAllowlistRules,
  normalizeAdditionalDirectories,
  normalizeSettingsSnapshot,
  normalizeToolRules,
  resolveZcodeAgentSpawnCommand,
} from "./host/hostSettingsBridge";
import { SessionsIndexBridge } from "./host/sessionsIndexBridge";
import { HostRuntime } from "./host/hostRuntime";
import {
  builtinProviderConfigPath,
  createPluginServices,
  EMPTY_ZCODE_BUILTIN_RELEASE_JSON,
  type PluginServiceAssembly,
} from "./host/serviceAssembly";
import type { PlatformMethodHandler } from "./host/platformRpcHandler";
import { RuntimeController } from "./runtimeController";
import { probeCapabilitiesFrame } from "./webview-react/capabilities";
import {
  createWorkspaceSessions,
  folderKey,
} from "./webview-react/session/workspaceSessions";
import { sessionAllowlistRule } from "./approvals/approvalService";
import { normalizeMcpServersForSettings } from "./configSettings";
import type { WorkspaceHostFramePayload } from "./host/hostFrameKinds";
import { registerHostCommands } from "./commands/hostCommands";
import { ChangesDiffOpener } from "./host/pendingChanges/diffOpener";
import { parsePatchHunks } from "./host/pendingChanges/beforeContent";

/** 指令导入的单文件内容上限（importWorkspaceInstructions，组4 一次性导入面）。 */
const INSTRUCTION_IMPORT_LIMIT_BYTES = 512 * 1024;

/** 会话标签共享态的 workspaceState 键（多页签/多对话页同步的 host 侧存储）。 */
const SESSION_TABS_HOST_KEY = "gode.sessionTabs.host";

export interface Container {
  chatPanel: ChatPanel;
  chatEditorPanel: ChatEditorPanel;
  hostRuntime: HostRuntime;
  runtimeController: RuntimeController;
  sessionsIndex: SessionsIndexBridge;
  statusBar: StatusBar;
  diagnostics: Diagnostics;
  diffViewer: DiffViewer;
  /** onboarding 引导面（P1-10.2/P1-10.3；CLI 未找到时自动呈现，T13）。 */
  welcomePage: WelcomePage;
  /** 3 步上手卡命令面（P1-10.2「随时可看」入口；CLI 实况由容器闭包读取）。 */
  presentOnboarding(): Promise<void>;
  /**
   * 首次打开对话的一次性上手卡（globalState 标记，仅首次呈现；openChat/newSession/
   * newChatTab 等入口经 registerCommands 注入的 firstOpen 钩子触发）。
   */
  presentOnboardingOnce(): void;
  services: PluginServiceAssembly;
  dispose(): Promise<void>;
}

export async function createContainer(
  context: ExtensionContext,
): Promise<Container> {
  const diagnostics = new Diagnostics();
  const statusBar = new StatusBar();
  const store = ExtensionStore.fromContext(context);
  const diffViewer = new DiffViewer();
  // per-folder 会话键控（P1-1.5/P1-2 host 半）：webview 侧 workspaceSessions 与
  // host 编排共用同一 ExtensionStore 键空间（只读复用 + 编排层写穿透）。
  const workspaceSessions = createWorkspaceSessions(store);
  const listFolders = () =>
    (workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);

  /** chat 侧文件路径（绝对为主）→ 工作区根解析兜底的 Uri（编辑器直开路由用）。 */
  const resolveWorkspaceUri = (path: string): Uri => {
    if (isAbsolute(path)) return Uri.file(path);
    const root = listFolders()[0];
    return Uri.file(root ? join(root, path) : path);
  };

  // ── 设置桥（code.* → create/resume/spawn 参数；先于 services 装配） ──
  const settingsBridge = new HostSettingsBridge(
    readHostSettingsSnapshot,
    (handler) =>
      workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("gode.")) handler();
      }),
  );

  // ── Agent 命令解析：cliLocator（保留改造）→ zcodeAgentCommandResolver ──
  // let：onboarding「重新检测」（P1-10.2）更新 CLI 面后，resolver 闭包按活绑定读新值。
  // 探测优先级：cliPath 设置 → PATH → 内置 bundle（cli-bundle/zcode.cjs，随 vsix 分发、
  // 与 monorepo 同 commit 构建；JS 入口经宿主 Node + ELECTRON_RUN_AS_NODE spawn）。
  const locator = new CliLocator(
    process.env["PATH"] ?? "",
    join(context.extensionUri.fsPath, "cli-bundle", "zcode.cjs"),
  );
  const cliPathOverride = readConfig().cliPath;
  let cliInfo = await locator.locate(cliPathOverride || undefined);
  if (!cliInfo) {
    // 诊断语义与 src/ui/welcomePage.ts 的 CLI_NOT_FOUND_LOG 同源（P1-10.2 引导对接面）。
    diagnostics.log(CLI_NOT_FOUND_LOG);
  }

  // （历史说明：v0.2.0 早期曾向 globalStorage/provider 种空 Release 并将数据根隔离到
  // globalStorage；M2 起改为共享桌面端 ~/.zcodium + CLI 完整内置目录（见上），空种子
  // 与隔离数据根均已退役。EMPTY_ZCODE_BUILTIN_RELEASE_JSON 常量与 providerConfigSeed
  // 测试保留（releaseSchema 契约样本）。）

  // ── 服务装配（数据根 = 桌面端默认 ~/.zcodium，与桌面共享会话/模型/登录态；频道白名单裁剪） ──
  // PRD §1.1 口径：「插件不复制 Agent 逻辑，但共享同一套会话存储」——不设 dataRootDir
  // 即回落 services 默认根（homedir/.zcodium）。代价：桌面端与插件同时运行时可能争用
  // CLI 存储锁（agents-state.json.lock）；zcodium-vscode PRD §8.4 的存储冲突门在共享
  // 模式下是已知取舍。
  // 内置 Provider 目录用 CLI 构建产物里的完整目录（cli-bundle/provider/zcode-builtin.json，
  // 含内置模型名单），不再是空 Release——添加模型弹窗的智能配置/检测可用模型才有数据源。
  // 工具面注入点（P1-3，勘察风险 1 裁决）：resolver 每次 spawn 调用（services 进程管理
  // zcodeAgentProcessManager 保证），因此这里按次读 HostSettingsBridge 快照，把
  // allowlist/denylist 编译为 --allowed-tools/--disallowed-tools 旗标；settings 变更 =
  // 下次 spawn 生效（不做运行中进程的热更新）。
  const services = createPluginServices({
    zcodeBuiltinProviderConfigFilePath: join(
      context.extensionUri.fsPath,
      "cli-bundle/provider/zcode-builtin.json",
    ),
    zcodeAgentCommandResolver: (spawnContext) => {
      if (!cliInfo) return null;
      // spawn argv 只含协议服务参数；工具规则经 createSession/resumeSession 协议参数下发
      // （真机教训：--allowed-tools 等 TUI 旗标不被 app-server 接受，会引发崩溃风暴）。
      const spawn = resolveZcodeAgentSpawnCommand(cliInfo.path, {
        nodeScript: cliInfo.nodeScript === true,
      });
      diagnostics.log(`[agent-spawn] spawn（workspace=${spawnContext.workspacePath}）`);
      return spawn;
    },
    zcodeAgentSpawnFallbackCwd:
      workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
  });

  // ── IDE 工程绑定（spec: ide-workspace-project-binding） ──
  // 新建任务要落进 IDE 当前工程的分组：先把打开的 folder 幂等注册为本地工程
  // （已有声明该根目录的工程则复用）；失败降级为任务未归类，不阻断对话面。
  const bindWorkspaceProjects = (): void => {
    void ensureWorkspaceProjectBinding({
      listFolders,
      getProjectService: () => services.services.get(IProjectService),
    });
  };
  bindWorkspaceProjects();

  // ── per-folder 会话索引桥（T06/T09 host 半：zcode-session 频道聚合 + 多根 QuickPick） ──
  const sessionsIndex = new SessionsIndexBridge({
    sessionService: services.services.get(IZCodeSessionService),
    workspaceSessions,
    listFolders,
    pickFolder: async (folders) =>
      (await window.showQuickPick(folders, {
        placeHolder:
          "选择 Gode 会话归属的 workspace folder（P1-2：会话按 folder 独立）",
        canPickMany: false,
      })) ?? null,
    log: (message) => diagnostics.log(message),
  });

  // ── 平台方法实现（host 端 VS Code API 落地面） ──
  // runtimeController 双向依赖（plat 写会话键 ↔ controller 持 agentService）：经占位解环。
  const runtimeControllerPlaceholder: { current?: RuntimeController } = {};
  // 聊天卡片「审查」用的原生双栏 diff，装配晚于平台方法表，占位懒解引用。
  const diffOpenerPlaceholder: { current?: ChangesDiffOpener } = {};
  const platformMethods = new Map<string, PlatformMethodHandler>(
    Object.entries(
      buildPlatformMethods({
        context,
        log: (message) => diagnostics.log(message),
        diffViewer,
        store,
        statusBar,
        sessionsIndex,
        runtimeController: () => runtimeControllerPlaceholder.current,
        resolveWorkspaceUri,
        diffOpener: () => diffOpenerPlaceholder.current,
        primaryFolder: () => listFolders()[0],
        // exportLogs 聚合源（§7.10）：输出通道内存镜像读取面（Diagnostics 持有）。
        diagnosticsSnapshot: () => diagnostics.snapshotLines(),
        // P1-1.1 降级列表数据源（M18）：workspaceSessions 键空间的只读投影。
        latestSessionIdByFolder: () => {
          const table: Record<string, string | undefined> = {};
          for (const folder of listFolders()) {
            const key = folderKey(folder);
            table[key] = workspaceSessions.get(key);
          }
          return table;
        },
      }),
    ),
  );

  // ── 桥运行时 + 面板 ──
  const hostRuntime = new HostRuntime({
    services: services.services,
    exposurePolicy: services.exposurePolicy,
    platformMethods,
    settingsBridge,
    // renderer 就绪 → 下发初始 host 帧（§2.2；M15 修复：原为空钩子）。
    // theme/locale/workspace 快照读 vscode API；初始帧经 postById 定向投递到刚就绪
    // 的连接（visibility 不再生产：多形态并存后广播会跨页污染，见 chatPanel.ts）。
    sendInitialFrames: (push) => {
      push("theme", window.activeColorTheme.kind);
      push("locale", env.language);
      const payload: WorkspaceHostFramePayload = {
        kind: "workspace-changed",
        folders: (workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
        activeFolder: workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
      };
      push("workspace", payload);
    },
    // 编辑器标签 UI 上行 → 回写对应 WebviewPanel 标题（会话标题/忙态前缀；
    // chatEditorPanel 声明在后，回调运行时才解引用，TDZ 无虞）。
    onEditorTabUi: (connectionId, payload) => {
      chatEditorPanel.handleEditorTabUi(connectionId, payload);
    },
    // 会话标签共享态持久化（多页签/多对话页同步的 host 侧存储）。
    sessionTabsPersistence: {
      read: () => context.workspaceState.get<unknown>(SESSION_TABS_HOST_KEY) ?? null,
      write: (value) => {
        void context.workspaceState.update(SESSION_TABS_HOST_KEY, value);
      },
    },
    // 空态「历史会话」主按钮 → 复用 gode.pickSession 全链（快捷选择 + session-switch + reveal）。
    onRequestSessionPicker: () => {
      void commands.executeCommand("gode.pickSession");
    },
    log: (message) => diagnostics.log(message),
  });

  // ── 薄编排（Agent 生命周期 + resume 编排，P1-6 崩溃横幅/自动恢复） ──
  const runtimeController = new RuntimeController({
    agentService: hostRuntime.agentService,
    settingsBridge,
    workspaceSessions,
    listFolders,
    log: (message) => diagnostics.log(message),
    events: {
      onStateChange: (state) => statusBar.setState(state),
      onRuntimeRestart: (outcome) => {
        // 横幅帧（P1-6：换代→横幅→自动恢复→失败降级）；载荷形状见 hostFrameKinds.ts。
        hostRuntime.pushHostFrame("restart", outcome);
      },
      onSessionRestoreFailure: (failure) => {
        // 纠正帧：webview 可能已按 bootstrap data-session-id 订阅失效会话（HTML 构建
        // 早于恢复完成，竞态固有）→ session-switch null 拉回草稿态，避免
        // fault.subscribe.sessionNotFound 错误卡住对话区。
        diagnostics.log(
          `[runtime] 恢复失败纠正：folder=${failure.folder} → webview 回草稿态`,
        );
        hostRuntime.pushHostFrame("session-switch", { sessionId: null });
      },
    },
  });
  runtimeControllerPlaceholder.current = runtimeController;

  // ── 原生编辑器 / 双栏 diff（聊天卡片「打开」「审查」的宿主落地面）──
  // 「文件改动历史」TreeView 及其会话订阅、状态栏角标、命令族已整体移除；
  // 只保留 diffOpener，供 openPatchDiffInEditor 复用 zcode-before 反向应用管线。
  const changesDiffOpener = new ChangesDiffOpener();
  diffOpenerPlaceholder.current = changesDiffOpener;
  context.subscriptions.push(changesDiffOpener.register(), {
    dispose: () => changesDiffOpener.dispose(),
  });

  // ── 状态栏投影（P0-2/P0-9）：Agent 生命周期事件 → setState（审批角标接 plat 上报面） ──
  // capabilities 横切生产面（T07「接线后行为」+ FR-A13 残余吸收，closeout-2）：agent
  // 就绪即探测能力面（编排见 webview-react/capabilities.ts probeCapabilitiesFrame），
  // 经 capabilities 帧下发 webview。full 模式单通道（§8.5）下进程内栈永不 spawn →
  // 本事件不触发 → 恒无帧，App 静默。
  const pushCapabilitiesFrame = (event: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): void => {
    void probeCapabilitiesFrame({
      agentService: hostRuntime.agentService,
      workspaceTarget: {
        workspacePath: event.workspacePath,
        ...(event.workspaceIdentity
          ? { workspaceIdentity: event.workspaceIdentity }
          : {}),
      },
      log: (message) => diagnostics.log(message),
    })
      .then((payload) => hostRuntime.pushHostFrame("capabilities", payload))
      .catch((error: unknown) => {
        diagnostics.log(
          `[capabilities] 能力帧生产异常：${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
  const lifecycleDisposable =
    hostRuntime.agentService.onAgentRuntimeLifecycle?.((event) => {
      statusBar.setState(event.state === "available" ? "ready" : "starting");
      // 探测是控制面读（不落盘、不建会话），fire-and-forget：失败已收敛为帧载荷，不外抛。
      if (event.state === "available") pushCapabilitiesFrame(event);
    });
  if (lifecycleDisposable) context.subscriptions.push(lifecycleDisposable);

  // ── 侧栏对话面（插件原生形态）：webview 挂载与 full/server 形态同源的桌面 Root， ──
  // ── 服务走进程内 ServiceCollection（与桌面 host 同一装配入口 createLocalServices）。──
  // bootstrap data-session-id：优先运行时已验证（activeSessions = restore 成功面），
  // 恢复尚未完成时乐观回落持久化键（失败由 onSessionRestoreFailure 纠正帧兜底）。
  const resolveInitialSessionId = (folder: string): string | null =>
    runtimeController.activeSession(folder) ??
    workspaceSessions.get(folderKey(folder)) ??
    null;
  // 编辑器标签页形态（可拖动/拆分/移动）：与侧栏共用同一 Root 与 hostRuntime 多连接桥。
  const chatEditorPanel = new ChatEditorPanel(
    context.extensionUri,
    hostRuntime,
    resolveInitialSessionId,
  );
  // 侧栏跳板 + 侧栏自动展开兜底：视图变为可见（无论触发源——点活动栏图标、IDE
  // 恢复布局、还是任意代码/命令把它展开）→ 聚焦编辑器标签。收栏逻辑内聚在
  // ChatEditorPanel.reveal()（延迟收起，赢过 IDE 对 agent webview 聚焦的自动展开）。
  const chatPanel = new ChatPanel(context.extensionUri, hostRuntime, resolveInitialSessionId, () => {
    chatEditorPanel.reveal();
  });

  // ── 服务调用统一路由（PRD §8.5 单通道） ──
  // 进程内 ServiceCollection 直取（命令面只用 agent/task 两服务；编辑器命令与
  // 一次性生成都走这条通道，无 WS/握手/项目注册面）。
  const runWithServices = <T>(
    run: (accessor: IServiceAccessor) => Promise<T>,
  ): Promise<T> => {
    const paneAccessor = {
      zcodeAgentService: services.services.get(IZCodeAgentService),
      zcodeTaskService: services.services.get(IZCodeTaskService),
    } as unknown as IServiceAccessor;
    return run(paneAccessor);
  };

  // ── onboarding 引导面（T13，P1-10.2/P1-10.3）：welcomePage 纯层 + vscode 端口落地 ──
  // - CLI 未找到 → 信息条引导（「重新检测」入口；检测事实已按 [cli] 行写诊断，不重复）；
  // - 3 步上手卡：QuickPick 卡面（说明项 + 重新检测 + Claude 导入入口）；
  // - Claude 导入入口走组4 面板 open-panel 帧（import-claude-sessions），不改组4 文件。
  const welcomePage = new WelcomePage({
    log: (message) => diagnostics.log(message),
    showInformation: (message, actions) =>
      Promise.resolve(window.showInformationMessage(message, ...actions)),
    showCard: async (items: readonly WelcomeCardItem[]) => {
      const picked = await window.showQuickPick([...items], {
        placeHolder: "Gode Agent：3 步上手",
        canPickMany: false,
      });
      return picked?.action;
    },
    revealChat: () => chatEditorPanel.reveal(),
    revealClaudeImportPanel: () => {
      // open-panel 是 UI 定向帧：只投给最近活动的对话页（广播会让两页同时弹面板）。
      hostRuntime.pushToActiveHostFrame("open-panel", {
        panel: "import-claude-sessions",
      });
      chatEditorPanel.reveal();
    },
    showLogs: () => diagnostics.show(),
    recheckCli: async () => {
      const found = await locator.locate(readConfig().cliPath || undefined);
      cliInfo = found;
      if (found) {
        // 等价 restartAgent 命令语义：释放运行时，下次对话经新 CLI 面重拉。
        services.services.get(IZCodeAgentService).disposeAll();
      }
      return found !== null;
    },
  });

  // ── renderer 就绪 → 下发初始 host 帧（theme/locale/workspace/可见性） ──
  context.subscriptions.push(
    window.onDidChangeActiveColorTheme((theme) => {
      hostRuntime.pushHostFrame("theme", theme.kind);
    }),
    workspace.onDidChangeWorkspaceFolders(() => {
      bindWorkspaceProjects();
      hostRuntime.pushHostFrame("workspace", {
        folders: (workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
        activeFolder: workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
        kind: "workspace-changed",
      });
    }),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("gode.")) {
        hostRuntime.pushHostFrame("workspace", { kind: "settings-changed" });
      }
    }),
  );

  // ── activate 后：per-folder 最近会话恢复（P1-1.5 host 半；resume 恒带约束面） ──
  void runtimeController.restoreWorkspaceSessions().catch(() => undefined);

  // ── P1-10.2：CLI 未找到 → 呈现安装引导与「重新检测」入口（P0-1 引导语义） ──
  if (!cliInfo) void welcomePage.presentCliMissing();

  // ── M1 编辑器原生功能（移植自 apps/zcodium-vscode features/）：Quick Edit、
  //    Code Action + 诊断修复、终端送入、Git 提交信息/改动审阅、历史会话、上下文加入 ──
  // 一次性文本生成走进程内 ServiceCollection 直调（oneShotText.ts）；「发进对话」走
  // composer-insert host 帧（webview requestComposerTextInsert 预填，P1-5 同通道）。
  setLogSink((line) => diagnostics.log(line));
  const quickEditProvider = createQuickEditContentProvider();
  const quickEditDisposable = workspace.registerTextDocumentContentProvider(
    "gode-quick-edit",
    quickEditProvider,
  );
  const editorWorkspacePath = () =>
    workspace.workspaceFolders?.[0]?.uri.fsPath ?? primaryWorkspacePath() ?? "";

  /**
   * M1「发进对话」：composer-insert host 帧预填 webview composer（P1-5 同通道）。
   * 侧栏 Root 与 full 形态同源，composer 可见可编辑，用户在界面里确认发送；
   * 选区/文件上下文随文本块一起预填，不再有跨源直发隐藏会话的架构断裂。
   */
  const editorPushFrame = (
    kind: "composer-insert" | "session-switch",
    payload: unknown,
  ): void => {
    // composer-insert 是纯 UI 定向内容（composer 预填）：只投给最近活动的对话页，
    // 避免「在页面 A 加入上下文，页面 B 的输入框也被预填」的跨页污染；
    // session-switch 是会话语义（历史会话切换），双页同显是有意设计，保持广播。
    if (kind === "composer-insert") {
      hostRuntime.pushToActiveHostFrame(kind, payload);
    } else {
      hostRuntime.pushHostFrame(kind, payload);
    }
  };
  const editorFeatureDisposables = registerEditorCommands({
    getWorkspacePath: editorWorkspacePath,
    currentSessionId: () => {
      const primary = editorWorkspacePath();
      if (!primary) return null;
      return workspaceSessions.get(folderKey(primary)) ?? null;
    },
    pushFrame: editorPushFrame,
    generateText: createGenerateText(runWithServices, editorWorkspacePath()),
    quickEditProvider,
    runWithServices,
  });
  const codeActionEntry = createCodeActionEntry(editorPushFrame);
  const codeActionDisposable = languages.registerCodeActionsProvider(
    { scheme: "file" },
    new GodeCodeActionProvider(codeActionEntry),
    GodeCodeActionProvider.metadata,
  );
  context.subscriptions.push(
    quickEditDisposable,
    codeActionDisposable,
    ...editorFeatureDisposables,
  );

  return {
    chatPanel,
    chatEditorPanel,
    hostRuntime,
    runtimeController,
    sessionsIndex,
    statusBar,
    diagnostics,
    diffViewer,
    welcomePage,
    presentOnboarding: () => welcomePage.presentOnboarding({ cli: cliInfo }),
    // 一次性上手卡：首次打开对话（任一打开入口）自动呈现，之后只在用户主动调
    // gode.onboarding 时出现。globalState 持久化标记，重装/重开窗口不重复打扰。
    presentOnboardingOnce: () => {
      const key = "gode.onboarding.autoPresented";
      if (context.globalState.get<boolean>(key, false)) return;
      void context.globalState.update(key, true);
      void welcomePage.presentOnboarding({ cli: cliInfo });
    },
    services,
    async dispose(): Promise<void> {
      chatEditorPanel.dispose();
      runtimeController.dispose();
      hostRuntime.dispose();
      await services.dispose();
      statusBar.dispose();
      diagnostics.dispose();
    },
  };
}

/** host 端平台方法实现表（webview plat-req 白名单内方法的 VS Code 落地）。 */
function buildPlatformMethods(deps: {
  context: ExtensionContext;
  log: (message: string) => void;
  diffViewer: DiffViewer;
  store: ExtensionStore;
  statusBar: StatusBar;
  sessionsIndex: SessionsIndexBridge;
  runtimeController: () => RuntimeController | undefined;
  /** chat 路径 → 工作区根解析兜底的 Uri（编辑器直开路由）。 */
  resolveWorkspaceUri: (path: string) => Uri;
  /** 原生双栏 diff（聊天卡片「审查」）；装配顺序晚于本表，闭包延迟解引用。 */
  diffOpener: () => ChangesDiffOpener | undefined;
  primaryFolder: () => string | undefined;
  /** per-folder 最近会话键表（P1-1.1 降级列表数据源；M18）。 */
  latestSessionIdByFolder: () => Record<string, string | undefined>;
  /** exportLogs 聚合源（§7.10）：输出通道内存镜像快照读取面（Diagnostics 持有）。 */
  diagnosticsSnapshot: () => string[];
}): Record<string, PlatformMethodHandler> {
  const { context, diffViewer, store, statusBar, sessionsIndex, resolveWorkspaceUri, diffOpener } =
    deps;
  const deviceIdKey = "gode.deviceId";
  const getDeviceId = (): string => {
    const existing = context.globalState.get<string>(deviceIdKey);
    if (existing) return existing;
    const id = randomUUID();
    void context.globalState.update(deviceIdKey, id);
    return id;
  };

  return {
    // 文件/目录选择（QuickPick / showOpenDialog）。
    selectDirectory: async () => {
      const uris = await window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
      });
      return uris?.[0]?.fsPath ?? null;
    },
    selectDirectories: async () => {
      const uris = await window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: true,
      });
      return (uris ?? []).map((uri) => uri.fsPath);
    },
    selectFile: async () => {
      const uris = await window.showOpenDialog({
        canSelectFolders: false,
        canSelectFiles: true,
        canSelectMany: false,
      });
      return uris?.[0]?.fsPath ?? null;
    },
    selectFiles: async () => {
      const uris = await window.showOpenDialog({
        canSelectFolders: false,
        canSelectFiles: true,
        canSelectMany: true,
      });
      return (uris ?? []).map((uri) => uri.fsPath);
    },
    // 打开/跳转。
    openExternal: async (args) => {
      const url = args[0];
      if (typeof url !== "string")
        throw new Error("openExternal: url 必须为字符串");
      const parsed = Uri.parse(url);
      // scheme 白名单：杜绝 webview 侧借 openExternal 触发任意 scheme（command:/javascript: 等）。
      if (
        ![
          "http",
          "https",
          "mailto",
          "file",
          "vscode",
          "vscode-insiders",
        ].includes(parsed.scheme)
      ) {
        throw new Error(`openExternal: 不支持的 scheme「${parsed.scheme}」`);
      }
      await env.openExternal(parsed);
    },
    openInFileManager: async (args) => {
      const path = args[0];
      if (typeof path !== "string")
        throw new Error("openInFileManager: path 必须为字符串");
      // stable API 无 revealIfVisible 选项：打开文件所在目录。
      await env.openExternal(Uri.file(path));
      return { success: true };
    },
    openExternalFile: async () => ({
      success: false,
      error: "由 VS Code 打开文件语义承担",
    }),
    openFeedback: async () => {
      await env.openExternal(Uri.parse("https://zcode.dev/feedback"));
    },
    openCommunity: async () => {
      await env.openExternal(Uri.parse("https://zcode.dev/community"));
    },
    canOpenCommunity: async () => true,
    // 编辑器集成。
    showDiff: async (args) => {
      const path = args[0];
      const proposed = typeof args[1] === "string" ? args[1] : undefined;
      if (typeof path !== "string")
        throw new Error("showDiff: path 必须为字符串");
      return diffViewer.open(`plat-${Date.now()}`, path, proposed);
    },
    showTextDocument: async (args) => {
      const path = args[0];
      if (typeof path !== "string")
        throw new Error("showTextDocument: path 必须为字符串");
      await window.showTextDocument(Uri.file(path), { preview: true });
      return true;
    },
    // code viewer 打开意图 → 宿主编辑器（webview 侧宽度过窄时的编辑器直开路由）。
    openFileInEditor: async (args) => {
      const path = args[0];
      if (typeof path !== "string")
        throw new Error("openFileInEditor: path 必须为字符串");
      await commands.executeCommand("vscode.open", resolveWorkspaceUri(path), {
        preview: true,
      });
      return true;
    },
    openPatchDiffInEditor: async (args) => {
      const request = args[0] as
        | {
            resolvedPath?: unknown;
            patches?: unknown;
          }
        | undefined;
      const resolvedPath =
        typeof request?.resolvedPath === "string" ? request.resolvedPath : undefined;
      if (!resolvedPath || !Array.isArray(request?.patches))
        throw new Error("openPatchDiffInEditor: resolvedPath/patches 必须提供");
      // 安全审查 S1：webview 传任意路径 = 任意文件读取 oracle（文件内容进 diff
      // 面板）。路径必须落在 workspace folder 内（fail-closed：无工作区一律拒绝）。
      const folders = (workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
      if (!isPathInsideWorkspace(resolvedPath, folders)) {
        throw new Error("openPatchDiffInEditor: resolvedPath 不在 workspace 内，已拒绝");
      }
      // 安全审查 S4：patches 形状宽松解析，畸形输入报参数错误而非未捕获异常。
      const patches = parsePatchHunks(request.patches);
      if (patches === null) {
        throw new Error("openPatchDiffInEditor: patches 形状非法（须为 hunk 数组）");
      }
      const opener = diffOpener();
      if (!opener) throw new Error("openPatchDiffInEditor: diffOpener 未就绪");
      // 复用 pendingChanges 的原生双栏 diff（zcode-before 反向应用管线）。
      await opener.openPendingDiff({ resolvedPath, patches });
      return true;
    },
    revealWorkspace: async () => {
      await commands.executeCommand("workbench.view.explorer");
      return true;
    },
    // 诊断/通知/设备。
    // exportLogs 聚合口径（架构 §7.10）：导出真实诊断面——输出通道内存镜像
    // （Diagnostics 环形缓冲）；为空时如实标注「（无记录）」。
    exportLogs: async () => {
      const logsDir = join(context.globalStorageUri.fsPath, "logs");
      await mkdir(logsDir, { recursive: true });
      const content = buildDiagnosticsExportContent({
        diagnosticsLines: deps.diagnosticsSnapshot(),
      });
      const tempPath = join(logsDir, `gode-${Date.now()}.log`);
      await writeFile(tempPath, content, "utf8");
      await window.showTextDocument(Uri.file(tempPath), { preview: true });
      return { success: true, path: tempPath };
    },
    showTaskNotification: async (args) => {
      const payload = args[0] as { title?: string; body?: string } | undefined;
      const choice = await window.showInformationMessage(
        payload?.title ?? "Gode",
        "打开",
      );
      if (choice === "打开")
        await commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    },
    getDeviceId: async () => getDeviceId(),
    activateOrSetWorkspace: async (args) => {
      // 多根工作区聚焦对应 folder（P1-2 的 host 半；完整切换在 T06）。
      const path = args[0];
      const folder = (workspace.workspaceFolders ?? []).find(
        (f) => f.uri.fsPath === path,
      );
      return { activated: folder !== undefined };
    },
    openDataRootImport: async () => {
      void window.showInformationMessage(
        "数据目录导入：请使用桌面端完成（插件侧无需迁移）",
      );
    },
    getSystemLocale: async () => env.language,
    // MCP 本机目录（桌面 ~/.zcode mcp.json；插件场景读宿主默认路径，P1-8）。
    loadMcpFromUserDirectory: async () => ({ servers: [] }),
    saveMcpToUserDirectory: async () => ({
      success: false,
      error: "请在插件设置 gode.mcp.servers 中配置（改动后需重建会话生效）",
    }),
    migrateLegacyCommonMcp: async () => ({
      servers: {},
      totalCount: 0,
      importedCount: 0,
      skippedCount: 0,
    }),
    // 同步面（未读投影归 webview 本地，P0-9：host 不再写 __unread__ 键槽）。
    syncWindowUnreadCount: async () => undefined,
    syncWindowTabs: async () => undefined,
    syncActiveTaskSession: async () => undefined,
    registerOAuthState: async () => undefined,
    // saveFile（白名单方法的真实落地面，此前缺失 → 调用恒 "method not allowed"）：
    // webview 传 dataB64（ArrayBuffer 过 postMessage 的 base64 形态）或 sourceUrl（host 侧拉取），
    // 弹 VS Code 保存对话框后写盘；两者皆缺时返回可读错误（数据面由附件上传链路承担）。
    saveFile: async (args) => {
      const payload = args[0] as
        | { dataB64?: string; sourceUrl?: string; suggestedName?: string }
        | undefined;
      const suggested =
        typeof payload?.suggestedName === "string" &&
        payload.suggestedName.trim().length > 0
          ? basename(payload.suggestedName.trim())
          : "download";
      const target = await window.showSaveDialog({
        defaultUri: Uri.file(suggested),
      });
      if (!target) return { success: false, canceled: true };
      let bytes: Uint8Array;
      if (typeof payload?.dataB64 === "string" && payload.dataB64.length > 0) {
        bytes = new Uint8Array(Buffer.from(payload.dataB64, "base64"));
      } else if (
        typeof payload?.sourceUrl === "string" &&
        payload.sourceUrl.length > 0
      ) {
        const res = await fetch(payload.sourceUrl);
        if (!res.ok)
          return {
            success: false,
            error: `saveFile: sourceUrl 拉取失败（HTTP ${res.status}）`,
          };
        bytes = new Uint8Array(await res.arrayBuffer());
      } else {
        return {
          success: false,
          error: "saveFile: 缺少 dataB64/sourceUrl（数据面由附件上传链路承担）",
        };
      }
      await writeFile(target.fsPath, bytes);
      return { success: true, path: target.fsPath };
    },
    // 附件（审批/引用场景的临时文本文件，落 globalStorage/tmp）。
    createTempTextAttachment: async (args) => {
      const payload = args[0] as
        | { text: string; filename?: string }
        | undefined;
      // filename 收敛为 basename：杜绝 webview 侧借路径分隔符写穿 tmp 目录（path traversal）。
      const filename = basename(
        payload?.filename ?? `attachment-${Date.now()}.txt`,
      );
      if (!filename || filename === "." || filename === "..") {
        throw new Error("createTempTextAttachment: filename 非法");
      }
      const dir = join(context.globalStorageUri.fsPath, "tmp");
      await mkdir(dir, { recursive: true });
      const localPath = join(dir, filename);
      await writeFile(localPath, payload?.text ?? "", "utf8");
      return {
        filename,
        localPath,
        mimeType: "text/plain" as const,
        sizeBytes: (payload?.text ?? "").length,
      };
    },
    // 资源管理器拖拽 URI 解析（spec: composer-explorer-file-drop）；vscode/fs 接线在
    // fileDropPlatformMethod.ts，container 只保留装配入口（max-file-lines 门禁）。
    resolveFileDropPaths: createResolveFileDropPathsMethod(),
    // ── 会话/编排接线（T02/T06：host 侧先行定义，组3/4 消费） ──
    /** 会话创建上报：写穿透 per-folder 键空间（P1-1.5），下次 activate 可恢复。 */
    notifySessionCreated: async (args) => {
      const sessionId = args[0];
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("notifySessionCreated: sessionId 必须为非空字符串");
      }
      const folder =
        typeof args[1] === "string" && args[1].trim()
          ? args[1]
          : deps.primaryFolder();
      if (!folder)
        throw new Error("notifySessionCreated: 无 workspace folder 可归属");
      deps.runtimeController()?.setActiveSession(folder, sessionId);
      return { folder: folderKey(folder), sessionId };
    },
    /** 会话删除上报：反查持有该会话的 folder 并清键。 */
    notifySessionDeleted: async (args) => {
      const sessionId = args[0];
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("notifySessionDeleted: sessionId 必须为非空字符串");
      }
      const folders = store.findFoldersBySessionId(sessionId);
      for (const folder of folders) {
        store.setSessionId(folder, undefined);
        deps.runtimeController()?.setActiveSession(folder, undefined);
      }
      return { sessionId, folders };
    },
    /** 审批角标上报面（P0-9：数据源尽力面，缺上报时状态栏保持状态机部分）。 */
    reportPendingApprovals: async (args) => {
      const raw = args[0];
      const count =
        typeof raw === "number" && Number.isFinite(raw)
          ? Math.max(0, Math.trunc(raw))
          : 0;
      statusBar.setPendingApprovals(count);
      return { count };
    },
    /** 「本次会话允许」settings 写回（P0-8 写回面）：code.permissions.allowlist。 */
    appendSessionAllowlist: async (args) => {
      const toolName = args[0];
      if (typeof toolName !== "string" || !toolName.trim()) {
        throw new Error("appendSessionAllowlist: toolName 必须为非空字符串");
      }
      const rule = sessionAllowlistRule(toolName, args[1]);
      const existing = readGodeSetting("permissions.allowlist");
      const rules = mergeAllowlistRules(
        Array.isArray(existing) ? existing : [],
        [rule],
      );
      await writeGodeSetting("permissions.allowlist", rules);
      deps.log(`[permissions] 会话允许写回：${rule}（workspace scope）`);
      return {
        rule,
        rules,
        requiresSessionRebuild: true,
        message: "允许规则已写入设置，改动后需重建会话生效",
      };
    },
    /** 权限规则整体写回（kind=allowlist|denylist）。 */
    updatePermissionRules: async (args) => {
      const kind = args[0];
      if (kind !== "allowlist" && kind !== "denylist") {
        throw new Error(
          "updatePermissionRules: kind 必须为 allowlist|denylist",
        );
      }
      const rules = normalizeToolRules(Array.isArray(args[1]) ? args[1] : []);
      await writeGodeSetting(
        kind === "allowlist" ? "permissions.allowlist" : "permissions.denylist",
        rules,
      );
      deps.log(
        `[permissions] ${kind} 写回：${rules.length} 条（workspace scope）`,
      );
      return {
        kind,
        rules,
        requiresSessionRebuild: true,
        message: "权限规则已写入设置，改动后需重建会话生效",
      };
    },
    /** MCP servers 写回。PRD 降级口径：运行中不可动态增删，仅落 settings + 提示重建。 */
    updateMcpServers: async (args) => {
      const servers = normalizeMcpServersForSettings(
        Array.isArray(args[0]) ? args[0] : [],
      );
      await writeGodeSetting("mcp.servers", servers);
      deps.log(
        `[mcp] servers 写回：${servers.length} 个（改动后需重建会话生效）`,
      );
      return {
        count: servers.length,
        requiresSessionRebuild: true,
        message: "MCP 配置已写入设置；运行中不可动态增删，改动后需重建会话生效",
      };
    },
    /** 附加目录写回（协议上限 256）。 */
    updateAdditionalDirectories: async (args) => {
      const directories = normalizeAdditionalDirectories(
        Array.isArray(args[0]) ? args[0] : [],
      );
      await writeGodeSetting("context.additionalDirectories", directories);
      deps.log(`[context] 附加目录写回：${directories.length} 个`);
      return {
        directories,
        requiresSessionRebuild: true,
        message: "附加目录已写入设置，改动后需重建会话生效",
      };
    },
    /** 活动编辑器选区（@-引用/上下文注入面）。 */
    getActiveEditorSelection: async () => {
      const editor = window.activeTextEditor;
      if (!editor) return null;
      const { start, end, isEmpty } = editor.selection;
      return {
        path: editor.document.uri.fsPath,
        startLine: start.line,
        startCharacter: start.character,
        endLine: end.line,
        endCharacter: end.character,
        isEmpty,
        text: isEmpty ? "" : editor.document.getText(editor.selection),
      };
    },
    /** workspace 指令文件一次性导入（组4）：读 GODE.md / CLAUDE.md（每 folder 取首个命中）。 */
    importWorkspaceInstructions: async () => {
      const files: Array<{
        folder: string;
        name: string;
        path: string;
        content: string;
        sizeBytes: number;
        truncated: boolean;
      }> = [];
      for (const folder of workspace.workspaceFolders ?? []) {
        for (const name of ["GODE.md", "CLAUDE.md"]) {
          const uri = Uri.joinPath(folder.uri, name);
          try {
            const bytes = await workspace.fs.readFile(uri);
            const truncated = bytes.length > INSTRUCTION_IMPORT_LIMIT_BYTES;
            const slice = truncated
              ? bytes.subarray(0, INSTRUCTION_IMPORT_LIMIT_BYTES)
              : bytes;
            files.push({
              folder: folder.uri.fsPath,
              name,
              path: uri.fsPath,
              content: new TextDecoder().decode(slice),
              sizeBytes: bytes.length,
              truncated,
            });
            break; // GODE.md 优先，命中即止
          } catch {
            // 文件不存在：尝试下一个候选名。
          }
        }
      }
      return { files };
    },
    /** 多根 QuickPick（P1-2 host 半；经 SessionsIndexBridge，单 folder 直接命中）。 */
    pickWorkspaceFolder: async () => sessionsIndex.pickWorkspaceFolder(),
    /** per-folder 最近会话键表（P1-1.1 降级列表数据源；M18 修复：原生产装配恒为空）。 */
    getLatestSessionIdByFolder: async () => deps.latestSessionIdByFolder(),
    /** 设置读面（T08/T12 面板 CRUD 的 R）：归一化后的 code.* 可编辑快照（只读投影）。 */
    getWorkspaceSettings: async () =>
      normalizeSettingsSnapshot(readHostSettingsSnapshot()),
  };
}

/** 命令注册（extension.ts 调用；实现体在 src/commands/hostCommands.ts）。 */
export function registerCommands(container: Container): void {
  registerHostCommands({
    chatEditorPanel: container.chatEditorPanel,
    hostRuntime: container.hostRuntime,
    diagnostics: container.diagnostics,
    sessionsIndex: container.sessionsIndex,
    agentService: container.services.services.get(IZCodeAgentService),
    // P1-10.2：3 步上手卡命令面（Gode: 上手引导）；CLI 实况由容器闭包读取。
    presentOnboarding: () => container.presentOnboarding(),
    // 首次打开对话自动呈现上手卡（一次性；presentOnboardingOnce 自带标记）。
    firstOpen: () => container.presentOnboardingOnce(),
  });
}
