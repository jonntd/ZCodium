/**
 * WebviewMessagePortLike — Webview postMessage 伪装成 @zcode/rpc 的 MessagePortLike
 * （架构 §2.2/§2.3/H2/H3，T03）。
 *
 * - postMessage(Uint8Array/ArrayBuffer) → base64 → `{t:"rpc", b64}` 帧 → vscode.postMessage；
 * - vscode 消息事件 → `{t:"rpc", b64}` 还原 Uint8Array → 以 `{data}` 事件形状 fire 给
 *   MessagePortProtocol（该类对非 Uint8Array 消息天然丢弃，`t` 分流隔离充分）；
 * - flow 帧对称透传（saturated/drained 背压，R1 缓解）。
 *
 * 纯模块：vscode API 以参数注入（acquireVsCodeApi 的返回值），vitest 用内存双端直测。
 */

import { BufferWriter, serialize, type MessagePortLike, type MessagePortPayload } from "@zcode/rpc";
import { base64ToBytes, bytesToBase64, parseBridgeEnvelope } from "../../bridge/wire";

/** acquireVsCodeApi() 的最小结构面。 */
export interface VscodeApi {
  postMessage(message: unknown): void;
  // getState/setState 本桥不使用（状态归 ExtensionStore 与 ui store）。
}

type MessageListener = (e: { data: MessagePortPayload }) => void;

/** webview 客户端身份（IPCServer 的 ctx，首条 RPC 帧发送）。 */
export const WEBVIEW_CLIENT_CONTEXT = "zcode-webview";

export class WebviewMessagePortLike implements MessagePortLike {
  private readonly listeners = new Set<MessageListener>();
  private started = false;
  private closed = false;
  /** 尚未 start() 前收到的消息缓冲（MessagePort 语义：start 前不派发）。 */
  private readonly pending: MessagePortPayload[] = [];

  constructor(private readonly vscode: VscodeApi) {}

  /** chrome 消息事件入口：chatPanel 注入的 window message 由 index.tsx 转发到这里。 */
  handleMessageData(data: unknown): void {
    if (this.closed) return;
    const frame = parseBridgeEnvelope(data);
    if (!frame) return;
    if (frame.t === "rpc") {
      this.dispatch(base64ToBytes(frame.b64));
      return;
    }
    if (frame.t === "flow") {
      // 还原为 MessagePortProtocol 可识别的流控对象。
      this.dispatch({ __zcodeRpcControl: "connection-flow-v1", state: frame.state });
    }
    // plat-* / host 帧不经此 port（由 HostFrameBus / PlatformRpcClient 分流）。
  }

  addEventListener(type: "message", listener: MessageListener): void {
    if (type !== "message") return;
    this.listeners.add(listener);
  }

  removeEventListener(type: "message", listener: MessageListener): void {
    if (type !== "message") return;
    this.listeners.delete(listener);
  }

  postMessage(message: MessagePortPayload): void {
    if (this.closed) return;
    if (message instanceof Uint8Array) {
      // 按视图精确编码（BufferWriter.buffer 可能带 offset/length）。
      this.vscode.postMessage({ t: "rpc", b64: bytesToBase64(message) });
      return;
    }
    if (message instanceof ArrayBuffer) {
      this.vscode.postMessage({ t: "rpc", b64: bytesToBase64(new Uint8Array(message)) });
      return;
    }
    // MessagePortFlowControl 对象 → flow 帧。
    if (
      typeof message === "object" &&
      message !== null &&
      (message as { __zcodeRpcControl?: string }).__zcodeRpcControl === "connection-flow-v1"
    ) {
      const state = (message as { state: "saturated" | "drained" }).state;
      this.vscode.postMessage({ t: "flow", state });
      return;
    }
    // 未知载荷丢弃（不猜语义）。
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const payload of this.pending.splice(0)) this.dispatch(payload);
  }

  close(): void {
    this.closed = true;
    this.listeners.clear();
  }

  private dispatch(payload: MessagePortPayload): void {
    if (!this.started) {
      this.pending.push(payload);
      return;
    }
    for (const listener of [...this.listeners]) {
      listener({ data: payload });
    }
  }
}

/**
 * 发送客户端身份帧（IPCServer 协议：连接后第一条消息 = ctx）。
 * 必须在 createMessagePortServiceConnection 之前调用一次。
 */
export function sendClientContext(vscode: VscodeApi): void {
  const writer = new BufferWriter();
  serialize(writer, WEBVIEW_CLIENT_CONTEXT);
  vscode.postMessage({ t: "rpc", b64: bytesToBase64(writer.buffer.buffer) });
}
