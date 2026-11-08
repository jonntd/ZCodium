/**
 * Webview 入口：acquireVsCodeApi → 桥建立 → React 装配树挂载。
 *
 * 启动序列：
 *  1. acquireVsCodeApi + 发送客户端身份帧（IPCServer ctx）；
 *  2. WebviewMessagePortLike（base64 shim）→ createMessagePortServiceConnection → services；
 *  3. PlatformRpcClient / HostFrameBus 挂到同一条 window message 流（t 字段分流）；
 *  4. notifyRendererReady → host 下发 theme/locale/workspace 初始帧；
 *  5. 读取 chatPanel 注入的初始值（workspace/theme/locale/sessionId）后挂载 App。
 *
 * UI 零自研（apps/zcodium-vscode PRD §4.2/§4.4）：App = 12 层 Provider 栈 + V4ChatPane；
 * 本文件只保留插件特有的装配件：选区 chip（P1-4 编辑器集成）、诊断注入（P1-5）、
 * workspace 帧跟随（folder 切换重绑对话区）。面板/顶栏等自拼 UI 已全部退役。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createMessagePortServiceConnection } from "@zcode/client";
import { parseBridgeEnvelope } from "../bridge/wire";
import type { IPlatformService } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { App } from "./App";
import { HostFrameBus } from "./bridge/hostFrames";
import { PlatformRpcClient } from "./bridge/platformRpcClient";
import {
  WebviewMessagePortLike,
  sendClientContext,
} from "./bridge/webviewMessagePort";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  applyWorkspaceSidebarVisibleFromHost,
  setWorkspaceSidebarVisibleReporter,
  setWorkspaceSidebarVisibleSeed,
} from "@/hooks/useAppPanels.js";
import { VscodePlatformService } from "./platform/vscodePlatformService";
import { mapVscodeLanguage } from "./i18nSetup";
import type { VscodeThemeKind } from "./themeBridge";
import { buildDiagnosticsInjection } from "./composer/injection";
import type {
  ComposerInsertHostFramePayload,
  DiagnosticsHostFramePayload,
  SessionSwitchHostFramePayload,
  WorkspaceHostFramePayload,
  WorkspaceSidebarVisibleHostFramePayload,
} from "../host/hostFrameKinds";

declare function acquireVsCodeApi(): {
  postMessage(message: unknown): void;
  getState(): Record<string, unknown>;
  setState(state: Record<string, unknown>): void;
};

interface BootstrapData {
  workspacePath: string;
  folders: string[];
  themeKind: VscodeThemeKind;
  locale: string;
  sessionId: string | null;
  /**
   * 侧栏显隐偏好（宿主 globalState 投影）：null = 从未设置过。
   * 必须由宿主注入——webview 的 localStorage 按 origin 隔离，跨页签读不到。
   */
  sidebarVisible: boolean | null;
}

function readBootstrapData(): BootstrapData {
  const script = document.getElementById(
    "zcode-bootstrap",
  ) as HTMLScriptElement | null;
  const data = script?.dataset;
  return {
    workspacePath: data?.workspacePath ?? "",
    folders: (data?.folders ?? "").split("\n").filter(Boolean),
    themeKind: (Number(data?.themeKind ?? "2") as VscodeThemeKind) || 2,
    locale:
      data?.locale ??
      (typeof navigator !== "undefined" ? navigator.language : "en"),
    sessionId: data?.sessionId ? data.sessionId : null,
    sidebarVisible:
      data?.sidebarVisible === "1"
        ? true
        : data?.sidebarVisible === "0"
          ? false
          : null,
  };
}

