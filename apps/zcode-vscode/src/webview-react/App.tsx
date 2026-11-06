/**
 * Webview React 装配 — 聊天 UI 零自研（apps/zcodium-vscode PRD §4.4/§4.5 硬要求）。
 *
 * 插件只写两样东西：数据适配（services 经桥 RPC）与宿主桥接（回调映射到 VS Code 命令）；
 * 聊天面直接挂载 ui 包单 pane 入口 `V4ChatPane`（内部 SessionPane：时间线/工具卡/审批卡/
 * 思考块/ConversationComposer/草稿空态全部与桌面端同源）——「侧边栏应该长什么样」的答案
 * 就是「看 SessionPane 长什么样」（PRD §4.2）。
 *
 * Provider 栈 = apps/zcodium-vscode PRD §4.5.6 jsdom 探针验证的 12 层顺序（不可乱序）：
 *   ZCodeIntlProvider → LucideProvider → TooltipProvider → ServiceProvider → PlatformProvider
 *   → StoreProvider → TabStoreProvider → ProjectDirectoryProvider → DiffsWorkerPoolProvider
 *   → AssistantCodeCommentFeatureProvider → CodingPlanUpgradeDialogProvider
 *   → RemoteConnectionProgressProvider ─ V4ChatPane（内部自带 V4ConversationProvider）
 *
 * 与桌面端的唯一差异（PRD §4.2.2）：顶部壳按钮不渲染（VS Code 视图标题菜单已提供
 * 新建会话/重启/切换工作区）；打开文件/外链桥接 VS Code 命令；工作流/子代理/计划等
 * 右侧面板语义在侧栏宽度下降级 no-op（PRD §4.5.2）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { LucideProvider } from "lucide-react";
import {
  AppErrorBoundary,
  PlatformProvider,
  ServiceProvider,
  StoreProvider,
  ZCodeIntlProvider,
} from "@zcode/ui";
import type { IPlatformService } from "@zcode/shared";
// —— 桌面壳 Root.tsx Provider 清单（§4.5.1 表，缺一层 = 一次 Context 崩溃，均已实测）——
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ProjectDirectoryProvider } from "@/project-sidebar/index.js";
import { DiffsWorkerPoolProvider } from "@/root/DiffsWorkerPoolProvider.js";
import { AssistantCodeCommentFeatureProvider } from "@/AssistantCodeCommentFeatureProvider.js";
import { CodingPlanUpgradeDialogProvider } from "@/settings/CodingPlanUpgradeDialogProvider.js";
import { RemoteConnectionProgressProvider } from "@/remote-connection-flow/ui/RemoteConnectionProgress.js";
import { TabStoreProvider, useTabStore } from "@/store/TabStoreProvider.js";
import { isSettingsTab } from "@/store/tabStore.js";
import { SettingsPage } from "@/SettingsPage.js";
import { V4ChatPane } from "@/v4/V4ChatPane.js";
import type { MessageFileLinkTarget } from "@/components/ai-elements/message.js";
import { setMcpStorePlatform } from "@/store/mcpStore.js";
import { setDefaultFileDisplayBasePath } from "@/lib/fileDisplay.js";
import type { IServiceAccessor } from "@zcode/services";
import { RuntimeRestartBanner } from "./banners/RuntimeRestartBanner";
import {
  gatePaneCallbacksByCapability,
  projectCapabilitiesPayload,
  type CapabilityUiProjection,
} from "./capabilities";
import type { CapabilitiesHostFramePayload } from "../host/hostFrameKinds";
import {
  applyThemeClasses,
  followThemeFrames,
  type VscodeThemeKind,
} from "./themeBridge";
import { useRenderPaused } from "./lifecycle/visibility";
import { mapVscodeLanguage } from "./i18nSetup";
import type { HostFrameBus } from "./bridge/hostFrames";
import type { WorkspaceHostFramePayload } from "../host/hostFrameKinds";

/** 会话上报面（VscodePlatformService 插件扩展；host 白名单方法，P1-1.5 闭环 webview 半）。 */
export interface SessionReportingPort {
  notifySessionCreated?(sessionId: string, folder?: string): Promise<unknown>;
  notifySessionDeleted?(sessionId: string): Promise<unknown>;
}

