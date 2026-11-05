/**
 * HostBridgeProtocol — host 侧 IMessagePassingProtocol 实现（架构 §2.2/§2.3）。
 *
 * Webview postMessage 通道伪装成 @zcode/rpc 的消息传递协议：
 * - send(VSBuffer)：VSBuffer 字节 → base64 → `{t:"rpc", b64}` 帧 → webview.postMessage；
 * - onMessage：webview 发来的 `{t:"rpc", b64}` 帧 → 还原 Uint8Array → VSBuffer → fire。
 *
 * 其余帧型（plat-* / host / flow）由 HostRuntime 分流到 PlatformRpcHandler /
 * host 帧推送；flow 帧在 host 侧仅记录（host→webview 方向不产生背压）。
 */

import { Emitter, type Event } from "@zcode/rpc";
import { VSBuffer, type IMessagePassingProtocol } from "@zcode/rpc";
import {
  base64ToBytes,
  bytesToBase64,
  parseBridgeEnvelope,
  type BridgeEnvelope,
  type PlatformRequestFrame,
} from "../bridge/wire";

/** 宿主侧对 webview 的最小发送面（vscode.Webview 结构兼容）。 */
export interface WebviewSender {
  postMessage(message: unknown): unknown;
}

export class HostBridgeProtocol implements IMessagePassingProtocol {
  private readonly _onMessage = new Emitter<VSBuffer>();
  readonly onMessage: Event<VSBuffer> = this._onMessage.event;
  private disposed = false;

  constructor(
    private readonly sender: WebviewSender,
    /** 非.rpc 帧的分流出口（HostRuntime 分发到平台 RPC / 日志）。 */
    private readonly dispatch: (frame: BridgeEnvelope) => void,
  ) {}

  /** chatPanel 的 onDidReceiveMessage 原样转发到这里。非法帧丢弃。 */
  handleRaw(data: unknown): void {
    if (this.disposed) return;
    const frame = parseBridgeEnvelope(data);
    if (!frame) {
      this.dispatch({ t: "plat-evt", event: "__invalid-frame", payload: data });
      return;
    }
    if (frame.t === "rpc") {
      // RPC 帧：base64 → 字节 → VSBuffer 进 ChannelServer/ChannelClient 栈。
      this._onMessage.fire(VSBuffer.wrap(base64ToBytes(frame.b64)));
      return;
    }
    // plat-* / host 方向的帧交给 HostRuntime 分流。
    this.dispatch(frame);
  }

  /** host → webview 的 RPC 二进制。 */
  send(buffer: VSBuffer): void {
    if (this.disposed) return;
    // VSBuffer.buffer 是 Uint8Array（可能带 offset/length 视图），按视图精确编码。
    void this.sender.postMessage({ t: "rpc", b64: bytesToBase64(buffer.buffer) });
  }

  dispose(): void {
    this.disposed = true;
    this._onMessage.dispose();
  }
}

/** 从桥帧中提取平台请求帧（HostRuntime 分流用）。 */
export function asPlatformRequest(frame: BridgeEnvelope): PlatformRequestFrame | null {
  return frame.t === "plat-req" ? frame : null;
}
