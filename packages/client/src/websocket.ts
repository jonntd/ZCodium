import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import { RelayE2eeChannel } from "@zcode/shared";
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
  /**
   * E2EE channelKey（来自分享链接的 `#k=` fragment；spec vps-relay-bridge.md §16）。
   * 提供即启用端到端加密。**fail-closed**：握手失败（对端未启用/错 key）→ reject →
   * 由调用方的 bootstrap 错误页呈现，不做明文降级。
   */
  e2eeChannelKey?: string;
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
      let protocol: IMessagePassingProtocol;
      /** E2EE 队列的放行时机由最后统一控制（见 onDidInitialize 之后的调用点）。 */
      let flushIncomingQueue: () => void = () => {};
      if (options?.e2eeChannelKey) {
        // E2EE 分支（spec vps-relay-bridge.md §16）：SocketProtocol 架在「解密后的虚拟
        // ISocket」上。与 packages/desktop/src/main/remoteRelayClient.ts 的同构适配
        // 互为镜像（role 相反）；crypto 核心双端共用 @zcode/shared 的 RelayE2eeChannel。
        const decrypted = new Emitter<VSBuffer>();
        let channel: RelayE2eeChannel | null = null;
        const rawSocket = wrapBrowserWebSocket(ws);
        // 进入通道的消息必须过**单一 FIFO 队列 + 泵守卫**：构造即发 hello 会在同步传输
        // （测试回环）下立刻引来对端响应，而此时闭包里的 channel 还是 null；更关键的是
        // 对端 secure 后立即发 record，若早到的 hello/confirm 还在缓冲里、record 却被
        // 直接处理，就违反「confirm 先于 record」的处理序（通道会 fail-closed）。
        // 生产网络 RTT 下队列为空，泵只增加一次函数调用。
        const incomingQueue: Uint8Array[] = [];
        let pumpingIncoming = false;
        const pumpIncoming = () => {
          if (pumpingIncoming) return;
          pumpingIncoming = true;
          try {
            while (channel !== null && incomingQueue.length > 0) {
              channel.accept(incomingQueue.shift() as Uint8Array);
            }
          } finally {
            pumpingIncoming = false;
          }
        };
        rawSocket.onData((buffer) => {
          incomingQueue.push(new Uint8Array(buffer.buffer));
          pumpIncoming();
        });
        channel = new RelayE2eeChannel({
          role: "phone",
          channelKey: options.e2eeChannelKey,
          send: (data) => rawSocket.write(VSBuffer.wrap(data)),
          onPlaintext: (data) => decrypted.fire(VSBuffer.wrap(data)),
          onFatal: (error) => {
            // fail-closed 且 fail-loud：进 bootstrap 错误页（可重试），绝不降级明文。
            fail(new Error(`端到端加密握手失败：${error.message}`));
            try {
              ws.close();
            } catch {
              /* 忽略 */
            }
          },
        });
        // 不能在这里放行：Initialize 可能已同步到达队列，而 ChannelClient 的
        // onDidInitialize 监听要等 createChannelClient 之后才挂上——提前放行会丢帧。
        flushIncomingQueue = pumpIncoming;
        protocol = new SocketProtocol({
          onData: decrypted.event,
          onClose: rawSocket.onClose,
          onEnd: rawSocket.onEnd,
          write: (buffer) => channel?.write(buffer.buffer),
          end: () => rawSocket.end(),
          drain: () => rawSocket.drain(),
          dispose: () => rawSocket.dispose(),
        });
      } else {
        protocol = new SocketProtocol(wrapBrowserWebSocket(ws));
      }
      const { client, services } = createChannelClient(protocol);
      client.onDidInitialize(() => succeed(services));
      // 监听全部就位后才放行 E2EE 队列：同步回环下握手与 Initialize 可能已经在队列里。
      flushIncomingQueue();
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