export interface WebviewAppProps {
  platform: IPlatformService;
  services: IServiceAccessor;
  /** VS Code 初始主题（ColorThemeKind）；挂载前同步一次，运行时经 host theme 帧跟随。 */
  themeKind: VscodeThemeKind;
  locale: string;
  workspacePath: string;
  /** globalState 恢复的最近会话（bootstrap data-session-id；无则草稿态）。 */
  sessionId: string | null;
  /**
   * host 帧总线（主题/可见性/restart 帧源）。缺省从 VscodePlatformService.hostFrames
   * 读取（index.tsx 装配注入的总线），测试可显式传入内存总线。
   */
  hostFrames?: HostFrameBus | null;
  /** 活跃会话镜像（index.tsx 持有；插件内部状态，不回写对话区）。 */
  onActiveSessionChange?: (sessionId: string | null) => void;
}

export function App({
  platform,
  services,
  themeKind,
  locale,
  workspacePath,
  sessionId: initialSessionId,
  hostFrames,
  onActiveSessionChange,
}: WebviewAppProps) {
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);
  // React 接管前先同步一次主题 class（避免首帧闪白）；运行时跟随见 followThemeFrames。
  applyThemeClasses(themeKind, document);
  const frameBus = hostFrames ?? null;

  // 桌面壳 RootInner 的两处横切接线，插件装配同样需要：
  // 1) mcpStore 平台注入（MCP 设置面的本机目录语义走 platform 分流）；
  // 2) fileDisplay 默认 basePath 跟随激活 workspace（@ 引用/文件展示的相对路径化）。
  useEffect(() => {
    setMcpStorePlatform(platform);
    return () => {
      setMcpStorePlatform(null);
    };
  }, [platform]);
  useEffect(() => {
    setDefaultFileDisplayBasePath(workspacePath);
  }, [workspacePath]);

  // 主题运行时跟随：host theme 帧 → applyThemeClasses（订阅时以最近一帧同步一次）。
  useEffect(() => followThemeFrames(frameBus, document), [frameBus]);

  // host new-session 帧（ZCodium: 新建会话）→ 回草稿态（会话数据保留）。
  useEffect(() => {
    if (!frameBus) return;
    return frameBus.on<WorkspaceHostFramePayload>("workspace", (payload) => {
      if (payload.kind === "new-session") {
        setSessionId(null);
        onActiveSessionChange?.(null);
      }
    });
  }, [frameBus, onActiveSessionChange]);

  // 可见性双源 gate：host visibility 帧 + document.visibilitychange 任一隐藏即暂停。
  useRenderPaused(frameBus);

  // capabilities 投影消费（T07「接线后行为」+ FR-A13，closeout-2）：host capabilities 帧
  // → projectCapabilitiesPayload → (a) unsupportedHint/binaryFrameHint 内联真实渲染；
  // (b) showTerminalEntry 驱动 onOpenBackgroundBash 门控（ui 按回调缺席隐藏终端入口）；
  // (c) showNativeDialogEntry 落状态保留（pane 无原生对话框入口，见投影字段注释）。
  // HostFrameBus.on 对晚订阅回放最近一帧，重挂载不丢能力面。
  const [capabilityProjection, setCapabilityProjection] =
    useState<CapabilityUiProjection | null>(null);
  useEffect(() => {
    if (!frameBus) return;
    return frameBus.on<CapabilitiesHostFramePayload>(
      "capabilities",
      (payload) => {
        setCapabilityProjection(projectCapabilitiesPayload(payload));
      },
    );
  }, [frameBus]);

  // 会话恢复闭环 webview 半：创建/删除上报 → host 写 ExtensionStore（P1-1.5）。
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const handleSessionCreated = useCallback(
    (createdSessionId: string) => {
      setSessionId(createdSessionId);
      onActiveSessionChange?.(createdSessionId);
      void (platform as IPlatformService & SessionReportingPort)
        .notifySessionCreated?.(createdSessionId, workspacePath)
        .catch(() => {
          // 上报失败不阻塞本地选择态；host 侧 restore 仍按 store 旧值兜底。
        });
    },
    [platform, workspacePath, onActiveSessionChange],
  );
  const handleSessionDeleted = useCallback(() => {
    const deletedSessionId = sessionIdRef.current;
    setSessionId(null);
    onActiveSessionChange?.(null);
    if (deletedSessionId) {
      void (platform as IPlatformService & SessionReportingPort)
        .notifySessionDeleted?.(deletedSessionId)
        .catch(() => {
          // 同上：host 键清理失败不阻塞本地回草稿。
        });
    }
  }, [platform, onActiveSessionChange]);

  // —— 宿主桥接（PRD §4.5.2 回调映射；侧栏语义降级项 no-op，不伪造面板）——
  const handleOpenFileLink = useCallback(
    (target: MessageFileLinkTarget) => {
      // 行级 selection 桥接待 FR 细化；先落「打开文件」主语义（showTextDocument 白名单方法）。
      void (
        platform as IPlatformService & {
          showTextDocument?(path: string): Promise<boolean>;
        }
      )
        .showTextDocument?.(target.path)
        .catch(() => undefined);
    },
    [platform],
  );
  const handleOpenBrowserUrl = useCallback(
    (url: string) => {
      platform.openExternal(url);
    },
    [platform],
  );
  // 侧栏宽度不适合承载工作流/子代理/计划等右侧面板；PRD §4.5.2 口径 = 降级，不硬编。
  const noopCallback = useCallback(() => undefined, []);

  return (
    <AppErrorBoundary>
      {/* 12 层 Provider 栈顺序 = §4.5.6 探针验证序，外层到内层不可调换。 */}
      <ZCodeIntlProvider
        settingService={services.settingService}
        initialLocale={mapVscodeLanguage(locale)}
      >
        <LucideProvider strokeWidth={1.5}>
          <TooltipProvider>
            <ServiceProvider services={services}>
              <PlatformProvider platform={platform}>
                <StoreProvider broadcastService={services.broadcastService}>
                  <TabStoreProvider>
                    <ProjectDirectoryProvider isDesktop>
                      <DiffsWorkerPoolProvider>
                        <AssistantCodeCommentFeatureProvider>
                          <CodingPlanUpgradeDialogProvider>
                            <RemoteConnectionProgressProvider>
                              <PluginInner
                                frameBus={frameBus}
                                workspacePath={workspacePath}
                                sessionId={sessionId}
                                onSessionCreated={handleSessionCreated}
                                onSessionDeleted={handleSessionDeleted}
                                onOpenFileLink={handleOpenFileLink}
                                onOpenBrowserUrl={handleOpenBrowserUrl}
                                onDegrade={noopCallback}
                                capabilityProjection={capabilityProjection}
                              />
                            </RemoteConnectionProgressProvider>
                          </CodingPlanUpgradeDialogProvider>
                        </AssistantCodeCommentFeatureProvider>
                      </DiffsWorkerPoolProvider>
                    </ProjectDirectoryProvider>
                  </TabStoreProvider>
                </StoreProvider>
              </PlatformProvider>
            </ServiceProvider>
          </TooltipProvider>
        </LucideProvider>
      </ZCodeIntlProvider>
    </AppErrorBoundary>
  );
}

