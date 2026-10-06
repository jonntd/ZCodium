/* eslint-disable max-lines -- Web 入口集中编排启动、路由与 workspace shell wiring，与 Root.tsx 同样先保持入口收口，避免跨层状态拆散。 */
import { createRoot } from "react-dom/client";
import {
  AppErrorBoundary,
  Root,
  ZCodeIntlProvider,
  generateMobileDeviceFingerprint,
  playTaskNotificationSound,
  setStreamClientId,
  type Theme,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import { connectViaWebSocket } from "@zcode/client";
import { connectWithBoundedRetry } from "./bootstrapRetry.js";
import { resolveConnectionLostAction, resolveConnectionLostNoticePolicy } from "./connectionLostNotice.js";
import { WebCallbackPage } from "./auth/WebCallbackPage.js";
import { createWebAuthService } from "./auth/webAuthService.js";
import { parseOAuthState, resolveSafeAppReturnTo } from "./auth/oauthStateCodec.js";
import { resolveWebCommunityUrl, resolveWebHelpConfig } from "./communityUrl.js";
import type {
  IPlatformService,
  ModelhubFetchModelsRequest,
  RemoteTarget,
  ServerRemoteInfo,
} from "@zcode/shared";
import { WEB_DEFAULT_THEME, resolveWebInitialTheme } from "./webThemeSeed.js";

function resolveWebThemePreference(defaultTheme: Theme = WEB_DEFAULT_THEME): Theme {
  const saved = localStorage.getItem("zcode-theme");
  return resolveWebInitialTheme({ storedTheme: saved, defaultTheme });
}

// 初始化主题：默认 Zai dark，后续由 useTheme hook 接管
// system 模式下需要查询系统偏好；非 system 模式直接用存储值
{
  const saved = resolveWebThemePreference();
  const resolved =
    saved === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : saved === "dark" || saved === "zai-dark"
        ? "dark"
        : "light";
  const appliedTheme =
    saved === "system"
      ? resolved === "dark"
        ? "zai-dark"
        : "zai-light"
      : saved === "dark"
        ? "zai-dark"
        : saved === "light"
          ? "zai-light"
          : saved;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.documentElement.classList.toggle("theme-zai-light", appliedTheme === "zai-light");
  document.documentElement.classList.toggle("theme-zai-dark", appliedTheme === "zai-dark");
}

async function resolveFeedbackUrl(): Promise<string | undefined> {
  return (await resolveWebHelpConfig()).feedback_url;
}

const root = createRoot(document.getElementById("root")!);
const webAuthService = createWebAuthService();

// 初始化 Web 端流式 clientId，确保所有 hook 在首次渲染前就使用稳定 ID
{
  setStreamClientId(generateMobileDeviceFingerprint());
}

interface WebBootstrapResult {
  wsUrl: string;
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialTaskId?: string;
  restoreSession?: boolean;
  allowOpenWorkspace?: boolean;
  /** E2EE channelKey（分享链接 `#k=` fragment；spec vps-relay-bridge.md §16）。 */
  e2eeChannelKey?: string;
}

function isWebOAuthCallback(params: URLSearchParams): boolean {
  return (
    ["/cn/share/callback", "/share/callback"].includes(window.location.pathname) &&
    params.has("state") &&
    (params.has("code") || params.has("error"))
  );
}

function renderWebAuthCallbackPage(): void {
  document.title = "ZCodium - Sign In";
  const callbackState = parseOAuthState(
    new URLSearchParams(window.location.search).get("state") ?? "",
  );
  const safeRetryTarget = resolveSafeAppReturnTo(callbackState?.app_return_to);
  root.render(
    <WebCallbackPage
      authService={webAuthService}
      onSuccess={({ appReturnTo }) => {
        window.location.replace(appReturnTo ?? "/");
      }}
      onRetry={() => {
        window.location.replace(safeRetryTarget ?? "/");
      }}
    />,
  );
}

function createWebPlatform(
  services: Awaited<ReturnType<typeof connectViaWebSocket>>,
): IPlatformService {
  // 拉取模型（modelhub）：浏览器直连渠道端点会被 CORS 拦，所以经 **Host 的 RPC 服务**
  // （`IProviderSettingsService.fetchModels`，Node 侧执行）透传。
  // UI 用 `platform.modelhubFetchModels != null` 探测按钮可见性，因此「Host 不支持」时必须
  // 保持 undefined（不能给一个必失败的实现），这也是旧 Host 上的降级行为。
  const fetchHostModels = services.providerSettingsService.fetchModels?.bind(
    services.providerSettingsService,
  );
  return {
    canSelectFilePath: false,
    // Web 端无法打开系统目录选择框
    selectDirectory: () => Promise.resolve(null),
    // Web 端无法打开系统文件选择框
    selectFile: () => Promise.resolve(null),
    selectFiles: () => Promise.resolve([]),
    getPathForFile: () => null,
    createTempTextAttachment: () =>
      Promise.reject(new Error("Temporary text attachments require a desktop host")),
    ...(fetchHostModels
      ? {
          modelhubFetchModels: (payload: ModelhubFetchModelsRequest) => fetchHostModels(payload),
        }
      : {}),
    // 视觉探测（modelhubProbeVision）仍未实现：它要向渠道发一张图片，同样受 CORS 限制，
    // 而 Host 侧暂无对应服务；保持 undefined 以免按钮可点却必失败。
    // 提示词增强已迁到 prompt-assist 统一服务链路（对 desktop/web 全量暴露），
    // 不再是 IPlatformService 可选方法，Web 端按钮照常渲染。
    onRemoteConnectionLog: () => () => {},
    onRemoteSessionClosed: () => () => {},
    onBotRemoteWorkspaceReconnected: () => () => {},
    // Web 端无多窗口管理
    activateOrSetWorkspace: () => Promise.resolve({ activated: false }),
    // TODO(web-remote-workspace): 普通 Web 模式先只保证 server 本地工作区可用。
    // 远程 WebSocket 只暴露部分 service，与 Root/RemoteServiceAccess 需要的完整
    // accessor 不匹配，直接打开 ?remote=<id> 会在项目向导或首屏卡住。
    connectRemote(options: RemoteTarget) {
      return Promise.resolve({
        success: false,
        error: `Remote connect is not supported in Web mode yet: ${options.kind}`,
      });
    },
    cancelPendingRemoteConnection: (_requestId?: string) => Promise.resolve(),
    disposeRemoteSession: () => Promise.resolve(),
    isDockerAvailable: () => Promise.resolve(false),
    listWSLDistros: () => Promise.resolve([]),
    listDockerContainers: () => Promise.resolve([]),
    listSSHConfigAliases: () => Promise.resolve([]),
    loadMcpFromUserDirectory: () => Promise.resolve({ servers: [] }),
    saveMcpToUserDirectory: () =>
      Promise.resolve({
        success: false,
        error: "MCP native directory management requires a desktop attachment",
      }),
    migrateLegacyCommonMcp: () =>
      Promise.resolve({
        servers: {},
        totalCount: 0,
        importedCount: 0,
        skippedCount: 0,
      }),
    openExternal: (url) => {
      window.open(url, "_blank", "noopener,noreferrer");
    },
    openFeedback: async () => {
      const feedbackUrl = await resolveFeedbackUrl();
      if (!feedbackUrl) {
        return;
      }
      window.open(feedbackUrl, "_blank", "noopener,noreferrer");
    },
    openCommunity: async () => {
      // fa-IR 等非中文语言跟随英文社区入口。
      const locale = document.documentElement.lang === "zh-CN" ? "zh-CN" : "en-US";
      const communityUrl = await resolveWebCommunityUrl(locale);
      if (!communityUrl) {
        return;
      }
      window.open(communityUrl, "_blank", "noopener,noreferrer");
    },
    canOpenCommunity: async (locale) => {
      const communityUrl = await resolveWebCommunityUrl(locale);
      return typeof communityUrl === "string" && communityUrl.length > 0;
    },
    openInFileManager: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    openExternalFile: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    registerOAuthState: (_payload) => {},
    onOAuthCallback: () => () => {},
    onPaymentCallback: () => () => {},
    onShareImport: () => () => {},
    notifyRendererReady: () => {},
    showTaskNotification: (payload) => {
      if (document.hasFocus()) {
        return;
      }

      if (
        typeof window.Notification === "undefined" ||
        window.Notification.permission !== "granted"
      ) {
        return;
      }

      try {
        new window.Notification(payload.title, {
          body: payload.body,
          silent: true,
        });
        void playTaskNotificationSound();
      } catch {
        // 浏览器通知不可用时静默忽略，避免打断主流程
      }
    },
    // Web 端不需要跨窗口 tab 管理
    syncWindowTabs: () => {},
    // Web 端没有宿主层 Dock / 任务栏徽标，保持空实现以兼容统一平台接口
    syncWindowUnreadCount: () => {},
    syncActiveTaskSession: () => {},
    onFocusTab: () => () => {},
    onNewTab: () => () => {},
    onCloseActiveContextRequest: () => () => {},
    onOpenBrowserUrl: () => () => {},
    onNewTask: () => () => {},
    onOpenWorkspace: () => () => {},
    onWindowFullscreenChanged: () => () => {},
    onTaskNotificationClick: () => () => {},
    exportLogs: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    captureWindowScreenshot: () => Promise.resolve(null),
    importChromeBrowserData: (_options) =>
      Promise.resolve({
        success: false,
        cookies: { imported: 0, skipped: 0, failed: 0 },
        localStorage: {
          originsImported: 0,
          entriesImported: 0,
          originsSkipped: 0,
          originsFailed: 0,
        },
        error: "chrome_import_not_supported" as const,
      }),
    clearEmbeddedBrowserData: () =>
      Promise.resolve({ success: false, error: "Not supported in web mode" }),
    // IPlatformService 新增更新提示能力后，Web fallback 没有同步补齐空实现，
    // 根级 typecheck 会直接失败，连与桌面端无关的改动都没法完成校验。
    // Web 端当前没有桌面更新器，先显式 no-op，保持接口完整且不改变现有行为。
    onUpdateReady: () => () => {},
    onUpdateCheckResult: () => () => {},
    onUpdateStateChanged: () => () => {},
    getUpdateState: () => Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => Promise.resolve(),
    cancelUpdateDownload: () => Promise.resolve(),
    getDesktopSessionActivity: () => Promise.resolve({ runningAgentSessionCount: 0 }),
    getDesktopZoomLevel: () => Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: () => () => {},
    onPostUpdateReleaseNotes: () => () => {},
    acknowledgePostUpdateReleaseNotes: () => Promise.resolve(),
    skipUpdateVersion: () => Promise.resolve(),
    quitAndInstallUpdate: () => Promise.resolve(),
    getInstalledEditors: () => Promise.resolve([]),
    openInEditor: () => Promise.resolve({ success: false, error: "Not supported in web mode" }),
    executeDesktopCommand: () => Promise.resolve(),
    setApplicationLocale: (_locale) => Promise.resolve(),
    setTitleBarTheme: () => Promise.resolve(),
    getDeviceId: () => {
      const nav = globalThis.navigator as Navigator & { platform?: string };
      const platform = nav?.platform ?? "";
      const screenWidth = globalThis.screen?.width;
      const screenHeight = globalThis.screen?.height;
      const colorDepth = globalThis.screen?.colorDepth;
      const parts = [
        platform,
        screenWidth !== undefined ? String(screenWidth) : "",
        screenHeight !== undefined ? String(screenHeight) : "",
        colorDepth !== undefined ? String(colorDepth) : "",
      ];
      return parts.filter(Boolean).join("|");
    },
  };
}

function resolveDefaultWsOrigin(): string {
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

/**
 * E2EE channelKey（spec vps-relay-bridge.md §16）：桌面分享链接把 channelKey 放在
 * **URL fragment**（`#k=`）——浏览器不把 fragment 发给服务器，中继因此拿不到它。
 * 不从地址栏清除：autoReconnect 的整页重载依赖 URL（含 fragment）原样保留。
 */
function resolveE2eeChannelKey(): string | undefined {
  const hash = window.location.hash;
  if (!hash.startsWith("#")) return undefined;
  const key = new URLSearchParams(hash.slice(1)).get("k")?.trim();
  return key || undefined;
}

async function resolveWebBootstrap(): Promise<WebBootstrapResult> {
  const params = new URLSearchParams(window.location.search);
  const remoteId = params.get("remote");
  // relay 的 token 双通道（spec vps-relay-bridge.md §12.4）：内置浏览器等环境里
  // 302 的 Set-Cookie 可能不落地，页面把 URL 里的 token 附加到 wsUrl 与
  // server-info 请求，WS/server-info 就不依赖 cookie。E2EE 的 #k= 在 fragment，
  // 不会进任何请求。
  const relayToken = params.get("token")?.trim();
  const tokenQuery = relayToken ? `?token=${encodeURIComponent(relayToken)}` : "";
  const wsUrl = remoteId
    ? `${resolveDefaultWsOrigin()}/ws/remote/${remoteId}`
    : `${resolveDefaultWsOrigin()}/ws${tokenQuery}`;

  if (remoteId) {
    return { wsUrl };
  }

  try {
    const response = await fetch(`/api/server-info${tokenQuery}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      return { wsUrl, e2eeChannelKey: resolveE2eeChannelKey() };
    }
    const serverInfo = (await response.json()) as Partial<ServerRemoteInfo>;
    const workspace = Array.isArray(serverInfo.workspaces) ? serverInfo.workspaces[0] : undefined;
    return {
      wsUrl,
      e2eeChannelKey: resolveE2eeChannelKey(),
      ...(workspace?.path ? { initialWorkspaceAbsPath: workspace.path } : {}),
      ...(workspace?.workspaceIdentity
        ? { initialWorkspaceIdentity: workspace.workspaceIdentity }
        : {}),
    };
  } catch {
    return { wsUrl, e2eeChannelKey: resolveE2eeChannelKey() };
  }
}

function WebBootstrapErrorScreen({ message }: { message: string }) {
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 rounded-full bg-destructive" />
            <h1 className="text-ui-xs font-medium">
              {/^zh\b/i.test(navigator.language) ? "Web 启动失败" : "Web bootstrap failed"}
            </h1>
          </div>
          <p className="mt-2 break-all text-ui-xs/relaxed text-foreground-subtle">{message}</p>
          <button
            type="button"
            className="mt-4 rounded-lg border border-border bg-surface px-3 py-2 text-ui-xs text-foreground-subtle hover:bg-surface-hover"
            onClick={() => {
              window.location.reload();
            }}
          >
            {/^zh\b/i.test(navigator.language) ? "重试" : "Retry"}
          </button>
        </section>
      </div>
    </div>
  );
}

function renderWebBootstrapError(error: unknown): void {
  document.title = "ZCodium - Web";
  root.render(
    <WebBootstrapErrorScreen message={error instanceof Error ? error.message : String(error)} />,
  );
}

/** 断线提示的挂载点 id（独立于 `root`，见 showWebConnectionLostNotice）。 */
const WEB_CONNECTION_LOST_NOTICE_ID = "zcode-web-connection-lost-notice";

/** 自动重连（opt-in）限流：同一标签 10s 内只自动重载一次，避免桌面长期离线时无限刷新。 */
const AUTO_RECONNECT_MIN_INTERVAL_MS = 10_000;
const AUTO_RECONNECT_STORAGE_KEY = "zcode-web-auto-reconnect-at";

/**
 * 领取一次自动重载配额。拿不到 sessionStorage（隐私模式等）时返回 false ——
 * 宁可不自动重载（横幅 + 手动重连仍可用），也不要冒险形成刷新循环。
 */
function claimAutoReconnectSlot(): boolean {
  try {
    const last = Number(sessionStorage.getItem(AUTO_RECONNECT_STORAGE_KEY) ?? 0);
    if (Date.now() - last < AUTO_RECONNECT_MIN_INTERVAL_MS) return false;
    sessionStorage.setItem(AUTO_RECONNECT_STORAGE_KEY, String(Date.now()));
    return true;
  } catch {
    return false;
  }
}

function WebConnectionLostNotice({ code, reason }: { code: number; reason: string }) {
  const isZh = /^zh\b/i.test(navigator.language);
  // 4004 = 被另一个页面顶替（多标签/换设备）：提示语必须与「桌面离线」区分，
  // 且**不**引导重连：否则两个标签会互相抢连接，形成刷新拉锯（见 connectionLostNotice.ts）。
  const { kind, showReconnect } = resolveConnectionLostNoticePolicy(code);
  const replaced = kind === "replaced";
  const title = replaced
    ? isZh
      ? "此页面已被其他窗口接管"
      : "This page was taken over by another window"
    : isZh
      ? "与桌面的连接已断开"
      : "Connection to the desktop was lost";
  const detail = reason || `code ${code}`;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[9999] flex justify-center px-4">
      <section className="pointer-events-auto flex w-full max-w-lg items-center gap-3 rounded-xl border border-card-border bg-card p-3 text-ui-xs shadow-lg">
        <span className="size-2 shrink-0 rounded-full bg-destructive" />
        <h1 className="font-medium">{title}</h1>
        {replaced ? null : <span className="truncate text-foreground-subtle">{detail}</span>}
        {showReconnect ? (
          <button
            type="button"
            className="ml-auto shrink-0 rounded-lg border border-border bg-surface px-3 py-1.5 text-foreground-subtle hover:bg-surface-hover"
            onClick={() => {
              window.location.reload();
            }}
          >
            {isZh ? "重连" : "Reconnect"}
          </button>
        ) : null}
      </section>
    </div>
  );
}

/**
 * 交付（已收到 `Initialize`）之后传输断开：叠加一条**非破坏性**提示，而不是卸载界面或自动刷新。
 *
 * 为什么不在 `root` 里渲染：那会卸载用户界面、丢掉未提交草稿。为什么不自动刷新：
 * 自动刷新同样丢草稿，且多标签下两个页面会互相顶替形成刷新拉锯。重连交给用户一键触发——
 * 整页重载 = 新 attachment = `replayable` 快照恢复，这是已验证的恢复路径。
 */
function showWebConnectionLostNotice(event: { code: number; reason: string }): void {
  if (document.getElementById(WEB_CONNECTION_LOST_NOTICE_ID)) return;
  const container = document.createElement("div");
  container.id = WEB_CONNECTION_LOST_NOTICE_ID;
  document.body.append(container);
  createRoot(container).render(<WebConnectionLostNotice code={event.code} reason={event.reason} />);
}

async function bootstrapWebApp() {
  const params = new URLSearchParams(window.location.search);
  if (isWebOAuthCallback(params)) {
    renderWebAuthCallbackPage();
    return;
  }

  let bootstrap: WebBootstrapResult;
  try {
    bootstrap = await resolveWebBootstrap();
  } catch (error) {
    renderWebBootstrapError(error);
    return;
  }

  const autoReconnect = params.get("autoReconnect") === "1";

  let delivered = false;
  try {
    // 连接阶段做**有界**自动重试：瞬时失败（桌面刚重启、relay 宽限到期）自动再来一次，
    // 真实离线仍落到错误页。策略、上限与依据见 bootstrapRetry.ts 与对应 spec。
    const services = await connectWithBoundedRetry(() =>
      connectViaWebSocket(bootstrap.wsUrl, {
        // E2EE（spec vps-relay-bridge.md §16）：链接带 #k= 才启用；握手失败走错误页。
        e2eeChannelKey: bootstrap.e2eeChannelKey,
        // 交付之前的断开由 reject + 重试/错误页处理；这里只管交付之后。
        onClose: (event) => {
          if (!delivered) return;
          // 先问策略「是否应当自动重载」（默认关闭，且 4004 永不自动重载），再用限流决定能否执行。
          const wantsReload =
            resolveConnectionLostAction({
              closeCode: event.code,
              autoReconnect,
              reloadAllowed: true,
            }) === "reload";
          if (wantsReload && claimAutoReconnectSlot()) {
            window.location.reload();
            return;
          }
          showWebConnectionLostNotice(event);
        },
      }),
    );
    delivered = true;
    const platform = createWebPlatform(services);
    document.title = "ZCodium - Web + Server";

    root.render(
      <AppErrorBoundary>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
        >
          <Root
            services={services}
            platform={platform}
            initialWorkspaceAbsPath={bootstrap.initialWorkspaceAbsPath}
            initialWorkspaceIdentity={bootstrap.initialWorkspaceIdentity}
            initialTaskId={bootstrap.initialTaskId}
            restoreSession={bootstrap.restoreSession}
            allowOpenWorkspace={bootstrap.allowOpenWorkspace}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  } catch (error) {
    renderWebBootstrapError(error);
  }
}

void bootstrapWebApp();
