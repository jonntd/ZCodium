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
  timer: ReturnType<typeof setTimeout>;
}

/** 调用超时（增量审查 X2）：host 不回（handler 卡死/帧丢失）时 pending Map
 *  无限累积 + Promise 永挂。30s 宽于最慢白名单方法（exportLogs 写盘 + 打开
 *  编辑器），超时视为通道异常。 */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export type PlatformEventHandler = (event: string, payload: unknown) => void;

export class PlatformRpcClient {
  private seq = 0;
  private readonly pending = new Map<number, PendingCall>();
  private readonly eventHandlers = new Set<PlatformEventHandler>();

  constructor(
    private readonly vscode: VscodeApi,
    private readonly timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ) {}

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

  /** 调用平台方法（host 白名单外会以 reject 返回 "method not allowed"）。
   *  超时 reject 并从 pending 移除（X2：防 host 不回导致永挂 + 泄漏）。 */
  call<T>(method: string, ...args: unknown[]): Promise<T> {
    this.seq += 1;
    const id = this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`plat-req 超时（${this.timeoutMs}ms）：${method}`));
        }
      }, this.timeoutMs);
      const settle = (fn: () => void): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        fn();
      };
      this.pending.set(id, {
        timer,
        resolve: (value) => settle(() => resolve(value as T)),
        reject: (error) => settle(() => reject(error)),
      });
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

  /** 丢弃全部挂起调用（webview dispose 时防泄漏；超时定时器一并清）。 */
  dispose(): void {
    for (const pendingCall of this.pending.values()) {
      clearTimeout(pendingCall.timer);
      pendingCall.reject(new Error("platform rpc client disposed"));
    }
    this.pending.clear();
    this.eventHandlers.clear();
  }
}

/** 供 HostFrameBus 等消费的类型再导出（避免跨模块 deep import）。 */
export type { BridgeEnvelope };
