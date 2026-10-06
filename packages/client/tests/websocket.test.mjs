// connectViaWebSocket 的交付点语义测试（spec §12.3.1「残留缺口」）。
//
// 覆盖「WS open ≠ 通道可用」这条最容易误判的边界：
//   - open 之后、Initialize 之前不得 resolve（否则调用方拿到死通道、渲染空壳且无重试入口）
//   - Initialize 到达才 resolve；之后断开只触发 onClose，不改变已交付的结果
//   - open 之后、Initialize 之前断开（relay 宽限到期 4002）：reject，交给调用方渲染错误页
//   - 一直不 Initialize：超时 reject 并主动关掉 socket，不留僵尸连接
//
// 用假 WebSocket + 真 ChannelServer 驱动真实的 connectViaWebSocket：
// Initialize 由 ChannelServer 构造时发出，帧格式与 relay / 服务端路径完全一致。
import assert from "node:assert/strict";
import { test } from "node:test";
import { ChannelServer, Emitter, SocketProtocol, VSBuffer } from "@zcode/rpc";
import { connectViaWebSocket } from "../src/websocket.ts";

/**
 * 安装假 WebSocket 并暴露「测试驱动」入口。
 *
 * 产品代码只用到 addEventListener/send/close/readyState/binaryType，
 * 所以假实现可以在不开端口的前提下精确控制 open / 帧 / close 的时序。
 */
function installFakeWebSocket(t) {
  const originalWebSocket = globalThis.WebSocket;
  const instances = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.binaryType = "blob";
      this.sent = [];
      this.listeners = new Map();
      this.onSend = null;
      instances.push(this);
    }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    removeEventListener(type, listener) {
      const listeners = this.listeners.get(type) ?? [];
      this.listeners.set(
        type,
        listeners.filter((item) => item !== listener),
      );
    }
    send(data) {
      this.sent.push(data);
      this.onSend?.(data);
    }
    close() {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", { code: 1005, reason: "", wasClean: true });
    }
    emit(type, event) {
      // 用 slice() 复制一份再派发：避免监听器在派发过程中被增删影响本次遍历。
      for (const listener of this.listeners.get(type)?.slice() ?? []) listener(event);
    }
    /** 握手完成。 */
    open() {
      this.readyState = FakeWebSocket.OPEN;
      this.emit("open", {});
    }
    /** 服务端/relay 主动关闭（4002 host-offline、4003 client-offline 等）。 */
    closeWith(code, reason) {
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", { code, reason, wasClean: true });
    }
  }
  globalThis.WebSocket = FakeWebSocket;
  t.after(() => {
    globalThis.WebSocket = originalWebSocket;
  });
  return {
    last: () => instances[instances.length - 1],
  };
}

/** 用真 ChannelServer 发 Initialize：构造即发，与产品服务端同一套封帧。 */
function emitInitialize(fakeWs) {
  const onData = new Emitter();
  const onClose = new Emitter();
  fakeWs.onSend = (data) => onData.fire(VSBuffer.wrap(new Uint8Array(data)));
  const socket = {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onClose.event,
    write: (buffer) => fakeWs.emit("message", { data: buffer.buffer }),
    end: () => {},
    drain: () => Promise.resolve(),
    dispose: () => {},
  };
  return new ChannelServer(new SocketProtocol(socket), "server");
}

const flushMicrotasks = () => new Promise((resolve) => setImmediate(resolve));

test("Initialize 之前不算连上：WS open 不足以 resolve", async (t) => {
  const fake = installFakeWebSocket(t);
  const pending = connectViaWebSocket("ws://relay/ws", { initializeTimeoutMs: 500 });
  let state = "pending";
  void pending.then(
    () => {
      state = "resolved";
    },
    () => {
      state = "rejected";
    },
  );

  fake.last().open();
  await flushMicrotasks();
  assert.equal(state, "pending", "WS open 之后、Initialize 之前不得 resolve");

  emitInitialize(fake.last());
  const services = await pending;
  assert.equal(state, "resolved");
  assert.equal(typeof services.fileService, "object", "resolve 时应交出服务访问器");
});

test("open 之后、Initialize 之前断开：reject（relay 宽限到期 4002 场景）", async (t) => {
  const fake = installFakeWebSocket(t);
  const pending = connectViaWebSocket("ws://relay/ws", { initializeTimeoutMs: 500 });

  fake.last().open();
  fake.last().closeWith(4002, "host-offline");
  await assert.rejects(pending, /host-offline/);
});

test("Initialize 之后断开：只触发 onClose，不改变已交付的结果", async (t) => {
  const fake = installFakeWebSocket(t);
  const closes = [];
  const pending = connectViaWebSocket("ws://relay/ws", {
    initializeTimeoutMs: 500,
    onClose: (event) => closes.push(event),
  });

  fake.last().open();
  emitInitialize(fake.last());
  const services = await pending;

  fake.last().closeWith(4003, "client-offline");
  assert.deepEqual(closes, [{ code: 4003, reason: "client-offline", wasClean: true }]);
  assert.equal(typeof services.fileService, "object", "已交付结果不因后续断开而失效");
});