function PluginInner({
  frameBus,
  workspacePath,
  sessionId,
  onSessionCreated,
  onSessionDeleted,
  onOpenFileLink,
  onOpenBrowserUrl,
  onDegrade,
  capabilityProjection,
}: {
  frameBus: HostFrameBus | null;
  workspacePath: string;
  sessionId: string | null;
  onSessionCreated: (sessionId: string) => void;
  onSessionDeleted: () => void;
  onOpenFileLink: (target: MessageFileLinkTarget) => void;
  onOpenBrowserUrl: (url: string) => void;
  onDegrade: () => void;
  /** capabilities 投影（App 消费帧后下传；null = 帧未到/暂时不可得，静默不诬告）。 */
  capabilityProjection: CapabilityUiProjection | null;
}) {
  // —— 最小 Tab 承载面 ——
  // composer 的「管理模型」等设置入口走 tabStore.openSettingsTab()；桌面壳有 Tab 系统渲染
  // SettingsPage，webview 没有壳 → 必须在这里承接：激活 tab 是设置页就渲染 SettingsPage，
  // 否则渲染聊天（V4ChatPane）。「返回」= 关闭设置 tab，激活态回落聊天。
  const tabs = useTabStore((state) => state.tabs);
  const activeTabId = useTabStore((state) => state.activeTabId);
  const closeTab = useTabStore((state) => state.closeTab);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;
  const settingsActive = activeTab !== null && isSettingsTab(activeTab);
  const handleSettingsBack = useCallback(() => {
    if (activeTab) closeTab(activeTab.id);
  }, [activeTab, closeTab]);

  // 能力门控（T07 closeout-2）：showTerminalEntry=false → onOpenBackgroundBash 置空，
  // ui 侧按回调缺席隐藏终端入口（ConversationStatusPanel 条件渲染）；投影未就绪不门控。
  const paneCallbacks = gatePaneCallbacksByCapability(
    { onOpenBackgroundBash: onDegrade },
    capabilityProjection,
  );

  return (
    <div className="flex h-dvh min-h-dvh w-full flex-col bg-background text-foreground">
      <RuntimeRestartBanner
        frameSource={frameBus}
        onRetry={(failure) => onSessionCreated(failure.sessionId)}
      />
      {capabilityProjection?.unsupportedHint && (
        <div
          role="status"
          data-testid="capability-unsupported-hint"
          className="flex shrink-0 items-center gap-2 border-b border-card-border bg-card px-3 py-1.5 text-ui-xs text-warning"
        >
          {capabilityProjection.unsupportedHint}
        </div>
      )}
      {capabilityProjection?.binaryFrameHint && (
        <div
          role="status"
          data-testid="capability-binary-frame-hint"
          className="flex shrink-0 items-center gap-2 border-b border-card-border bg-card px-3 py-1.5 text-ui-xs text-foreground-subtle"
        >
          {capabilityProjection.binaryFrameHint}
        </div>
      )}
      <div className="min-h-0 flex-1">
        {settingsActive ? (
          <SettingsPage
            isDesktop
            captionWorkspacePath={workspacePath}
            onBack={handleSettingsBack}
          />
        ) : (
          <V4ChatPane
            workspacePath={workspacePath}
            isDesktop
            sessionId={sessionId}
            onSessionCreated={onSessionCreated}
            onSessionDeleted={onSessionDeleted}
            onOpenFileLink={onOpenFileLink}
            onOpenBrowserUrl={onOpenBrowserUrl}
            onOpenGitReview={onDegrade}
            onRefreshGit={onDegrade}
            onOpenAutomationsMain={onDegrade}
            onOpenCodeViewer={onDegrade}
            onAutoOpenAssistantPptx={onDegrade}
            onOpenBackgroundBash={paneCallbacks.onOpenBackgroundBash}
            onOpenSubagentSession={onDegrade}
            onOpenSubagentDirectory={onDegrade}
            onSyncSubagentSessionTabs={onDegrade}
            onOpenPlanDetail={onDegrade}
            onOpenWorkflowRun={onDegrade}
            onOpenWorkflowArtifact={onDegrade}
            onOpenWorkflowRunDirectory={onDegrade}
            onOpenWorkflowActorSession={onDegrade}
            onOpenWorkflowWorkspace={onDegrade}
          />
        )}
      </div>
    </div>
  );
}
