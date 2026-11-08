/**
 * HostRuntime — extension host 侧桥运行时（架构 §2.1/§2.3/T02）。
 *
 * 扮演桌面架构中 utilityProcess(host) 的角色：
 * - 持有 ServiceCollection（serviceAssembly 装配）并把白名单频道暴露到 IPCServer；
 * - 每个 webview 连接各建一个 HostBridgeProtocol（postMessage 伪装 IMessagePassingProtocol）；
 * - plat-* 帧分流到 PlatformRpcHandler（方法白名单）；
 * - host 帧（theme/locale/workspace/visibility）推送给 webview。
 *
 * 本类不 import vscode：sender/postMessage 以接口注入，vitest 用内存 sender 双端对打。
 */

import { Emitter, type Event } from "@zcode/rpc";
import { IPCServer, type ClientConnectionEvent } from "@zcode/rpc";
import {
  ServiceCollection,
  type ServiceExposurePolicy,
  IZCodeAgentService,
  IZCodeSessionService,
  IZCodeTaskService,
  IFileService,
  ISettingService,
  IBroadcastService,
  ISubagentsService,
} from "@zcode/services";
import type { BridgeEnvelope, HostFrame, HostFrameKind } from "../bridge/wire";
import { HostBridgeProtocol, type WebviewSender } from "./hostBridgeProtocol";
import {
  parseSessionTabsPayload,
} from "./hostFrameKinds";
import {
  PlatformRpcHandler,
  type PlatformMethodHandler,
} from "./platformRpcHandler";
import type { HostSettingsBridge } from "./hostSettingsBridge";

export interface HostHostFramePayloads {
  theme: unknown;
  locale: unknown;
  workspace: { folders: string[]; activeFolder: string | null };
  visibility: unknown;
}

export interface HostRuntimeOptions {
  services: ServiceCollection;
  exposurePolicy: ServiceExposurePolicy;
  platformMethods: ReadonlyMap<string, PlatformMethodHandler>;
  settingsBridge: HostSettingsBridge;
  /** 客户端身份（IPCServer ctx）；缺省 zcode-webview。 */
  clientContext?: string;
  /**
   * renderer 就绪 → 下发初始 host 帧（§2.2）。extension 层注入真实实现（读 vscode
   * API：theme.kind/locale/workspace 快照；visibility 由 chatPanel 变化事件生产）；
   * push 只投递到当前就绪的 webview 连接。缺省为空（不推送）。
   */
  sendInitialFrames?: (
    push: (kind: HostFrameKind, payload: unknown) => void,
  ) => void;
  /**
   * webview → host 的编辑器标签 UI 上行（plat-evt "notifyEditorTabUi"）：连接 id +
   * 已过桥层校验的原始载荷。extension 层据此回写对应 WebviewPanel 的标题
   * （会话标题 / 忙态前缀）；侧栏等非编辑器连接由消费方自行过滤。
   */
  onEditorTabUi?: (connectionId: string, payload: unknown) => void;
  /**
   * 会话标签共享态的持久化出口（webview 上行 syncSessionTabs 时写；读面用于
   * 晚启动连接补发）。extension 层注入 workspaceState 适配；缺省仅内存中继。
   */
  sessionTabsPersistence?: {
    read(): unknown;
    write(value: unknown): void;
  };
  /**
   * webview 空态「历史会话」主按钮上行（plat-evt requestSessionPicker）。
   * extension 层注入为执行 gode.pickSession 命令（含 session-switch 帧 + reveal 全链）。
   */
  onRequestSessionPicker?: () => void;
  /** 诊断出口。 */
  log?: (message: string) => void;
}

/** 当前连接的桥上下文（每 webview 一份）。 */
interface BridgeConnection {
  id: string;
  protocol: HostBridgeProtocol;
  sender: WebviewSender;
  platformRpc: PlatformRpcHandler;
  /** webview bootstrap 完成（notifyRendererReady 到达）后才接受直发帧。 */
  readyForFrames: boolean;
  /** 断开事件（detachWebview 时 fire，IPCServer 据此清理 ChannelServer/Client）。 */
  onDidDisconnect: Emitter<void>;
}

