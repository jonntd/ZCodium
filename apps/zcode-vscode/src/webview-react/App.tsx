/**
 * Webview React 装配 — 与 full/server 形态**同一个**工作台组件树。
 *
 * 侧栏直接挂载 ui 包的桌面壳入口 `Root`（full 形态 packages/web 挂的就是它）：
 * 12 层 Provider 栈、tab 系统、会话/模型/diff/Git/子代理/工作流面板全部由 Root
 * 内部装配，UI 与功能行为和完整界面逐组件同源——「完全一致」由构造保证，不再有
 * V4ChatPane 单 pane 的降级回调面（onOpenGitReview 等 no-op 全部消失）。
 *
 * 插件只保留三样宿主桥接（web 入口同款包装：AppErrorBoundary + ZCodeIntlProvider）：
 * 1. 平台服务：VscodePlatformService（文件选择/showTextDocument/openExternal 走
 *    VS Code 原生，语义与桌面壳一致且更贴编辑器）；
 * 2. host 帧：theme/visibility/restart/capabilities 横幅 + 编辑器命令的
 *    composer-insert 注入（见 index.tsx，模块级 zustand store 直达 Root composer）；
 * 3. 会话恢复：P1-1.5 per-folder 最近会话 → Root initialTaskId（session-switch
 *    帧经重挂载精确 active）。
 */

import { useEffect, useRef, useState } from "react";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import { Button } from "@/components/ui/button.js";
import type { IPlatformService } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
// 模块级 zustand 单例（Root 内部消费同一实例）：观察 activeTaskId 变化承接 P1-1.5 上报。
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { useWorkspaceHeaderHintStore } from "@/store/workspaceHeaderHintStore.js";
import { RuntimeRestartBanner } from "./banners/RuntimeRestartBanner";
import { SessionTabBar } from "./SessionTabBar";
import {
  SESSION_TAB_ACTIVE_STORAGE_KEY,
  SESSION_TAB_DEFAULT_TITLE,
  SESSION_TAB_STORAGE_KEY,
  bindActiveSession,
  closeSessionTab,
  createSessionTab,
  parseStoredSessionTabs,
  reorderSessionTabs,
  toggleSessionTabPinned,
  type SessionTab,
} from "./sessionTabs";
import {
  headerHintFromCapabilities,
  projectCapabilitiesPayload,
  type CapabilityUiProjection,
} from "./capabilities";
import type { CapabilitiesHostFramePayload } from "../host/hostFrameKinds";
import {
  parseSessionTabsPayload,
  type SessionTabsHostFramePayload,
} from "../host/hostFrameKinds";
import {
  applyThemeClasses,
  followThemeFrames,
  type VscodeThemeKind,
} from "./themeBridge";
import { useRenderPaused } from "./lifecycle/visibility";
import { mapVscodeLanguage } from "./i18nSetup";
import type { HostFrameBus } from "./bridge/hostFrames";
import type {
  SessionSwitchHostFramePayload,
  WorkspaceHostFramePayload,
} from "../host/hostFrameKinds";

/** 会话上报面（VscodePlatformService 插件扩展；host 白名单方法，P1-1.5 闭环 webview 半）。 */
export interface SessionReportingPort {
  notifySessionCreated?(sessionId: string, folder?: string): Promise<unknown>;
  notifySessionDeleted?(sessionId: string): Promise<{ sessionId: string; folders: string[] }>;
}

/** 编辑器标签 UI 上报面（plat-evt notifyEditorTabUi；host 回写 WebviewPanel 标题）。 */
export interface EditorTabUiReportingPort {
  notifyEditorTabUi?(state: { title: string | null; busy: boolean }): void;
}

/** 会话标签共享上行面（plat-evt syncSessionTabs；host 持久化 + 中继给其他对话页）。 */
export interface SessionTabsSyncPort {
  syncSessionTabs?(tabs: unknown): void;
}

