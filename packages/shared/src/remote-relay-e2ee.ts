/**
 * VPS 中继端到端加密（E2EE）—— spec `docs/spec/vps-relay-bridge.md` §16。
 *
 * 目标：中继（VPS）看不到任何明文。中继仍是哑管道（**零改动**），加密发生在两端：
 * 桌面 Main（`remoteRelayClient`）与手机 web bundle（`connectViaWebSocket`）。
 * 本模块是双端**唯一**实现，只依赖 `@noble/*`（纯 JS、同步 API）：
 * - 不用 WebCrypto `subtle`：它只在 secure context 可用，`http://<局域网IP>`（内网场景）下
 *   为 undefined；且异步 API 与 `ISocket` 的同步 write/onData 契约相性差（需保序队列）。
 * - x25519 ECDH 提供 PFS（channelKey 事后泄露不破解已录流量——链接被贴进聊天是常态）；
 *   PSK（channelKey）绑定握手，使中继无法各建两条 ECDH 做 MITM。
 *
 * 密钥分发（§16.2）：channelKey 走分享链接的 **URL fragment**（`#k=`）。浏览器不把
 * fragment 发给服务器，所以中继拿不到它——这也是 `RELAY_TOKEN` 不能当 PSK 的原因
 * （它经 `GET /?token=` 明文到达 TLS 终结点）。
 *
 * 线格式（§16.3，一条 WS 消息 = 一条消息，relay 1:1 转发保边界）：
 * ```text
 * hello   "ZRE1" + role(1B) + ephPub(32B) + nonce(32B)            —— 两端构造即发
 * confirm "ZRC1" + mac(32B) = HMAC(k_confirm, label|role|双方hello) —— 验证通过前不处理应用帧
 * record  0xC1 + seq(u64 BE) + ChaCha20-Poly1305(ad=头部, pt=一帧 SocketProtocol payload)
 * ```
 * 密钥：`ikm = channelKey ‖ ecdh`，`salt = nonceHost ‖ noncePhone`，
 * HKDF-SHA256 派生 `k_hostOut` / `k_phoneOut` / `k_confirm`（方向分离 ⇒ nonce 不跨方向复用）。
 * **严格 seq**：只接受等于本方向期望值的 seq（TCP 保序之下的重放/乱序防护）；
 * 跨会话因 eph 密钥更换天然失效。任何校验失败都 fatal（fail-closed），调用方必须断开。
 */

import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";

export type RelayE2eeRole = "host" | "phone";

/** channelKey 的字节长度（base64url 编码前）。 */
export const RELAY_E2EE_CHANNEL_KEY_BYTES = 32;

const HELLO_MAGIC = new Uint8Array([0x5a, 0x52, 0x45, 0x31]); // "ZRE1"
const CONFIRM_MAGIC = new Uint8Array([0x5a, 0x52, 0x43, 0x31]); // "ZRC1"
const RECORD_TYPE_DATA = 0xc1;
const ROLE_HOST_BYTE = 1;
const ROLE_PHONE_BYTE = 2;
const NONCE_BYTES = 32;
const HELLO_BYTES = 4 + 1 + 32 + NONCE_BYTES; // 69
const CONFIRM_BYTES = 4 + 32;
const RECORD_HEADER_BYTES = 1 + 8; // type + seq
const TAG_BYTES = 16;
/**
 * 握手完成前 host 侧出站缓冲上限（spec §16.4）：Host attach 即发 Initialize，而 secure
 * 要等手机 hello 走完一个 RTT。**溢出 fatal 而不是丢最旧**——这是 RPC 流不是广播流，
 * 静默丢帧等于破坏流（relay 侧缓冲可以丢最旧是因为回放语义只关心 Initialize）。
 */
const OUTBOUND_MAX_RECORDS = 64;
const OUTBOUND_MAX_BYTES = 1024 * 1024;

const HKDF_INFO_PREFIX = "zcode-relay-e2ee v1 ";
const CONFIRM_LABEL = "zcode-relay-e2ee confirm v1";

function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  if (bytes.length < prefix.length) return false;
  return bytesEqual(bytes.subarray(0, prefix.length), prefix);
}

