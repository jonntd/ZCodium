/**
 * ChannelServer 非法帧容错回归（spec vps-relay-bridge.md §14.9）。
 *
 * 真桌面事故：路线 B 远控桥把「不是 RPC 帧」的字节喂进 Host 的 ChannelServer，
 * `deserialize` 的结果不是数组 ⇒ `header[0]` 抛 TypeError ⇒ uncaughtException
 * 崩掉整个 Host 进程（Host 无自动重启，只能重启桌面才恢复）。
 * 本套件用真 ChannelServer + 假协议直接投递裸字节，锁定两点：
 *   1. 非法帧按协议错误丢弃 + 记警，绝不抛出；
 *   2. 丢完非法帧之后，合法 RPC 仍然照常服务。
 * 另附终端页「直连模式」探测帧（PromiseCancel + 未知 id）的语义：合法、静默、零响应。
 *
 * 运行：node --import tsx --test packages/desktop/tests/rpc-channel-server-frame-tolerance.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BufferReader,
  BufferWriter,
  ChannelServer,
  Emitter,
  VSBuffer,
  deserialize,
  serialize,
} from "@zcode/rpc";

// channels.shared.ts 里是 const enum（编译期擦除），测试侧用字面量对齐，避免运行期取值。
const REQUEST_PROMISE = 100;
const REQUEST_PROMISE_CANCEL = 101;
const RESPONSE_INITIALIZE = 200;
const RESPONSE_PROMISE_SUCCESS = 201;

/** 假协议：send 收进 outbox；deliver 把裸字节投给 server（等价于 Host 收到 port 消息）。 */
function createHarness() {
  const emitter = new Emitter();
  const outbox = [];
  const server = new ChannelServer(
    { send: (buffer) => outbox.push(buffer), onMessage: emitter.event },
    "test-ctx",
  );
  return {
    server,
    outbox,
    deliver: (bytes) => emitter.fire(VSBuffer.wrap(Uint8Array.from(bytes))),
    /** 已发出的响应逐条解码成 { header, body }。 */
    responses: () =>
      outbox.map((buffer) => {
        const reader = new BufferReader(buffer);
        return { header: deserialize(reader), body: deserialize(reader) };
      }),
  };
}

/** 按 RPC 序列化格式编一条逻辑消息（header + body）。 */
function encode(header, body) {
  const writer = new BufferWriter();
  serialize(writer, header);
  serialize(writer, body);
  return writer.buffer.buffer;
}

async function waitFor(fn, label, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`等待 ${label} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function registerEchoChannel(harness) {
  harness.server.registerChannel("echo", {
    call: async (_ctx, command, arg) => `${command}:${arg}`,
    listen: () => () => ({ dispose() {} }),
  });
}

test("非法帧（裸文本 / 随机字节 / 截断）不抛错，RPC 服务继续可用", async () => {
  const h = createHarness();
  registerEchoChannel(h);
  h.outbox.length = 0; // 丢掉构造期的 Initialize

  const garbage = [
    new TextEncoder().encode("echo-1759-终端→设备回显测试"), // 真桌面事故的原始载荷
    new Uint8Array([0xff, 0xff, 0xff, 0xff]),
    new Uint8Array([4]), // Array 标签后截断
    new Uint8Array([6, 0x80]), // Int 标签 + 未结束的 VQL
    new Uint8Array([]),
  ];
  for (const bytes of garbage) {
    assert.doesNotThrow(() => h.deliver(bytes), `投递垃圾帧不得抛错（${bytes.length}B）`);
  }

  // 容错之后必须还能正常服务：合法 Promise 请求照常被应答。
  h.deliver(encode([REQUEST_PROMISE, 1, "echo", "greet"], "hi"));
  const success = await waitFor(
    () => h.responses().find((r) => r.header[0] === RESPONSE_PROMISE_SUCCESS),
    "PromiseSuccess",
  );
  assert.equal(success.header[1], 1);
  assert.equal(success.body, "greet:hi");
});

test("非法帧按协议错误记警，不静默吞掉", (t) => {
  const warn = t.mock.method(console, "warn");
  const h = createHarness();
  h.outbox.length = 0;

  h.deliver(new TextEncoder().encode("not-an-rpc-frame"));

  assert.equal(warn.mock.callCount(), 1, "每帧非法帧记警一次");
  assert.match(String(warn.mock.calls[0].arguments[1]), /undecodable|malformed/);
});

test("合法探测帧（PromiseCancel + 未知 id）被静默忽略：零响应、零抛错", async () => {
  const h = createHarness();
  h.outbox.length = 0;

  assert.doesNotThrow(() => h.deliver(encode([REQUEST_PROMISE_CANCEL, 7], undefined)));
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(h.responses().length, 0, "探测帧不得产生任何响应");
});

test("构造期 Initialize 仍是首个出向响应（容错未改握手）", () => {
  const h = createHarness();
  assert.equal(h.responses()[0].header[0], RESPONSE_INITIALIZE);
});
