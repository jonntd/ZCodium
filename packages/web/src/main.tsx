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
  Button,
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
  setWebRemoteControlTerminalTransportState,
  useZCodeIntl,
  type Theme,
  type WebRemoteControlTerminalTransportState as UiWebRemoteControlTerminalTransportState,
} from "@zcode/ui";
import "@zcode/ui/styles.css";
import {
  connectViaProtocol,
  connectViaWebSocket,
  createAcknowledgedWebRemoteControlRelayProtocol,
} from "@zcode/client";
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
import { WebCallbackPage } from "./auth/WebCallbackPage.js";
import { WebLoginPage } from "./auth/WebLoginPage.js";
import { createWebAuthService } from "./auth/webAuthService.js";
import { WEB_ZAI_OAUTH_CONFIG, resolveWebAuthDevReturnTo } from "./auth/webZaiOAuthConfig.js";
import type {
  ServerRemoteInfo,
  WebRemoteControlAppPayload,
  WebRemoteControlExternalWorkspaceBridge,
  WebRemoteControlFailure,
  WebRemoteControlFailureReason,
  WebRemoteControlMobileNavigationIntent,
  WebRemoteControlPlatformMethod,
  WebRemoteControlPlatformMethodArgsMap,
  WebRemoteControlPlatformMethodResultMap,
  WebRemoteControlPlatformRequestPayload,
  WebRemoteControlPlatformResponsePayload,
  WebRemoteControlStatus,
  WebRemoteControlTaskTarget,
  WebRemoteControlWindowBootstrapResult,
  WebRemoteControlWorkspaceBridge,
  WebRemoteControlWorkspaceListResult,
  WebRemoteControlWorkspaceSwitchOptions,
} from "@zcode/shared";

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

type WebRemoteControlWorkspaceListUpdateListener = (
  result: WebRemoteControlWorkspaceListResult,
) => void;

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

function renderWebRemoteControlFailure(failure: WebRemoteControlFailure): void {
  root.render(
    <WebRemoteControlFailureScreen
      failure={failure}
      locale={resolveWebRemoteControlScreenLocale(navigator.language)}
      primaryActionLabel={
        failure.reason === "device-not-owned"
          ? isZhLocale()
            ? "切换账号"
            : "Switch account"
          : undefined
      }
      secondaryAction={
        isWebRemoteControlRoute()
          ? {
              label: isZhLocale() ? "选择其他设备" : "Choose another device",
              onClick: () => {
                void remoteEntry.chooseOtherDevice();
              },
            }
          : undefined
      }
      onReload={() => {
        if (failure.reason === "device-not-owned") void remoteEntry.switchAccount();
        else window.location.reload();
      }}
    />,
  );
}

function isWebOAuthCallback(params: URLSearchParams): boolean {
  return (
    isWebRemoteControlOAuthCallback(new URL(window.location.href)) ||
    (["/cn/share/callback", "/share/callback"].includes(window.location.pathname) &&
      params.has("state") &&
      // BigModel 的 authCode 要先进入回调页，才能由 provider 归一化为 code。
      (params.has("code") || params.has("authCode") || params.has("error")))
  );
}

function renderWebAuthCallbackPage(): void {
  document.title = "ZCode - Web Remote Control Sign In";
  // 区域登录的 state 来自服务端，回跳地址只记在 pending 里；必须在 handleCallback 取出前读取。
  const safeRetryTarget = webAuthService.resolveCallbackReturnTo(window.location.href);
  root.render(
    <WebCallbackPage
      authService={webAuthService}
      onSuccess={({ appReturnTo }) => {
        window.location.replace(appReturnTo ?? "/remote/v4");
      }}
      onRetry={() => {
        window.location.replace(safeRetryTarget ?? "/remote/v4");
      }}
    />,
  );
}


function renderWebLoginPage(): void {
  document.title = "ZCode - Web Remote Control Sign In";
  root.render(
    <WebLoginPage onLogin={(provider, signal) => remoteEntry.startLogin(provider, signal)} />,
  );
}


function isWebRemoteControlRoute(): boolean {
  return (
    matchesWebRemoteControlRoutePath(window.location.pathname, "/remote/v4") ||
    matchesWebRemoteControlRoutePath(
      window.location.pathname,
      resolveWebRemoteControlRoutePath(import.meta.env),
    )
  );
}

function createWebRemoteControlRequestId(prefix: string): string {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`}`;
}

function seedStableWebRemoteControlClientId(deviceSid: string): void {
  const storageKey = `zcode-web-remote-client-id:${deviceSid}`;
  try {
    const existing = globalThis.localStorage?.getItem(storageKey)?.trim();
    if (existing) {
      setStreamClientId(existing);
      return;
    }
    const nextId = globalThis.crypto?.randomUUID?.() ?? generateMobileDeviceFingerprint();
    globalThis.localStorage?.setItem(storageKey, nextId);
    setStreamClientId(nextId);
  } catch {
    // Bugfix: iOS private mode 等环境可能禁用 localStorage。
    // 这里保留前面注入的物理指纹 fallback，避免远控首屏因 clientId 持久化失败而中断。
    setStreamClientId(generateMobileDeviceFingerprint());
  }
}

function createUnsupportedHomeOnlyService<T extends object>(serviceName: string): T {
  return new Proxy(
    {},
    {
      get: (_target, property) => async () => {
        throw new Error(
          `${serviceName}.${String(property)} is not available before a Web remote control workspace bridge is connected.`,
        );
      },
    },
  ) as T;
}

const emptyHomeOnlyEvent = () => ({ dispose() {} });

function createEmptyHomeOnlyService<T extends object>(handlers: Record<string, ServiceMethod>): T {
  return new Proxy(handlers, {
    get: (target, property) => {
      if (typeof property !== "string") {
        return undefined;
      }
      if (target[property]) return target[property];
      // Bug 原因：bridge 服务由 ProxyChannel 生成，onDynamicXxx(arg) 同步返回 Event，onXxx 本身是 Event；
      // 这里曾把所有未列出成员都当 RPC 方法返回 Promise，手机 home 侧栏订阅任务事件时直接崩溃。
      // 按同一命名契约返回永不触发的空 Event，不再逐个补订阅兜底。
      if (/^onDynamic[A-Z]/.test(property)) return () => emptyHomeOnlyEvent;
      if (/^on[A-Z]/.test(property)) return emptyHomeOnlyEvent;
      return async () => undefined;
    },
  }) as T;
}