function seqToBytes(seq: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let value = seq;
  for (let i = 7; i >= 0; i -= 1) {
    out[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return out;
}

function bytesToSeq(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte ?? 0);
  return value;
}

/** ChaCha20-Poly1305 的 12B nonce：前 4B 恒零 + 8B seq（方向密钥分离 ⇒ 不复用）。 */
function recordNonce(seq: bigint): Uint8Array {
  return concat(new Uint8Array(4), seqToBytes(seq));
}

export function generateRelayChannelKey(): string {
  const bytes = new Uint8Array(RELAY_E2EE_CHANNEL_KEY_BYTES);
  // getRandomValues 在非 secure context 同样可用（内网 http 场景必须）。
  globalThis.crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte ?? 0);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

export function decodeBase64Url(text: string): Uint8Array {
  const padded = text.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(`${padded}${"=".repeat((4 - (padded.length % 4)) % 4)}`);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/** 解析并校验配置里的 channelKey；格式不对时抛错（调用方应拒绝启用 E2EE）。 */
export function decodeRelayChannelKey(channelKey: string): Uint8Array {
  const bytes = decodeBase64Url(channelKey.trim());
  if (bytes.length !== RELAY_E2EE_CHANNEL_KEY_BYTES) {
    throw new Error(
      `channelKey 长度应为 ${RELAY_E2EE_CHANNEL_KEY_BYTES} 字节（base64url），实际 ${bytes.length}`,
    );
  }
  return bytes;
}

interface HandshakeSecrets {
  /** host→client 方向的 AEAD key。 */
  hostOut: Uint8Array;
  /** client→host 方向的 AEAD key。 */
  phoneOut: Uint8Array;
  confirm: Uint8Array;
}

function deriveSecrets(
  psk: Uint8Array,
  ecdhShared: Uint8Array,
  nonceHost: Uint8Array,
  noncePhone: Uint8Array,
): HandshakeSecrets {
  const ikm = concat(psk, ecdhShared);
  const salt = concat(nonceHost, noncePhone);
  const derive = (usage: string): Uint8Array =>
    hkdf(sha256, ikm, salt, utf8(`${HKDF_INFO_PREFIX}${usage}`), 32);
  return {
    hostOut: derive("host-out"),
    phoneOut: derive("phone-out"),
    confirm: derive("confirm"),
  };
}

export interface RelayE2eeChannelOptions {
  role: RelayE2eeRole;
  /** base64url 的 32B channelKey（来自配置文件 / 链接 `#k=`）。 */
  channelKey: string;
  /** 底层 WS 出口：发送一条完整 WS 消息（hello / confirm / record）。 */
  send: (data: Uint8Array) => void;
  /** 解密后的应用帧（SocketProtocol payload），严格按对端发送顺序回调。 */
  onPlaintext: (data: Uint8Array) => void;
  /**
   * 不可恢复错误（对端未启用 E2EE / 错 channelKey / 篡改 / 乱序重放）。
   * 调用方必须断开底层连接——本通道此后不再产出任何输出。
   */
  onFatal: (error: Error) => void;
  logger?: { warn(message: string, detail?: unknown): void };
}

type RelayE2eeState = "awaiting-peer-hello" | "awaiting-peer-confirm" | "secure" | "fatal";

/**
 * 单条 WS 连接上的 E2EE 通道。
 *
 * 用法（两端对称）：构造即发出 hello（relay 在手机未配对时会缓冲回放，与 Initialize
 * 缓冲同构，spec §12.3.1）；`accept()` 喂入每条 WS 消息；`write()` 提交应用帧
 * （secure 前自动入队，secure 后按序冲刷）。应用帧之上是既有的 `SocketProtocol`，
 * 本模块只负责「一条 WS 消息 ⇄ 一帧 payload」。
 */
export class RelayE2eeChannel {
  private readonly options: RelayE2eeChannelOptions;
  private readonly psk: Uint8Array;
  private state: RelayE2eeState;
  private ownPriv: Uint8Array;
  /** transcript 用：按角色保存双方 hello 原文（host 在前做 transcript 规范序）。 */
  private helloByRole: { host: Uint8Array | null; phone: Uint8Array | null };
  private secrets: HandshakeSecrets | null = null;
  private sendSeq = 0n;
  private recvSeq = 0n;
  private outboundQueue: Array<{ data: Uint8Array; bytes: number }> = [];
  private outboundBytes = 0;
  private disposed = false;

  constructor(options: RelayE2eeChannelOptions) {
    this.options = options;
    this.psk = decodeRelayChannelKey(options.channelKey);
    this.state = "awaiting-peer-hello";
    this.helloByRole = { host: null, phone: null };
    this.ownPriv = x25519.utils.randomPrivateKey();
    // 构造即发 hello：两端都在 WS open 时构造本通道，无需等对端。
    this.sendHello();
  }

  isSecure(): boolean {
    return this.state === "secure";
  }

  dispose(): void {
    this.disposed = true;
    this.state = "fatal";
    // 密钥材料尽快失活（best-effort：JS 无法保证内存清零，但避免残留在可复用对象里）。
    this.ownPriv.fill(0);
    this.psk.fill(0);
    this.secrets = null;
    this.outboundQueue = [];
    this.outboundBytes = 0;
  }

  /** 提交一条应用帧（明文）。secure 前入队缓冲（有界），secure 后立即按序加密发出。 */
  write(data: Uint8Array): void {
    if (this.disposed) return;
    if (this.state !== "secure") {
      this.outboundQueue.push({ data, bytes: data.length });
      this.outboundBytes += data.length;
      if (
        this.outboundQueue.length > OUTBOUND_MAX_RECORDS ||
        this.outboundBytes > OUTBOUND_MAX_BYTES
      ) {
        this.fatal(
          new Error("E2EE 握手完成前出站缓冲溢出（对端长时间未完成握手），为保流完整主动断开"),
        );
      }
      return;
    }
    this.sendRecord(data);
  }

  /** 喂入一条底层 WS 消息（必须是一条完整消息：relay 保证 1:1 转发保边界）。 */
  accept(data: Uint8Array): void {
    if (this.disposed) return;
    try {
      if (startsWith(data, HELLO_MAGIC)) {
        this.acceptHello(data);
        return;
      }
      if (startsWith(data, CONFIRM_MAGIC)) {
        this.acceptConfirm(data);
        return;
      }
      if (data[0] === RECORD_TYPE_DATA) {
        this.acceptRecord(data);
        return;
      }
      throw new Error("对端消息不是 ZRE1 E2EE 格式（对端未启用端到端加密或 bundle 过旧）");
    } catch (error) {
      this.fatal(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private fatal(error: Error): void {
    if (this.disposed) return;
    // 先置 fatal 再回调：保证 onFatal 触发后本通道不再产出任何输出（fail-closed）。
    this.dispose();
    this.options.logger?.warn("[remote-relay-e2ee] 通道失败", error.message);
    this.options.onFatal(error);
  }

  private sendHello(): void {
    const roleByte = this.options.role === "host" ? ROLE_HOST_BYTE : ROLE_PHONE_BYTE;
    const hello = concat(
      HELLO_MAGIC,
      new Uint8Array([roleByte]),
      x25519.getPublicKey(this.ownPriv),
      this.randomNonce(),
    );
    this.helloByRole[this.options.role] = hello;
    this.options.send(hello);
  }

  private randomNonce(): Uint8Array {
    const nonce = new Uint8Array(NONCE_BYTES);
    globalThis.crypto.getRandomValues(nonce);
    return nonce;
  }

  private acceptHello(data: Uint8Array): void {
    if (data.length !== HELLO_BYTES) {
      throw new Error(`hello 长度应为 ${HELLO_BYTES}，实际 ${data.length}`);
    }
    const peerRoleByte = data[4] ?? 0;
    const peerRole: RelayE2eeRole = peerRoleByte === ROLE_HOST_BYTE ? "host" : "phone";
    if (peerRole === this.options.role) {
      throw new Error(`hello 角色冲突（双方都是 ${peerRole}）`);
    }
    // 手机端在 secure 后收到新 hello = host 被顶替（桌面重连后新 attachment），
    // 按设计走**重新握手**：新 eph/新密钥/seq 归零，旧会话状态全部作废（spec §16.4）。
    if (this.state === "secure" || this.state === "awaiting-peer-confirm") {
      this.options.logger?.warn("[remote-relay-e2ee] 收到新 hello，重新握手（对端换代）");
      this.ownPriv.fill(0);
      this.ownPriv = x25519.utils.randomPrivateKey();
      this.secrets = null;
      this.sendSeq = 0n;
      this.recvSeq = 0n;
      this.helloByRole = { host: null, phone: null };
      this.state = "awaiting-peer-hello";
      // 必须重发自己的 hello：旧 hello 属于已作废的会话，不能进新 transcript。
      this.sendHello();
    }
    if (this.state !== "awaiting-peer-hello") {
      throw new Error(`hello 到达时机错误（状态 ${this.state}）`);
    }
    this.helloByRole[peerRole] = data;

    const peerPub = data.subarray(5, 5 + 32);
    const ownNonce = (this.helloByRole[this.options.role] as Uint8Array).subarray(37, 69);
    const ecdhShared = x25519.getSharedSecret(this.ownPriv, peerPub);
    const nonceHost =
      this.options.role === "host" ? ownNonce : data.subarray(37, 69);
    const noncePhone =
      this.options.role === "host" ? data.subarray(37, 69) : ownNonce;
    this.secrets = deriveSecrets(this.psk, ecdhShared, nonceHost, noncePhone);

    // confirm 立即发：对端验证通过即 secure，无额外 RTT（与各自 hello 并行在途）。
    this.sendConfirm();
    this.state = "awaiting-peer-confirm";
  }

  private sendConfirm(): void {
    if (!this.secrets) throw new Error("confirm 前必须完成密钥派生");
    const mac = this.computeConfirmMac(this.options.role);
    this.options.send(concat(CONFIRM_MAGIC, mac));
  }

  private transcript(): Uint8Array {
    const hostHello = this.helloByRole.host;
    const phoneHello = this.helloByRole.phone;
    if (!hostHello || !phoneHello) throw new Error("transcript 需要双方 hello");
    return concat(hostHello, phoneHello);
  }

  private computeConfirmMac(role: RelayE2eeRole): Uint8Array {
    if (!this.secrets) throw new Error("confirm 前必须完成密钥派生");
    const roleByte = role === "host" ? ROLE_HOST_BYTE : ROLE_PHONE_BYTE;
    return hmac(sha256, this.secrets.confirm, concat(utf8(CONFIRM_LABEL), new Uint8Array([roleByte]), this.transcript()));
  }

  private acceptConfirm(data: Uint8Array): void {
    if (this.state !== "awaiting-peer-confirm") {
      throw new Error(`confirm 到达时机错误（状态 ${this.state}）`);
    }
    if (data.length !== CONFIRM_BYTES) {
      throw new Error(`confirm 长度应为 ${CONFIRM_BYTES}，实际 ${data.length}`);
    }
    if (!this.secrets) throw new Error("confirm 校验前必须完成密钥派生");
    // 对端 confirm 带对端角色 tag：反射（把己方 confirm 弹回来）会因 tag 不符而失败。
    const peerRole: RelayE2eeRole = this.options.role === "host" ? "phone" : "host";
    const expected = this.computeConfirmMac(peerRole);
    if (!bytesEqual(data.subarray(4), expected)) {
      throw new Error("confirm 校验失败（channelKey 不一致或中间人篡改）");
    }
    this.state = "secure";
    this.flushOutbound();
  }

  private flushOutbound(): void {
    const queue = this.outboundQueue;
    this.outboundQueue = [];
    this.outboundBytes = 0;
    for (const item of queue) this.sendRecord(item.data);
  }

  private directionKey(outgoing: boolean): Uint8Array {
    if (!this.secrets) throw new Error("尚未完成握手");
    if (outgoing) {
      return this.options.role === "host" ? this.secrets.hostOut : this.secrets.phoneOut;
    }
    return this.options.role === "host" ? this.secrets.phoneOut : this.secrets.hostOut;
  }

  private sendRecord(plaintext: Uint8Array): void {
    const header = new Uint8Array([RECORD_TYPE_DATA, ...Array.from(seqToBytes(this.sendSeq))]);
    const cipher = chacha20poly1305(this.directionKey(true), recordNonce(this.sendSeq), header);
    this.options.send(concat(header, cipher.encrypt(plaintext)));
    this.sendSeq += 1n;
  }

  private acceptRecord(data: Uint8Array): void {
    if (this.state !== "secure") {
      throw new Error("confirm 校验通过前收到数据记录（协议违规）");
    }
    if (data.length < RECORD_HEADER_BYTES + TAG_BYTES) {
      throw new Error("数据记录过短");
    }
    const header = data.subarray(0, RECORD_HEADER_BYTES);
    const seq = bytesToSeq(data.subarray(1, RECORD_HEADER_BYTES));
    // 严格 seq：TCP 已保序，非期望值只能是重放/注入/内部错误。
    if (seq !== this.recvSeq) {
      throw new Error(`数据记录 seq 不连续（期望 ${this.recvSeq}，收到 ${seq}）`);
    }
    const cipher = chacha20poly1305(this.directionKey(false), recordNonce(seq), header);
    const plaintext = cipher.decrypt(data.subarray(RECORD_HEADER_BYTES));
    this.recvSeq += 1n;
    this.options.onPlaintext(plaintext);
  }
}
