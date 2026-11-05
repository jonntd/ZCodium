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
import { PlatformRpcHandler, type PlatformMethodHandler } from "./platformRpcHandler";
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
  sendInitialFrames?: (push: (kind: HostFrameKind, payload: unknown) => void) => void;
  /** 诊断出口。 */
  log?: (message: string) => void;
}

/** 当前连接的桥上下文（每 webview 一份）。 */
interface BridgeConnection {
  id: string;
  protocol: HostBridgeProtocol;
  sender: WebviewSender;
  platformRpc: PlatformRpcHandler;
  /** 断开事件（detachWebview 时 fire，IPCServer 据此清理 ChannelServer/Client）。 */
  onDidDisconnect: Emitter<void>;
}

export class HostRuntime {
  private readonly connectionEvent = new Emitter<ClientConnectionEvent>();
  private readonly ipcServer: IPCServer<string>;
  private readonly connections = new Map<string, BridgeConnection>();
  private disposed = false;

  constructor(private readonly options: HostRuntimeOptions) {
    this.ipcServer = new IPCServer<string>(this.connectionEvent.event);
    // 白名单频道暴露到 IPCServer（IPCServer 实现 IChannelServer）。
    options.services.exposeOnChannelServer(this.ipcServer, new Map(), options.exposurePolicy);
  }

  /** Agent 服务（runtimeController / 命令编排用）。 */
  get agentService() {
    return this.options.services.get(IZCodeAgentService);
  }

  /** webview 可见性变化 → host 帧推送（webview 隐藏时 UI 暂停渲染）。 */
  pushHostFrame(kind: HostFrameKind, payload: unknown): void {
    const frame: HostFrame = { t: "host", kind, payload };
    for (const connection of this.connections.values()) {
      this.post(connection, frame);
    }
  }

  /** chatPanel.resolveWebviewView 时调用：建立该 webview 的 RPC 连接。 */
  attachWebview(id: string, sender: WebviewSender): void {
    if (this.disposed) return;
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
        this.sendInitialHostFrames(id);
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
