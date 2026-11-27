// 远控 / 分享网页运行在用户自己的浏览器里，版本不受我们控制。
// ZCT-2118215639243444224：Chrome 109 没有 Array.prototype.toSorted，Hook 详情组件渲染时抛
// TypeError，区域错误边界显示“这块界面出了点问题”。Vite 只降级语法、不补运行时 API，
// 这里只补产物实际用到、且高于构建语法基线的 API；core-js 会先检测原生实现，不覆盖新版浏览器。
// 必须放在最前面：ES module 按 import 顺序求值，其他模块执行前 API 需已就绪。
// 范围与新增规则见 docs/web-remote-control/web-browser-support.md。
import "core-js/stable/array/to-sorted";
import "core-js/stable/array/to-reversed";
import "core-js/stable/object/group-by";
import { createWebPlatform } from "#src/platform/index.js";
import { mobilePluginDiscoveryTelemetrySchema } from "@zcode/shared";
import {
  sessionCreateTelemetrySchema,
  WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
  createWebRemoteControlConnectionRecoveryTimeoutFailure,
  resolveWebRemoteControlRelayWsUrl,
  matchesWebRemoteControlRoutePath,
  resolveWebRemoteControlWorkspaceKey,
} from "@zcode/shared";
/* eslint-disable max-lines -- Web 远程控制启动、错误页和 web 平台桥接暂时集中在入口编排。 */
import type { ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import {
  AppErrorBoundary,
  ensurePendingTaskDraft,
  readPendingTaskDraft,
  readComposerWorkspaceScope,
  Root,
  RootStartupLoading,
  ZCodeIntlProvider,
  generateMobileDeviceFingerprint,
  playTaskNotificationSound,
  readSettingsSectionFromLocationHash,
  setStreamClientId,
  useZCodeIntl,
  type Theme,
  type WebRemoteControlTerminalTransportState as UiWebRemoteControlTerminalTransportState,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import { connectViaWebSocket } from "@zcode/client";
import { ZCODE_COMMIT, ZCODE_VERSION, decryptRelayReport } from "@zcode/shared";
import { connectWithBoundedRetry } from "./bootstrapRetry.js";
import {
  resolveConnectionLostAction,
  resolveConnectionLostNoticePolicy,
} from "./connectionLostNotice.js";
import {
  relayBundleFreshnessNoticeKey,
  resolveRelayBundleFreshnessNotice,
  type RelayBundleFreshnessNotice,
} from "./relayBundleFreshness.js";
import { resolveWebCommunityUrl, resolveWebHelpConfig } from "./communityUrl.js";
import type {
  IPlatformService,
  ModelhubFetchModelsRequest,
  RemoteTarget,
  ServerRemoteInfo,
  WebRemoteControlStatus,
} from "@zcode/shared";
import { WEB_DEFAULT_THEME, resolveWebInitialTheme } from "./webThemeSeed.js";

import {
  WebRemoteControlEntry,
  isWebRemoteControlOAuthCallback,
  type WebRemoteControlEntryConnection,
  createWebRemoteControlV2TokenClient,
  readKnownDevices,
  createWebRemoteControlDeviceClient,
  createWebRemoteControlBridgeRecoveryRunner,
  acceptWebRemoteControlBridgeInvalidation,
  resolveWebRemoteControlRecoveryTarget,
  getWebRemoteControlBridgeRecoveryRetryDelay,
  WebRemoteControlTerminalTransport,
  type WebRemoteControlTerminalTransportDiagnostic,
  type WebRemoteControlTerminalTransportState,
  createWebRemoteControlAppPayloadRequester,
  createWebRemoteControlRelayRequestRecovery,
  createWebRemoteControlLifecycleRecovery,
  WEB_REMOTE_CONTROL_DEFAULT_THEME,
  resolveWebRemoteControlInitialTheme,
  collectWebRemoteControlMobileDeviceInfo,
  createWebRemoteControlVersionGuard,
  resolveWebRemoteControlRoutePath,
  registerWebRemoteControlWorkspaceBridgeServices,
  connectWebRemoteControlWorkspaceBridgeServices,
  replayWebRemoteControlWorkspaceBridgeFrames,
  createWebRemoteControlTaskViewPublisher,
  type WebRemoteControlWorkspaceBridgeServiceRegistration,
  markWebRemoteControlBridgeTaskRead,
  markWebRemoteControlTaskRead,
} from "#src/web-remote-control/index.js";

import {
  WebRemoteControlDeviceListPage,
  WebRemoteControlLoadingScreen,
  type WebRemoteControlConnectingDevice,
  WebRemoteControlFailureScreen,
  resolveWebRemoteControlScreenLocale,
  showWebRemoteControlVersionNotice,
} from "#src/web-remote-control/views.js";

type RootServices = Parameters<typeof Root>[0]["services"];
type ServiceMethod = (...args: any[]) => unknown;

function logWebRemoteControlTaskReadFailure(
  error: unknown,
  context: { taskId: string; workspaceKey: string },
): void {
  console.warn("[web-remote-control] 标记手机端 task 已读失败", {
    error: error instanceof Error ? error.message : String(error),
    taskId: context.taskId,
    workspaceKey: context.workspaceKey,
  });
}

async function markCurrentWebRemoteControlBridgeTaskRead({
  bridge,
  services,
  task,
}: {
  bridge: WebRemoteControlExternalWorkspaceBridge | WebRemoteControlWorkspaceBridge;
  services: RootServices;
  task: WebRemoteControlTaskTarget;
}): Promise<void> {
  const taskWorkspaceKey = resolveWebRemoteControlWorkspaceKey(task);
  if (taskWorkspaceKey !== bridge.workspaceKey) {
    // 修复原因：同路径 remote workspace 可能属于不同 identity，禁止误用当前 bridge 写另一条连接。
    console.warn("[web-remote-control] 跳过跨 workspace 的 task 已读写入", {
      taskId: task.taskId,
      taskWorkspaceKey,
      bridgeWorkspaceKey: bridge.workspaceKey,
    });
    return;
  }
  if (typeof task.unreadAt !== "number") {
    return;
  }

  const result = await markWebRemoteControlTaskRead({
    service: services.zcodeTaskService,
    target: {
      taskId: task.taskId,
      workspacePath: task.workspacePath,
      ...(task.workspaceIdentity ? { workspaceIdentity: task.workspaceIdentity } : {}),
      expectedUnreadAt: task.unreadAt,
    },
  });
  if (!result.ok) {
    logWebRemoteControlTaskReadFailure(result.error, {
      taskId: task.taskId,
      workspaceKey: taskWorkspaceKey,
    });
  }
}

async function markOpenedWebRemoteControlBridgeTaskRead({
  bridge,
  expectedUnreadAt,
  services,
}: {
  bridge: WebRemoteControlExternalWorkspaceBridge | WebRemoteControlWorkspaceBridge;
  expectedUnreadAt?: number;
  services: RootServices;
}): Promise<void> {
  const result = await markWebRemoteControlBridgeTaskRead({
    bridge,
    expectedUnreadAt,
    service: services.zcodeTaskService,
  });
  if (!result.ok) {
    logWebRemoteControlTaskReadFailure(result.error, {
      taskId: bridge.initialTaskId ?? "unknown",
      workspaceKey: bridge.workspaceKey,
    });
  }
}

function resolveWebThemePreference(defaultTheme: Theme = WEB_REMOTE_CONTROL_DEFAULT_THEME): Theme {
  const saved = localStorage.getItem("zcode-theme");
  return resolveWebRemoteControlInitialTheme({ storedTheme: saved, defaultTheme });
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

const root = createRoot(document.getElementById("root")!);
const webAuthService = createWebAuthService();
let isPageUnloading = false;

// 初始化 Web 端流式 clientId，确保所有 hook 在首次渲染前就使用稳定 ID
{
  setStreamClientId(generateMobileDeviceFingerprint());
}

window.addEventListener("beforeunload", () => {
  isPageUnloading = true;
});

interface WebBootstrapResult {
  wsUrl: string;
  initialWorkspaceAbsPath?: string;
  initialWorkspaceIdentity?: string;
  initialTaskId?: string;
  restoreSession?: boolean;
  allowOpenWorkspace?: boolean;
  /** E2EE channelKey（分享链接 `#k=` fragment；spec vps-relay-bridge.md §16）。 */
  e2eeChannelKey?: string;
  /** 桌面 Host 上报的应用版本（`/api/server-info` 的 `version`，或 E2EE 解密后的 `report.appVersion`）。 */
  hostAppVersion?: string;
  /** 桌面 Host 上报的构建期 commit 戳（只有 E2EE 路径拿得到，中继不解析明文）。 */
  hostBuildCommitId?: string;
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
    openDataRootImport: () => {},
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
    // Web 端不作为 Web 远程控制的发起端，保留空实现以兼容统一接口。
    startWebRemoteControl: () =>
      Promise.reject(new Error("Web remote control can only be started from desktop")),
    refreshWebRemoteControlPairing: () =>
      Promise.reject(new Error("Web remote control pairing can only be refreshed from desktop")),
    stopWebRemoteControl: () => Promise.resolve(),
    getWebRemoteControlStatus: () =>
      Promise.resolve<WebRemoteControlStatus>({
        status: "idle",
      }),
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
    notifyRendererReady: () => {},
    showTaskNotification: (payload) => {
      if (document.hasFocus()) {
        return;
      }

// 访问 window.localStorage 本身在部分浏览器会抛错，统一包在方法里交给调用方兜底。
const webRemoteControlStorage: Pick<Storage, "getItem" | "setItem"> = {
  getItem: (key) => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};

const remoteEntry = new WebRemoteControlEntry({
  auth: webAuthService,
  getHref: () => window.location.href,
  replaceHref: (href) => window.history.replaceState(window.history.state, "", href),
  storage: webRemoteControlStorage,
  locale: resolveWebRemoteControlScreenLocale(navigator.language),
  devices: createWebRemoteControlDeviceClient(window.location.origin),
  subscribeVisible: (listener) => {
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") listener();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  },
  loginOptions: { devReturnTo: resolveWebAuthDevReturnTo(WEB_ZAI_OAUTH_CONFIG) },
  token: createWebRemoteControlV2TokenClient(window.location.origin),
  connect: (connection) => {
    void bootstrapExternalRelayWebRemoteControl(connection);
  },
  onView: (view) => {
    if (view.kind === "callback") renderWebAuthCallbackPage();
    else if (view.kind === "login") renderWebLoginPage();
    else if (view.kind === "devices") {
      document.title = "ZCode - Web Remote Control";
      root.render(
        <WebRemoteControlDeviceListPage
          view={view}
          onSelect={(sid) => remoteEntry.selectDevice(sid)}
          onRefresh={() => {
            void remoteEntry.refreshDevices();
          }}
          onSwitchAccount={() => {
            void remoteEntry.switchAccount();
          }}
          locale={resolveWebRemoteControlScreenLocale(navigator.language)}
        />,
      );
    } else if (view.kind === "failure") renderWebRemoteControlFailure(view.failure);
  },
});

function toWebRemoteControlFailure(
  reason: WebRemoteControlFailureReason,
  message?: string,
): WebRemoteControlFailure {
  return { reason, message };
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
  // 时效签名链接（spec §18.4）：signed 四元组与 token 同理——302 保留参数在地址栏，
  // 页面把它们附加到 wsUrl/server-info，作为 cookie 之外的对等凭据通道。
  const shareSid = params.get("s")?.trim();
  const shareT = params.get("t")?.trim();
  const shareE = params.get("e")?.trim();
  const shareH = params.get("h")?.trim();
  const signedQuery =
    shareSid && shareT && shareE && shareH
      ? `?s=${encodeURIComponent(shareSid)}&t=${encodeURIComponent(shareT)}&e=${encodeURIComponent(
          shareE,
        )}&h=${encodeURIComponent(shareH)}`
      : "";
  const credentialQuery = tokenQuery || signedQuery;
  const wsUrl = remoteId
    ? `${resolveDefaultWsOrigin()}/ws/remote/${remoteId}`
    : `${resolveDefaultWsOrigin()}/ws${credentialQuery}`;

  if (remoteId) {
    return { wsUrl };
  }

  try {
    const response = await fetch(`/api/server-info${credentialQuery}`, {
      cache: "no-store",
    });
    if (!response.ok) {
      return { wsUrl, e2eeChannelKey: resolveE2eeChannelKey() };
    }
    const raw = (await response.json()) as Partial<ServerRemoteInfo> & {
      e2ee?: boolean;
      v?: number;
      nonce?: string;
      ciphertext?: string;
    };
    // host-report 端到端加密（spec §16.9）：relay 只回不透明信封，这里用 #k=
    // 派生密钥解密并在客户端组合同一形状。缺 #k= / 密文损坏 ⇒ fail-closed
    // （报错上屏，不降级——中继没存明文，降级只会得到误导性的空信息）。
    let serverInfo: Partial<ServerRemoteInfo>;
    // 桌面 Host 上报的构建期 commit 戳。**只有 E2EE 路径拿得到**：中继对明文上报会
    // 白名单重组字段（`buildServerInfo()` 只回 serverId/version/workspaces/…），
    // 但 E2EE 时它把整份密文原样回给手机，这里解密后就能读到任意字段。
    let hostBuildCommitId: string | undefined;
    if (raw.e2ee === true) {
      const channelKey = resolveE2eeChannelKey();
      if (!channelKey || typeof raw.nonce !== "string" || typeof raw.ciphertext !== "string") {
        throw new RelayReportDecryptError(
          "server-info 已端到端加密，但链接缺少 #k=（channelKey），无法解密——请使用带密钥的完整分享链接",
        );
      }
      let report: {
        workspacePath?: string;
        workspaceIdentity?: string;
        hostLabel?: string;
        appVersion?: string;
        buildCommitId?: string;
      };
      try {
        report = JSON.parse(
          decryptRelayReport(channelKey, {
            v: 1,
            e2ee: true,
            nonce: raw.nonce,
            ciphertext: raw.ciphertext,
          }),
        ) as typeof report;
      } catch {
        throw new RelayReportDecryptError("server-info 解密失败：链接密钥不匹配或数据被篡改");
      }
      const path = typeof report.workspacePath === "string" ? report.workspacePath : null;
      hostBuildCommitId =
        typeof report.buildCommitId === "string" && report.buildCommitId.trim().length > 0
          ? report.buildCommitId
          : undefined;
      serverInfo = {
        serverId: report.hostLabel || "zcode-relay",
        version: report.appVersion || "relay",
        workspaces: path
          ? [
              {
                path,
                label: path.split("/").filter(Boolean).pop() || path,
                ...(report.workspaceIdentity
                  ? { workspaceIdentity: report.workspaceIdentity }
                  : {}),
              },
            ]
          : [],
      };
    } else {
      serverInfo = raw;
    }
    const workspace = Array.isArray(serverInfo.workspaces) ? serverInfo.workspaces[0] : undefined;
    return {
      wsUrl,
      e2eeChannelKey: resolveE2eeChannelKey(),
      // 非 E2EE 路径下中继只回 `version`（= 桌面 host-report 的 appVersion）；
      // E2EE 路径下两者都能拿到，交给 relayBundleFreshness 决定比哪个。
      ...(typeof serverInfo.version === "string" ? { hostAppVersion: serverInfo.version } : {}),
      ...(hostBuildCommitId ? { hostBuildCommitId } : {}),
      ...(workspace?.path ? { initialWorkspaceAbsPath: workspace.path } : {}),
      ...(workspace?.workspaceIdentity
        ? { initialWorkspaceIdentity: workspace.workspaceIdentity }
        : {}),
    };
  } catch (error) {
    // 解密失败必须上屏（fail-closed），其余网络错误维持优雅降级。
    if (error instanceof RelayReportDecryptError) throw error;
    return { wsUrl, e2eeChannelKey: resolveE2eeChannelKey() };
  }
}

/** server-info 信封解密失败（缺 #k= / 篡改 / 错 key）：bootstrap 直接报错而非降级。 */
class RelayReportDecryptError extends Error {}

/**
 * Web 启动失败页。
 *
 * ⚠ 这个组件渲染在 `Root` 之外（React 接管前就失败了），但**必须**与 App 内其它错误态
 * 共用同一套组件与文案来源：
 * - 文案走 `intl`，不再用 `/^zh\b/i.test(navigator.language)` 手判中英——那种写法
 *   在 fa-IR 等语言下永远拿不到译文，是「中继页 UI 与桌面 App 不一致」的典型来源。
 * - 按钮用 `@zcode/ui` 的 `Button`，而不是裸 `<button>` + 手抄的样式类，
 *   否则 hover / focus-visible / cursor 与 App 内按钮对不上。
 */
function WebBootstrapErrorScreen({ message }: { message: string }) {
  const { intl } = useZCodeIntl();
  return (
    <div className="h-dvh min-h-dvh w-screen bg-background text-foreground">
      <div className="mx-auto flex h-full w-full max-w-lg items-center px-4">
        <section className="w-full rounded-xl border border-card-border bg-card p-5">
          <div className="flex items-center gap-3">
            <span className="size-2 rounded-full bg-destructive" />
            <h1 className="text-ui-xs font-medium">
              {intl.formatMessage({ id: "webBootstrap.failed" })}
            </h1>
          </div>
          <p className="mt-2 break-all text-ui-xs/relaxed text-foreground-subtle">{message}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-4 enabled:cursor-pointer"
            onClick={() => {
              window.location.reload();
            }}
          >
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </section>
      </div>
    </div>
  );
}

function renderWebBootstrapError(error: unknown): void {
  document.title = "ZCodium - Web";
  root.render(
    <ZCodeIntlProvider>
      <WebBootstrapErrorScreen message={error instanceof Error ? error.message : String(error)} />
    </ZCodeIntlProvider>,
  );
}

/**
 * 非桌面入口「初始 workspace 已给、workspace tab 尚未注入」那几帧的兜底。
 *
 * `Root.tsx:932-947` 专门为这种情形留了分支（`!isDesktop && initialWorkspaceAbsPath &&
 * initialWorkspaceLoadingFallback`），但**两个入口此前都没传这个 prop**，分支是死代码 ⇒
 * 这几帧会渲染一个空的 `RootShell`，在手机浏览器里就是白底（`Root.tsx:577-578` 的注释
 * 描述的正是这个现象）。
 *
 * 复用桌面同款 `RootStartupLoading`，保证「中继页首屏」与「桌面 App 首屏」是同一套视觉。
 */
function WebInitialWorkspaceLoading() {
  const { intl } = useZCodeIntl();
  return <RootStartupLoading label={intl.formatMessage({ id: "common.loading" })} />;
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

/**
 * 交付之后传输断开时叠加的非破坏性提示。
 *
 * ⚠ 与 `WebBootstrapErrorScreen` 同理：它渲染在 `Root` 之外（不能卸载用户界面），
 * 但文案与按钮必须与 App 内一致——走 `intl`（支持三语，不再手判中英）+ `Button`。
 */
function WebConnectionLostNotice({ code, reason }: { code: number; reason: string }) {
  const { intl } = useZCodeIntl();
  // 4004 = 被另一个页面顶替（多标签/换设备）：提示语必须与「桌面离线」区分，
  // 且**不**引导重连：否则两个标签会互相抢连接，形成刷新拉锯（见 connectionLostNotice.ts）。
  const { kind, showReconnect } = resolveConnectionLostNoticePolicy(code);
  const replaced = kind === "replaced";
  const title = intl.formatMessage({
    id: replaced ? "webConnectionLost.replaced" : "webConnectionLost.disconnected",
  });
  const detail = reason || `code ${code}`;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[9999] flex justify-center px-4">
      <section className="pointer-events-auto flex w-full max-w-lg items-center gap-3 rounded-xl border border-card-border bg-card p-3 text-ui-xs shadow-lg">
        <span className="size-2 shrink-0 rounded-full bg-destructive" />
        <h1 className="font-medium">{title}</h1>
        {replaced ? null : <span className="truncate text-foreground-subtle">{detail}</span>}
        {showReconnect ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto shrink-0 enabled:cursor-pointer"
            onClick={() => {
              window.location.reload();
            }}
          >
            {intl.formatMessage({ id: "webConnectionLost.reconnect" })}
          </Button>
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
  createRoot(container).render(
    // 提示渲染在 Root 之外，需要自己套一层 intl provider 才能取到与 App 同源的文案。
    <ZCodeIntlProvider>
      <WebConnectionLostNotice code={event.code} reason={event.reason} />
    </ZCodeIntlProvider>,
  );
}

/** 产物过期提示的挂载点 id（独立于 `root`，与断线提示同一套"不卸载界面"的理由）。 */
const WEB_BUNDLE_STALE_NOTICE_ID = "zcode-web-bundle-stale-notice";
/** 关闭记录（sessionStorage）：同一组不一致在本标签页内只提示一次。 */
const WEB_BUNDLE_STALE_DISMISS_KEY = "zcode-web-bundle-stale-dismissed";

/**
 * 中继托管的 web 产物与桌面 Host 不是同一次构建时的提示（docs/spec/web-remote-ui-parity.md §7）。
 *
 * 为什么必须**可见**而不是只记日志：这条不一致的症状是"同一个页面两侧长得不一样"，
 * 用户的第一反应是 UI bug（2026-10-09 的「提示词页面不一致」就是这样查了半天）。
 * 一条能指出"产物过期、请重新部署"的提示，比任何日志都省事。
 *
 * 非阻塞、可关闭：产物过期是持续状态，常驻横幅会一直占位；关掉后本标签页不再提示，
 * 换一组不一致（重新构建/重新部署后）会重新提示。
 */
function WebBundleStaleNotice({
  notice,
  onDismiss,
}: {
  notice: RelayBundleFreshnessNotice;
  onDismiss: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[9998] flex justify-center px-4">
      <section className="pointer-events-auto flex w-full max-w-xl items-start gap-3 rounded-xl border border-card-border bg-card p-3 text-ui-xs shadow-lg">
        <span className="mt-1 size-2 shrink-0 rounded-full bg-warning" />
        <p className="min-w-0 flex-1 leading-5">
          {notice.kind === "commit-mismatch"
            ? intl.formatMessage(
                { id: "webBundleStale.commit" },
                { bundleCommit: notice.bundleCommit, hostCommit: notice.hostCommit },
              )
            : intl.formatMessage(
                { id: "webBundleStale.version" },
                { bundleVersion: notice.bundleVersion, hostVersion: notice.hostVersion },
              )}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 enabled:cursor-pointer"
          onClick={onDismiss}
        >
          {intl.formatMessage({ id: "webBundleStale.dismiss" })}
        </Button>
      </section>
    </div>
  );
}

function showWebBundleStaleNotice(notice: RelayBundleFreshnessNotice): void {
  if (document.getElementById(WEB_BUNDLE_STALE_NOTICE_ID)) return;
  const key = relayBundleFreshnessNoticeKey(notice);
  try {
    if (sessionStorage.getItem(WEB_BUNDLE_STALE_DISMISS_KEY) === key) return;
  } catch {
    // 拿不到 sessionStorage（隐私模式等）时照常提示，只是关不掉记忆。
  }
  const container = document.createElement("div");
  container.id = WEB_BUNDLE_STALE_NOTICE_ID;
  document.body.append(container);
  const dismiss = () => {
    try {
      sessionStorage.setItem(WEB_BUNDLE_STALE_DISMISS_KEY, key);
    } catch {
      // 同上：写不进去也不影响关闭动作本身。
    }
    container.remove();
  };
  createRoot(container).render(
    <ZCodeIntlProvider>
      <WebBundleStaleNotice notice={notice} onDismiss={dismiss} />
    </ZCodeIntlProvider>,
  );
}

/**
 * 比对「本 bundle 的版本/提交」与「桌面 Host 上报的版本/提交」，必要时提示产物过期。
 *
 * fail-open：任何一侧缺信息都不提示（见 relayBundleFreshness 的判定顺序）。
 * 本地开发时两边版本号都是 package.json 的同一个值，所以真正起作用的是 commit 戳
 * ——这也是 `packages/web/vite.config.ts` 要给 `__ZCODE_COMMIT__` 补 git 回退的原因。
 */
function reportBundleFreshness(bootstrap: WebBootstrapResult): void {
  const notice = resolveRelayBundleFreshnessNotice(
    { version: ZCODE_VERSION, commit: ZCODE_COMMIT },
    { version: bootstrap.hostAppVersion, commit: bootstrap.hostBuildCommitId },
  );
  if (!notice) return;
  // 不额外打日志：`packages/web/src` 全目录没有日志出口（`@zcode/ui` 的 logger 不在
  // 公开导出面上），而提示本身已经把两个 commit 都写出来了，比一行 warn 更有用。
  showWebBundleStaleNotice(notice);
}

async function bootstrapWebApp() {
  const params = new URLSearchParams(window.location.search);
  let bootstrap: WebBootstrapResult;
  try {
    bootstrap = await resolveWebBootstrap();
  } catch (error) {
    renderWebRemoteControlFailure(
      error && typeof error === "object" && "reason" in error
        ? (error as WebRemoteControlFailure)
        : toWebRemoteControlFailure(
            "unexpected-error",
            error instanceof Error ? error.message : String(error),
          ),
    );
    return;
  }

  // 产物过期提示与连接是否成功无关：拿到 host-report 就先判定一次，
  // 这样即使随后 WS 连不上（桌面离线），用户也能知道"页面本身也是旧的"。
  reportBundleFreshness(bootstrap);

  const autoReconnect = params.get("autoReconnect") === "1";

  // 设置页深链（FR-B14「在完整界面查看/撤销权限规则」）：插件/外部链接带 `#settings=<id>`。
  // 只读 hash 不改写——fragment 里可能同时承载 E2EE 的 #k=，地址栏必须原样保留。
  const settingsDeepLink = readSettingsSectionFromLocationHash();

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
            initialSettingsDeepLink={
              settingsDeepLink.requested ? (settingsDeepLink.section ?? true) : undefined
            }
            restoreSession={bootstrap.restoreSession}
            allowOpenWorkspace={bootstrap.allowOpenWorkspace}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
            initialWorkspaceLoadingFallback={<WebInitialWorkspaceLoading />}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  } catch (error) {
    renderWebRemoteControlFailure(
      error && typeof error === "object" && "reason" in error
        ? (error as WebRemoteControlFailure)
        : toWebRemoteControlFailure(
            "unexpected-error",
            error instanceof Error ? error.message : String(error),
          ),
    );
  }
}

void bootstrapWebApp();
