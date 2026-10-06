/**
 * 官方远控 rpc-frame 帧编解码（spec vps-relay-bridge.md §14.9）。
 *
 * 职责：把 Host 侧 `MessagePortProtocol` 的裸逻辑帧与官方数据面的
 * `rpc-frame`/`rpc-frame-ack` JSON 信封互转——分片、crc32 校验、物理/逻辑序号、
 * 逐 messageSeq ack、未 ack 重放（replayUnacknowledged）、gap 降级。
 *
 * 字段与常量逐字对齐官方 asar 还原结果（strict schema）：
 *   - 上限：单帧 1MiB、单逻辑消息 16MiB、最多 64 分片
 *   - seq = 物理信封序号（gap → rpc-frame-gap 降级）；messageSeq = 逻辑消息序号（ack 对象）
 *   - messageBytes = 整条逻辑消息长度；checksum = crc32（8 位小写 hex）对分片字节
 *
 * fork v1 与官方的已知偏差（均记录在 spec §14.9）：不做饱和流控
 * （saturated/drained → sendFlowState），背压由 WS 自身缓冲承担。
 */

/** 标准 CRC-32（IEEE 802.3，反射多项式 0xEDB88320），输出 8 位小写 hex。 */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32Hex(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

export const OFFICIAL_FRAME_LIMITS = {
  maxFrameBytes: 1024 * 1024,
  maxMessageBytes: 16 * 1024 * 1024,
  maxFragments: 64,
} as const;

export interface OfficialFrameIdentity {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
}

export interface OfficialFrameCodecOptions {
  identity: OfficialFrameIdentity;
  /** 编码后的信封经此发出；返回 false = 通道当前不可发（信封保留待重放）。 */
  sendEnvelope: (envelope: Record<string, unknown>) => boolean;
  /** 完整逻辑消息（Host 的一个逻辑帧）重组完成。 */
  onMessage: (bytes: Uint8Array) => void;
  /** 不可恢复问题（gap / 校验失败 / 超限）。 */
  onDegrade: (reason: string, detail?: Record<string, unknown>) => void;
  logger?: {
    warn(message: string, detail?: unknown): void;
    debug?(message: string, detail?: unknown): void;
  };
}

export interface OfficialFrameCodec {
  /** Host → phone：编码并发出一个逻辑帧。false = 未就绪/已降级/超限/通道不可发。 */
  sendFrame(bytes: Uint8Array): boolean;
  /** phone → device：处理一个 raw transport 信封（rpc-frame / rpc-frame-ack）。 */
  handleEnvelope(payload: Record<string, unknown>): void;
  /** 重连 send-ready 后重放未 ack 的信封（保持原 seq/messageSeq）。 */
  replayUnacknowledged(): void;
  isDegraded(): boolean;
  /** ready 门控（workspace-bridge-ready 发出后调用）。 */
  markReady(): void;
  dispose(): void;
}

function identityFields(identity: OfficialFrameIdentity): Record<string, unknown> {
  return {
    bridgeSessionId: identity.bridgeSessionId,
    ...(identity.bridgeGeneration !== undefined
      ? { bridgeGeneration: identity.bridgeGeneration }
      : {}),
    ...(identity.recoveryId ? { recoveryId: identity.recoveryId } : {}),
  };
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function createOfficialFrameCodec(options: OfficialFrameCodecOptions): OfficialFrameCodec {
  const { identity, sendEnvelope, onMessage, onDegrade, logger } = options;
  let ready = false;
  let degraded = false;
  let disposed = false;
  let outSeq = 0;
  let outMessageSeq = 0;
  /** messageSeq → 未 ack 的信封对象列表（重放时保持原序原 seq）。 */
  const pendingAcks = new Map<number, Record<string, unknown>[]>();
  /** 入向重组器：messageSeq → 分片缓冲。 */
  const inboundAssemblies = new Map<
    number,
    { fragmentCount: number; messageBytes: number; parts: Map<number, Uint8Array> }
  >();
  let expectedInboundSeq: number | null = null;

  function fail(reason: string, detail?: Record<string, unknown>): void {
    if (degraded || disposed) return;
    degraded = true;
    logger?.warn(`官方 rpc-frame 通道降级：${reason}`, detail);
    onDegrade(reason, detail);
  }

  function sendRaw(envelopes: Record<string, unknown>[]): boolean {
    for (const envelope of envelopes) {
      if (!sendEnvelope(envelope)) return false;
    }
    return true;
  }

  return {
    sendFrame(bytes: Uint8Array): boolean {
      if (disposed || degraded || !ready) return false;
      if (bytes.length > OFFICIAL_FRAME_LIMITS.maxMessageBytes) {
        fail("buffer-overflow", { messageBytes: bytes.length });
        return false;
      }
      const messageSeq = ++outMessageSeq;
      const fragmentCount = Math.max(
        1,
        Math.min(
          OFFICIAL_FRAME_LIMITS.maxFragments,
          Math.ceil(bytes.length / OFFICIAL_FRAME_LIMITS.maxFrameBytes),
        ),
      );
      // 分片过半数上限时收窄分片尺寸（16MiB / 64 片 = 256KiB 每片下限）。
      const chunkSize =
        fragmentCount > 1 ? Math.ceil(bytes.length / fragmentCount) : bytes.length;
      const jsons: Record<string, unknown>[] = [];
      for (let fragmentIndex = 0; fragmentIndex < fragmentCount; fragmentIndex++) {
        const piece = bytes.subarray(
          fragmentIndex * chunkSize,
          Math.min(bytes.length, (fragmentIndex + 1) * chunkSize),
        );
        const envelope = {
          zcode_type: "rpc-frame",
          ...identityFields(identity),
          seq: ++outSeq,
          messageSeq,
          fragmentIndex,
          fragmentCount,
          messageBytes: bytes.length,
          checksum: { algorithm: "crc32", value: crc32Hex(piece) },
          data: Buffer.from(piece).toString("base64"),
        };
        jsons.push(envelope);
      }
      pendingAcks.set(messageSeq, jsons);
      const sent = sendRaw(jsons);
      if (!sent) logger?.warn("官方 rpc-frame 部分信封未发出，保留待重放", { messageSeq });
      return sent;
    },

    handleEnvelope(payload: Record<string, unknown>): void {
      if (disposed || degraded) return;
      if (payload.zcode_type === "rpc-frame-ack") {
        const ackMessageSeq = payload.ackMessageSeq;
        if (!isPositiveSafeInteger(ackMessageSeq)) {
          fail("rpc-transport-fault", { problem: "invalid ackMessageSeq" });
          return;
        }
        pendingAcks.delete(ackMessageSeq);
        return;
      }
      if (payload.zcode_type !== "rpc-frame") {
        logger?.warn("raw transport 收到未知信封", { zcode_type: payload.zcode_type ?? null });
        return;
      }
      // identity 强校验：串桥/旧会话的帧直接忽略（官方 rawIdentityMatches 同语义）。
      if (
        payload.bridgeSessionId !== identity.bridgeSessionId ||
        (payload.bridgeGeneration !== undefined &&
          payload.bridgeGeneration !== identity.bridgeGeneration)
      ) {
        logger?.warn("rpc-frame 身份不匹配，忽略");
        return;
      }
      const seq = payload.seq;
      const messageSeq = payload.messageSeq;
      const fragmentIndex = payload.fragmentIndex;
      const fragmentCount = payload.fragmentCount;
      const messageBytes = payload.messageBytes;
      if (
        !isPositiveSafeInteger(seq) ||
        !isPositiveSafeInteger(messageSeq) ||
        !isPositiveSafeInteger(fragmentCount) ||
        typeof fragmentIndex !== "number" ||
        !Number.isSafeInteger(fragmentIndex) ||
        fragmentIndex < 0 ||
        !isPositiveSafeInteger(messageBytes)
      ) {
        fail("rpc-transport-fault", { problem: "invalid frame fields" });
        return;
      }
      // seq gap：信封通道（WS）本身有序，出现跳号 = 对端实现异常 → 降级。
      if (expectedInboundSeq !== null && seq !== expectedInboundSeq) {
        fail("rpc-frame-gap", { seq, expectedSeq: expectedInboundSeq });
        return;
      }
      expectedInboundSeq = seq + 1;

      const data = typeof payload.data === "string" ? payload.data : "";
      let piece: Uint8Array;
      try {
        piece = new Uint8Array(Buffer.from(data, "base64"));
      } catch {
        fail("rpc-transport-fault", { problem: "invalid base64" });
        return;
      }
      const checksum = payload.checksum as { algorithm?: unknown; value?: unknown } | undefined;
      if (
        !checksum ||
        checksum.algorithm !== "crc32" ||
        checksum.value !== crc32Hex(piece)
      ) {
        fail("rpc-transport-fault", { problem: "checksum mismatch", messageSeq });
        return;
      }

      let assembly = inboundAssemblies.get(messageSeq);
      if (!assembly) {
        if (fragmentCount > OFFICIAL_FRAME_LIMITS.maxFragments || messageBytes > OFFICIAL_FRAME_LIMITS.maxMessageBytes) {
          fail("buffer-overflow", { messageSeq, messageBytes });
          return;
        }
        assembly = { fragmentCount, messageBytes, parts: new Map() };
        inboundAssemblies.set(messageSeq, assembly);
      }
      if (assembly.parts.has(fragmentIndex)) {
        // 重复分片：幂等重 ack（官方 duplicate 分支同语义）。
        sendEnvelope({ zcode_type: "rpc-frame-ack", ...identityFields(identity), ackMessageSeq: messageSeq });
        return;
      }
      assembly.parts.set(fragmentIndex, piece);
      if (assembly.parts.size < assembly.fragmentCount) return;

      // 重组完成：按序拼接并校验总长。
      const total = [...assembly.parts.values()].reduce((sum, part) => sum + part.byteLength, 0);
      if (total !== assembly.messageBytes) {
        inboundAssemblies.delete(messageSeq);
        fail("rpc-transport-fault", { problem: "message length mismatch", messageSeq, total });
        return;
      }
      const full = new Uint8Array(total);
      let offset = 0;
      for (let index = 0; index < assembly.fragmentCount; index++) {
        const part = assembly.parts.get(index) as Uint8Array;
        full.set(part, offset);
        offset += part.byteLength;
      }
      inboundAssemblies.delete(messageSeq);
      sendEnvelope({ zcode_type: "rpc-frame-ack", ...identityFields(identity), ackMessageSeq: messageSeq });
      onMessage(full);
    },

    replayUnacknowledged(): void {
      if (disposed || degraded) return;
      for (const jsons of pendingAcks.values()) {
        if (!sendRaw(jsons)) return;
      }
    },

    isDegraded: () => degraded,
    markReady() {
      ready = true;
    },
    dispose() {
      disposed = true;
      pendingAcks.clear();
      inboundAssemblies.clear();
    },
  };
}
