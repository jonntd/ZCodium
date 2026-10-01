import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface WebSocketConnectionOptions {
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
  /** 等 `Initialize` 的兜底上限；超过则按 bootstrap 失败处理，并主动关闭 socket。 */
  initializeTimeoutMs?: number;
}

/**
 * 等 `Initialize` 的默认上限。
 *
 * 正常情况下失败由 close 事件给出（relay 宽限到期会明确 4002），这个超时只兜
 * 「socket 一直开着但通道始终不初始化」这一种情况：没有它，调用方会永远停在 loading 壳。
 */
const DEFAULT_INITIALIZE_TIMEOUT_MS = 20_000;

function wrapBrowserWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (e) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(e.data as ArrayBuffer)));
  });
  ws.addEventListener("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.addEventListener("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

/**
 * 何时算「连上了」：**服务端 `Initialize` 帧到达**，而不是 WS `open`。
 *
 * WS `open` 只证明传输握手完成。`ChannelClient` 在收到 `Initialize` 前会排队所有请求，
 * 而在它之前断开时调用方拿到的只是一个已死通道 —— 若在 open 就 resolve，页面会渲染空壳
 * 且没有重试入口（VPS relay 刷新撞 host 空窗时就是这种白屏）。所以这里把
 * 「close 早于 Initialize」与「超时未 Initialize」都按 bootstrap 失败抛出，
 * 由调用方渲染可重试的错误页。
 */
export function connectViaWebSocket(
  wsUrl: string,
  options?: WebSocketConnectionOptions,
): Promise<IServiceAccessor> {
  const initializeTimeoutMs = options?.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let settled = false;
    let initializeTimer: ReturnType<typeof setTimeout> | null = null;

    /** 交付点唯一：成功（Initialize）或失败（error/close/超时）先到者生效。 */
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      if (initializeTimer) clearTimeout(initializeTimer);
      initializeTimer = null;
      reject(error);
    };
    const succeed = (services: IServiceAccessor) => {
      if (settled) return;
      settled = true;
      if (initializeTimer) clearTimeout(initializeTimer);
      initializeTimer = null;
      resolve(services);
    };

    ws.addEventListener("error", () => {
      fail(new Error(`WebSocket connection failed: ${wsUrl}`));
    });
    ws.addEventListener("close", (event) => {
      options?.onClose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });

      fail(
        new Error(
          event.reason
            ? `WebSocket closed before ready: ${event.reason}`
            : `WebSocket closed before ready (${event.code})`,
        ),
      );
    });

    ws.addEventListener("open", () => {
      options?.onOpenSocket?.(ws);
      const { client, services } = createChannelClient(new SocketProtocol(wrapBrowserWebSocket(ws)));
      client.onDidInitialize(() => succeed(services));
      initializeTimer = setTimeout(() => {
        fail(new Error(`WebSocket RPC channel was not initialized within ${initializeTimeoutMs}ms`));
        // 超时也要收掉连接：否则页面已显示错误页，后台还挂着一个不会用的 socket。
        ws.close();
      }, initializeTimeoutMs);
    });
  });
}

export function connectViaProtocol(protocol: IMessagePassingProtocol): IServiceAccessor {
  return createChannelClient(protocol).services;
}

/** `connectViaProtocol` 的同源构造，额外交出 `ChannelClient` 以便观察 `Initialize`。 */
function createChannelClient(protocol: IMessagePassingProtocol): {
  client: ChannelClient;
  services: IServiceAccessor;
} {
  const client = new ChannelClient(protocol);
  return { client, services: new RemoteServiceAccess(client) };
}
