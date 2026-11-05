/**
 * HostFrameBus — host 帧（theme/locale/workspace/visibility）订阅（架构 §2.2，T03/T04）。
 *
 * host 侧在 renderer 就绪与状态变化时推送 `{t:"host"}` 帧；ThemeBridge / i18n /
 * workspace 头部经本总线消费。保留最近一帧作为初始值（重订阅立即生效）。
 */

import { parseBridgeEnvelope, type HostFrame, type HostFrameKind } from "../../bridge/wire";

type HostFrameListener<T> = (payload: T) => void;

export class HostFrameBus {
  private readonly listeners = new Map<HostFrameKind, Set<HostFrameListener<unknown>>>();
  private readonly last = new Map<HostFrameKind, unknown>();

  /** index.tsx 把 webview 收到的原始消息转发到这里。 */
  handleMessageData(data: unknown): void {
    const frame = parseBridgeEnvelope(data);
    if (!frame || frame.t !== "host") return;
    const hostFrame = frame as HostFrame;
    this.last.set(hostFrame.kind, hostFrame.payload);
    const handlers = this.listeners.get(hostFrame.kind);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      handler(hostFrame.payload);
    }
  }

  /** 订阅某类 host 帧；若已有最近一帧立即同步一次。 */
  on<T>(kind: HostFrameKind, handler: HostFrameListener<T>): () => void {
    let handlers = this.listeners.get(kind);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(kind, handlers);
    }
    handlers.add(handler as HostFrameListener<unknown>);
    if (this.last.has(kind)) {
      handler(this.last.get(kind) as T);
    }
    return () => {
      handlers?.delete(handler as HostFrameListener<unknown>);
    };
  }

  /** 最近一帧（无则 undefined）；ThemeBridge 初始化用。 */
  lastPayload<T>(kind: HostFrameKind): T | undefined {
    return this.last.get(kind) as T | undefined;
  }
}
