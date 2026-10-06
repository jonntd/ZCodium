// remote-relay-e2ee 的单元测试（spec vps-relay-bridge.md §16.7）。
//
// 覆盖握手两个方向、双向 record 往返、以及必须 fail-closed 的攻击面：
// 篡改、错 channelKey（MITM/错配置）、seq 重放、对端非 E2EE、角色冲突、
// 出站缓冲上界、host 顶替 → 重新握手且旧会话 record 作废。
//
// 管道模型：每个 endpoint 一条 **FIFO** 出站队列 + 全网泵逐条投递。
// 真实系统里单条 WS 保证同方向 FIFO（hello 必先于对端 confirm 到达），
// 泵必须保持这一不变式——早期版本用「信箱后投递」破坏了它，测出的是假问题。
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RelayE2eeChannel,
  decodeRelayChannelKey,
  decryptRelayReport,
  encryptRelayReport,
  generateRelayChannelKey,
  type RelayE2eeRole,
} from "../src/remote-relay-e2ee.ts";

const KEY = generateRelayChannelKey();

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const toText = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

interface Endpoint {
  role: RelayE2eeRole;
  channel: RelayE2eeChannel;
  /** 对端发来的应用帧（明文，按序）。 */
  received: string[];
  fatal: Error | null;
  /** 本端出口 wire 字节拷贝（篡改/重放测试用）。 */
  captured: Uint8Array[];
  peer: { channel: RelayE2eeChannel | null };
  queue: Uint8Array[];
  disposePeer: () => void;
}

const endpoints: Endpoint[] = [];
let pumping = false;

function pump(): void {
  if (pumping) return;
  pumping = true;
  try {
    // 全网泵：任意非空队列投一条（保持每条队列自身 FIFO），直到无可投递。
    // 注意：fatal 端点**已发出**、尚在队列里的消息仍要投递（真实系统里它们已在线上）。
    for (;;) {
      const ready = endpoints.find(
        (ep) => ep.queue.length > 0 && ep.peer.channel !== null,
      );
      if (!ready) break;
      const data = ready.queue.shift();
      if (data) ready.peer.channel?.accept(data);
    }
  } finally {
    pumping = false;
  }
}

function createEndpoint(role: RelayE2eeRole, channelKey: string): Endpoint {
  const endpoint: Endpoint = {
    role,
    channel: undefined as unknown as RelayE2eeChannel,
    received: [],
    fatal: null,
    captured: [],
    peer: { channel: null },
    queue: [],
    disposePeer: () => {},
  };
  endpoint.channel = new RelayE2eeChannel({
    role,
    channelKey,
    send: (data) => {
      endpoint.captured.push(new Uint8Array(data));
      endpoint.queue.push(new Uint8Array(data));
      pump();
    },
    onPlaintext: (data) => endpoint.received.push(toText(data)),
    onFatal: (error) => {
      endpoint.fatal = error;
    },
  });
  endpoints.push(endpoint);
  pump();
  return endpoint;
}

function link(a: Endpoint, b: Endpoint): void {
  a.peer.channel = b.channel;
  b.peer.channel = a.channel;
  pump();
}

/** 两端即连即握手的默认环境（host 先构造，对应桌面先连）。 */
function createLinkedPair(phoneKey = KEY): { host: Endpoint; phone: Endpoint } {
  const phone = createEndpoint("phone", phoneKey);
  const host = createEndpoint("host", KEY);
  link(host, phone);
  return { host, phone };
}

function dataRecords(endpoint: Endpoint): Uint8Array[] {
  return endpoint.captured.filter((d) => d[0] === 0xc1);
}

test("握手 + 双向 record 往返：明文逐字节一致且有序", () => {
  const { host, phone } = createLinkedPair();
  assert.ok(host.channel.isSecure(), "host 应进入 secure");
  assert.ok(phone.channel.isSecure(), "phone 应进入 secure");

  host.channel.write(utf8("initialize-frame"));
  host.channel.write(utf8("second-frame"));
  phone.channel.write(utf8("rpc-request"));
  assert.deepEqual(phone.received, ["initialize-frame", "second-frame"]);
  assert.deepEqual(host.received, ["rpc-request"]);
});

test("secure 前出站帧入队缓冲，握手完成后按序冲刷", () => {
  // host 先上线（对应桌面先连），phone 还没接入：write 的帧进通道内缓冲。
  const host = createEndpoint("host", KEY);
  host.channel.write(utf8("early-initialize"));
  assert.equal(host.channel.isSecure(), false);

  const phone = createEndpoint("phone", KEY);
  link(host, phone);

  assert.ok(host.channel.isSecure());
  assert.ok(phone.channel.isSecure());
  assert.deepEqual(phone.received, ["early-initialize"]);
});

test("线上字节不含明文（中继视角密文不可读）", () => {
  const { host, phone } = createLinkedPair();
  host.captured.length = 0; // 只看握手后的数据 record
  host.channel.write(utf8("SECRET-PLAINTEXT-MARKER"));
  assert.deepEqual(phone.received, ["SECRET-PLAINTEXT-MARKER"]);
  const raw = Buffer.concat(host.captured.map((b) => Buffer.from(b))).toString("latin1");
  assert.ok(!raw.includes("SECRET-PLAINTEXT-MARKER"), "wire 字节里不得出现明文");
});