/** 无就绪 webview 时暂存 host 帧的上限（spec: composer-insert-delivery），超出丢最旧。 */
const HOST_FRAME_QUEUE_LIMIT = 32;

export class HostRuntime {
  private readonly connectionEvent = new Emitter<ClientConnectionEvent>();
  private readonly ipcServer: IPCServer<string>;
  private readonly connections = new Map<string, BridgeConnection>();
  /** 无就绪连接时暂存的 host 帧（有界 FIFO）；renderer ready 后按序 flush。 */
  private pendingHostFrames: HostFrame[] = [];
  /**
   * 最近活动的对话页连接 id（webview 每发一条消息即更新；新连接建立也视为活动）。
   * composer-insert / open-panel / diagnostics 等纯 UI 帧定向投递给它，避免
   * 广播把页面 A 的操作同步到所有页（多形态并存后的跨页状态污染）。
   */
  private lastActiveConnectionId: string | null = null;
  /** 最近一次 webview 上行的会话标签全集（syncSessionTabs 中继 + 晚启动补发）。 */
  private lastSessionTabs: unknown = null;
  private sessionTabsHydrated = false;
  private disposed = false;

  constructor(private readonly options: HostRuntimeOptions) {
    this.ipcServer = new IPCServer<string>(this.connectionEvent.event);
    // 白名单频道暴露到 IPCServer（IPCServer 实现 IChannelServer）。
    options.services.exposeOnChannelServer(
      this.ipcServer,
      new Map(),
      options.exposurePolicy,
    );
  }

  /** Agent 服务（runtimeController / 命令编排用）。 */
  get agentService() {
    return this.options.services.get(IZCodeAgentService);
  }

  /** webview 可见性变化 → host 帧推送（webview 隐藏时 UI 暂停渲染）。 */
  pushHostFrame(kind: HostFrameKind, payload: unknown): void {
    if (this.disposed) return;
    const frame: HostFrame = { t: "host", kind, payload };
    // webview 懒解析 + main.js 异步加载：ready 前的帧会投空（面板从未打开时命令链路
    // 全程静默）。无就绪连接时入队，等 renderer ready 后按序 flush（≤32，超出丢最旧）。
    const hasReadyConnection = [...this.connections.values()].some(
      (c) => c.readyForFrames,
    );
    if (!hasReadyConnection) {
      this.pendingHostFrames.push(frame);
      if (this.pendingHostFrames.length > HOST_FRAME_QUEUE_LIMIT) {
        this.pendingHostFrames.shift();
      }
      return;
    }
    for (const connection of this.connections.values()) {
      this.post(connection, frame);
    }
  }

  /**
   * 定向推送：host 帧只投给「最近活动的对话页」。多形态（侧栏 view + 编辑器
   * WebviewPanel）并存后，纯 UI 帧若走广播，页面 A 的操作会在页面 B 同步生效
   * （composer 双页预填、面板双页弹出）——这正是「点击一个按钮，所有页面跟着变」。
   * 兜底：最近活动连接不就绪 → 投给任一就绪连接；全部未就绪 → 入 pending 队列
   * （与广播同语义：命令先行、面板后开的场景，flush 时页面就是用户刚打开的那页）。
   */
  pushToActiveHostFrame(kind: HostFrameKind, payload: unknown): void {
    if (this.disposed) return;
    const frame: HostFrame = { t: "host", kind, payload };
    const ready = [...this.connections.values()].filter((c) => c.readyForFrames);
    if (ready.length === 0) {
      this.pendingHostFrames.push(frame);
      if (this.pendingHostFrames.length > HOST_FRAME_QUEUE_LIMIT) {
        this.pendingHostFrames.shift();
      }
      return;
    }
    const preferred = this.lastActiveConnectionId
      ? this.connections.get(this.lastActiveConnectionId)
      : undefined;
    // ready.length > 0 已在上方保证，兜底取最后一个就绪连接。
    const target =
      preferred && preferred.readyForFrames
        ? preferred
        : ready[ready.length - 1]!;
    this.post(target, frame);
  }

