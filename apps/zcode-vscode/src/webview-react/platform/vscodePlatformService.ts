/**
 * VscodePlatformService — IPlatformService 的 VS Code Webview 实现
 * （架构 §2.4 装配矩阵全量方法，P1-9.3，T03）。
 *
 * 原则（P1-9.3）：**不支持的能力不抛错、返回安全空值**——
 * - 可代理面：plat-req → host PlatformRpcHandler 白名单方法 → VS Code API；
 * - 不可代理面：no-op / false / [] / {success:false}（UI 入口自然隐藏）；
 * - `isDesktop === true`（解锁 Claude 会话迁移：extension host 真实读本机 ~/.claude/projects）。
 */

import type {
  BotRemoteWorkspaceReconnectedEvent,
  IPlatformService,
  Locale,
  LoadCliMcpFromUserDirectoryRequest,
  LoadCliMcpFromUserDirectoryResult,
  MigrateLegacyCommonMcpResult,
  PostUpdateReleaseNotesPayload,
  RemoteConnectionRuntimeLog,
  RemoteSessionClosedEvent,
  RemoteTarget,
  TaskNotificationPayload,
  UpdateCheckResultPayload,
  WebRemoteControlStatus,
} from "@zcode/shared";
import type { HostFrameBus } from "../bridge/hostFrames";
import type { PlatformRpcClient } from "../bridge/platformRpcClient";
// base64 编码复用桥 wire 的分块实现（增量审查 X6：原内联实现逐字节字符串拼接，
// saveFile 图片导出 MB 级时是数百万次拼接；wire 实现在 webview 无 Buffer 环境
// 自动走 0x8000 分块快路径，双端行为一致）。
import { bytesToBase64 } from "../../bridge/wire";
import type { VscodeThemeKind } from "../themeBridge";

/** 不支持能力的安全返回值集中定义（矩阵 §2.4）。 */
const UNSUPPORTED_OPEN_RESULT = {
  success: false,
  error: "Not supported in VS Code webview",
} as const;

export interface VscodePlatformServiceOptions {
  rpc: PlatformRpcClient;
  /** host 帧总线（locale/settings 变化经 host 帧驱动；缺省为空实现）。 */
  hostFrames?: HostFrameBus;
}

export class VscodePlatformService implements IPlatformService {
  /** 插件运行在本机 extension host 旁：桌面能力位开启（H7）。 */
  readonly isDesktop = true;
  /** 终端/帮助由 IDE 原生提供，隐藏应用内嵌的终端面板、帮助菜单与链路提示。 */
  readonly nativeTerminalHost = true;
  readonly canOpenLocalFiles = true;
  readonly canSelectFilePath = true;
  readonly isLocalDevelopmentRuntime = false;

  private readonly rpc: PlatformRpcClient;
  /**
   * host 帧总线（App 主题/可见性运行时跟随的帧源；index.tsx 装配注入）。
   * 公开只读：webview 基座（App.tsx）从平台服务取总线，避免装配层二次传线。
   */
  readonly hostFrames?: HostFrameBus;

  constructor(options: VscodePlatformServiceOptions) {
    this.rpc = options.rpc;
    this.hostFrames = options.hostFrames;
  }

  /**
   * fire-and-forget 调用（X2 配套）：超时/dispose reject 时静默吞掉——单向通知
   * （打开外部/任务通知/计数同步）失败无 UI 可呈现，且无人 await 的 reject 会
   * 变成 unhandledRejection（真机冒烟实测：webview-smoke 因此退出 1）。
   */
  private fireAndForget(method: string, ...args: unknown[]): void {
    void this.rpc.call(method, ...args).catch(() => {
      // 单向通知失败静默；需要用户可见错误的面走有返回值的 call。
    });
  }

  // ── 文件/目录选择（host showOpenDialog / QuickPick） ──

  selectDirectory(): Promise<string | null> {
    return this.rpc.call<string | null>("selectDirectory");
  }

  selectDirectories(): Promise<string[]> {
    return this.rpc.call<string[]>("selectDirectories");
  }

  selectFile(): Promise<string | null> {
    return this.rpc.call<string | null>("selectFile");
  }

