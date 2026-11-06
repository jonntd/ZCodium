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
import { uuidv7 } from "@zcode/shared";
import type { ZCodeSessionMode } from "@zcode/shared";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { CliLocator } from "./cli/cliLocator";
import {
  createCodeActionEntry,
  registerEditorCommands,
} from "./features/editorCommands";
import { createGenerateText } from "./features/oneShotText";
import { createQuickEditContentProvider } from "./features/quickEdit";
import { ZcodiumCodeActionProvider } from "./features/codeActions";
import { setLogSink } from "./features/logger";
import { primaryWorkspacePath } from "./features/featureConfig";
import { ServerHost, SERVER_LOG_FILE_NAME } from "./fullui/serverHost";
import { openFullUi } from "./fullui/openFullUi";
import { readServerLogTail } from "./fullui/serverLogTail";
import { buildDiagnosticsExportContent } from "./ui/diagnosticsBuffer";
import { ChatPanel, CHAT_VIEW_ID } from "./ui/chatPanel";
import { Diagnostics } from "./ui/diagnostics";
import { DiffViewer } from "./ui/diffViewer";
import { StatusBar } from "./ui/statusBar";
import { CLI_NOT_FOUND_LOG, WelcomePage, type WelcomeCardItem } from "./ui/welcomePage";
import { ExtensionStore } from "./store";
import {
  readConfig,
  readHostSettingsSnapshot,
  readZcodiumSetting,
  writeZcodiumSetting,
} from "./config";
import {
  IZCodeAgentService,
  IZCodeSessionService,
  IZCodeTaskService,
  type IServiceAccessor,
} from "@zcode/services";
import { HostServices } from "./fullui/hostServices";
import {
  HostSettingsBridge,
  ZCODE_AGENT_SERVER_BASE_ARGS,
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
import { createWorkspaceSessions, folderKey } from "./webview-react/session/workspaceSessions";
import { sessionAllowlistRule } from "./approvals/approvalService";
import { normalizeMcpServersForSettings } from "./configSettings";
import type { WorkspaceHostFramePayload } from "./host/hostFrameKinds";
import { registerHostCommands } from "./commands/hostCommands";

/** 指令导入的单文件内容上限（importWorkspaceInstructions，组4 一次性导入面）。 */
const INSTRUCTION_IMPORT_LIMIT_BYTES = 512 * 1024;

export interface Container {
  chatPanel: ChatPanel;
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
  services: PluginServiceAssembly;
  dispose(): Promise<void>;
}

export async function createContainer(context: ExtensionContext): Promise<Container> {
  const diagnostics = new Diagnostics();
  const statusBar = new StatusBar();
  const store = ExtensionStore.fromContext(context);
  const diffViewer = new DiffViewer();
  // per-folder 会话键控（P1-1.5/P1-2 host 半）：webview 侧 workspaceSessions 与
  // host 编排共用同一 ExtensionStore 键空间（只读复用 + 编排层写穿透）。
  const workspaceSessions = createWorkspaceSessions(store);
  const listFolders = () => (workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);

  // ── 设置桥（zcodium.* → create/resume/spawn 参数；先于 services 装配） ──
  const settingsBridge = new HostSettingsBridge(readHostSettingsSnapshot, (handler) =>
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("zcodium.")) handler();
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
      const flags = settingsBridge.resolveSpawnToolFlags();
      const spawn = resolveZcodeAgentSpawnCommand(cliInfo.path, flags, {
        nodeScript: cliInfo.nodeScript === true,
      });
      if (spawn.args.length > ZCODE_AGENT_SERVER_BASE_ARGS.length) {
        diagnostics.log(
          `[agent-spawn] 工具面旗标（settings 快照，workspace=${spawnContext.workspacePath}）：` +
            `allowed=${flags.toolAllowlist.length} disallowed=${flags.toolDenylist.length}`,
        );
      }
      // services 对 resolver 产物原样使用（args 不合并），必须自带 app-server 协议服务模式基底。
      return spawn;
    },
    zcodeAgentSpawnFallbackCwd: workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
  });

  // ── per-folder 会话索引桥（T06/T09 host 半：zcode-session 频道聚合 + 多根 QuickPick） ──
  const sessionsIndex = new SessionsIndexBridge({
    sessionService: services.services.get(IZCodeSessionService),
    workspaceSessions,
    listFolders,
    pickFolder: async (folders) =>
      (await window.showQuickPick(folders, {
        placeHolder: "选择 ZCodium 会话归属的 workspace folder（P1-2：会话按 folder 独立）",
        canPickMany: false,
      })) ?? null,
    log: (message) => diagnostics.log(message),
  });

  // ── 平台方法实现（host 端 VS Code API 落地面） ──
  // runtimeController 双向依赖（plat 写会话键 ↔ controller 持 agentService）：经占位解环。
  const runtimeControllerPlaceholder: { current?: RuntimeController } = {};
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
    // theme/locale/workspace 快照读 vscode API；visibility 由 chatPanel 变化事件生产。
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
    },
  });
  runtimeControllerPlaceholder.current = runtimeController;

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

  // ── 完整界面共享 server（单例，懒启动；侧栏 full 模式与 openFullUi 命令共用） ──
  const globalStorageDir = context.globalStorageUri.fsPath;
  const fullUiConfig = () => workspace.getConfiguration("zcodium");
  /** 真 Node 解析：设置 zcodium.nodePath → 常见安装位 → 兜底 Electron 二进制（会 SIGTRAP）。 */
  const resolveAgentNodePath = (): string => {
    const configured = fullUiConfig().get<string>("nodePath", "").trim();
    if (configured && existsSync(configured)) return configured;
    for (const candidate of ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]) {
      if (existsSync(candidate)) return candidate;
    }
    return process.execPath;
  };
  const sidebarUiMode = () => fullUiConfig().get<string>("sidebarUi", "full");
  const resolveFullUiRepoRoot = (): string => {    const configured = fullUiConfig().get<string>("fullUiRepoRoot", "").trim();
    if (configured) return configured;
    if (typeof __ZCODE_REPO_ROOT__ === "string" && __ZCODE_REPO_ROOT__) {
      return __ZCODE_REPO_ROOT__;
    }
    // 工作区向上探测（工作区在 monorepo 内的场景）。
    for (const folder of workspace.workspaceFolders ?? []) {
      let dir = folder.uri.fsPath;
      for (let i = 0; i < 6; i += 1) {
        if (
          existsSync(join(dir, "packages/web/dist/index.html")) &&
          existsSync(join(dir, "packages/server/dist/entry-http.js"))
        ) {
          return dir;
        }
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
    }
    return "";
  };
  const fullUiServer = new ServerHost({
    get repoRoot() {
      return resolveFullUiRepoRoot();
    },
    get configuredEntry() {
      return fullUiConfig().get<string>("fullUiServerEntry", "");
    },
    get configuredStaticRoot() {
      return fullUiConfig().get<string>("fullUiStaticRoot", "");
    },
    nodePath: process.execPath,
    logDir: join(globalStorageDir, "logs"),
    // agent 不能用 Electron 二进制：server（node 模式 Electron）再 spawn 同一二进制时，
    // Electron 会剥离 ELECTRON_RUN_AS_NODE（防嵌套逃逸），子进程以 GUI 模式启动 →
    // 无头环境 SIGTRAP（stderr 零输出，实测）。必须解析真 Node：
    agentCommand: resolveAgentNodePath(),
    agentArgs: [
      join(context.extensionUri.fsPath, "cli-bundle", "zcode.cjs"),
      "app-server",
      "--stdio",
    ],
  });

  // ── 工作区项目预注册（full 模式）：server 作用域要求会话必须归属项目
  // （project.remote-project-required），否则用户在完整界面里无法直接发送。
  // 关键事实：完整界面（iframe web 应用）聊天用的是 server 的**默认对话工作区**
  // （{dataRoot}/workspace/default，与桌面端共享 ~/.zcodium 数据根），而不是 VS Code
  // 打开的文件夹——所以默认对话目录必须注册；VS Code 文件夹有则一并注册。
  // 幂等：同 root 且同 host 作用域已注册则复用。
  const conversationWorkspaceDir = join(homedir(), ".zcodium", "workspace", "default");
  const registerProjectForPath = async (
    projectService: NonNullable<IServiceAccessor["projectService"]>,
    projects: Awaited<ReturnType<typeof projectService.readProjects>>,
    folder: string,
    name: string,
  ): Promise<void> => {
    // 幂等守卫必须按 host 作用域判断：共享存储里同名 root 的 local 项目
    // （桌面 CLI 写入）对 server 作用域不可见，不能作为跳过依据。
    // server 作用域的项目 hostId 形如 remote:server:<hostname>。
    const registeredOnServer = projects.some(
      (p) =>
        typeof p.hostId === "string" &&
        p.hostId.startsWith("remote:server:") &&
        p.roots?.some((r) => r.rootPath === folder),
    );
    if (registeredOnServer) {
      diagnostics.log(`[full-ui] 项目已注册，跳过：${folder}`);
      return;
    }
    const saved = await projectService.saveProject({
      name,
      roots: [folder],
      primaryRoot: folder,
    });
    diagnostics.log(`[full-ui] 工作区已注册为项目：${folder}（${saved.id}）`);
  };
  const registerWorkspaceProject = async (): Promise<void> => {
    try {
      await hostServices.use(async (accessor) => {
        const projectService = accessor.projectService;
        if (!projectService) throw new Error("project service 不可用");
        const projects = await projectService.readProjects();
        // 1) 默认对话工作区——完整界面聊天的真实落点，必注册。
        await registerProjectForPath(
          projectService,
          projects,
          conversationWorkspaceDir,
          "默认对话",
        );
        // 2) VS Code 打开的文件夹（如有）——编辑器能力（quick edit 等）用。
        const folder = workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (folder && folder !== conversationWorkspaceDir) {
          await registerProjectForPath(projectService, projects, folder, basename(folder));
        } else if (!folder) {
          diagnostics.log("[full-ui] 当前窗口没有打开文件夹，跳过文件夹项目注册");
        }
      });
    } catch (error) {
      diagnostics.log(
        `[full-ui] 工作区项目注册失败（不影响 server）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const chatPanel = new ChatPanel(
    context.extensionUri,
    hostRuntime,
    (folder) => workspaceSessions.get(folderKey(folder)) ?? null,
    {
      enabled: () => sidebarUiMode() === "full",
      ensureUrl: async () => {
        const url = await fullUiServer.ensureStarted();
        void registerWorkspaceProject();
        return url;
      },
    },
  );

  // ── 服务调用统一路由（PRD §8.5 单通道） ──
  // full 模式：Agent 归共享 server 所有，宿主编辑器能力经 /ws accessor 调用，
  // 进程内服务栈绝不 spawn agent（双实例会在 CLI 存储锁上互撞，实测
  // "ZCode agent stdio transport is closed"）。
  // pane 模式：进程内 ServiceCollection 直取（结构化子集，命令面只用 agent/task 两服务）。
  const hostServices = new HostServices({
    getWsUrl: async () => {
      const url = await fullUiServer.ensureStarted();
      return `${url.replace(/^http/, "ws")}/ws`;
    },
  });
  const runWithServices = <T>(
    run: (accessor: IServiceAccessor) => Promise<T>,
  ): Promise<T> => {
    if (sidebarUiMode() === "full") {
      return hostServices.use(run);
    }
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
        placeHolder: "ZCodium Agent：3 步上手",
        canPickMany: false,
      });
      return picked?.action;
    },
    revealChat: () => chatPanel.reveal(),
    revealClaudeImportPanel: () => {
      hostRuntime.pushHostFrame("open-panel", { panel: "import-claude-sessions" });
      chatPanel.reveal();
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
      hostRuntime.pushHostFrame("workspace", {
        folders: (workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
        activeFolder: workspace.workspaceFolders?.[0]?.uri.fsPath ?? null,
        kind: "workspace-changed",
      });
    }),
    workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("zcodium.")) {
        hostRuntime.pushHostFrame("workspace", { kind: "settings-changed" });
      }
      // 侧栏承载模式切换（full ↔ pane）：重建面板 webview。
      if (event.affectsConfiguration("zcodium.sidebarUi")) {
        chatPanel.reload();
      }
    }),
  );

  // ── activate 后：per-folder 最近会话恢复（P1-1.5 host 半；resume 恒带约束面） ──
  // full 模式下跳过：Agent 归共享 server 所有，插件进程内栈不得 spawn（单通道，§8.5）；
  // 会话恢复由完整界面自身的订阅/续传语义承接。
  if (sidebarUiMode() !== "full") {
    void runtimeController.restoreWorkspaceSessions();
  }

  // ── P1-10.2：CLI 未找到 → 呈现安装引导与「重新检测」入口（P0-1 引导语义） ──
  if (!cliInfo) void welcomePage.presentCliMissing();

  // ── M1 编辑器原生功能（移植自 apps/zcodium-vscode features/）：Quick Edit、
  //    Code Action + 诊断修复、终端送入、Git 提交信息/改动审阅、历史会话、上下文加入 ──
  // 一次性文本生成走进程内 ServiceCollection 直调（oneShotText.ts）；「发进对话」走
  // composer-insert host 帧（webview requestComposerTextInsert 预填，P1-5 同通道）。
  setLogSink((line) => diagnostics.log(line));
  const quickEditProvider = createQuickEditContentProvider();
  const quickEditDisposable = workspace.registerTextDocumentContentProvider(
    "zcodium-quick-edit",
    quickEditProvider,
  );
  const editorWorkspacePath = () =>
    workspace.workspaceFolders?.[0]?.uri.fsPath ?? primaryWorkspacePath() ?? "";

  /**
   * M1「发进对话」的路由：
   * - full 模式（默认）：侧栏是完整界面 iframe，跨源无法预填其 composer → 直接经
   *   services 发 v4 sendText 到该 folder 的会话（无会话则先编程式创建）；完整界面
   *   订阅同一会话，消息实时出现在界面里。
   * - pane 模式：composer-insert host 帧预填 React composer（P1-5 同通道）。
   */
  const submitToConversation = async (content: string): Promise<void> => {
    const folder = editorWorkspacePath();
    if (!folder) {
      void window.showInformationMessage("先打开一个工作区文件夹。");
      return;
    }
    let sessionId = workspaceSessions.get(folderKey(folder)) ?? null;
    if (!sessionId && sidebarUiMode() === "full") {
      // full 模式：会话必须归属共享 server。经 /ws 通道在 server 侧编程式创建
      // （参数面与 RuntimeController.createSession 一致）；绝不能走进程内
      // agentService——那会 spawn 第二个 agent 实例，与 server 在 CLI 存储锁上
      // 互撞（实测表现 "ZCode agent stdio transport is closed"）。
      sessionId = await runWithServices(async (accessor) => {
        const params = settingsBridge.resolveCreateParams(folder);
        const snapshot = await accessor.zcodeAgentService.createSession({
          workspacePath: params.workspacePath,
          mode: params.config.mode as ZCodeSessionMode,
          ...(params.config.modelSelection ? { model: params.config.modelSelection } : {}),
          toolAllowlist: params.toolAllowlist,
          toolDenylist: params.toolDenylist,
          mcpServers: params.mcpServers as never[],
          additionalDirectories: params.additionalDirectories,
        } as Parameters<NonNullable<typeof accessor.zcodeAgentService>["createSession"]>[0]);
        const created = snapshot.session.sessionId;
        workspaceSessions.set(folderKey(folder), created);
        return created;
      });
    } else if (!sessionId) {
      sessionId = (await runtimeController.createSession(folder)).sessionId;
    }
    await runWithServices((accessor) =>
      accessor.zcodeAgentService.sendConversationCommandV4({
        workspacePath: folder,
        envelope: {
          commandId: uuidv7(),
          clientId: "zcode-vscode-host",
          sessionId,
          type: "sendText",
          payload: { text: content },
          issuedAt: Date.now(),
        },
      }),
    );
  };
  const editorPushFrame = (
    kind: "composer-insert" | "session-switch",
    payload: unknown,
  ): void => {
    if (kind === "composer-insert" && sidebarUiMode() === "full") {
      const text = (payload as { text?: string } | undefined)?.text ?? "";
      void submitToConversation(text)
        .then(() => window.setStatusBarMessage("ZCodium：已发送到对话", 3000))
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          void window.showErrorMessage(`发送到对话失败：${message}`);
        });
      return;
    }
    hostRuntime.pushHostFrame(kind, payload);
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
    new ZcodiumCodeActionProvider(codeActionEntry),
    ZcodiumCodeActionProvider.metadata,
  );
  context.subscriptions.push(
    quickEditDisposable,
    codeActionDisposable,
    ...editorFeatureDisposables,
  );

  // ── 完整界面（fullui，M2）：packages/web 构建产物由共享 server 进程托管，Simple Browser 打开 ──
  // 与侧边栏共享数据根（services 默认根 $HOME/.zcodium：两侧同回落，docs/architecture.md §7.9）与 Agent（内置 CLI bundle）；
  // server/web 产物路径按本机 monorepo 布局解析（设置可覆盖，见 zcodium.fullUi*）。
  context.subscriptions.push(
    commands.registerCommand("zcodium.openFullUi", async () => {
      // 共享单例：侧栏 full 模式与 Simple Browser 用同一 server 进程（数据/进程不双份）。
      await openFullUi(fullUiServer);
    }),
  );

  return {
    chatPanel,
    hostRuntime,
    runtimeController,
    sessionsIndex,
    statusBar,
    diagnostics,
    diffViewer,
    welcomePage,
    presentOnboarding: () => welcomePage.presentOnboarding({ cli: cliInfo }),
    services,
    async dispose(): Promise<void> {
      runtimeController.dispose();
      hostRuntime.dispose();
      await services.dispose();
      void fullUiServer.dispose();
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
  primaryFolder: () => string | undefined;
  /** per-folder 最近会话键表（P1-1.1 降级列表数据源；M18）。 */
  latestSessionIdByFolder: () => Record<string, string | undefined>;
  /** exportLogs 聚合源（§7.10）：输出通道内存镜像快照读取面（Diagnostics 持有）。 */
  diagnosticsSnapshot: () => string[];
}): Record<string, PlatformMethodHandler> {
  const { context, diffViewer, store, statusBar, sessionsIndex } = deps;
  const deviceIdKey = "zcodium.deviceId";
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
      const uris = await window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
      return uris?.[0]?.fsPath ?? null;
    },
    selectDirectories: async () => {
      const uris = await window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: true });
      return (uris ?? []).map((uri) => uri.fsPath);
    },
    selectFile: async () => {
      const uris = await window.showOpenDialog({ canSelectFolders: false, canSelectFiles: true, canSelectMany: false });
      return uris?.[0]?.fsPath ?? null;
    },
    selectFiles: async () => {
      const uris = await window.showOpenDialog({ canSelectFolders: false, canSelectFiles: true, canSelectMany: true });
      return (uris ?? []).map((uri) => uri.fsPath);
    },
    // 打开/跳转。
    openExternal: async (args) => {
      const url = args[0];
      if (typeof url !== "string") throw new Error("openExternal: url 必须为字符串");
      const parsed = Uri.parse(url);
      // scheme 白名单：杜绝 webview 侧借 openExternal 触发任意 scheme（command:/javascript: 等）。
      if (!["http", "https", "mailto", "file", "vscode", "vscode-insiders"].includes(parsed.scheme)) {
        throw new Error(`openExternal: 不支持的 scheme「${parsed.scheme}」`);
      }
      await env.openExternal(parsed);
    },
    openInFileManager: async (args) => {
      const path = args[0];
      if (typeof path !== "string") throw new Error("openInFileManager: path 必须为字符串");
      // stable API 无 revealIfVisible 选项：打开文件所在目录。
      await env.openExternal(Uri.file(path));
      return { success: true };
    },
    openExternalFile: async () => ({ success: false, error: "由 VS Code 打开文件语义承担" }),
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
      if (typeof path !== "string") throw new Error("showDiff: path 必须为字符串");
      return diffViewer.open(`plat-${Date.now()}`, path, proposed);
    },
    showTextDocument: async (args) => {
      const path = args[0];
      if (typeof path !== "string") throw new Error("showTextDocument: path 必须为字符串");
      await window.showTextDocument(Uri.file(path), { preview: true });
      return true;
    },
    revealWorkspace: async () => {
      await commands.executeCommand("workbench.view.explorer");
      return true;
    },
    // 诊断/通知/设备。
    // exportLogs 聚合口径（架构 §7.10，closeout-3）：导出真实诊断面——输出通道内存
    // 镜像（Diagnostics 环形缓冲）+ fullui server 日志尾部（SERVER_LOG_FILE_NAME，
    // 有界 ≤256KB）；来源皆空时如实标注「（无记录）」，不再是一行占位文本。
    exportLogs: async () => {
      const logsDir = join(context.globalStorageUri.fsPath, "logs");
      await mkdir(logsDir, { recursive: true });
      const serverLogPath = join(logsDir, SERVER_LOG_FILE_NAME);
      const serverLogLines = readServerLogTail(serverLogPath);
      const content = buildDiagnosticsExportContent({
        diagnosticsLines: deps.diagnosticsSnapshot(),
        serverLogLines,
        serverLogPath: serverLogLines.length > 0 ? serverLogPath : null,
      });
      const tempPath = join(logsDir, `zcodium-${Date.now()}.log`);
      await writeFile(tempPath, content, "utf8");
      await window.showTextDocument(Uri.file(tempPath), { preview: true });
      return { success: true, path: tempPath };
    },
    showTaskNotification: async (args) => {
      const payload = args[0] as { title?: string; body?: string } | undefined;
      const choice = await window.showInformationMessage(payload?.title ?? "ZCodium", "打开");
      if (choice === "打开") await commands.executeCommand(`${CHAT_VIEW_ID}.focus`);
    },
    getDeviceId: async () => getDeviceId(),
    activateOrSetWorkspace: async (args) => {
      // 多根工作区聚焦对应 folder（P1-2 的 host 半；完整切换在 T06）。
      const path = args[0];
      const folder = (workspace.workspaceFolders ?? []).find((f) => f.uri.fsPath === path);
      return { activated: folder !== undefined };
    },
    openDataRootImport: async () => {
      void window.showInformationMessage("数据目录导入：请使用桌面端完成（插件侧无需迁移）");
    },
    getSystemLocale: async () => env.language,
    // MCP 本机目录（桌面 ~/.zcode mcp.json；插件场景读宿主默认路径，P1-8）。
    loadMcpFromUserDirectory: async () => ({ servers: [] }),
    saveMcpToUserDirectory: async () => ({
      success: false,
      error: "请在插件设置 zcodium.mcp.servers 中配置（改动后需重建会话生效）",
    }),
    migrateLegacyCommonMcp: async () => ({ servers: {}, totalCount: 0, importedCount: 0, skippedCount: 0 }),
    // 同步面（未读投影归 webview 本地，P0-9：host 不再写 __unread__ 键槽）。
    syncWindowUnreadCount: async () => undefined,
    syncWindowTabs: async () => undefined,
    syncActiveTaskSession: async () => undefined,
    registerOAuthState: async () => undefined,
    // saveFile（白名单方法的真实落地面，此前缺失 → 调用恒 "method not allowed"）：
    // webview 传 dataB64（ArrayBuffer 过 postMessage 的 base64 形态）或 sourceUrl（host 侧拉取），
    // 弹 VS Code 保存对话框后写盘；两者皆缺时返回可读错误（数据面由附件上传链路承担）。
    saveFile: async (args) => {
      const payload = args[0] as { dataB64?: string; sourceUrl?: string; suggestedName?: string } | undefined;
      const suggested =
        typeof payload?.suggestedName === "string" && payload.suggestedName.trim().length > 0
          ? basename(payload.suggestedName.trim())
          : "download";
      const target = await window.showSaveDialog({ defaultUri: Uri.file(suggested) });
      if (!target) return { success: false, canceled: true };
      let bytes: Uint8Array;
      if (typeof payload?.dataB64 === "string" && payload.dataB64.length > 0) {
        bytes = new Uint8Array(Buffer.from(payload.dataB64, "base64"));
      } else if (typeof payload?.sourceUrl === "string" && payload.sourceUrl.length > 0) {
        const res = await fetch(payload.sourceUrl);
        if (!res.ok) return { success: false, error: `saveFile: sourceUrl 拉取失败（HTTP ${res.status}）` };
        bytes = new Uint8Array(await res.arrayBuffer());
      } else {
        return { success: false, error: "saveFile: 缺少 dataB64/sourceUrl（数据面由附件上传链路承担）" };
      }
      await writeFile(target.fsPath, bytes);
      return { success: true, path: target.fsPath };
    },
    // 附件（审批/引用场景的临时文本文件，落 globalStorage/tmp）。
    createTempTextAttachment: async (args) => {
      const payload = args[0] as { text: string; filename?: string } | undefined;
      // filename 收敛为 basename：杜绝 webview 侧借路径分隔符写穿 tmp 目录（path traversal）。
      const filename = basename(payload?.filename ?? `attachment-${Date.now()}.txt`);
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
      if (!folder) throw new Error("notifySessionCreated: 无 workspace folder 可归属");
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
        typeof raw === "number" && Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;
      statusBar.setPendingApprovals(count);
      return { count };
    },
    /** 「本次会话允许」settings 写回（P0-8 写回面）：zcodium.permissions.allowlist。 */
    appendSessionAllowlist: async (args) => {
      const toolName = args[0];
      if (typeof toolName !== "string" || !toolName.trim()) {
        throw new Error("appendSessionAllowlist: toolName 必须为非空字符串");
      }
      const rule = sessionAllowlistRule(toolName, args[1]);
      const existing = readZcodiumSetting("permissions.allowlist");
      const rules = mergeAllowlistRules(
        Array.isArray(existing) ? existing : [],
        [rule],
      );
      await writeZcodiumSetting("permissions.allowlist", rules);
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
        throw new Error("updatePermissionRules: kind 必须为 allowlist|denylist");
      }
      const rules = normalizeToolRules(Array.isArray(args[1]) ? args[1] : []);
      await writeZcodiumSetting(kind === "allowlist" ? "permissions.allowlist" : "permissions.denylist", rules);
      deps.log(`[permissions] ${kind} 写回：${rules.length} 条（workspace scope）`);
      return {
        kind,
        rules,
        requiresSessionRebuild: true,
        message: "权限规则已写入设置，改动后需重建会话生效",
      };
    },
    /** MCP servers 写回。PRD 降级口径：运行中不可动态增删，仅落 settings + 提示重建。 */
    updateMcpServers: async (args) => {
      const servers = normalizeMcpServersForSettings(Array.isArray(args[0]) ? args[0] : []);
      await writeZcodiumSetting("mcp.servers", servers);
      deps.log(`[mcp] servers 写回：${servers.length} 个（改动后需重建会话生效）`);
      return {
        count: servers.length,
        requiresSessionRebuild: true,
        message: "MCP 配置已写入设置；运行中不可动态增删，改动后需重建会话生效",
      };
    },
    /** 附加目录写回（协议上限 256）。 */
    updateAdditionalDirectories: async (args) => {
      const directories = normalizeAdditionalDirectories(Array.isArray(args[0]) ? args[0] : []);
      await writeZcodiumSetting("context.additionalDirectories", directories);
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
    /** workspace 指令文件一次性导入（组4）：读 ZCODIUM.md / CLAUDE.md（每 folder 取首个命中）。 */
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
        for (const name of ["ZCODIUM.md", "CLAUDE.md"]) {
          const uri = Uri.joinPath(folder.uri, name);
          try {
            const bytes = await workspace.fs.readFile(uri);
            const truncated = bytes.length > INSTRUCTION_IMPORT_LIMIT_BYTES;
            const slice = truncated ? bytes.subarray(0, INSTRUCTION_IMPORT_LIMIT_BYTES) : bytes;
            files.push({
              folder: folder.uri.fsPath,
              name,
              path: uri.fsPath,
              content: new TextDecoder().decode(slice),
              sizeBytes: bytes.length,
              truncated,
            });
            break; // ZCODIUM.md 优先，命中即止
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
    /** 设置读面（T08/T12 面板 CRUD 的 R）：归一化后的 zcodium.* 可编辑快照（只读投影）。 */
    getWorkspaceSettings: async () =>
      normalizeSettingsSnapshot(readHostSettingsSnapshot()),
  };
}

/** 命令注册（extension.ts 调用；实现体在 src/commands/hostCommands.ts）。 */
export function registerCommands(container: Container): void {
  registerHostCommands({
    chatPanel: container.chatPanel,
    hostRuntime: container.hostRuntime,
    diagnostics: container.diagnostics,
    sessionsIndex: container.sessionsIndex,
    agentService: container.services.services.get(IZCodeAgentService),
    // P1-10.2：3 步上手卡命令面（ZCodium: 上手引导）；CLI 实况由容器闭包读取。
    presentOnboarding: () => container.presentOnboarding(),
  });
}