export function createHomeOnlyWebRemoteControlServices(): RootServices {
  const unsupported = (channel: string) => async () => {
    throw new Error(
      `${channel} is not available before a Web remote control workspace bridge is connected.`,
    );
  };
  const settingService: RootServices["settingService"] = {
    get: async () => ({
      recentProjects: [],
      locale: resolveWebRemoteControlScreenLocale(navigator.language),
    }),
    update: async () => {},
    updateDataBaseDir: async () => {},
    // 个性化指令编辑的是桌面 Host 的 ~/.zcode/AGENTS.md；未连接 bridge 前没有本机 Host，明确报错。
    getUserInstructions: unsupported("settingService.getUserInstructions"),
    saveUserInstructions: unsupported("settingService.saveUserInstructions"),
  };

  const emptyGitSummary = (workspacePath: string) => ({
    workspacePath,
    repoRoot: workspacePath,
    workspaceInRepoPath: ".",
    autoRefreshWatchPaths: [],
    branchName: null,
    trackingBranchName: null,
    headRefType: "branch" as const,
    ahead: 0,
    behind: 0,
    isDirty: false,
    isGitAvailable: false,
    isRepository: false,
  });
  // Bugfix: 手机端只有断开的远程 workspace 时，不能为了进入任务首页强行创建 bridge。
  // 这里提供只读/空结果服务，吸收 Root 首屏 OAuth、模型供应商、Git、技能等后台初始化，
  // 避免断连这种预期状态被误报成未处理异常；真正聊天能力仍需重连成功后切到 bridge services。
  const homeOnlyZCodeTaskService = createEmptyHomeOnlyService<RootServices["zcodeTaskService"]>({
    initialize: async () => ({ available: false }),
    releaseWorkspacePreparation: async () => {},
    checkCodexConnectivity: async () => ({ ok: true }),
    listTasks: async () => [],
    listPinnedTaskIds: async () => [],
    listPinnedTasks: async () => [],
    listTaskList: async () => ({ items: [], total: 0, hasMore: false }),
    getTaskTokenUsage: async (params: { taskId: string }) => ({
      sessionId: params.taskId,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      modelRequestCount: 0,
      modelErrorCount: 0,
      inputBaselineBySource: {},
    }),
    listArchivedTasks: async () => [],
    getTaskSnapshot: async () => null,
    getTaskSnapshotWithEtag: async () => ({ snapshot: null }),
    getTaskSnapshotBody: async () => null,
    getTaskSnapshotRef: async () => null,
    getTaskSnapshotToolCallsSlice: async () => null,
    getTaskMeta: async () => null,
  });
  return {
    fileService: {
      readdir: unsupported("fileService.readdir"),
      stat: unsupported("fileService.stat"),
      checkFilesExist: unsupported("fileService.checkFilesExist"),
      resolvePath: unsupported("fileService.resolvePath"),
      createDefaultWorkspace: unsupported("fileService.createDefaultWorkspace"),
      ensureConversationWorkspace: unsupported("fileService.ensureConversationWorkspace"),
      createScratchWorkspace: unsupported("fileService.createScratchWorkspace"),
      readTextFile: unsupported("fileService.readTextFile"),
      readMediaPreview: unsupported("fileService.readMediaPreview"),
      readFileRange: unsupported("fileService.readFileRange"),
      readBinaryPreview: unsupported("fileService.readBinaryPreview"),
      searchWorkspaceFiles: unsupported("fileService.searchWorkspaceFiles"),
      listWorkspaceFilesLength: unsupported("fileService.listWorkspaceFilesLength"),
      listWorkspaceFilesRange: unsupported("fileService.listWorkspaceFilesRange"),
      readWorkspaceFileSearchIgnore: unsupported("fileService.readWorkspaceFileSearchIgnore"),
      applyWorkspaceFileSearchIgnoreTransform: unsupported(
        "fileService.applyWorkspaceFileSearchIgnoreTransform",
      ),
      writeWorkspaceFileSearchIgnore: unsupported("fileService.writeWorkspaceFileSearchIgnore"),
      readDesignSourceFile: unsupported("fileService.readDesignSourceFile"),
      writeDesignSourceFile: unsupported("fileService.writeDesignSourceFile"),
    },
    mediaPreviewService:
      createUnsupportedHomeOnlyService<NonNullable<RootServices["mediaPreviewService"]>>(
        "mediaPreviewService",
      ),
    gitService: createEmptyHomeOnlyService<RootServices["gitService"]>({
      getRepositorySummary: async (params: { workspacePath: string }) =>
        emptyGitSummary(params.workspacePath),
      getWorkspaceRepositoryInfo: async () => ({ repositories: [] }),
      getLocalBranches: async () => ({ branches: [], currentBranch: null }),
      getChanges: async () => [],
      getIgnoredPaths: async () => [],
      getDiff: async () => ({ sections: [], files: [] }),
      getBranchComparison: async () => ({
        baseRef: null,
        headRef: null,
        comparisonLabel: null,
        changes: [],
      }),
      getIdentity: async () => ({
        userName: null,
        userEmail: null,
        nameSource: null,
        emailSource: null,
        scopeLabel: null,
      }),
      refresh: async () => ({ ok: true }),
    }),
    gitCheckpointService:
      createUnsupportedHomeOnlyService<RootServices["gitCheckpointService"]>(
        "gitCheckpointService",
      ),
    systemService: createUnsupportedHomeOnlyService<RootServices["systemService"]>("systemService"),
    terminalService:
      createUnsupportedHomeOnlyService<RootServices["terminalService"]>("terminalService"),
    settingService,
    credentialService: createEmptyHomeOnlyService<RootServices["credentialService"]>({
      load: async () => null,
    }),
    broadcastService: createEmptyHomeOnlyService<RootServices["broadcastService"]>({
      send: async () => {},
    }),
    zcodeTaskService: homeOnlyZCodeTaskService,
    zcodeAgentService: createEmptyHomeOnlyService<RootServices["zcodeAgentService"]>({
      initialize: async (params: { workspacePath: string; workspaceIdentity?: string }) => ({
        available: false,
        workspaceKey: params.workspaceIdentity?.trim() || params.workspacePath,
        reason: "ZCode agent service is not available before workspace bridge is connected.",
      }),
      disposeAll: () => {},
    }),
    zcodeSessionService: createEmptyHomeOnlyService<RootServices["zcodeSessionService"]>({
      initializeWorkspace: async (params: {
        workspacePath: string;
        workspaceIdentity?: string;
      }) => ({
        available: false,
        workspaceKey: params.workspaceIdentity?.trim() || params.workspacePath,
        reason: "ZCode session service is not available before workspace bridge is connected.",
      }),
    }),
    promptAttachmentTransferService: createEmptyHomeOnlyService<
      RootServices["promptAttachmentTransferService"]
    >({
      stage: unsupported("promptAttachmentTransferService.stage"),
      adopt: async () => {},
      cancel: async () => {},
      cleanup: async () => {},
    }),
    botsService: createUnsupportedHomeOnlyService<RootServices["botsService"]>("botsService"),
    fileWatcherService: createEmptyHomeOnlyService<RootServices["fileWatcherService"]>({
      watch: async () => ({ dispose: () => {} }),
    }),
    oauthService: createEmptyHomeOnlyService<RootServices["oauthService"]>({
      getProviders: async () => [],
      getActiveProvider: async () => null,
      restoreCachedSession: async () => null,
      restoreCachedSessionState: async () => ({ status: "signed-out" }),
      restoreSession: async () => null,
      refreshToken: async () => {},
      logout: async () => {},
      logoutAll: async () => {},
      cancelPending: async () => {},
    }),
    providerSettingsService: createEmptyHomeOnlyService<RootServices["providerSettingsService"]>({
      getView: async () => ({ revision: 0, providers: [] }),
      refresh: async () => ({ revision: 0, providers: [] }),
      testModelConnectivity: async () => ({ results: [] }),
    }),
    modelSelectionService: createEmptyHomeOnlyService<RootServices["modelSelectionService"]>({
      getView: async () => ({ revision: 0, providers: [] }),
    }),
    sourceServerWorkspaceService: createUnsupportedHomeOnlyService<
      RootServices["sourceServerWorkspaceService"]
    >("sourceServerWorkspaceService"),
    usageStatsService:
      createUnsupportedHomeOnlyService<RootServices["usageStatsService"]>("usageStatsService"),
    codingPlanSubscriptionService: createUnsupportedHomeOnlyService<
      RootServices["codingPlanSubscriptionService"]
    >("codingPlanSubscriptionService"),
    clientConfigService: createEmptyHomeOnlyService<RootServices["clientConfigService"]>({
      getSnapshot: async () => ({
        pluginStoreOrder: null,
        zsrcUrl: null,
        uiPluginRecommendations: [],
        draftModelMigration: null,
      }),
    }),
    // 手机 Web 未连接 shared-host attachment 时禁止直连 scenes HTTP；返回空配置保持首页可用。
    clientScenesService: createEmptyHomeOnlyService<RootServices["clientScenesService"]>({
      list: async () => ({ code: 0, msg: "", data: [] }),
    }),
    // 闲时任务仅桌面本地（D13）；web home-only 环境按不支持处理。
    offPeakTaskService:
      createUnsupportedHomeOnlyService<RootServices["offPeakTaskService"]>("offPeakTaskService"),
    highspeedCardService:
      createUnsupportedHomeOnlyService<RootServices["highspeedCardService"]>(
        "highspeedCardService",
      ),
    skillsService: createEmptyHomeOnlyService<RootServices["skillsService"]>({
      list: async () => ({
        skills: [],
        capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
        diagnostics: [],
      }),
      buildPromptContext: async ({ prompt }: { prompt: string }) => ({
        prompt,
        activatedSkillNames: [],
      }),
    }),
    skillSyncService:
      createUnsupportedHomeOnlyService<RootServices["skillSyncService"]>("skillSyncService"),
    mcpSyncService:
      createUnsupportedHomeOnlyService<RootServices["mcpSyncService"]>("mcpSyncService"),
    pluginSyncService:
      createUnsupportedHomeOnlyService<RootServices["pluginSyncService"]>("pluginSyncService"),
    userConfigSyncService:
      createUnsupportedHomeOnlyService<RootServices["userConfigSyncService"]>(
        "userConfigSyncService",
      ),
    pluginsService: createEmptyHomeOnlyService<RootServices["pluginsService"]>({
      list: async () => [],
    }),
    // M5 ③-3：设置页插件管理仅桌面/远控 bridge 可用，Web 首页 fallback 明确报不可用。
    pluginManagementService:
      createUnsupportedHomeOnlyService<RootServices["pluginManagementService"]>(
        "pluginManagementService",
      ),
    subagentsService: createEmptyHomeOnlyService<RootServices["subagentsService"]>({
      list: async () => ({ agents: [], capability: { supported: false } }),
    }),
    commandsService: createEmptyHomeOnlyService<RootServices["commandsService"]>({
      list: async () => ({
        commands: [],
        userCommands: [],
        pluginCommands: [],
        capability: { userScopeAvailable: false, userScopeReason: "desktop_only" },
      }),
      setCommandEnabled: async () => undefined,
    }),
    hooksService: createEmptyHomeOnlyService<RootServices["hooksService"]>({
      loadHooks: async () => ({ hooks: [], hooksEnabled: false }),
      saveHooks: async () => undefined,
    }),
    memoryService: createEmptyHomeOnlyService<RootServices["memoryService"]>({
      loadMemory: async () => ({ memory: null }),
      listProjectMemories: async () => [],
    }),
    outputStyleService: createEmptyHomeOnlyService<RootServices["outputStyleService"]>({
      listStyles: async () => ({ styles: [] }),
      getUserStylesDirectory: async () => ({ path: "" }),
    }),
    // Bugfix: feedbackService 成为统一服务接口后，Web 远控首页 fallback 也必须补齐。
    // 断开 bridge 时这里明确报不可用，避免类型通过但运行时误以为空反馈数据。
    feedbackService:
      createUnsupportedHomeOnlyService<RootServices["feedbackService"]>("feedbackService"),
    settingsSyncService:
      createUnsupportedHomeOnlyService<RootServices["settingsSyncService"]>("settingsSyncService"),
  };
}