  selectFiles(): Promise<string[]> {
    return this.rpc.call<string[]>("selectFiles");
  }

  saveFile(payload: {
    data?: ArrayBuffer;
    sourceUrl?: string;
    suggestedName: string;
  }): Promise<{
    success: boolean;
    canceled?: boolean;
    error?: string;
    path?: string;
  }> {
    // ArrayBuffer 过 postMessage 需 base64：data 编为 dataB64；sourceUrl 交给宿主侧拉取。
    // 两者皆缺时宿主返回可读错误（附件上传链路另行承担大文件面）。
    const dataB64 = payload.data
      ? bytesToBase64(new Uint8Array(payload.data))
      : undefined;
    return this.rpc.call("saveFile", {
      dataB64,
      sourceUrl: payload.sourceUrl,
      suggestedName: payload.suggestedName,
    });
  }

  getPathForFile(_file: unknown): string | null {
    // Webview 沙箱内 File 对象无法安全映射本机路径；附件走 upload 链路。
    return null;
  }

  /** 资源管理器拖拽 file:// URI → 本地文件条目（host 过滤目录/缺失；spec: composer-explorer-file-drop）。 */
  resolveFileDropPaths(
    uris: readonly string[],
  ): Promise<{ path: string; sizeBytes: number }[] | null> {
    return this.rpc.call("resolveFileDropPaths", uris);
  }


  createTempTextAttachment(payload: {
    text: string;
    filename?: string;
  }): Promise<{
    filename: string;
    localPath: string;
    mimeType: "text/plain";
    sizeBytes: number;
  }> {
    return this.rpc.call("createTempTextAttachment", payload);
  }

  // ── 打开/跳转（env.openExternal 等） ──

  openExternal(url: string): void {
    this.fireAndForget("openExternal", url);
  }

  openInFileManager(
    path: string,
  ): Promise<{ success: boolean; error?: string }> {
    return this.rpc.call("openInFileManager", path);
  }

  openExternalFile(
    path: string,
  ): Promise<{ success: boolean; error?: string }> {
    return this.rpc.call("openExternalFile", path);
  }

  /**
   * code viewer 打开意图 → 宿主编辑器（IPlatformService.openCodeViewerInEditor 实现）。
   *
   * 侧栏 webview 放不下应用内右侧预览面板：patch 来源走宿主原生双栏 diff
   * （复用 pendingChanges 的 zcode-before 反向应用管线），file 来源直接
   * vscode.open。解析失败/无路径时返回 false，调用方落回应用内面板。
   */
  async openCodeViewerInEditor(source: {
    type: "file" | "patch";
    path?: string;
    patch?: string;
    title?: string;
  }): Promise<boolean> {
    if (source.type === "patch" && source.path && source.patch) {
      const patches = parseUnifiedPatch(source.patch);
      if (patches.length === 0) return false;
      await this.rpc.call("openPatchDiffInEditor", {
        resolvedPath: source.path,
        patches,
      });
      return true;
    }
    if (source.path) {
      await this.rpc.call("openFileInEditor", source.path);
      return true;
    }
    return false;
  }

  async openFeedback(): Promise<void> {
    await this.rpc.call("openFeedback");
  }

  async openCommunity(): Promise<void> {
    await this.rpc.call("openCommunity");
  }

  async canOpenCommunity(_locale: Locale): Promise<boolean> {
    return this.rpc.call<boolean>("canOpenCommunity", _locale);
  }

  // ── 会话/编排上报（T06/P1-1.5 webview 半；host 白名单方法写穿透 per-folder 键空间） ──

  /**
   * 会话创建上报：host 侧 setActiveSession 写 ExtensionStore per-folder 键空间
   * （P1-1.5 闭环 webview 半），下次 activate 经 bootstrap data-session-id 恢复。
   */
  notifySessionCreated(
    sessionId: string,
    folder?: string,
  ): Promise<{ folder: string; sessionId: string }> {
    return this.rpc.call("notifySessionCreated", sessionId, folder);
  }