async function bootstrap(): Promise<void> {
  const vscode = acquireVsCodeApi();
  const bootstrapData = readBootstrapData();

  // 1. 客户端身份帧（IPCServer 协议首消息 = ctx）。
  sendClientContext(vscode);

  // 2. 桥 port + services 连接。
  const port = new WebviewMessagePortLike(vscode);
  const rpc = new PlatformRpcClient(vscode);
  const hostFrames = new HostFrameBus();
  // —— 桥层未知帧观测（永久保留、有界）：外部宿主（如 Antigravity 外壳）可能向 webview
  // iframe 注入自家消息；被三个消费者全部丢弃的非桥帧计数并回传 host 日志（每视图至多
  // 20 条），用于发现桥协议外的注入流量。健康环境零命中、零开销。 ——
  let unknownFrameCount = 0;
  const previewOf = (data: unknown): string => {
    try {
      const text = typeof data === "string" ? data : JSON.stringify(data);
      return (text ?? String(data)).slice(0, 240);
    } catch {
      return "[unserializable]";
    }
  };
  window.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    // t 字段分流：三个消费者各自只认自己的帧型。
    port.handleMessageData(data);
    rpc.handleMessageData(data);
    hostFrames.handleMessageData(data);
    // 探针：任何非桥帧（三家都不认）计数并上报前 20 条。
    if (parseBridgeEnvelope(data) === null && unknownFrameCount < 20) {
      unknownFrameCount += 1;
      vscode.postMessage({
        t: "plat-evt",
        event: "__debug-unknown-frame",
        payload: {
          n: unknownFrameCount,
          type: typeof data,
          ctor: (data as object | null)?.constructor?.name ?? null,
          preview: previewOf(data),
        },
      });
    }
  });
  vscode.postMessage({
    t: "plat-evt",
    event: "__debug-webview-ready",
    payload: { unknownFrameCount, ua: navigator.userAgent.slice(0, 120) },
  });

  const connection = createMessagePortServiceConnection(
    port as unknown as Parameters<typeof createMessagePortServiceConnection>[0],
  );

  // 3. 平台服务 + renderer 就绪信号（host 据此下发初始 host 帧）。
  const platformService = new VscodePlatformService({ rpc, hostFrames });
  platformService.notifyRendererReady();

  // 侧栏显隐偏好：宿主注入的种子（跨 webview 生效）与变更回传。
  // 必须**在首次渲染前**注入 seed，否则 useState 初值会先落到"默认收起"。
  setWorkspaceSidebarVisibleSeed(bootstrapData.sidebarVisible);
  setWorkspaceSidebarVisibleReporter((visible) =>
    platformService.notifyWorkspaceSidebarVisible(visible),
  );

  // 4. React 装配树（App 内先同步应用主题 class，避免首帧闪白）。
  const container = document.getElementById("app");
  if (!container) throw new Error("webview 缺少 #app 挂载点");
  const root = createRoot(container);
  root.render(
    <WebviewRoot
      platform={platformService}
      services={connection.services}
      hostFrames={hostFrames}
      themeKind={bootstrapData.themeKind}
      locale={bootstrapData.locale}
      workspacePath={bootstrapData.workspacePath}
      folders={bootstrapData.folders}
      sessionId={bootstrapData.sessionId}
    />,
  );
}

interface WebviewRootProps {
  platform: IPlatformService;
  services: IServiceAccessor;
  hostFrames: HostFrameBus;
  themeKind: VscodeThemeKind;
  locale: string;
  workspacePath: string;
  folders: string[];
  sessionId: string | null;
}