  /** chatPanel.resolveWebviewView 时调用：建立该 webview 的 RPC 连接。 */
  attachWebview(id: string, sender: WebviewSender): void {
    if (this.disposed) return;
    // 新连接 = 用户刚打开的对话页：后续 UI 定向帧优先投给它。
    this.lastActiveConnectionId = id;
    const platformRpc = new PlatformRpcHandler({
      methods: this.options.platformMethods,
      post: (frame) => this.postById(id, frame),
      warn: this.options.log,
    });
    const protocol = new HostBridgeProtocol(sender, (frame) => {
      this.handleBridgeFrame(id, platformRpc, frame);
    });
    const onDidDisconnect = new Emitter<void>();
    const connection: BridgeConnection = {
      id,
      protocol,
      sender,
      platformRpc,
      readyForFrames: false,
      onDidDisconnect,
    };
    this.connections.set(id, connection);

    // 连接事件交给 IPCServer：等首条消息（ctx）后建 ChannelServer/ChannelClient。
    this.connectionEvent.fire({
      protocol,
      onDidClientDisconnect: onDidDisconnect.event,
    });
    // webview dispose → 断开（ChannelServer/ChannelClient 清理由 IPCServer 完成）。
    void (sender as { onDidDispose?: Event<void> }).onDidDispose?.(() => {
      this.detachWebview(id);
    });
    this.options.log?.(`[host-bridge] webview 已连接：${id}`);
  }

  /** chatPanel.onDidDispose 时调用。 */
  detachWebview(id: string): void {
    const connection = this.connections.get(id);
    if (!connection) return;
    connection.protocol.dispose();
    connection.onDidDisconnect.fire();
    connection.onDidDisconnect.dispose();
    this.connections.delete(id);
    this.options.log?.(`[host-bridge] webview 断开：${id}`);
  }