  /** 会话删除上报：host 侧反查持有该会话的 folder 并清键（P1-1.4 从列表移除的写回面）。 */
  notifySessionDeleted(
    sessionId: string,
  ): Promise<{ sessionId: string; folders: string[] }> {
    return this.rpc.call("notifySessionDeleted", sessionId);
  }

  /**
   * per-folder 最近会话键表（host workspaceSessions 键空间只读投影）；
   * zcode-session 频道失败时的降级列表数据源（P1-1.1）。
   */
  getLatestSessionIdByFolder(): Promise<Record<string, string | undefined>> {
    return this.rpc.call<Record<string, string | undefined>>(
      "getLatestSessionIdByFolder",
    );
  }

  /** 多根 folder QuickPick（P1-2 host 半经组2 SessionsIndexBridge；单 folder 直接命中）。 */
  pickWorkspaceFolder(): Promise<string | null> {
    return this.rpc.call<string | null>("pickWorkspaceFolder");
  }

  // ── 编辑器集成（插件特有平台路由：P1-9.3 diff 走 VS Code 原生 diff 编辑器） ──

  /** 打开原生 diff（插件扩展方法，非 IPlatformService 面；审批 UI 经 platform 路由调用）。 */
  showDiff(path: string, proposedContent?: string): Promise<boolean> {
    return this.rpc.call<boolean>("showDiff", path, proposedContent);
  }

  /** 打开文件（只读预览）。 */
  showTextDocument(path: string): Promise<boolean> {
    return this.rpc.call<boolean>("showTextDocument", path);
  }

  // ── 诊断/通知/工作区 ──

  exportLogs(): Promise<{ success: boolean; path?: string; error?: string }> {
    return this.rpc.call("exportLogs");
  }

  showTaskNotification(payload: TaskNotificationPayload): void {
    this.fireAndForget("showTaskNotification", payload);
  }

  getDeviceId(): string {
    // 同步语义：宿主 globalState 持久化 UUID 在激活期注入 webview 初始帧；
    // 此处返回缓存（未就绪时返回空串，UI 仅用于展示）。见 hostFrames workspace 帧。
    return this.deviceIdCache;
  }

  private deviceIdCache = "";

  /** host 初始帧下发后由装配层调用，回填同步读取面（getDeviceId）。 */
  setDeviceId(id: string): void {
    this.deviceIdCache = id;
  }

  activateOrSetWorkspace(path: string): Promise<{ activated: boolean }> {
    return this.rpc.call("activateOrSetWorkspace", path);
  }

  openDataRootImport(): void {
    this.fireAndForget("openDataRootImport");
  }

  async getSystemLocale(): Promise<Locale> {
    return this.rpc.call<Locale>("getSystemLocale");
  }

  getInstalledEditors(): Promise<
    { id: string; name: string; iconDataUrl: string }[]
  > {
    // 矩阵：返回当前 VS Code。
    return Promise.resolve([
      { id: "vscode", name: "Visual Studio Code", iconDataUrl: "" },
    ]);
  }

  async openInEditor(
    _editorId: string,
    _path: string,
    _options?: {
      remoteTarget?: unknown;
      workspaceIdentity?: string;
      pathKind?: "file" | "directory";
    },
  ): Promise<{ success: boolean; error?: string }> {
    return UNSUPPORTED_OPEN_RESULT;
  }

  // ── MCP 本机目录（桌面能力位，P1-8） ──

  loadMcpFromUserDirectory(
    payload?: LoadCliMcpFromUserDirectoryRequest,
  ): Promise<LoadCliMcpFromUserDirectoryResult> {
    return this.rpc.call("loadMcpFromUserDirectory", payload);
  }

  saveMcpToUserDirectory(
    payload: unknown,
  ): Promise<{ success: boolean; error?: string }> {
    return this.rpc.call("saveMcpToUserDirectory", payload);
  }

  migrateLegacyCommonMcp(
    payload?: unknown,
  ): Promise<MigrateLegacyCommonMcpResult> {
    return this.rpc.call("migrateLegacyCommonMcp", payload);
  }

  // ── 同步面 ──

