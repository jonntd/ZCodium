/**
 * PlatformRpcClient — webview 侧平台小 RPC 客户端（架构 §2.2，T03）。
 *
 * VscodePlatformService 的能力方法经 `plat-req`/`plat-res` 帧穿越 postMessage 通道；
 * host 端 PlatformRpcHandler 白名单校验后落地为 VS Code API。`plat-evt` 帧以事件面分发。
 */

import { parseBridgeEnvelope, type BridgeEnvelope, type PlatformEventFrame } from "../../bridge/wire";
import type { VscodeApi } from "./webviewMessagePort";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export type PlatformEventHandler = (event: string, payload: unknown) => void;

export class PlatformRpcClient {
  private seq = 0;
  private readonly pending = new Map<number, PendingCall>();
  private readonly eventHandlers = new Set<PlatformEventHandler>();

  constructor(private readonly vscode: VscodeApi) {}

  /** index.tsx 把 webview 收到的原始消息转发到这里（先于 port 分流亦可）。 */
  handleMessageData(data: unknown): void {
    const frame = parseBridgeEnvelope(data);
    if (!frame) return;
    if (frame.t === "plat-res") {
      const pendingCall = this.pending.get(frame.id);
      if (!pendingCall) return;
      this.pending.delete(frame.id);
      if (frame.ok) pendingCall.resolve(frame.value);
      else pendingCall.reject(new Error(frame.error));
      return;
    }
    if (frame.t === "plat-evt") {
      const eventFrame = frame as PlatformEventFrame;
      for (const handler of [...this.eventHandlers]) {
        handler(eventFrame.event, eventFrame.payload);
      }
    }
  }

  /** 调用平台方法（host 白名单外会以 reject 返回 "method not allowed"）。 */
  call<T>(method: string, ...args: unknown[]): Promise<T> {
    this.seq += 1;
    const id = this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.vscode.postMessage({ t: "plat-req", id, method, args });
    });
  }

  /** 发送 host → webview 方向不存在的 webview 主动事件（如 notifyRendererReady）。 */
  sendEvent(event: string, payload?: unknown): void {
    this.vscode.postMessage({ t: "plat-evt", event, payload: payload ?? null });
  }

  /** 订阅 host → webview 平台事件，返回 disposer。 */
  onEvent(handler: PlatformEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /** 丢弃全部挂起调用（webview dispose 时防泄漏）。 */
  dispose(): void {
    for (const pendingCall of this.pending.values()) {
      pendingCall.reject(new Error("platform rpc client disposed"));
    }
    this.pending.clear();
    this.eventHandlers.clear();
  }
}

/** 供 HostFrameBus 等消费的类型再导出（避免跨模块 deep import）。 */
export type { BridgeEnvelope };