  /** chatPanel 的 webview.onDidReceiveMessage 原样转发到这里。 */
  handleWebviewMessage(id: string, data: unknown): void {
    const connection = this.connections.get(id);
    if (!connection) return;
    // 任意 webview 消息 = 该页仍是用户当前交互面（UI 定向帧的投递依据）。
    this.lastActiveConnectionId = id;
    connection.protocol.handleRaw(data);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const id of [...this.connections.keys()]) this.detachWebview(id);
    this.ipcServer.dispose();
    this.connectionEvent.dispose();
  }

  private handleBridgeFrame(
    id: string,
    platformRpc: PlatformRpcHandler,
    frame: BridgeEnvelope,
  ): void {
    if (frame.t === "plat-req") {
      void platformRpc.handleRequest(frame.id, frame.method, frame.args);
      return;
    }
    if (frame.t === "plat-evt") {
      // webview → host 的平台事件（notifyRendererReady 等以 plat-evt 表达）。
      if (frame.event === "notifyRendererReady") {
        // 防御：webview reload 与 dispose 交错时，ready 帧可能迟到于 detach——
        // 连接已不存在则静默忽略（旧实现 get(id)! 非空断言会在此 TypeError）。
        const connection = this.connections.get(id);
        if (!connection) return;
        connection.readyForFrames = true;
        this.sendInitialHostFrames(id);
        this.flushPendingHostFrames();
        this.postSessionTabsTo(id);
        return;
      }
      // 编辑器标签 UI 上行（会话标题/忙态）→ 定向回写该连接的 WebviewPanel 标题。
      if (frame.event === "notifyEditorTabUi") {
        this.options.onEditorTabUi?.(id, frame.payload);
        return;
      }
      // 会话标签全集上行 → 持久化 + 中继给其他就绪连接（多页签共享，回声由
      // webview 侧 JSON 快照比对抑制）。
      if (frame.event === "syncSessionTabs") {
        this.syncSessionTabsFrom(id, frame.payload);
        return;
      }
      // 空态「历史会话」主按钮 → host 快捷选择器（复用 gode.pickSession 全链）。
      if (frame.event === "requestSessionPicker") {
        this.options.onRequestSessionPicker?.();
        return;
      }
      // 桥层未知帧观测（webview 探针回传；外部宿主注入流量哨兵，有界 20 条/视图）。
      if (frame.event.startsWith("__debug")) {
        this.options.log?.(
          `[host-bridge] ${frame.event}: ${JSON.stringify(frame.payload)?.slice(0, 600)}`,
        );
      }
      return;
    }
    // flow 帧 host 侧不背压；host 帧不会从 webview 发来。其余忽略并记日志。
    if (frame.t !== "rpc" && frame.t !== "flow") {
      this.options.log?.(`[host-bridge] 意外帧型：${frame.t}`);
    }
  }

  /** renderer 就绪：extension 层注入的初始帧实现（theme/locale/workspace 快照，§2.2）。 */
  private sendInitialHostFrames(id: string): void {
    this.options.sendInitialFrames?.((kind, payload) => {
      const frame: HostFrame = { t: "host", kind, payload };
      this.postById(id, frame);
    });
  }

  /**
   * webview 上行会话标签全集：宽松解析 → 持久化 → 广播给**其他**就绪连接
   * （发送方自己已持有该状态；webview 侧 JSON 快照比对天然抑制回声环）。
   * 载荷非法（解析为 null）整体丢弃——不中继半残数据。
   */
  private syncSessionTabsFrom(fromId: string, payload: unknown): void {
    const tabs = parseSessionTabsPayload(payload);
    if (tabs === null) {
      this.options.log?.(`[host-bridge] syncSessionTabs 载荷非法（来自 ${fromId}），已丢弃`);
      return;
    }
    this.lastSessionTabs = { tabs };
    if (!this.sessionTabsHydrated) this.sessionTabsHydrated = true;
    this.options.sessionTabsPersistence?.write(this.lastSessionTabs);
    const frame: HostFrame = { t: "host", kind: "session-tabs", payload: this.lastSessionTabs };
    for (const connection of this.connections.values()) {
      if (connection.id !== fromId && connection.readyForFrames) {
        this.post(connection, frame);
      }
    }
  }

  /** 晚启动（或重载）连接补发当前会话标签全集：内存中继优先，否则读持久化。 */
  private postSessionTabsTo(id: string): void {
    let payload = this.lastSessionTabs;
    if (payload === null && !this.sessionTabsHydrated) {
      payload = this.options.sessionTabsPersistence?.read() ?? null;
      if (payload !== null) this.lastSessionTabs = payload;
      this.sessionTabsHydrated = true;
    }
    if (payload === null) return;
    const frame: HostFrame = { t: "host", kind: "session-tabs", payload };
    this.postById(id, frame);
  }

  /**
   * renderer ready 后按序下发暂存帧。pending 帧本就是「无就绪连接时」的广播
   * 帧语义——flush 时投给**当前全部就绪连接**（旧实现只投第一个 ready 的连接，
   * 后开的页签永远收不到命令先行场景的暂存帧，如不回草稿）。
   */
  private flushPendingHostFrames(): void {
    if (this.pendingHostFrames.length === 0) return;
    const frames = this.pendingHostFrames;
    this.pendingHostFrames = [];
    for (const frame of frames) {
      for (const connection of this.connections.values()) {
        if (connection.readyForFrames) this.post(connection, frame);
      }
    }
    this.options.log?.(
      `[host-bridge] flush 暂存 host 帧 ${frames.length} 条 → ${this.connections.size} 个就绪连接`,
    );
  }

  private post(connection: BridgeConnection, frame: BridgeEnvelope): void {
    void connection.sender.postMessage(frame);
  }

  private postById(id: string, frame: BridgeEnvelope): void {
    const connection = this.connections.get(id);
    if (connection) this.post(connection, frame);
  }
}

/** 常用服务描述符再导出（container/命令编排用，避免散落 import）。 */
export {
  IZCodeAgentService,
  IZCodeSessionService,
  IZCodeTaskService,
  IFileService,
  ISettingService,
  IBroadcastService,
  ISubagentsService,
};