  notifyRendererReady(): void {
    // 触发 host 下发 theme/locale/workspace/visibility 初始帧（§2.2）。
    this.rpc.sendEvent("notifyRendererReady");
  }

  syncWindowTabs(_paths: string[]): void {
    // 多窗口 tab 管理是桌面壳概念；VS Code 场景由原生窗口管理。
  }

  syncWindowUnreadCount(count: number): void {
    // unread → 状态栏角标（经 host 帧；host 端映射到 StatusBar.setPendingApprovals 类似面）。
    this.fireAndForget("syncWindowUnreadCount", count);
  }

  syncActiveTaskSession(_sessionId: string | null): void {
    // 桌面 PiP focus 概念，VS Code 无对应面。
  }

  // ── 插件扩展上行（plat-evt fire-and-forget；host 侧 HostRuntime 消费） ──

  /** 编辑器标签 UI 状态（会话标题/忙态）→ host 回写对应 WebviewPanel 标题。 */
  notifyEditorTabUi(state: { title: string | null; busy: boolean }): void {
    this.rpc.sendEvent("notifyEditorTabUi", state);
  }

  /** 会话标签全集上行 → host 持久化 + 中继给其他对话页（多页签共享）。 */
  syncSessionTabs(tabs: unknown): void {
    this.rpc.sendEvent("syncSessionTabs", tabs);
  }

  /**
   * 工作区侧栏显隐偏好上行 → host 写 globalState，下次任何 webview
   * （新页签/重建/重启）经 bootstrap data-sidebar-visible 注入回来。
   * localStorage 在 VS Code 里按 webview origin 隔离，这是唯一跨页签通道。
   */
  notifyWorkspaceSidebarVisible(visible: boolean): void {
    this.rpc.sendEvent("notifyWorkspaceSidebarVisible", { visible });
  }

  registerOAuthState(_payload: unknown): void {
    // OAuth deep link 由 VS Code URI handler 承担（下期）。
  }

  onOAuthCallback(_callback: (url: string) => void): () => void {
    return () => {};
  }

  onPaymentCallback(_callback: (url: string) => void): () => void {
    return () => {};
  }

  // ── 监听族：返回真实 unsubscribe 的空监听（no-op，矩阵 §2.4） ──

  onRemoteConnectionLog(
    _handler: (entry: RemoteConnectionRuntimeLog) => void,
  ): () => void {
    return () => {};
  }

  onRemoteSessionClosed(
    _handler: (event: RemoteSessionClosedEvent) => void,
  ): () => void {
    return () => {};
  }

  onBotRemoteWorkspaceReconnected(
    _callback: (event: BotRemoteWorkspaceReconnectedEvent) => void,
  ): () => void {
    return () => {};
  }

  onFocusTab(_handler: (path: string) => void): () => void {
    return () => {};
  }

  onNewTab(_handler: () => void): () => void {
    return () => {};
  }

  onNewTask(_handler: () => void): () => void {
    return () => {};
  }

  onOpenWorkspace(_handler: () => void): () => void {
    return () => {};
  }

  onWindowFullscreenChanged(
    _handler: (isFullscreen: boolean) => void,
  ): () => void {
    return () => {};
  }

  onTaskNotificationClick(_handler: (taskId: string) => void): () => void {
    return () => {};
  }

  onUpdateReady(_callback: (version: string) => void): () => void {
    return () => {};
  }

  onUpdateCheckResult(
    _callback: (payload: UpdateCheckResultPayload) => void,
  ): () => void {
    return () => {};
  }

  onPostUpdateReleaseNotes(
    _callback: (payload: PostUpdateReleaseNotesPayload) => void,
  ): () => void {
    return () => {};
  }

  // ── 远程族：不支持（入口自然隐藏，矩阵 §2.4） ──

  connectRemote(
    options: RemoteTarget,
    _requestId?: string,
    _context?: unknown,
  ): Promise<{ success: boolean; error?: string }> {
    return Promise.resolve({
      success: false,
      error: `VS Code 插件暂不支持远程连接（${options.kind}）`,
    });
  }

  cancelPendingRemoteConnection(_requestId?: string): Promise<void> {
    return Promise.resolve();
  }

