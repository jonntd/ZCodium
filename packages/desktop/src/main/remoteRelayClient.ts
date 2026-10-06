/**
 * 桌面侧的 VPS 中继客户端。
 *
 * 职责：主动拨出到中继，把本窗口的 Local Host 通过一个 MessagePort 借给远端手机。
 *
 * 关键设计（为什么这么写）：
 *
 * 1. **主动拨出**：桌面在 NAT 后无法被直连，必须由它去连中继。
 *
 * 2. **两侧协议不同，必须在协议层对接，不能搬字节**：
 *    - WS 侧用 `SocketProtocol`：`send()` 会写 13 字节帧头
 *      （`packages/rpc/src/protocol.ts` `HEADER_SIZE = 13`，`writeProtocolMessage`）。
 *    - Host 侧用 `MessagePortProtocol`：`send()` 是 `postMessage(buffer.buffer)`，
 *      **裸 payload 无帧头**，并额外承载 `connection-flow-v1` 流控帧。
 *    因此必须让两个协议实例各自负责自己的成帧，只在 `IMessagePassingProtocol`
 *    的 `onMessage`/`send` 这一层互相对接。**不能**把 WS 原始字节直接 `postMessage`
 *    给 Host（帧头会被当成 payload 解析），也**不能**用裸 `postMessage` 桥接
 *    （会丢掉 Host 侧的流控帧）。
 *
 * 3. **稳定的 attachmentId**：`windowHostAttachmentRegistry.attach()` 对同一
 *    `attachmentId` 会先 dispose 前一个，因此重连时复用同一个 id 就是「原子替换」，
 *    不需要显式 `DetachServicePort`。
 *
 * 4. **默认关闭**：未配置 `ZCODE_REMOTE_RELAY_URL` 时本模块不被实例化，
 *    行为与改动前完全一致。
 */
import { randomUUID } from "node:crypto";
import {
  Emitter,
  MessagePortProtocol,
  SocketProtocol,
  VSBuffer,
  type ISocket,
  type MessagePortLike,
  type MessagePortPayload,
} from "@zcode/rpc";
import { HostMessageTypes, RelayE2eeChannel, encryptRelayReport } from "@zcode/shared";
import { WebSocket } from "ws";

/** 只要求 Host 进程的 postMessage 能力，便于单测替身。 */
export interface RelayHostProcess {
  postMessage(message: unknown, transfer?: unknown[]): void;
}

/**
 * 端口的最小结构类型。
 *
 * 用结构类型而不是 `MessagePortMain`，是为了**让本模块完全不依赖 electron**：
 * 既能被 `main/index.ts` 传入真实的 `MessagePortMain`，也能在单测里用纯 JS 替身。
 * 这也避免了在非 Electron 环境（单测）导入本模块时因值导入 electron 而失败。
 */
export interface RelayMessagePort {
  on(event: "message", listener: (event: { data: MessagePortPayload }) => void): unknown;
  off(event: "message", listener: (event: { data: MessagePortPayload }) => void): unknown;
  postMessage(message: unknown): void;
  start(): void;
  close(): void;
}

/**
 * 把 Electron 的 `MessagePortMain` 适配成 RPC 层的 `MessagePortLike`。
 *
 * Electron 用 Node EventEmitter 风格（`.on/.off`），而 `MessagePortLike` 用 Web 标准风格
 * （`addEventListener/removeEventListener`）。`packages/desktop/src/host/electronPort.ts`
 * 有同功能实现，但那个文件属于 `tsconfig.host.json` 工程，**main 工程引用它会被 TS6307 挡住**
 * （两个工程各自 `include` 自己的 src 子目录）。因此这里按同样方式本地实现。
 * 导出供路线 B 的数据面桥（remoteOfficialDataPlane）复用，避免第三份拷贝。
 */
export function wrapElectronPort(port: RelayMessagePort): MessagePortLike {
  return {
    addEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      // MessagePortMain 的 message 事件已经是 { data } 结构，直接转发。
      port.on("message", listener);
    },
    removeEventListener(_type: "message", listener: (e: { data: MessagePortPayload }) => void) {
      port.off("message", listener);
    },
    postMessage(data: MessagePortPayload) {
      port.postMessage(data);
    },
    start() {
      port.start();
    },
    close() {
      port.close();
    },
  };
}

export interface RelayTargetWindow {
  windowId: number;
  hostProcess: RelayHostProcess;
}