test("篡改 record（保持 seq 合法）→ 解密失败 fatal，不产出明文", () => {
  const { host, phone } = createLinkedPair();
  host.channel.write(utf8("frame-0"));
  assert.deepEqual(phone.received, ["frame-0"]);

  // 伪造下一条：seq 改成 phone 期望的 1，再翻转 tag 最后一字节（AEAD 必须拒绝）。
  const forged = new Uint8Array(dataRecords(host)[0] ?? new Uint8Array());
  assert.equal(forged[0], 0xc1);
  forged[8] = 1;
  forged[forged.length - 1] = (forged[forged.length - 1] ?? 0) ^ 0xff;
  phone.channel.accept(forged);
  assert.ok(phone.fatal, "篡改必须 fatal");
  assert.equal(phone.received.length, 1, "fatal 后不产出明文");
});

test("record 重放（同一条发两次）→ 第二次因 seq 不连续 fatal", () => {
  const { host, phone } = createLinkedPair();
  host.channel.write(utf8("only-once"));
  const record = dataRecords(host)[0];
  assert.ok(record, "应有数据 record");
  assert.deepEqual(phone.received, ["only-once"]);

  phone.channel.accept(record); // 重放：seq 已消费
  assert.match(phone.fatal?.message ?? "", /seq/u);
});

test("错 channelKey（MITM/错配置）→ 双端 confirm 校验失败", () => {
  const { host, phone } = createLinkedPair(generateRelayChannelKey());
  assert.match(host.fatal?.message ?? "", /confirm 校验失败/u);
  assert.match(phone.fatal?.message ?? "", /confirm 校验失败/u);
});

test("对端消息非 E2EE 格式（旧 bundle 直发 SocketProtocol 帧）→ 立即 fatal", () => {
  const { phone } = createLinkedPair();
  phone.channel.accept(utf8("\x00\x00\x00\x00legacy-socket-protocol-frame"));
  assert.match(phone.fatal?.message ?? "", /未启用端到端加密/u);
});

test("角色冲突（双方都是 host）→ fatal", () => {
  const a = createEndpoint("host", KEY);
  const b = createEndpoint("host", KEY);
  link(a, b);
  assert.match(a.fatal?.message ?? "", /角色冲突/u);
  assert.match(b.fatal?.message ?? "", /角色冲突/u);
});

test("channelKey 生成/解析 roundtrip，长度可校验", () => {
  const key = generateRelayChannelKey();
  assert.equal(decodeRelayChannelKey(key).length, 32);
  assert.deepEqual(
    Array.from(decodeRelayChannelKey(key)),
    Array.from(decodeRelayChannelKey(key)),
  );
  assert.throws(() => decodeRelayChannelKey("aW52YWxpZA"), /长度应为/u);
});

test("host 被顶替：phone 收到新 hello → 重新握手，旧会话 record 作废", () => {
  const { host, phone } = createLinkedPair();
  assert.ok(phone.channel.isSecure());

  // 顶替前截获一条旧会话 record（模拟中继留存）。
  host.channel.write(utf8("old-session-frame"));
  const staleRecord = new Uint8Array(dataRecords(host)[0] ?? new Uint8Array());
  assert.ok(staleRecord.length > 0);

  // 旧 host 下线（不再投递），新 host（新 eph 密钥）接管 phone。
  host.peer.channel = null;
  const newHost = createEndpoint("host", KEY);
  newHost.peer.channel = phone.channel;
  phone.peer.channel = newHost.channel;
  pump();

  assert.ok(newHost.channel.isSecure(), "新 host 完成重新握手");
  assert.ok(phone.channel.isSecure(), "phone 重新进入 secure");

  // 新会话正常通信。
  newHost.channel.write(utf8("post-rehandshake"));
  assert.ok(phone.received.includes("post-rehandshake"), "重新握手后新会话帧可达");

  // 旧会话 record 在新会话里必须无效：seq 恰好归零对得上，但密钥已换 → 解密失败。
  phone.fatal = null;
  phone.channel.accept(staleRecord);
  assert.ok(phone.fatal, "旧会话 record 不得在新会话中被接受");
  assert.equal(phone.received.at(-1), "post-rehandshake");
});

test("出站缓冲溢出 → fatal（保流完整，不静默丢帧）", () => {
  const host = createEndpoint("host", KEY);
  for (let i = 0; i < 65; i += 1) {
    host.channel.write(utf8(`frame-${i}`));
  }
  assert.ok(host.fatal, "超过 64 条应 fatal");
  assert.match(host.fatal?.message ?? "", /缓冲溢出/u);
});

// ─── host-report 信封加密（spec §16.9）──────────────────────────────────────

test("report 信封：加解密往返逐字节保真", () => {
  const plaintext = JSON.stringify({
    workspacePath: "/Users/demo/project",
    hostLabel: "demo-mac",
    appVersion: "3.14.9",
  });
  const envelope = encryptRelayReport(KEY, plaintext);
  assert.equal(envelope.v, 1);
  assert.equal(envelope.e2ee, true);
  assert.equal(decryptRelayReport(KEY, envelope), plaintext);
});

test("report 信封：篡改 ciphertext / 错 key 都必须抛错（fail-closed）", () => {
  const envelope = encryptRelayReport(KEY, '{"workspacePath":"/x"}');
  const tampered = {
    ...envelope,
    ciphertext: envelope.ciphertext.slice(0, -4) + "AAAA",
  };
  assert.throws(() => decryptRelayReport(KEY, tampered));
  const otherKey = generateRelayChannelKey();
  assert.throws(() => decryptRelayReport(otherKey, envelope));
});