function WebviewRoot({
  platform,
  services,
  hostFrames,
  themeKind,
  locale,
  workspacePath: initialWorkspacePath,
  folders: initialFolders,
  sessionId: initialSessionId,
}: WebviewRootProps) {
  // 会话选择态镜像（App 内部亦有；此处供选区 chip 与诊断注入的 workspace 键）。
  const [sessionId, setSessionId] = useState<string | null>(initialSessionId);
  const [workspacePath, setWorkspacePath] = useState(initialWorkspacePath);
  const workspaceRef = useRef(workspacePath);
  workspaceRef.current = workspacePath;
  const foldersRef = useRef(initialFolders);
  foldersRef.current = initialFolders;

  // workspace 帧消费（形状唯一定义处 hostFrameKinds.WorkspaceHostFramePayload）：
  // - workspace-focused：switchWorkspace 命令聚焦 folder → 对话区重绑；
  // - workspace-changed：host 工作区 folders 变化 → 聚焦 folder 同步；
  // - new-session：由 App 消费回草稿态。
  useEffect(
    () =>
      hostFrames.on<WorkspaceHostFramePayload>("workspace", (payload) => {
        if (payload.kind === "workspace-focused") {
          setWorkspacePath(payload.folder);
        } else if (
          payload.kind === "workspace-changed" &&
          payload.activeFolder
        ) {
          setWorkspacePath(payload.activeFolder);
        }
      }),
    [hostFrames],
  );

  // 侧栏显隐偏好：宿主回推（同窗口其它页签改了抽屉）→ 本页跟随。
  // 与 bootstrap seed 的分工：seed 管"本页签首次渲染"，本帧管"已经开着的时候别人改了"。
  useEffect(
    () =>
      hostFrames.on<WorkspaceSidebarVisibleHostFramePayload>(
        "workspace-sidebar-visible",
        (payload) => {
          const visible = payload?.visible;
          if (typeof visible === "boolean") {
            applyWorkspaceSidebarVisibleFromHost(visible);
          }
        },
      ),
    [hostFrames],
  );

  // P1-5：diagnostics 帧（两档，host 已过滤）→ composer 预填。
  useEffect(
    () =>
      hostFrames.on<DiagnosticsHostFramePayload>("diagnostics", (payload) => {
        // requestComposerTextInsert 的 workspace 键取当前聚焦 folder（诊断来自活动编辑器）。
        const activeWorkspace = foldersRef.current.includes(
          workspaceRef.current,
        )
          ? workspaceRef.current
          : (foldersRef.current[0] ?? workspaceRef.current);
        // 增量审查 X6：顶部已静态 import 同一模块，此处原动态 import 是多余的
        // Promise 链（诊断帧每帧执行一次）——直接走静态引用。
        useZCodeSessionStore
          .getState()
          .requestComposerTextInsert(
            activeWorkspace,
            buildDiagnosticsInjection(payload),
          );
      }),
    [hostFrames],
  );

  // M1 编辑器功能：composer-insert 帧（终端送入/审阅改动/Code Action 等）→ composer 预填。
  // mention + prepend-if-missing = Claude Code/Augment 式干净上下文 pill（不覆盖草稿）。
  // 批量 mentions（spec: composer-insert-delivery）：多文件上下文单帧到达，避免单槽覆盖。
  useEffect(
    () =>
      hostFrames.on<ComposerInsertHostFramePayload>(
        "composer-insert",
        (payload) => {
          const activeWorkspace = foldersRef.current.includes(
            workspaceRef.current,
          )
            ? workspaceRef.current
            : (foldersRef.current[0] ?? workspaceRef.current);
          useZCodeSessionStore
            .getState()
            .requestComposerTextInsert(
              activeWorkspace,
              payload.text,
              undefined,
              payload.mention,
              payload.mode,
              payload.mentions,
            );
        },
      ),
    [hostFrames],
  );

  // M1 编辑器功能：session-switch 帧（历史会话命令）→ 重绑 sessionId（V4ChatPane resume）。
  useEffect(
    () =>
      hostFrames.on<SessionSwitchHostFramePayload>(
        "session-switch",
        (payload) => {
          setSessionId(payload.sessionId);
        },
      ),
    [hostFrames],
  );

  const handleActiveSessionChange = useCallback((next: string | null) => {
    setSessionId(next);
  }, []);

  // Root 自带选区侧聊/文件引用 UX，pane 特有的选区 chip 已随装配切换退役；
  // 编辑器命令（composer-insert/诊断注入）仍经模块级 store 直达 Root composer。
  return (
    <App
      platform={platform}
      services={services}
      themeKind={themeKind}
      locale={locale}
      workspacePath={workspacePath}
      sessionId={sessionId}
      hostFrames={hostFrames}
      onActiveSessionChange={handleActiveSessionChange}
    />
  );
}

void bootstrap();