export interface RemoteRelayClientOptions {
  /** 中继地址，如 `wss://relay.example.com`（也接受 `ws://` 便于本机验证）。 */
  url: string;
  /** 与中继 `HOST_SECRET` 一致的共享密钥。 */
  hostSecret: string;
  /** 选出要借出 Host 的窗口；返回 null 表示当前没有可用窗口（稍后重试）。 */
  resolveTargetWindow: () => RelayTargetWindow | null;
  /** 读出该窗口当前的工作区，用于回答手机端的 /api/server-info。 */
  resolveWorkspace: (
    windowId: number,
  ) => { workspacePath: string; workspaceIdentity?: string } | null;
  /** 展示用主机名，仅用于中继的 /api/server-info。 */
  hostLabel?: string;
  appVersion?: string;
  logger?: {
    info(message: string, detail?: unknown): void;
    warn(message: string, detail?: unknown): void;
  };
  /** 心跳间隔，默认 30s。只为穿过反代/CDN 的空闲连接回收，不承担业务保活语义。 */
  heartbeatIntervalMs?: number;
  /** 允许临时停用；返回 false 时不建立连接。 */
  enabled?: () => boolean;
  /**
   * E2EE channelKey（base64url，来自配置文件 `channelKey`；spec vps-relay-bridge.md §16）。
   * 提供即启用端到端加密：WS 线上只有 ZRE1 握手/密文，中继不可读。
   * **fail-closed**：对端第一条消息不是合法 hello（旧 bundle/错 key）→ 断开重连，
   * 不做明文降级——探测降级等于用超时掩盖同步问题。
   */
  e2eeChannelKey?: string;
  /**
   * 中继槽位号（spec §17）：拨出 URL 变为 `/host?slot=<k>`，同槽位重连在 relay 侧
   * 顶替旧连接。多槽位时控制层为每个槽位创建独立的本客户端实例（各自的连接、
   * attachment、E2EE 握手、重连循环）。
   */
  slot?: number;
  /**
   * 建一个 MessageChannel。由调用方注入 Electron 的 `MessageChannelMain`，
   * 使本模块**不依赖 electron**（单测可用纯 JS 替身）。
   * 与 `desktopRemoteSessions.ts` 的 `options.createMessageChannel` 是同一惯例。
   */
  createChannel: () => { port1: RelayMessagePort; port2: RelayMessagePort };
}

export interface RemoteRelayClient {
  start(): void;
  stop(): void;
  isConnected(): boolean;
}

const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
/**
 * 手机离线连坐（close 4003）的补位延迟。
 * 手机刷新/断开是常规操作，每次都会连坐关闭 host 连接；空窗越长，
 * 下一次页面加载的 WS 越容易撞进去（relay 会 4002 秒踢 → 白屏，spec §12.3.1）。
 * 所以这类**预期内**的关闭用固定小延迟立即补位，不消耗指数退避——
 * 退避留给真实故障（4001 被顶替 / 4002 host 异常 / 1006 网络断）。
 */
const CLIENT_OFFLINE_RECONNECT_DELAY_MS = 100;

/**
 * 把 `ws` 的 WebSocket 适配成 `@zcode/rpc` 的 `ISocket`。
 *
 * 与 `packages/server/src/http.ts` 内的同名私有函数同构。那个函数未导出，
 * 且 `packages/server/src/remote/stdio-socket.ts` 的注释表明「同模式各自实现」是既有做法，
 * 因此这里按同样方式本地实现，避免为 legacy 模块新增跨模块公开边。
 */