function resolveExternalRelayWsUrl(): string {
  return resolveWebRemoteControlRelayWsUrl({ endpointOrigin: window.location.origin });
}

function isZhLocale(): boolean {
  return /^zh\b/i.test(navigator.language);
}

function renderWebRemoteControlLoading(
  state: WebRemoteControlTerminalTransportState,
  device: WebRemoteControlConnectingDevice,
): void {
  document.title = "ZCode - Web Remote Control";
  root.render(
    <WebRemoteControlLoadingScreen
      state={state}
      locale={resolveWebRemoteControlScreenLocale(navigator.language)}
      device={device}
    />,
  );
}

async function bootstrapExternalRelayWebRemoteControl(
  connection: WebRemoteControlEntryConnection,
): Promise<void> {
  if (connection.signal.aborted) return;
  const { params: relayParams, getToken } = connection;
  const terminalClientSessionId = createWebRemoteControlRequestId("terminal-page");
  seedStableWebRemoteControlClientId(relayParams.deviceSid);
  // 平台只是展示偏好：取本机按 MID 记住的记录，扫码直连的陌生设备显示通用电脑图标。
  const connectingDevice: WebRemoteControlConnectingDevice = {
    name: relayParams.deviceName,
    platform: relayParams.deviceMid
      ? readKnownDevices(webRemoteControlStorage).get(relayParams.deviceMid)?.platform
      : undefined,
  };
  // 只由入口 owner 负责取消连接并选设备；不能重启 start()，否则会自动连回最近设备。
  const deviceNavigation = {
    deviceName: relayParams.deviceName,
    devicePlatform: connectingDevice.platform,
    chooseOtherDevice: () => {
      if (!connection.signal.aborted) void remoteEntry.chooseOtherDevice();
    },
  };

  let bootstrapping = false;
  let ready = false;
  let terminated = false;
  let terminalTransportState: UiWebRemoteControlTerminalTransportState = "idle";
  let currentWorkspaceKey: string | undefined;
  let currentTaskId: string | undefined;
  let currentRecoveryId: string | undefined;
  let bridgeRecoveryRetryAttempt = 0;
  let bridgeRecoveryRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let nextBridgeGeneration = 0;
  const checkVersionOnRecovery = window.location.pathname.replace(/\/+$/, "") === "/remote/v4";
  let disposeVersionNotice: (() => void) | undefined;
  const versionGuard = createWebRemoteControlVersionGuard({
    requestBootstrap: () => requestBootstrap(),
    onAccepted: (result) => {
      if (terminalTransportState === "paired") taskViewPublisher.seed(result.mobileTaskViewEpoch);
    },
    getUrl: () => window.location.href,
    isPageReady: () => ready,
    navigate: (url) => window.location.replace(url),
    onMismatch: (version) => {
      disposeVersionNotice = showWebRemoteControlVersionNotice(version, () =>
        versionGuard.confirm(),
      );
    },
  });
  // 必须先于 Root 的全局捕获阶段快捷键注册；原生 modal 只能隔离背景元素，不能隔离 window listener。
  const blockVersionMismatchShortcuts = (event: KeyboardEvent) => {
    if (versionGuard.isBlocked()) event.stopImmediatePropagation();
  };
  window.addEventListener("keydown", blockVersionMismatchShortcuts, true);
  const disposeVersionInputGuard = () =>
    window.removeEventListener("keydown", blockVersionMismatchShortcuts, true);
  let activeRelayProtocol:
    | ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>
    | undefined;
  let pendingRelayProtocol: typeof activeRelayProtocol;
  let pendingBridgeAbort: AbortController | undefined;
  let activeBridgeServiceRegistration:
    | WebRemoteControlWorkspaceBridgeServiceRegistration
    | undefined;
  let sendMobileDiagnosticPayload:
    | ((payload: WebRemoteControlAppPayload & { zcode_type: "mobile-diagnostic" }) => void)
    | undefined;
  const workspaceListUpdateListeners = new Set<WebRemoteControlWorkspaceListUpdateListener>();

  const subscribeWorkspaceListUpdates = (listener: WebRemoteControlWorkspaceListUpdateListener) => {
    workspaceListUpdateListeners.add(listener);
    return () => {
      workspaceListUpdateListeners.delete(listener);
    };
  };

  const normalizeWorkspaceListResult = (
    result: WebRemoteControlWorkspaceListResult,
  ): WebRemoteControlWorkspaceListResult => ({
    ...result,
    activeWorkspaceKey: result.activeWorkspaceKey ?? currentWorkspaceKey,
    activeTaskId: result.activeTaskId ?? currentTaskId,
  });

  const applyWorkspaceListUpdated = (result: WebRemoteControlWorkspaceListResult) => {
    const normalized = normalizeWorkspaceListResult(result);
    for (const listener of workspaceListUpdateListeners) {
      listener(normalized);
    }
  };

  const sendMobileDiagnostic = (diagnostic: WebRemoteControlTerminalTransportDiagnostic) => {
    if (diagnostic.type === "socket-extensions") {
      return;
    }
    sendMobileDiagnosticPayload?.({
      zcode_type: "mobile-diagnostic",
      event: diagnostic.type,
      timestamp: diagnostic.timestamp,
      state: diagnostic.state,
      previousState: "previousState" in diagnostic ? diagnostic.previousState : undefined,
      pairStatus: "pairStatus" in diagnostic ? diagnostic.pairStatus : undefined,
      closeCode: "code" in diagnostic ? diagnostic.code : undefined,
      closeReason: "reason" in diagnostic ? diagnostic.reason : undefined,
      wasClean: "wasClean" in diagnostic ? diagnostic.wasClean : undefined,
      wasPaired: "wasPaired" in diagnostic ? diagnostic.wasPaired : undefined,
      visibilityState: diagnostic.visibilityState,
      online: diagnostic.online,
      hiddenDurationMs: diagnostic.hiddenDurationMs,
    });
  };

  const sendMobileFailureDiagnostic = (failure: WebRemoteControlFailure) => {
    sendMobileDiagnosticPayload?.({
      zcode_type: "mobile-diagnostic",
      event: "failure",
      timestamp: Date.now(),
      state: terminalTransportState,
      failureReason: failure.reason,
      failureMessage: failure.message,
      visibilityState: document.visibilityState,
      online: navigator.onLine,
    });
  };

  const mapBootstrapUnknownErrorToFailure = (error: unknown): WebRemoteControlFailure => {
    if (error && typeof error === "object" && "reason" in error) {
      return error as WebRemoteControlFailure;
    }
    if (
      error instanceof Error &&
      error.message === "Web remote control relay did not recover before timeout."
    ) {
      // Bugfix: 桌面端长时间休眠导致“假连接”时，手机端 recoverConnection 超时会先落入 unknown，
      // 随后 waiting timer 又触发 invalid-mobile，用户会看到前后冲突的两张错误页。
      // 这里把 recover 超时直接映射为 desktop-disconnected，并在失败后立即终止 transport，
      // 保证错误语义单一且稳定。
      return toWebRemoteControlFailure(
        "desktop-disconnected",
        "Desktop did not recover the Web remote control session in time.",
      );
    }
    return toWebRemoteControlFailure(
      "unexpected-error",
      error instanceof Error ? error.message : String(error),
    );
  };

  const disposeConnection = () => {
    if (terminated) return;
    terminated = true;
    if (bridgeRecoveryRetryTimer) clearTimeout(bridgeRecoveryRetryTimer);
    bridgeRecoveryRetryTimer = undefined;
    versionGuard.dispose();
    disposeVersionInputGuard();
    disposeVersionNotice?.();
    activeBridgeServiceRegistration?.dispose();
    activeBridgeServiceRegistration = undefined;
    activeRelayProtocol?.dispose();
    activeRelayProtocol = undefined;
    pendingBridgeAbort?.abort();
    pendingBridgeAbort = undefined;
    pendingRelayProtocol?.dispose();
    pendingRelayProtocol = undefined;
    requester.dispose();
    transport.dispose();
    lifecycle.dispose();
    window.removeEventListener("beforeunload", disposeConnection);
    connection.signal.removeEventListener("abort", disposeConnection);
  };

  const renderBootstrapFailure = (failure: WebRemoteControlFailure) => {
    if (terminated || versionGuard.isBlocked()) return;
    sendMobileFailureDiagnostic(failure);
    disposeConnection();
    connection.onFailure(failure);
  };

  const renderBootstrapError = (error: unknown) => {
    renderBootstrapFailure(mapBootstrapUnknownErrorToFailure(error));
  };

  let bootstrapPairedSession:
    | ((options?: { preferredWorkspaceKey?: string; preferredTaskId?: string }) => Promise<void>)
    | undefined;

  const isLifecycleRecoveryReason = (reason: string): boolean =>
    reason === "visible" || reason === "pageshow" || reason === "online" || reason === "resume";

  const clearBridgeRecoveryRetry = (): void => {
    if (bridgeRecoveryRetryTimer) clearTimeout(bridgeRecoveryRetryTimer);
    bridgeRecoveryRetryTimer = undefined;
    bridgeRecoveryRetryAttempt = 0;
  };

  const scheduleBridgeRecoveryRetry = (): void => {
    if (bridgeRecoveryRetryTimer || terminated || isPageUnloading || versionGuard.isBlocked())
      return;
    const delay = getWebRemoteControlBridgeRecoveryRetryDelay(bridgeRecoveryRetryAttempt);
    if (delay === null) {
      // Bug 原因：旧逻辑把有界重试的 null 当成静默停止，导致已 degraded 的 protocol
      // 和旧 React Root 永久残留。预算耗尽必须进入既有终态边界，统一释放 bridge 资源并提供手动重试。
      renderBootstrapFailure(
        createWebRemoteControlConnectionRecoveryTimeoutFailure(
          "Mobile connection did not rebuild the workspace bridge within the retry budget.",
        ),
      );
      return;
    }
    bridgeRecoveryRetryAttempt += 1;
    bridgeRecoveryRetryTimer = setTimeout(() => {
      bridgeRecoveryRetryTimer = undefined;
      void recoverVisibleSession("bridge-rebuild-retry");
    }, delay);
  };

  const recoverVisibleSession = createWebRemoteControlBridgeRecoveryRunner(async (reason) => {
    if (isPageUnloading || terminated || versionGuard.isBlocked()) {
      return;
    }
    const preferredWorkspaceKey = currentWorkspaceKey;
    const preferredTaskId = currentTaskId;
    const isBridgeRebuildRetry = reason === "bridge-rebuild-retry";
    if (!isBridgeRebuildRetry) {
      bridgeRecoveryRetryAttempt = 0;
      currentRecoveryId = createWebRemoteControlRequestId("recovery");
    } else {
      // 同一 degraded recovery flight 的 bridge open 每次换 bridge generation，但 recoveryId
      // 保持不变；这样迟到 response 仍能按 recovery 边界拒绝。
      currentRecoveryId ??= createWebRemoteControlRequestId("recovery");
    }
    let requiresBridgeRebuild =
      !isLifecycleRecoveryReason(reason) || activeRelayProtocol?.isDegraded() === true;
    if (requiresBridgeRebuild) {
      activeRelayProtocol?.markDegraded();
    }
    bootstrapping = true;
    let transportRecovered = false;
    try {
      if (!import.meta.env.PROD) {
        console.info("[web-remote-control] recover terminal session", {
          reason,
          recoveryId: currentRecoveryId,
          currentWorkspaceKey: preferredWorkspaceKey,
          currentTaskId: preferredTaskId,
        });
      }
      await transport.recoverConnection();
      transportRecovered = true;
      if (!requiresBridgeRebuild && activeRelayProtocol && !activeRelayProtocol.isDegraded()) {
        if (checkVersionOnRecovery) {
          try {
            await checkDesktopVersion();
          } catch (error) {
            // 校验等待期间失效的 bridge 仍须走下方 bootstrap；它会重新校验版本并沿用原错误处理。
            if (!activeRelayProtocol.isDegraded()) throw error;
          }
        }
        // Bugfix: 手机短暂切后台只会暂停 JS/心跳，不代表 shared-host bridge 已经失效。
        // 原逻辑每次回前台都重建 bridge 和 Root，导致用户看到“已配对，正在加载工作区…”闪回。
        // bridge 是否需要重建以 desktop 发来的 bridge-degraded 或本地 frame gap 为准，避免只按后台时长误判。
        // 版本校验是异步的，完成后必须重新读取 bridge 状态，避免丢失并发的降级事件。
        if (!activeRelayProtocol.isDegraded()) {
          currentRecoveryId = undefined;
          return;
        }
      }
      // 校验期间也可能收到失效通知；实际转入重建后，失败必须沿原预算重试，不能沿用起点的健康判断。
      requiresBridgeRebuild = true;
      await bootstrapPairedSession?.({
        preferredWorkspaceKey,
        preferredTaskId,
      });
      clearBridgeRecoveryRetry();
    } catch (error) {
      if (!import.meta.env.PROD) {
        console.warn(
          "[web-remote-control] terminal recover timed out, keeping current page for retry",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!terminated && !isPageUnloading && transportRecovered && requiresBridgeRebuild) {
        // Bug 原因：transport 已恢复但单次 bridge-open 失败时，旧逻辑只调用 transport
        // background recovery；旧 bridge 已 degraded，之后没有事件会再次发起 open。
        scheduleBridgeRecoveryRetry();
      } else if (!terminated && !isPageUnloading) {
        // Bugfix: 手机长时间切到后台后，recoverConnection 可能超过单次等待窗口。
        // 这不代表桌面端离线，也不应该卸载当前 React 页面；否则输入框草稿会被错误页打断。
        // 这里保留原页面和输入状态，继续让 transport 的重连状态机自动恢复。
        transport.recoverInBackground();
      }
    } finally {
      bootstrapping = false;
    }
  });

  renderWebRemoteControlLoading("connecting", connectingDevice);

  const taskViewPublisher = createWebRemoteControlTaskViewPublisher(
    (payload) => !terminated && !versionGuard.isBlocked() && transport.sendPayload(payload),
  );
  const transport = new WebRemoteControlTerminalTransport({
    relayWsUrl: resolveExternalRelayWsUrl(),
    deviceSid: relayParams.deviceSid,
    deviceMid: relayParams.deviceMid,
    appVersion: relayParams.appVersion,
    getToken,
    onRawTransportPayload: (payload) =>
      pendingRelayProtocol?.acceptPayload(payload) ||
      activeRelayProtocol?.acceptPayload(payload) ||
      false,
    onRawTransportFault: (reasonCode) => {
      pendingRelayProtocol?.markDegraded(reasonCode);
      activeRelayProtocol?.markDegraded(reasonCode);
    },
    onPayload: (payload) => {
      if (terminated) {
        return;
      }
      if (payload.zcode_type === "mobile-task-view-request") {
        taskViewPublisher.request(payload.epoch);
        return;
      }
      if (payload.zcode_type === "rpc-frame" || payload.zcode_type === "rpc-frame-ack") {
        if (!pendingRelayProtocol?.acceptPayload(payload))
          activeRelayProtocol?.acceptPayload(payload);
        return;
      }
      if (requester.acceptPayload(payload)) {
        return;
      }
      if (payload.zcode_type === "workspace-list-updated") {
        applyWorkspaceListUpdated(payload.result);
        return;
      }
      if (payload.zcode_type === "bridge-degraded") {
        acceptWebRemoteControlBridgeInvalidation(
          pendingRelayProtocol,
          payload.bridgeSessionId,
          payload.reason,
        );
        // 通知可能在后台丢失，桌面会重复补发；重复通知不能重置在途恢复与有界重试预算。
        acceptWebRemoteControlBridgeInvalidation(
          activeRelayProtocol,
          payload.bridgeSessionId,
          payload.reason,
        );
        return;
      }
      if (payload.zcode_type === "workspace-bridge-error") {
        if (
          pendingRelayProtocol &&
          payload.bridgeSessionId === pendingRelayProtocol.getBridgeSessionId()
        )
          pendingRelayProtocol.markDegraded(payload.reason);
        if (payload.bridgeSessionId === activeRelayProtocol?.getBridgeSessionId()) {
          // 失效通知不对应 pending request；先关闭 workspace RPC 门禁，让既有会话
          // 显示断线横幅并保留草稿，不能让旧 services 继续被当作 ready。
          activeBridgeServiceRegistration?.dispose();
          activeBridgeServiceRegistration = undefined;
          acceptWebRemoteControlBridgeInvalidation(
            activeRelayProtocol,
            payload.bridgeSessionId,
            payload.reason,
          );
        }
        return;
      }
      if (payload.zcode_type === "app-error") {
        renderBootstrapFailure(toWebRemoteControlFailure(payload.reason, payload.error));
      }
    },
    onStateChange: (state) => {
      if (terminated || versionGuard.isBlocked()) {
        return;
      }
      taskViewPublisher.transportStateChanged(state, terminalTransportState);
      terminalTransportState = state;
      if (state !== "paired") versionGuard.invalidate();
      setWebRemoteControlTerminalTransportState(state);
      if (!ready) {
        renderWebRemoteControlLoading(state, connectingDevice);
      }
      if (state !== "paired") {
        return;
      }
      connection.onPaired();
      // 已有校验操作自行跨重连消费一次重试；配对事件不能启动另一个恢复 owner。
      if (bootstrapping && pendingVersionCheck) return;
      // healthy bridge 与在途初始化都不能并发新建 bridge，但新配对仍必须检查桌面版本。
      if ((activeRelayProtocol && !activeRelayProtocol.isDegraded()) || bootstrapping) {
        if (!checkVersionOnRecovery) return;
        void checkDesktopVersion().catch((error) => {
          // 版本读取失败沿用恢复链路，不卸载已挂载页面和草稿。
          if (!terminated && !versionGuard.isBlocked()) {
            void recoverVisibleSession("visible");
            if (!import.meta.env.PROD)
              console.warn("[web-remote-control] version check failed", error);
          }
        });
        return;
      }
      if (!bootstrapPairedSession) {
        return;
      }
      bootstrapping = true;
      void bootstrapPairedSession()
        .catch((error) => {
          renderBootstrapError(error);
        })
        .finally(() => {
          bootstrapping = false;
        });
    },
    onFailure: (failure) => {
      renderBootstrapFailure(failure);
    },
    onError: (error) => {
      if (!import.meta.env.PROD) {
        console.warn("[web-remote-control] terminal transport error", error.message);
      }
    },
    onDiagnostic: (diagnostic) => {
      if (!import.meta.env.PROD) {
        console.info("[web-remote-control] terminal diagnostic", diagnostic);
      }
      sendMobileDiagnostic(diagnostic);
    },
    onSendReady: () => {
      if (versionGuard.isBlocked()) return;
      taskViewPublisher.flush();
      replayWebRemoteControlWorkspaceBridgeFrames({ activeRelayProtocol, pendingRelayProtocol });
    },
    reloadPage: () => {
      window.location.reload();
    },
  });
  sendMobileDiagnosticPayload = (payload) => transport.sendPayload(payload);
  const requester = createWebRemoteControlAppPayloadRequester({
    sendPayload: (payload) => !versionGuard.isBlocked() && transport.sendPayload(payload),
  });

  const requestAppPayload = requester.requestAppPayload;
  const requestWithRelayRecovery = createWebRemoteControlRelayRequestRecovery(() =>
    transport.recoverConnection(),
  );

  const requestBootstrap = async (): Promise<WebRemoteControlWindowBootstrapResult> => {
    const requestId = createWebRemoteControlRequestId("bootstrap");
    const response = await requestAppPayload(
      { zcode_type: "bootstrap-request", requestId, terminalClientSessionId },
      (
        payload,
      ): payload is Extract<WebRemoteControlAppPayload, { zcode_type: "bootstrap-response" }> =>
        payload.zcode_type === "bootstrap-response" && payload.requestId === requestId,
    );
    return response.result;
  };

  let pendingVersionCheck: Promise<WebRemoteControlWindowBootstrapResult | undefined> | undefined;
  const checkDesktopVersion = (): Promise<WebRemoteControlWindowBootstrapResult | undefined> => {
    if (pendingVersionCheck) return pendingVersionCheck;
    const readCurrentVersion = async () => {
      let result = await versionGuard.check();
      // 配对变化可能发生在旧 bootstrap 等待期间；旧响应失效后在当前连接重新读取。
      while (
        !result &&
        !terminated &&
        !versionGuard.isBlocked() &&
        terminalTransportState === "paired"
      ) {
        result = await versionGuard.check();
      }
      return result;
    };
    const request = requestWithRelayRecovery(readCurrentVersion, { recoverTimeout: true }).finally(
      () => {
        if (pendingVersionCheck === request) pendingVersionCheck = undefined;
      },
    );
    pendingVersionCheck = request;
    return request;
  };

  const requestPlatformMethod = async <K extends WebRemoteControlPlatformMethod>(
    method: K,
    args?: WebRemoteControlPlatformMethodArgsMap[K],
  ): Promise<WebRemoteControlPlatformMethodResultMap[K]> => {
    const response = await requestWithRelayRecovery(() => {
      const requestId = createWebRemoteControlRequestId("platform");
      const request = {
        zcode_type: "platform-request",
        requestId,
        method,
        args,
      } as WebRemoteControlPlatformRequestPayload;
      return requestAppPayload(
        request,
        (
          payload,
        ): payload is Extract<
          WebRemoteControlPlatformResponsePayload,
          { zcode_type: "platform-response" }
        > =>
          payload.zcode_type === "platform-response" &&
          payload.requestId === requestId &&
          payload.method === method,
      );
    });
    const platformResponse = response as WebRemoteControlPlatformResponsePayload;
    if (!platformResponse.success) {
      throw new Error(platformResponse.error);
    }
    return platformResponse.result as WebRemoteControlPlatformMethodResultMap[K];
  };
  const listWorkspaces = async (): Promise<WebRemoteControlWorkspaceListResult> => {
    const requestWorkspaceList = async () => {
      const requestId = createWebRemoteControlRequestId("workspace-list");
      return requestAppPayload(
        { zcode_type: "workspace-list-request", requestId },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-list-response" }
        > => payload.zcode_type === "workspace-list-response" && payload.requestId === requestId,
      );
    };
    const response = await requestWithRelayRecovery(() => requestWorkspaceList(), {
      // Bugfix: 外部 relay 偶发只保留手机到 desktop 的单向通路，或请求发生在重连/suspect 窗口导致未发送。
      // 首页列表是幂等请求，失败后重建 terminal socket 并重试一次，比直接展示 0 个任务更稳。
      recoverTimeout: true,
    });
    return normalizeWorkspaceListResult(response.result);
  };

  const updateMobileViewState = async (workspaceKey: string, taskId?: string): Promise<void> => {
    currentWorkspaceKey = workspaceKey;
    currentTaskId = taskId;
    transport.sendPayload({
      zcode_type: "mobile-view-state-update",
      viewState: {
        activeWorkspaceKey: workspaceKey,
        ...(taskId ? { activeTaskId: taskId } : {}),
        updatedAt: Date.now(),
      },
      deviceInfo: collectWebRemoteControlMobileDeviceInfo({
        appVersion: relayParams.appVersion,
      }),
    });
  };

  const reconnectWorkspace = async (workspaceKey: string): Promise<void> => {
    const response = await requestWithRelayRecovery(() => {
      const requestId = createWebRemoteControlRequestId("workspace-reconnect");
      return requestAppPayload(
        {
          zcode_type: "workspace-reconnect-request",
          requestId,
          workspaceKey,
        },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-reconnect-response" }
        > =>
          payload.zcode_type === "workspace-reconnect-response" &&
          payload.requestId === requestId &&
          payload.workspaceKey === workspaceKey,
        {
          // 远程重连会启动或部署 host，Docker/SSH 首连可能超过默认 10 秒；这里放宽等待，避免桌面端成功后手机端先误报超时。
          timeoutMs: WEB_REMOTE_CONTROL_WORKSPACE_RECONNECT_TIMEOUT_MS,
        },
      );
    });
    if (!response.success) {
      throw new Error(response.error);
    }
    if (workspaceKey === currentWorkspaceKey && activeRelayProtocol?.isDegraded()) {
      await recoverVisibleSession(
        "workspace-reconnected",
        () => workspaceKey === currentWorkspaceKey && activeRelayProtocol?.isDegraded() === true,
      );
    }
  };

  const openWorkspaceBridge = async (
    workspaceKey: string,
    options?: WebRemoteControlWorkspaceSwitchOptions & {
      project?: Extract<
        WebRemoteControlAppPayload,
        { zcode_type: "workspace-bridge-open" }
      >["project"];
    },
  ): Promise<{
    bridge: WebRemoteControlExternalWorkspaceBridge;
    services: Awaited<ReturnType<typeof connectViaProtocol>>;
    relayProtocol: ReturnType<typeof createAcknowledgedWebRemoteControlRelayProtocol>;
  }> => {
    const bridgeSessionId = createWebRemoteControlRequestId("bridge");
    const bridgeGeneration = ++nextBridgeGeneration;
    pendingBridgeAbort?.abort();
    const bridgeAbort = new AbortController();
    pendingBridgeAbort = bridgeAbort;
    const isCurrent = () =>
      !terminated && !versionGuard.isBlocked() && bridgeGeneration === nextBridgeGeneration;
    const response = await requestWithRelayRecovery(() =>
      requestAppPayload(
        {
          zcode_type: "workspace-bridge-open",
          terminalClientSessionId,
          requestId: createWebRemoteControlRequestId("workspace-bridge"),
          bridgeSessionId,
          bridgeGeneration,
          ...(currentRecoveryId ? { recoveryId: currentRecoveryId } : {}),
          workspaceKey,
          ...(options?.taskId ? { taskId: options.taskId } : {}),
          ...(options?.taskHostId ? { taskHostId: options.taskHostId } : {}),
          ...(options?.fileTreeTaskId ? { fileTreeTaskId: options.fileTreeTaskId } : {}),
          ...(options?.project ? { project: options.project } : {}),
        },
        (
          payload,
        ): payload is Extract<
          WebRemoteControlAppPayload,
          { zcode_type: "workspace-bridge-ready" }
        > =>
          payload.zcode_type === "workspace-bridge-ready" &&
          payload.bridgeSessionId === bridgeSessionId,
      ),
    );
    if (!isCurrent() || bridgeAbort.signal.aborted) {
      throw new Error("Web remote control version changed before the workspace bridge was ready.");
    }
    currentRecoveryId = undefined;
    const relayProtocol = createAcknowledgedWebRemoteControlRelayProtocol({
      bridgeSessionId: response.bridge.bridgeSessionId,
      bridgeGeneration: response.bridge.bridgeGeneration,
      recoveryId: response.bridge.recoveryId,
      measureFrameBytes: (frame) => transport.measurePayloadBytes(frame),
      sendFrame: (frame) => {
        if (versionGuard.isBlocked()) return false;
        const result = transport.sendPayloadResult(frame);
        if (result.kind === "oversize") {
          throw new Error("remote.rpcFrame.envelopeTooLarge");
        }
        return result.kind === "sent";
      },
    });
    relayProtocol.onDegraded((fault) => {
      if (activeRelayProtocol !== relayProtocol) return;
      if (!import.meta.env.PROD) {
        console.warn("[web-remote-control] raw relay bridge degraded", {
          bridgeSessionId: relayProtocol.getBridgeSessionId(),
          reasonCode: fault.reasonCode,
        });
      }
      void recoverVisibleSession(fault.reasonCode);
    });
    const services = await connectWebRemoteControlWorkspaceBridgeServices({
      relayProtocol,
      windowProjectDirectory:
        response.bridge.kind === "remote" &&
        response.bridge.capabilities?.windowProjectDirectory === true,
      activateTransport: () => {
        // 能力 RPC 必须先有收帧目标；服务与 Root 仍等就绪后才切换。
        pendingRelayProtocol = relayProtocol;
        return () => {
          if (pendingRelayProtocol === relayProtocol) pendingRelayProtocol = undefined;
        };
      },
      isCurrent,
      signal: bridgeAbort.signal,
    });
    const bridgeServiceRegistration = registerWebRemoteControlWorkspaceBridgeServices({
      bridge: response.bridge,
      services,
    });
    // 已读写入是打开 task 的伴随动作，不等待它完成，避免慢磁盘/远程 IO 阻塞 bridge 切换。
    void markOpenedWebRemoteControlBridgeTaskRead({
      bridge: response.bridge,
      expectedUnreadAt: options?.markTaskReadExpectedUnreadAt,
      services,
    });
    const previousRelayProtocol = activeRelayProtocol;
    const previousBridgeServiceRegistration = activeBridgeServiceRegistration;
    activeRelayProtocol = relayProtocol;
    taskViewPublisher.setBridge(response.bridge);
    if (pendingRelayProtocol === relayProtocol) pendingRelayProtocol = undefined;
    if (pendingBridgeAbort === bridgeAbort) pendingBridgeAbort = undefined;
    activeBridgeServiceRegistration = bridgeServiceRegistration;
    previousRelayProtocol?.dispose();
    previousBridgeServiceRegistration?.dispose();
    currentWorkspaceKey = response.bridge.workspaceKey;
    currentTaskId = response.bridge.initialTaskId;
    await updateMobileViewState(response.bridge.workspaceKey, response.bridge.initialTaskId);
    if (!isCurrent()) throw new Error("Workspace bridge request was superseded.");
    return { bridge: response.bridge, services, relayProtocol };
  };

  const renderExternalRelayRoot = (
    services: Awaited<ReturnType<typeof connectViaProtocol>>,
    bridge: WebRemoteControlExternalWorkspaceBridge,
    initialNavigationIntent?: WebRemoteControlMobileNavigationIntent,
    initialTaskDraft?: ComponentProps<typeof Root>["initialTaskDraft"],
    initialSidebarFileTreeOpen = false,
  ) => {
    if (terminated || versionGuard.isBlocked()) return;
    ready = true;
    document.title = "ZCode - Web Remote Control";
    root.render(
      <AppErrorBoundary key={bridge.bridgeSessionId}>
        <ZCodeIntlProvider
          settingService={services.settingService}
          broadcastService={services.broadcastService}
          preferSettingServiceLocale
        >
          <Root
            services={services}
            platform={createWebPlatform({
              externalWebRemoteControlProxy: {
                requestPlatformMethod,
                reportTelemetryEvent: (event) => {
                  const parsed = sessionCreateTelemetrySchema
                    .or(mobilePluginDiscoveryTelemetrySchema)
                    .safeParse(event);
                  if (parsed.success)
                    transport.sendPayload({ zcode_type: "telemetry-report", event: parsed.data });
                },
              },
            })}
            // Bug 原因：手机复用 Desktop Host 中已持久化的 Assistant row，但 Root 默认关闭
            // code-comment 投影，导致 replay hydration 暴露原始 directive。该开关只修正展示能力，
            // 不进入 relay、Host 或 replayable 状态。
            assistantCodeCommentCardsEnabled
            initialWorkspaceAbsPath={bridge.workspacePath}
            initialWorkspaceIdentity={
              bridge.kind === "remote" ? bridge.workspaceIdentity : undefined
            }
            initialTaskId={bridge.initialTaskId}
            initialTaskDraft={initialTaskDraft}
            composerClientNamespace={`mobile:${relayParams.deviceMid ?? relayParams.deviceSid}`}
            terminalOwnerId={bridge.terminalOwnerId}
            initialSidebarFileTreeOpen={initialSidebarFileTreeOpen}
            initialWebRemoteControlMobileNavigationIntent={initialNavigationIntent}
            webRemoteControlTerminalTransportState={terminalTransportState}
            initialWorkspaceLoadingFallback={
              <WebRemoteControlLoadingScreen
                state="paired"
                locale={resolveWebRemoteControlScreenLocale(navigator.language)}
                device={connectingDevice}
              />
            }
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              deviceNavigation,
              listWorkspaces,
              onWorkspaceListUpdated: subscribeWorkspaceListUpdates,
              openProjectDraft,
              switchWorkspace: async (workspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(workspaceKey, options);
                renderExternalRelayRoot(
                  result.services,
                  result.bridge,
                  initialNavigationIntent,
                  undefined,
                  Boolean(options?.fileTreeTaskId || options?.openFileManager),
                );
              },
              markTaskRead: (task) =>
                markCurrentWebRemoteControlBridgeTaskRead({
                  bridge,
                  services,
                  task,
                }),
              startDraft: async (workspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(workspaceKey, undefined);
                await updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              reconnectWorkspace,
              updateMobileViewState,
              updateMobileTaskView: async (view) => {
                taskViewPublisher.update(bridge, view);
              },
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  const openProjectDraft = async (
    request: NonNullable<ComponentProps<typeof Root>["initialTaskDraft"]>,
    navigation: "open" | "restore" = "open",
  ) => {
    const projectId = request.projectId ?? null;
    const pendingDraft =
      !projectId && (!request.hostId || request.hostId === "local")
        ? ensurePendingTaskDraft({
            clientNamespace: `mobile:${relayParams.deviceMid ?? relayParams.deviceSid}`,
            hostId: "local",
            projectId: null,
          })
        : null;
    const result = await openWorkspaceBridge(currentWorkspaceKey ?? "project-navigation", {
      project: {
        projectId,
        ...(request.hostId ? { hostId: request.hostId } : {}),
        ...(pendingDraft
          ? { draftId: pendingDraft.draftId, reuseDraft: Boolean(pendingDraft.workspacePath) }
          : {}),
      },
    });
    renderExternalRelayRoot(
      result.services,
      result.bridge,
      navigation === "open" ? "chat" : undefined,
      {
        ...request,
        projectId,
        ...(pendingDraft ? { draftId: pendingDraft.draftId } : {}),
      },
    );
  };

  const renderExternalRelayHomeOnlyRoot = async (
    workspaceKey: string,
    taskId?: string,
  ): Promise<void> => {
    if (terminated || versionGuard.isBlocked()) return;
    currentWorkspaceKey = workspaceKey;
    currentTaskId = taskId;
    await updateMobileViewState(workspaceKey, taskId);
    document.title = "ZCode - Web Remote Control";
    if (terminated || versionGuard.isBlocked()) return;
    // Bug 原因：staging 合并 a861a83cbc 丢了这里的 ready 标记，home-only 挂载后每次配对状态抖动
    // 都会被 onStateChange 当成首屏重渲染加载页，配对恢复后再整页重挂，引导与本地状态全部丢失。
    // 与 bridge Root 一致：Root 挂载后由其自身横幅展示断线状态。
    ready = true;
    root.render(
      <AppErrorBoundary key={`home-only-${workspaceKey}`}>
        <ZCodeIntlProvider>
          <Root
            composerClientNamespace={`mobile:${relayParams.deviceMid ?? relayParams.deviceSid}`}
            services={createHomeOnlyWebRemoteControlServices()}
            platform={createWebPlatform({
              externalWebRemoteControlProxy: {
                requestPlatformMethod,
                reportTelemetryEvent: (event) => {
                  const parsed = sessionCreateTelemetrySchema
                    .or(mobilePluginDiscoveryTelemetrySchema)
                    .safeParse(event);
                  if (parsed.success)
                    transport.sendPayload({ zcode_type: "telemetry-report", event: parsed.data });
                },
              },
            })}
            initialWorkspaceAbsPath={workspaceKey}
            initialTaskId={taskId}
            initialWebRemoteControlMobileNavigationIntent={undefined}
            webRemoteControlTerminalTransportState={terminalTransportState}
            initialWorkspaceLoadingFallback={
              <WebRemoteControlLoadingScreen
                state="paired"
                locale={resolveWebRemoteControlScreenLocale(navigator.language)}
                device={connectingDevice}
              />
            }
            restoreSession={false}
            allowOpenWorkspace={false}
            webRemoteControlWorkspaceSwitcher={{
              deviceNavigation,
              listWorkspaces: async () => ({
                ...(await listWorkspaces()),
                activeWorkspaceKey: currentWorkspaceKey,
                activeTaskId: currentTaskId,
              }),
              onWorkspaceListUpdated: subscribeWorkspaceListUpdates,
              openProjectDraft,
              switchWorkspace: async (nextWorkspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(nextWorkspaceKey, options);
                renderExternalRelayRoot(
                  result.services,
                  result.bridge,
                  initialNavigationIntent,
                  undefined,
                  Boolean(options?.fileTreeTaskId || options?.openFileManager),
                );
              },
              startDraft: async (nextWorkspaceKey, options) => {
                const initialNavigationIntent = options?.mobileNavigationIntent;
                const result = await openWorkspaceBridge(nextWorkspaceKey, undefined);
                await updateMobileViewState(result.bridge.workspaceKey);
                renderExternalRelayRoot(result.services, result.bridge, initialNavigationIntent);
              },
              reconnectWorkspace,
              updateMobileViewState,
            }}
            preferDirectoryBrowser
            supportsEmbeddedBrowser={false}
            allowRemoteWorkspace={false}
          />
        </ZCodeIntlProvider>
      </AppErrorBoundary>,
    );
  };

  bootstrapPairedSession = async (options?: {
    preferredWorkspaceKey?: string;
    preferredTaskId?: string;
  }) => {
    const bootstrapResult = await checkDesktopVersion();
    if (!bootstrapResult || terminated || versionGuard.isBlocked()) return;
    const savedView = options?.preferredWorkspaceKey
      ? { activeWorkspaceKey: options.preferredWorkspaceKey, activeTaskId: options.preferredTaskId }
      : bootstrapResult.mobileViewState;
    const savedScope =
      savedView?.activeWorkspaceKey && !savedView.activeTaskId
        ? readComposerWorkspaceScope(
            savedView.activeWorkspaceKey,
            undefined,
            `mobile:${relayParams.deviceMid ?? relayParams.deviceSid}`,
          )
        : undefined;
    const pendingDraft = savedScope?.projectId === null ? readPendingTaskDraft(savedScope) : null;
    if (
      savedView &&
      !savedView.activeTaskId &&
      pendingDraft?.workspacePath &&
      savedView.activeWorkspaceKey === pendingDraft.workspacePath
    ) {
      // 刷新会释放旧 bridge，手机独有的草稿目录随之退出 workspace 候选。
      // 同时核对当前设备的作用域与 draftId，由 Host 重新校验目录；同目录的项目草稿不能误认领。
      await openProjectDraft({ projectId: null, hostId: "local" }, "restore");
      return;
    }
    const selectedWorkspace = resolveWebRemoteControlRecoveryTarget(bootstrapResult, options);
    if (!selectedWorkspace) {
      throw toWebRemoteControlFailure(
        "workspace-closed",
        "No opened desktop workspace is available for Web remote control.",
      );
    }
    if (!selectedWorkspace.canBridge) {
      // Source 断开后的 bootstrap 只确认离线，不替换当前 Root；内容与草稿仍由
      // 原会话 owner 持有。冷启动没有已加载 bridge，继续使用原 home-only 边界。
      if (activeRelayProtocol && selectedWorkspace.workspaceKey === currentWorkspaceKey) {
        activeBridgeServiceRegistration?.dispose();
        activeBridgeServiceRegistration = undefined;
        return;
      }
      await renderExternalRelayHomeOnlyRoot(
        selectedWorkspace.workspaceKey,
        selectedWorkspace.taskId,
      );
      return;
    }

    const result = await openWorkspaceBridge(selectedWorkspace.workspaceKey, {
      taskId: selectedWorkspace.taskId,
      taskHostId: selectedWorkspace.taskHostId,
    });
    renderExternalRelayRoot(result.services, result.bridge);
  };

  const lifecycle = createWebRemoteControlLifecycleRecovery({
    documentTarget: document,
    windowTarget: window,
    onSuspend: () => {
      // hidden/pagehide/freeze 后 JS 与 WebSocket 都可能暂停；先撤销查看，再关闭发送门。
      // 导航恢复位置保留，是否重建 bridge 仍由既有恢复流程决定。
      taskViewPublisher.suspend();
      transport.suspend();
    },
    onRecover: (reason) => {
      void recoverVisibleSession(reason);
    },
  });
  window.addEventListener("beforeunload", disposeConnection, { once: true });
  connection.signal.addEventListener("abort", disposeConnection, { once: true });
  transport.start();
}

async function bootstrapWebApp() {
  const params = new URLSearchParams(window.location.search);
  // v4.0.0 合并：先分发远控/OAuth 回调路由（远控经 relay 首页：登录→设备列表→配对），
  // 其余路径维持 fork 应用链路（E2EE bootstrap → 有界重试 → Root）。
  if (isWebRemoteControlRoute() || isWebRemoteControlOAuthCallback(new URL(window.location.href))) {
    document.documentElement.lang = resolveWebRemoteControlScreenLocale(navigator.language);
  }
  if (isWebOAuthCallback(params)) {
    renderWebAuthCallbackPage();
    return;
  }

  if (isWebRemoteControlRoute()) {
    await remoteEntry.start();
    return;
  }

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
    const platform = createWebPlatform();
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