  startWebRemoteControl(_context: unknown): Promise<never> {
    return Promise.reject(new Error("Web 远程控制仅在桌面端可用"));
  }

  refreshWebRemoteControlPairing(_context: unknown): Promise<never> {
    return Promise.reject(new Error("Web 远程控制仅在桌面端可用"));
  }

  async stopWebRemoteControl(): Promise<void> {
    // no-op：从未开启。
  }

  async getWebRemoteControlStatus(): Promise<WebRemoteControlStatus> {
    return { status: "idle" } as WebRemoteControlStatus;
  }

  async disposeRemoteSession(_sessionId: string): Promise<void> {
    // no-op。
  }

  async isDockerAvailable(): Promise<boolean> {
    return false;
  }

  async listWSLDistros(): Promise<never[]> {
    return [];
  }

  async listDockerContainers(): Promise<never[]> {
    return [];
  }

  async listSSHConfigAliases(): Promise<never[]> {
    return [];
  }

  // ── 更新族：插件更新走 VS Code 扩展更新，全部 no-op（矩阵 §2.4） ──

  async downloadUpdate(): Promise<void> {}

  async cancelUpdateDownload(): Promise<void> {}

  async skipUpdateVersion(_version: string): Promise<void> {}

  async acknowledgePostUpdateReleaseNotes(_version: string): Promise<void> {}

  async quitAndInstallUpdate(): Promise<void> {}

  async executeDesktopCommand(_command: string): Promise<unknown> {
    return undefined;
  }

  async setApplicationLocale(_locale: Locale): Promise<void> {
    // locale 跟随 VS Code。
  }

  async setTitleBarTheme(_theme: "light" | "dark" | "system"): Promise<void> {
    // 标题栏配色由 VS Code 主题管理。
  }

  // ── host 帧驱动的监听（settings/locale/theme 变化） ──

  onSettingsChanged(callback: () => void): () => void {
    // host 在 code.* settings 变更时推送 workspace 帧（载荷 {kind:"settings-changed"}）。
    return (
      this.hostFrames?.on("workspace", (payload: unknown) => {
        const record = payload as { kind?: string } | null;
        if (record?.kind === "settings-changed") callback();
      }) ?? (() => {})
    );
  }

  onApplicationLocaleChanged(callback: (locale: Locale) => void): () => void {
    return this.hostFrames?.on<Locale>("locale", callback) ?? (() => {});
  }

  /**
   * 主题帧订阅面（§2.4 主题跟随；复制 locale 帧消费模式）：
   * host 在 onDidChangeActiveColorTheme 时推送 theme 帧（payload = ColorThemeKind）。
   */
  onThemeChanged(callback: (kind: VscodeThemeKind) => void): () => void {
    return (
      this.hostFrames?.on<VscodeThemeKind>("theme", callback) ?? (() => {})
    );
  }
}

/** 与宿主 ChangesDiffOpener.openPendingDiff 对齐的结构化 hunk。 */
export interface ParsedPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/**
 * 反解析 unified diff 文本（conversationFileChangeDiff.formatPatch 的产出）为
 * 结构化 hunk。`@@ -a,b +c,d @@` 头 + 保留 +/-/ 前缀的行；`\ No newline` 元
 * 标记跳过。解析不出任何 hunk 时返回空数组（调用方落回应用内面板）。
 */
export function parseUnifiedPatch(patch: string): ParsedPatchHunk[] {
  const hunks: ParsedPatchHunk[] = [];
  let current: ParsedPatchHunk | null = null;
  for (const rawLine of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(rawLine);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (rawLine.startsWith("\\")) continue; // "\ No newline at end of file"
    if (
      rawLine.startsWith("diff ") ||
      rawLine.startsWith("index ") ||
      rawLine.startsWith("--- ") ||
      rawLine.startsWith("+++ ")
    ) {
      continue; // 相邻 hunk 之间的文件头残片
    }
    if (rawLine.startsWith("+") || rawLine.startsWith("-") || rawLine.startsWith(" ")) {
      current.lines.push(rawLine);
    }
  }
  return hunks;
}
