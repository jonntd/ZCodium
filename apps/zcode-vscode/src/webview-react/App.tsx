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

import { useEffect, useState } from "react";
import { AppErrorBoundary, Root, ZCodeIntlProvider } from "@zcode/ui";
import type { IPlatformService } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
// 模块级 zustand 单例（Root 内部消费同一实例）：观察 activeTaskId 变化承接 P1-1.5 上报。
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { RuntimeRestartBanner } from "./banners/RuntimeRestartBanner";
import {
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
import type {
  SessionSwitchHostFramePayload,
  WorkspaceHostFramePayload,
} from "../host/hostFrameKinds";

/** 会话上报面（VscodePlatformService 插件扩展；host 白名单方法，P1-1.5 闭环 webview 半）。 */
export interface SessionReportingPort {
  notifySessionCreated?(sessionId: string, folder?: string): Promise<unknown>;
  notifySessionDeleted?(sessionId: string): Promise<{ sessionId: string; folders: string[] }>;
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

  // host workspace 帧：new-session（ZCodium: 新建会话）→ 回草稿态（重挂载 Root）。
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

  // capabilities 帧：只取两类横幅文案（Agent 运行时不兼容/二进制帧降级提示）。
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
          {capabilityHints?.unsupportedHint && (
            <div
              role="status"
              data-testid="capability-unsupported-hint"
              className="flex shrink-0 items-center gap-2 border-b border-card-border bg-card px-3 py-1.5 text-ui-xs text-warning"
            >
              {capabilityHints.unsupportedHint}
            </div>
          )}
          {capabilityHints?.binaryFrameHint && (
            <div
              role="status"
              data-testid="capability-binary-frame-hint"
              className="flex shrink-0 items-center gap-2 border-b border-card-border bg-card px-3 py-1.5 text-ui-xs text-foreground-subtle"
            >
              {capabilityHints.binaryFrameHint}
            </div>
          )}
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