/** 空态历史入口上行面（plat-evt requestSessionPicker；host 复用 gode.pickSession 全链）。 */
export interface SessionPickerRequestPort {
  requestSessionPicker?(): void;
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
   * host 帧总线（主题/可见性/restart/workspace 帧源）。缺省从 VscodePlatformService.hostFrames
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
  // 会话镜像：Root 内部自管会话态，这里只跟随（上报 host 写 ExtensionStore，P1-1.5）。
  // 会话标签栏（Claude「Untitled」同款）：拖拽重排 / 锁定 / 新建关闭，
  // 与 Root 内部会话态解耦，仅通过 switchTarget.initialTaskId 驱动切换。
  const [tabState, setTabState] = useState<{
    tabs: SessionTab[];
    activeId: string | null;
  }>(() => {
    let stored: SessionTab[] = [];
    let storedActiveId: string | null = null;
    try {
      stored = parseStoredSessionTabs(localStorage.getItem(SESSION_TAB_STORAGE_KEY));
      const activeRaw = localStorage.getItem(SESSION_TAB_ACTIVE_STORAGE_KEY);
      storedActiveId = typeof activeRaw === "string" ? activeRaw : null;
    } catch {
      stored = []; // webview 禁用 storage 时降级为单标签
    }
    const base = stored.length > 0 ? stored : [createSessionTab(initialSessionId)];
    const tabs = base.map((tab, index) =>
      index === 0 && tab.sessionId === null && initialSessionId
        ? { ...tab, sessionId: initialSessionId }
        : tab,
    );
    // 选中态本地恢复：存的 id 仍在集合中才用，否则回落首个。
    const activeId =
      storedActiveId !== null && tabs.some((tab) => tab.id === storedActiveId)
        ? storedActiveId
        : (tabs[0]?.id ?? null);
    return { tabs, activeId };
  });
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);
  // session-switch / new-session 帧 → 变更 initialTaskId + 递增 key 重挂载 Root
  // （精确 active 指定会话/回草稿态）。Root 内部的正常会话创建/删除不改 key
  // （避免无谓重挂整个工作台）。
  const [switchTarget, setSwitchTarget] = useState<{
    taskId: string | null;
    seq: number;
  }>({ taskId: initialSessionId, seq: 0 });

  // React 接管前先同步一次主题 class（避免首帧闪白）；运行时跟随见 followThemeFrames。
  applyThemeClasses(themeKind, document);
  const frameBus = hostFrames ?? null;

  // 主题运行时跟随：host theme 帧 → applyThemeClasses（订阅时以最近一帧同步一次）。
  useEffect(() => followThemeFrames(frameBus, document), [frameBus]);

  // host workspace 帧：new-session（Gode: 新建会话）→ 回草稿态（重挂载 Root）。
  useEffect(() => {
    if (!frameBus) return;
    return frameBus.on<WorkspaceHostFramePayload>("workspace", (payload) => {
      if (payload.kind === "new-session") {
        setSessionId(null);
        onActiveSessionChange?.(null);
        setSwitchTarget((prev) => ({ taskId: null, seq: prev.seq + 1 }));
      }
    });
  }, [frameBus, onActiveSessionChange]);

  // session-switch 帧（zcagent.pickSession 历史会话命令）→ Root 重挂载到目标会话。
  useEffect(() => {
    if (!frameBus) return;
    return frameBus.on<SessionSwitchHostFramePayload>("session-switch", (payload) => {
      setSessionId(payload.sessionId);
      onActiveSessionChange?.(payload.sessionId);
      setSwitchTarget((prev) => ({
        taskId: payload.sessionId,
        seq: prev.seq + 1,
      }));
    });
  }, [frameBus, onActiveSessionChange]);

  // 可见性双源 gate：host visibility 帧 + document.visibilitychange 任一隐藏即暂停。
  useRenderPaused(frameBus);

  // capabilities 帧：只取两类提示文案（Agent 运行时不兼容/二进制帧降级提示）。
  // Root 自身的能力门控（终端入口等）由其内部按 platform/services 自行裁决。
  const [capabilityHints, setCapabilityHints] = useState<CapabilityUiProjection | null>(
    () => projectCapabilitiesPayload(undefined),
  );
  useEffect(() => {
    if (!frameBus) return;
    return frameBus.on<CapabilitiesHostFramePayload>("capabilities", (payload) => {
      setCapabilityHints(projectCapabilitiesPayload(payload));
    });
  }, [frameBus]);

  // 编辑器标签标题跟随（Claude Code 同款）：编辑器标签标题 = 活动会话的任务标题
  // （首条消息自动截取，agent 还会推送自动命名），Agent 运行中加忙态前缀；草稿态
  // 回默认标题。订阅模块级 session store，仅 title/busy 变化时上行（plat-evt 一次）。
  useEffect(() => {
    if (!workspacePath) return;
    const reporting = platform as EditorTabUiReportingPort;
    if (!reporting.notifyEditorTabUi) return;
    const store = useZCodeSessionStore;
    let prevKey: string | null = null;
    const send = (): void => {
      const ws = store.getState().getWorkspaceState(workspacePath);
      const taskId = ws.activeTaskId ?? null;
      const runtime = taskId != null ? ws.taskRuntimeByTaskId[taskId] : undefined;
      const busy =
        runtime?.status === "streaming" ||
        runtime?.status === "creating" ||
        runtime?.status === "restoring";
      const meta = taskId
        ? (ws.optimisticTaskListByTaskId[taskId] ??
          ws.taskListCache?.find((task) => task.taskId === taskId) ??
          null)
        : null;
      const next = { title: meta?.title ?? null, busy };
      const key = `${next.title ?? ""}|${String(next.busy)}`;
      if (key === prevKey) return;
      prevKey = key;
      reporting.notifyEditorTabUi?.(next);
    };
    send();
    return store.subscribe(send);
  }, [platform, workspacePath]);

  // composer 聚焦（Claude Code 同款）：webview 激活/窗口重新聚焦（切回对话页签、
  // 点开面板）时把焦点交给输入框，打开即可直接输入。走 store 的 requestComposerFocus
  // （递增 draftFocusVersion，复用 ConversationComposer 既有聚焦链路；幂等无害）。
  useEffect(() => {
    if (!workspacePath) return;
    const focusComposer = (): void => {
      if (document.visibilityState !== "visible") return;
      useZCodeSessionStore.getState().requestComposerFocus(workspacePath);
    };
    window.addEventListener("focus", focusComposer);
    document.addEventListener("visibilitychange", focusComposer);
    return () => {
      window.removeEventListener("focus", focusComposer);
      document.removeEventListener("visibilitychange", focusComposer);
    };
  }, [workspacePath]);

  // 顶栏状态提示（spec: workspace-header-status-hint）：横幅行并入 WorkspaceHeader
  // 单排后，capabilities 投影经 store 全量覆写进 header chip（null 即清除）。
  const setWorkspaceHeaderHint = useWorkspaceHeaderHintStore(
    (state) => state.setWorkspaceHeaderHint,
  );
  useEffect(() => {
    setWorkspaceHeaderHint(headerHintFromCapabilities(capabilityHints));
  }, [capabilityHints, setWorkspaceHeaderHint]);

  // 会话恢复闭环 webview 半（P1-1.5）：Root 不暴露会话回调，改为订阅模块级
  // zcodeSessionStore 的 activeTaskId（Root 内部会话切换都写它）→ 上报 host 写
  // ExtensionStore。创建/删除以外的工作区切换（无 taskId 变化）不触发上报。
  useEffect(() => {
    if (!workspacePath) return;
    const store = useZCodeSessionStore;
    let prev = store.getState().getWorkspaceState(workspacePath).activeTaskId ?? null;
    return store.subscribe((state) => {
      const next = state.getWorkspaceState(workspacePath).activeTaskId ?? null;
      if (next === prev) return;
      const removed = prev;
      prev = next;
      setSessionId(next);
      onActiveSessionChange?.(next);
      // Root 内部会话切换 / 草稿转正 → 回写当前标签绑定的 sessionId。
      setTabState((current) => {
        if (!current.activeId) return current;
        const bound = bindActiveSession(current.tabs, current.activeId, next);
        return bound === current.tabs ? current : { ...current, tabs: [...bound] };
      });
      const reporting = platform as IPlatformService & SessionReportingPort;
      if (next) {
        void reporting.notifySessionCreated?.(next, workspacePath).catch(() => {
          // 上报失败不阻塞本地选择态；host 侧 restore 仍按 store 旧值兜底。
        });
      } else if (removed) {
        void reporting.notifySessionDeleted?.(removed).catch(() => {
          // 同上：host 键清理失败不阻塞本地回草稿。
        });
      }
    });
  }, [platform, workspacePath, onActiveSessionChange]);

  // 标签顺序 / 锁定态持久化（不持久化会话内容；webview 重建后仍恢复标签骨架）。
  // 草稿标签（未绑定会话且未命名）不写入 localStorage——否则每开一个新标签就存
  // 一条空 Untitled，重开窗口恢复一排无意义草稿（旧实现曾堆积出 8 个空标签）。
  // 多页签共享：标签全集经 host 中继给其他对话页（各 webview localStorage 互相
  // 隔离，同步只能走 host 面）；JSON 快照比对抑制回声环（收到的帧先记快照再
  // 应用，应用触发的 effect 发现快照一致即不再上行）。
  const lastSyncedTabsJsonRef = useRef<string | null>(null);
  useEffect(() => {
    try {
      const persistable = tabState.tabs.filter(
        (tab) => tab.sessionId !== null || tab.title !== SESSION_TAB_DEFAULT_TITLE,
      );
      localStorage.setItem(SESSION_TAB_STORAGE_KEY, JSON.stringify(persistable));
      localStorage.setItem(SESSION_TAB_ACTIVE_STORAGE_KEY, tabState.activeId ?? "");
    } catch {
      // storage 不可用时仅当前生命周期有效
    }
    const syncJson = JSON.stringify(tabState.tabs);
    if (lastSyncedTabsJsonRef.current !== syncJson) {
      lastSyncedTabsJsonRef.current = syncJson;
      (platform as SessionTabsSyncPort).syncSessionTabs?.({ tabs: tabState.tabs });
    }
  }, [tabState.tabs, platform]);

  // session-tabs 帧（host 中继其他对话页的标签全集 / 晚启动补发）：与本地快照
  // 不一致才应用；本页新建、尚未进入共享列表的**草稿标签保留**（新页签从草稿态
  // 开始——应用共享列表不能把用户刚开的空白对话冲掉，保留后随下一次上行汇入
  // 共享列表）；activeId 仍在集合中则保留（各页选中态独立），否则回落首个。
  useEffect(() => {
    if (!frameBus) return;
    return frameBus.on<SessionTabsHostFramePayload>("session-tabs", (payload) => {
      const incoming = parseSessionTabsPayload(payload);
      if (incoming === null || incoming.length === 0) return;
      const incomingJson = JSON.stringify(incoming);
      if (incomingJson === lastSyncedTabsJsonRef.current) return;
      lastSyncedTabsJsonRef.current = incomingJson;
      setTabState((current) => {
        const incomingIds = new Set(incoming.map((tab) => tab.id));
        const localDrafts = current.tabs.filter(
          (tab) => tab.sessionId === null && !incomingIds.has(tab.id),
        );
        const merged =
          localDrafts.length > 0 ? [...incoming, ...localDrafts] : incoming;
        const mergedJson = JSON.stringify(merged);
        if (mergedJson === JSON.stringify(current.tabs)) return current;
        const activeId =
          current.activeId !== null && merged.some((tab) => tab.id === current.activeId)
            ? current.activeId
            : (merged[0]?.id ?? null);
        return { tabs: merged, activeId };
      });
    });
  }, [frameBus]);

  const switchToTab = (tab: SessionTab): void => {
    setSessionId(tab.sessionId);
    onActiveSessionChange?.(tab.sessionId);
    // 与 session-switch 帧同款路径：重挂载 Root 并精确 initialTaskId。
    setSwitchTarget((prev) => ({ taskId: tab.sessionId, seq: prev.seq + 1 }));
  };

  const handleSelectTab = (id: string): void => {
    const tab = tabState.tabs.find((candidate) => candidate.id === id);
    if (!tab || id === tabState.activeId) return;
    setTabState((current) => ({ ...current, activeId: id }));
    switchToTab(tab);
  };

  const handleNewTab = (): void => {
    const tab = createSessionTab();
    setTabState((current) => ({ tabs: [...current.tabs, tab], activeId: tab.id }));
    switchToTab(tab);
  };

  const handleCloseTab = (id: string): void => {
    const result = closeSessionTab(tabState.tabs, id);
    if (result.tabs.length === tabState.tabs.length) return; // 锁定标签不可关
    if (result.tabs.length === 0) {
      const fresh = createSessionTab();
      setTabState({ tabs: [fresh], activeId: fresh.id });
      switchToTab(fresh);
      return;
    }
    const closingActive = id === tabState.activeId;
    const nextActiveId = closingActive
      ? (result.nextActiveId ?? result.tabs[0]!.id)
      : tabState.activeId;
    setTabState({ tabs: result.tabs, activeId: nextActiveId });
    if (closingActive) {
      const next = result.tabs.find((candidate) => candidate.id === nextActiveId);
      if (next) switchToTab(next);
    }
  };

  const handleTogglePin = (id: string): void => {
    setTabState((current) => ({
      ...current,
      tabs: toggleSessionTabPinned(current.tabs, id),
    }));
  };

  const handleReorder = (fromId: string, toId: string): void => {
    setTabState((current) => {
      const next = reorderSessionTabs(current.tabs, fromId, toId);
      return next === current.tabs ? current : { ...current, tabs: [...next] };
    });
  };

  // 空态判定：活动页签尚未绑定会话（草稿态）。Root 内首条消息创建会话后
  // onActiveSessionChange 回写页签 → 立即消失，不会与进行中会话并存。
  const activeTab =
    tabState.tabs.find((tab) => tab.id === tabState.activeId) ?? null;
  const isDraftActive = activeTab !== null && activeTab.sessionId === null;

  return (
    <AppErrorBoundary>
      {/* 与 web 入口同款包装：AppErrorBoundary + ZCodeIntlProvider + Root。
          Root 内部自带 12 层 Provider 栈（Lucide/Tooltip/Service/Platform/Store/
          TabStore/ProjectDirectory/Diffs/CodeComment/CodingPlan/RemoteProgress），
          外层不得重复包裹（双重 Store 会产生两套互不相通的状态树）。 */}
      <ZCodeIntlProvider
        settingService={services.settingService}
        broadcastService={services.broadcastService}
        initialLocale={mapVscodeLanguage(locale)}
      >
        <div className="flex h-dvh min-h-dvh w-full flex-col bg-background text-foreground">
          <RuntimeRestartBanner
            frameSource={frameBus}
            onRetry={(failure) => {
              // 重试 = 失败会话重新 active（走 session-switch 同款重挂载 resume 路径）。
              setSessionId(failure.sessionId);
              onActiveSessionChange?.(failure.sessionId);
              setSwitchTarget((prev) => ({
                taskId: failure.sessionId,
                seq: prev.seq + 1,
              }));
            }}
          />
          {/* 能力提示横幅行已移除（spec: workspace-header-status-hint）：
              文案经 workspaceHeaderHintStore 并入 WorkspaceHeader 单排 chip。 */}
          {/* 会话标签栏仅在多会话时渲染：单会话时与外层 IDE 编辑器标签视觉重复。 */}
          {tabState.tabs.length > 1 ? (
            <SessionTabBar
              tabs={tabState.tabs}
              activeId={tabState.activeId}
              onSelect={handleSelectTab}
              onNew={handleNewTab}
              onClose={handleCloseTab}
              onTogglePin={handleTogglePin}
              onReorder={handleReorder}
            />
          ) : null}
          {/* 空态主按钮（Claude 同款 CTA）：草稿态下唯一显性的历史入口——
              编辑器 title 按钮在标签多/窗口窄时会被折叠，这里保底常显。
              非 draft（会话进行中）不渲染，避免与顶栏历史入口重复。 */}
          {isDraftActive ? (
            <div className="flex shrink-0 items-center justify-center gap-2 pb-0.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-foreground-subtle enabled:cursor-pointer"
                onClick={() => {
                  (platform as SessionPickerRequestPort).requestSessionPicker?.();
                }}
              >
                历史会话
              </Button>
            </div>
          ) : null}
          <div className="min-h-0 flex-1">
            <Root
              key={switchTarget.seq}
              services={services}
              platform={platform}
              initialWorkspaceAbsPath={workspacePath || undefined}
              initialTaskId={switchTarget.taskId ?? undefined}
              restoreSession={false}
              allowOpenWorkspace
              supportsEmbeddedBrowser={false}
              allowRemoteWorkspace={false}
            />
          </div>
        </div>
      </ZCodeIntlProvider>
    </AppErrorBoundary>
  );
}