function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buffer)));
  });
  ws.on("close", () => {
    onClose.fire();
  });
  ws.on("error", () => {
    onClose.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onClose.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === WebSocket.OPEN) ws.send(buffer.buffer);
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

/** `wss://h` → `https://h`，用于 /api/host-report。 */
function toHttpOrigin(url: string): string {
  return url.replace(/^ws:/, "http:").replace(/^wss:/, "https:");
}

export function createRemoteRelayClient(options: RemoteRelayClientOptions): RemoteRelayClient {
  const logger = options.logger;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 30_000;
  const httpOrigin = toHttpOrigin(options.url);
  /** 稳定 id：重连时由 Host registry 原子替换上一个 attachment。 */
  const attachmentId = `relay-${randomUUID()}`;

  let socket: WebSocket | null = null;
  let wsProtocol: SocketProtocol | null = null;
  let hostProtocol: MessagePortProtocol | null = null;
  let e2eeChannel: RelayE2eeChannel | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
  let stopped = true;
  let connected = false;
  /**
   * 已成功上报的工作区路径。
   * 用途：① 避免重复上报；② 等工作区就绪后补报（渲染器晚于 WS 连接才把工作区报给 Main）；
   * ③ 用户切换工作区时重报。断开时清空，以便重连后重新上报（中继可能已重启）。
   */
  let lastReportedWorkspacePath: string | null = null;

  function clearTimers(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function teardownConnection(): void {
    clearTimers();
    connected = false;
    // 清空已上报记录：重连后要重新上报（中继可能已重启，缓存已丢）。
    lastReportedWorkspacePath = null;
    e2eeChannel?.dispose();
    e2eeChannel = null;
    try {
      hostProtocol?.disconnect();
    } catch {
      /* 忽略：端口可能已被 Host 侧关闭 */
    }
    hostProtocol = null;
    try {
      wsProtocol?.dispose();
    } catch {
      /* 忽略 */
    }
    wsProtocol = null;
    try {
      socket?.close();
    } catch {
      /* 忽略 */
    }
    socket = null;
  }

  function scheduleReconnect(reason: string, delayOverrideMs?: number): void {
    if (stopped || options.enabled?.() === false || reconnectTimer) return;
    // 覆盖延迟（预期事件的快速补位）不推进指数退避：退避状态只由真实失败驱动。
    const delay = delayOverrideMs ?? reconnectDelay;
    if (delayOverrideMs === undefined) {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
    }
    // 必须带上原因：启动早期窗口尚未创建时也会走到这里，
    // 若只说「中继断开」会让人误判成网络或鉴权问题。
    logger?.warn(`中继将在 ${delay}ms 后重连（${reason}）`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  /** 把工作区上报给中继。走独立 HTTP —— 复用数据面 WS 会污染通道协议帧流。 */
  async function reportWorkspace(windowId: number): Promise<void> {
    const workspace = options.resolveWorkspace(windowId);
    // 工作区可能还没就绪（渲染器要晚几秒才把它报给 Main），此时**不能**放弃：
    // 心跳会再次调用本函数，等工作区出现后补报。
    if (!workspace) return;
    // 路径没变就不重复上报；变了（用户切换工作区）则重报。
    if (workspace.workspacePath === lastReportedWorkspacePath) return;
    // host-report 端到端加密（spec §16.9）：e2ee 开启时报文体就是信封，
    // 中继不解析不落明文日志——「中继只见密文」涵盖最后一条旁路。
    const report = {
      workspacePath: workspace.workspacePath,
      ...(workspace.workspaceIdentity
        ? { workspaceIdentity: workspace.workspaceIdentity }
        : {}),
      ...(options.hostLabel ? { hostLabel: options.hostLabel } : {}),
      ...(options.appVersion ? { appVersion: options.appVersion } : {}),
    };
    const body = options.e2eeChannelKey
      ? JSON.stringify(encryptRelayReport(options.e2eeChannelKey, JSON.stringify(report)))
      : JSON.stringify(report);
    try {
      const response = await fetch(`${httpOrigin}/api/host-report`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.hostSecret}`,
          "content-type": "application/json",
        },
        body,
      });
      if (!response.ok) {
        logger?.warn(`上报工作区失败 status=${response.status}`);
        return;
      }
      lastReportedWorkspacePath = workspace.workspacePath;
      logger?.info(`已上报工作区 ${workspace.workspacePath}`);
    } catch (error) {
      // 上报失败不影响数据面：手机端只会拿不到初始工作区，仍可自行选择。
      logger?.warn("上报工作区失败", error);
    }
  }

  function connect(): void {
    if (stopped || options.enabled?.() === false) return;

    const target = options.resolveTargetWindow();
    if (!target) {
      // 没有窗口就没法借 Host；稍后重试，等窗口出现。
      scheduleReconnect("尚无可用窗口");
      return;
    }

    let ws: WebSocket;
    try {
      ws = new WebSocket(`${options.url}/host${options.slot ? `?slot=${options.slot}` : ""}`, {
        headers: { authorization: `Bearer ${options.hostSecret}` },
      });
    } catch (error) {
      logger?.warn("中继连接创建失败", error);
      scheduleReconnect("WebSocket 构造失败");
      return;
    }
    socket = ws;

    ws.on("open", () => {
      connected = true;
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      logger?.info(`已连上中继 ${options.url}`);

      const rawSocket = wrapWebSocket(ws);
      let bridgeSocket: ISocket;
      /** E2EE 队列的放行时机由最后统一控制（见 onMessage 接线之后的调用点）。 */
      let flushIncomingQueue: () => void = () => {};
      if (options.e2eeChannelKey) {
        // E2EE 分支（spec vps-relay-bridge.md §16）：SocketProtocol 架在「解密后的虚拟
        // ISocket」上——两个协议实例只在 onMessage/send 层对接的结构不变，只是中间多了
        // 一层加解密。与 packages/client/src/websocket.ts 的同构适配互为镜像（role 相反）。
        const decrypted = new Emitter<VSBuffer>();
        // 进入通道的消息必须过**单一 FIFO 队列 + 泵守卫**（与 client/websocket.ts 同一
        // 教训）：构造即发 hello 会在同步传输下立刻引来对端响应而闭包里还是 null；
        // 且对端 secure 后立即发 record，若早到的 hello/confirm 还在缓冲、record 被直接
        // 处理，就违反「confirm 先于 record」的处理序（通道会 fail-closed）。
        const incomingQueue: Uint8Array[] = [];
        let pumpingIncoming = false;
        const pumpIncoming = () => {
          if (pumpingIncoming) return;
          pumpingIncoming = true;
          try {
            while (e2eeChannel !== null && incomingQueue.length > 0) {
              e2eeChannel.accept(incomingQueue.shift() as Uint8Array);
            }
          } finally {
            pumpingIncoming = false;
          }
        };
        rawSocket.onData((buffer) => {
          incomingQueue.push(new Uint8Array(buffer.buffer));
          pumpIncoming();
        });
        e2eeChannel = new RelayE2eeChannel({
          role: "host",
          channelKey: options.e2eeChannelKey,
          send: (data) => rawSocket.write(VSBuffer.wrap(data)),
          onPlaintext: (data) => decrypted.fire(VSBuffer.wrap(data)),
          onFatal: (error) => {
            // fail-closed：对端未启用 E2EE（旧 bundle）/ 错 key / 篡改，一律断开重连。
            logger?.warn("E2EE 通道失败，断开重连", error);
            try {
              ws.close();
            } catch {
              /* 忽略 */
            }
          },
          logger: { warn: (message, detail) => logger?.warn(message, detail) },
        });
        // 不能在这里放行：手机侧的帧可能已同步到达队列，而 wsProtocol/hostProtocol
        // 的对接要等下面才挂上——提前放行会丢帧。
        flushIncomingQueue = pumpIncoming;
        bridgeSocket = {
          onData: decrypted.event,
          onClose: rawSocket.onClose,
          onEnd: rawSocket.onEnd,
          write: (buffer) => e2eeChannel?.write(buffer.buffer),
          end: () => rawSocket.end(),
          drain: () => rawSocket.drain(),
          dispose: () => rawSocket.dispose(),
        };
      } else {
        bridgeSocket = rawSocket;
      }

      // 两侧各用自己的协议实例负责成帧；只在 onMessage/send 这一层对接。
      wsProtocol = new SocketProtocol(bridgeSocket);

      const channel = options.createChannel();
      hostProtocol = new MessagePortProtocol(wrapElectronPort(channel.port1));

      wsProtocol.onMessage((buffer) => hostProtocol?.send(buffer));
      hostProtocol.onMessage((buffer) => wsProtocol?.send(buffer));

      // 监听全部就位后才放行 E2EE 队列：同步回环下握手与数据帧可能已经在队列里。
      flushIncomingQueue();

      // 上报工作区（独立 HTTP）。
      void reportWorkspace(target.windowId);

      // 把 port2 交给窗口 Host。未 ready 时 Host 会自行挂起，无需在此重试。
      target.hostProcess.postMessage(
        {
          type: HostMessageTypes.AttachServicePort,
          requestId: randomUUID(),
          attachmentId,
          // 手机侧走 replayable 档；握手强校验 clientMode↔deliveryProfile，填错会在握手期失败。
          clientMode: "web-remote-replayable",
          // local scope 是 .strict() 的：只能有 kind 一个字段。
          scope: { kind: "local" },
        },
        [channel.port2],
      );
      logger?.info(`已向窗口 Host 挂载中继 attachment，windowId=${target.windowId}`);

      heartbeatTimer = setInterval(() => {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.ping();
        } catch {
          /* 忽略 */
        }
        // 顺带补报工作区：WS 连上时渲染器往往还没把工作区报给 Main，
        // 只在上报时做一次会永久拿不到工作区（手机端 /api/server-info 会是空的）。
        void reportWorkspace(target.windowId);
      }, heartbeatIntervalMs);
    });

    ws.on("close", (code: number) => {
      if (socket !== ws) return;
      logger?.warn(`中继连接关闭 code=${code}`);
      teardownConnection();
      // 4003 = relay 明确告知「手机离线连坐」（手机刷新/断开是常规操作）：
      // 快速补位把 host 缺位空窗压到最小，避免下一次页面加载撞进 4002 空窗（spec §12.3.1）。
      if (code === 4003) {
        scheduleReconnect("手机离线连坐，快速补位", CLIENT_OFFLINE_RECONNECT_DELAY_MS);
        return;
      }
      scheduleReconnect(`连接已关闭 code=${code}`);
    });

    // close 事件会随后触发；这里只记录，避免重复调度重连。
    ws.on("error", (error: Error) => {
      logger?.warn("中继连接错误", error);
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      reconnectDelay = INITIAL_RECONNECT_DELAY_MS;
      connect();
    },
    stop() {
      stopped = true;
      teardownConnection();
    },
    isConnected() {
      return connected;
    },
  };
}