test("通道始终不 Initialize：超时失败并主动关闭 socket", async (t) => {
  const fake = installFakeWebSocket(t);
  const pending = connectViaWebSocket("ws://relay/ws", { initializeTimeoutMs: 30 });

  fake.last().open();
  await assert.rejects(pending, /not initialized/);
  assert.equal(fake.last().readyState, 3, "超时后必须主动关闭，避免留下僵尸连接");
});

// ---------------------------------------------------------------------------
// E2EE 接缝（spec vps-relay-bridge.md §16）：connectViaWebSocket 的 e2eeChannelKey 路径。
//
// 与上面用例的区别：服务端侧同样架着真实的 RelayE2eeChannel + SocketProtocol + ChannelServer
// （与桌面 remoteRelayClient 的结构互为镜像），验证完整链路「假 WS ⇄ E2EE ⇄ 帧格式 ⇄ RPC 握手」。
import { generateRelayChannelKey, RelayE2eeChannel } from "@zcode/shared";

/**
 * 在假 WS 的**服务端侧**架设 E2EE host 通道 + 真 ChannelServer（惰性启动）。
 *
 * 服务端在第一条 client wire 消息到达时才建通道——真实时序里「谁先发」不固定
 * （relay 宽限配对后 client hello 可能先到），服务端必须能从收到对端 hello 开始握手。
 * wire 走带泵守卫的 FIFO：host 构造即发 hello，client 的 confirm 会同步回打，
 * 不排队的话会抢在原始消息之前被处理（与 shared 单测的泵同一教训）。
 */
function attachHostE2ee(fakeWs, channelKey) {
  const state = { fatal: null };
  const onData = new Emitter();
  let hostChannel = null;
  let pumping = false;
  const wire = [];
  const pumpWire = () => {
    if (pumping) return;
    pumping = true;
    try {
      while (wire.length > 0) {
        if (!hostChannel) {
          hostChannel = new RelayE2eeChannel({
            role: "host",
            channelKey,
            send: (record) => fakeWs.emit("message", { data: record.buffer }),
            onPlaintext: (frame) => onData.fire(VSBuffer.wrap(frame)),
            onFatal: (error) => {
              state.fatal = error;
            },
          });
          new ChannelServer(
            new SocketProtocol({
              onData: onData.event,
              onClose: new Emitter().event,
              onEnd: new Emitter().event,
              write: (buffer) => hostChannel.write(buffer.buffer),
              end: () => {},
              drain: () => Promise.resolve(),
              dispose: () => {},
            }),
            "server",
          );
        }
        hostChannel.accept(wire.shift());
      }
    } finally {
      pumping = false;
    }
  };
  fakeWs.onSend = (data) => {
    wire.push(new Uint8Array(data));
    pumpWire();
  };
  return { state };
}

test("E2EE：带 e2eeChannelKey 连接 → Initialize 经密文到达才交付，线上无明文帧", async (t) => {
  const fake = installFakeWebSocket(t);
  const KEY = generateRelayChannelKey();
  const pending = connectViaWebSocket("ws://relay/ws", {
    initializeTimeoutMs: 3000,
    e2eeChannelKey: KEY,
  });

  // 先架服务端（必须在 open 前：hello 在 open 时就发出）
  const { state } = attachHostE2ee(fake.last(), KEY);
  fake.last().open();

  const services = await pending;
  assert.equal(typeof services.fileService, "object", "E2EE 握手完成后应正常交付");

  // 线上（client → 服务端）每一条消息都必须是 E2EE 形状：ZRE1 hello / ZRC1 confirm / 0xC1 record。
  // 若出现裸 SocketProtocol 帧（0x01 开头的 13B 帧头）即明文泄漏。
  assert.ok(fake.last().sent.length >= 2, "应有 hello + confirm + 数据帧");
  for (const data of fake.last().sent) {
    const u8 = new Uint8Array(data);
    const magic = Buffer.from(u8.subarray(0, 4)).toString("latin1");
    const shaped = magic === "ZRE1" || magic === "ZRC1" || u8[0] === 0xc1;
    assert.ok(shaped, `wire 消息必须是 E2EE 形状，实际 magic=${magic} len=${u8.length}`);
  }
  assert.equal(state.fatal, null, "服务端通道不应 fatal");
});

test("E2EE：channelKey 不一致 → reject（端到端加密握手失败），绝不降级明文", async (t) => {
  const fake = installFakeWebSocket(t);
  const pending = connectViaWebSocket("ws://relay/ws", {
    initializeTimeoutMs: 3000,
    e2eeChannelKey: generateRelayChannelKey(), // 与服务端不同 = 错配置 / MITM 换钥
  });

  const { state } = attachHostE2ee(fake.last(), generateRelayChannelKey());
  fake.last().open();

  await assert.rejects(pending, /端到端加密握手失败/);
  assert.ok(state.fatal, "服务端 confirm 校验同样失败 fatal");
});
