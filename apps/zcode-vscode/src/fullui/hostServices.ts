/**
 * 宿主侧共享 server 服务访问（移植自 apps/zcodium-vscode bridge/hostServices，PRD §8.5 单通道）。
 *
 * 完整界面（full 模式）下，server 进程是 Agent 的唯一所有者（PRD：侧边栏与完整界面
 * 共用 server 进程，避免两条链路各自 spawn app-server 在 CLI 存储锁上互相等待——
 * 双实例冲突在 Antigravity 实测表现即 "ZCode agent stdio transport is closed"）。
 * 宿主的编辑器侧能力（一次性文本生成/列会话/停止/直发消息）因此经 `/ws` 直连
 * 同一个 server，复用 @zcode/client 的 RemoteServiceAccess，不自研协议。
 *
 * 与源实现的差异：Node 22 原生 WebSocket 替代 `ws` 包（免新增依赖；无 terminate()，
 * 关闭用 close()）。
 */

import { ChannelClient, Emitter, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import { RemoteServiceAccess } from "@zcode/client";
import type { IServiceAccessor } from "@zcode/services";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import { log } from "../features/logger";

const CONNECT_TIMEOUT_MS = 20_000;
const HOST_CLIENT_ID = "zcode-vscode-host";
const HOST_CLIENT_VERSION = "0.2.0";

/** Node 原生 WebSocket → @zcode/rpc ISocket 适配。 */
function wrapNativeWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.addEventListener("message", async (event) => {
    const raw: unknown = event.data;
    // Node 原生 WebSocket（undici）的二进制消息是 Blob，浏览器是 ArrayBuffer——
    // 两者都要兜住，否则 server 首个二进制帧就会在宿主里抛未捕获异常。
    let data: Buffer;
    try {
      if (typeof raw === "string") {
        data = Buffer.from(raw, "utf8");
      } else if (typeof Blob !== "undefined" && raw instanceof Blob) {
        data = Buffer.from(await raw.arrayBuffer());
      } else {
        data = Buffer.from(raw as ArrayBuffer);
      }
    } catch (error) {
      log.warn("host-services", `帧解码失败：${String(error)}`);
      return;
    }
    onData.fire(VSBuffer.wrap(new Uint8Array(data)));
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
        ws.send(Buffer.from(buffer.buffer));
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

export interface HostServicesOptions {
  /** 共享 server 的 `/ws` 直连地址；未就绪时抛错（由调用方决定怎么提示）。 */
  readonly getWsUrl: () => Promise<string>;
}

export class HostServices {
  private accessor: IServiceAccessor | undefined;
  private connecting: Promise<IServiceAccessor> | undefined;
  private disposed = false;

  constructor(private readonly options: HostServicesOptions) {}

  dispose(): void {
    this.disposed = true;
    this.accessor = undefined;
    this.connecting = undefined;
  }

  /**
   * 拿到可用的 `IServiceAccessor` 并执行 `run`。
   *
   * 一次性能力（generateText / 列会话 / 停止 / 直发消息）都是短请求：连接断开时
   * 下一次调用自动重建，不做后台保活（server 侧 Initialize 每连接只发一次，
   * 复用旧连接反而要在客户端自行处理断线重放，得不偿失）。
   */
  async use<T>(run: (accessor: IServiceAccessor) => Promise<T>): Promise<T> {
    if (this.disposed) throw new Error("插件已停用，服务连接不可用");
    const accessor = await this.ensureAccessor();
    try {
      return await run(accessor);
    } catch (error) {
      // 请求级失败可能与通道半开有关（server 重启等）：丢弃连接，下次重建。
      log.debug("host-services", `服务调用失败，丢弃通道：${String(error)}`);
      this.accessor = undefined;
      throw error;
    }
  }

  private ensureAccessor(): Promise<IServiceAccessor> {
    if (this.accessor) return Promise.resolve(this.accessor);
    if (!this.connecting) {
      this.connecting = this.connect()
        .then((accessor) => {
          this.accessor = accessor;
          return accessor;
        })
        .finally(() => {
          this.connecting = undefined;
        });
    }
    return this.connecting;
  }

  private async connect(): Promise<IServiceAccessor> {
    const wsUrl = await this.options.getWsUrl();
    const ws = new WebSocket(wsUrl);
    return new Promise<IServiceAccessor>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        try {
          ws.close();
        } catch {
          // 已关闭
        }
        reject(new Error(`共享服务通道在 ${CONNECT_TIMEOUT_MS / 1000}s 内未完成 Initialize`));
      }, CONNECT_TIMEOUT_MS);

      const socket = wrapNativeWebSocket(ws);
      const protocol = new SocketProtocol(socket);
      const client = new ChannelClient(protocol);
      const closeListener = socket.onClose(() => fail(new Error("共享服务通道在 Initialize 前断开")));
      const initializeListener = client.onDidInitialize(() => {
        closeListener.dispose();
        initializeListener.dispose();
        const accessor = new RemoteServiceAccess(client);
        // 会话协议握手（hello → clientHello）：server 按连接校验会话类命令的握手
        // 状态，缺省拒所有 sendConversationCommandV4（fault.connection.handshakeRequired）。
        // 与 iframe 完整界面的 web 传输保持同一握手契约；超时定时器覆盖到握手完成。
        accessor.zcodeAgentService
          .helloConversationV4()
          .then(() =>
            accessor.zcodeAgentService.initializeConversationV4({
              kind: "clientHello",
              protocolVersion: V4_WIRE_PROTOCOL_VERSION,
              clientId: HOST_CLIENT_ID,
              clientKind: "web",
              appVersion: HOST_CLIENT_VERSION,
              capabilities: { historyFirst: true },
            }),
          )
          .then(() => {
            clearTimeout(timer);
            resolve(accessor);
          })
          .catch((error: unknown) => {
            fail(new Error(`会话协议握手失败：${String(error)}`));
          });
      });

      function cleanup(): void {
        clearTimeout(timer);
        closeListener.dispose();
        initializeListener.dispose();
      }
      function fail(error: Error): void {
        cleanup();
        client.dispose();
        protocol.dispose();
        reject(error);
      }

      ws.addEventListener("open", () => log.debug("host-services", `服务通道已连接：${wsUrl}`));
      ws.addEventListener("error", () => fail(new Error("共享服务连接失败")));
    });
  }
}
