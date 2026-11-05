/**
 * T03 Webview 桥 shim 测试：
 * - Uint8Array → base64 → 还原 roundtrip；
 * - flow 帧透传（saturated/drained）；
 * - `t` 字段分流（plat/host 帧不进 RPC 通道）；
 * - createMessagePortServiceConnection(port) 的 ChannelClient 可对内存 host 完成 call roundtrip。
 */

import { describe, expect, it } from "vitest";
import {
  ChannelClient,
  Emitter,
  MessagePortProtocol,
  VSBuffer,
  type IMessagePassingProtocol,
} from "@zcode/rpc";
import { ServiceCollection, createServiceDescriptor } from "@zcode/services";
import { WebviewMessagePortLike, sendClientContext } from "../src/webview-react/bridge/webviewMessagePort";
import { PlatformRpcClient } from "../src/webview-react/bridge/platformRpcClient";
import { HostFrameBus } from "../src/webview-react/bridge/hostFrames";
import { HostRuntime } from "../src/host/hostRuntime";
import { createExposurePolicy } from "../src/host/serviceAssembly";
import { HostSettingsBridge, normalizeSettingsSnapshot } from "../src/host/hostSettingsBridge";
import { base64ToBytes, bytesToBase64 } from "../src/bridge/wire";

interface TestService {
  ping(): Promise<string>;
}

const ITestService = createServiceDescriptor<TestService>("test-channel");

interface Harness {
  port: WebviewMessagePortLike;
  rpc: PlatformRpcClient;
  hostFrames: HostFrameBus;
  host: HostRuntime;
  webviewInbox: unknown[];
  /** 假 acquireVsCodeApi 返回值（sendClientContext 注入点）。 */
  vscode: { postMessage: (message: unknown) => void };
}

/** 完整内存双端：假 vscode API ↔ HostRuntime（chatPanel 等价物）。 */
function makeHarness(): Harness {
  const webviewInbox: unknown[] = [];
  const vscode = {
    postMessage: (message: unknown) => {
      // webview → host：等价 chatPanel 的 onDidReceiveMessage 转发。
      host.handleWebviewMessage("test", message);
    },
  };
  const host = new HostRuntime({
    services: makeServices(),
    exposurePolicy: createExposurePolicy(["test-channel"]),
    platformMethods: new Map<string, (args: unknown[]) => unknown>([
      ["getDeviceId", () => "device-42"],
    ]),
    settingsBridge: new HostSettingsBridge(() => normalizeSettingsSnapshot({})),
  });
  const hostSender = {
    postMessage: (message: unknown) => {
      // host → webview：等价 webview 的 window message 事件。
      webviewInbox.push(message);
      port.handleMessageData(message);
      rpc.handleMessageData(message);
      hostFrames.handleMessageData(message);
    },
  };
  const port = new WebviewMessagePortLike(vscode);
  const rpc = new PlatformRpcClient(vscode);
  const hostFrames = new HostFrameBus();
  host.attachWebview("test", hostSender);
  return { port, rpc, hostFrames, host, webviewInbox, vscode };
}

function makeServices(): ServiceCollection {
  const services = new ServiceCollection();
  services.register(ITestService, { ping: async () => "pong" } satisfies TestService);
  return services;
}

describe("WebviewMessagePortLike（base64 shim）", () => {
  it("Uint8Array → base64 → 还原 roundtrip（经真实 MessagePortProtocol）", async () => {
    const harness = makeHarness();
    const client = new ChannelClient(new MessagePortProtocol(harness.port));
    // IPCServer 协议首消息 = ctx 身份帧。内存环回同步派发：先完成订阅再发 ctx，
    // host 回发的 Initialize 才能抵达 ChannelClient（真实 webview 跨进程异步无此竞态）。
    sendClientContext(harness.vscode);
    const channel = client.getChannel(ITestService.channelName);
    await expect(channel.call("ping")).resolves.toBe("pong");
  });

  it("二进制载荷 roundtrip：RPC call 参数含大 Uint8Array 不失真", async () => {
    const harness = makeHarness();
    // host 侧注册一个回显频道，验证大 payload（含 0x00-0xFF 全字节）过 base64 shim 不失真。
    const services = new ServiceCollection();
    const bigPayload = new Uint8Array(512 * 1024);
    for (let i = 0; i < bigPayload.length; i += 1) bigPayload[i] = i % 256;
    let received: Uint8Array | null = null;
    services.register(createServiceDescriptor<{ echo(b: Uint8Array): Promise<Uint8Array> }>("echo-channel"), {
      echo: async (b: Uint8Array) => {
        received = b;
        return b;
      },
    });
    const host = new HostRuntime({
      services,
      exposurePolicy: createExposurePolicy(["echo-channel"]),
      platformMethods: new Map(),
      settingsBridge: new HostSettingsBridge(() => normalizeSettingsSnapshot({})),
    });
    host.attachWebview("test", {
      postMessage: (message: unknown) => {
        harness.port.handleMessageData(message);
      },
    });
    const client = new ChannelClient(new MessagePortProtocol(harness.port));
    // 用第二个 port 会话与原 harness 的 vscode 分流并存：直接手工对接。
    // 注意：client2 挂在 "test2" 会话（119 行 attachWebview），ctx 必须发往同一会话，
    // 否则 Initialize 会回发到 "test" 会话的 harness.port（111 行的弃用 client）。
    const vscode2 = {
      postMessage: (message: unknown) => {
        host.handleWebviewMessage("test2", message);
      },
    };
    const port2 = new WebviewMessagePortLike(vscode2);
    host.attachWebview("test2", {
      postMessage: (message: unknown) => {
        port2.handleMessageData(message);
      },
    });
    const client2 = new ChannelClient(new MessagePortProtocol(port2));
    // ctx 身份帧（同步环回下先订阅后发送，与 makeHarness 用例同理）。
    sendClientContext(vscode2);
    // fromService 约定：args 是参数数组（toService 打包 (...args) → call(method, args)）。
    const result = (await client2
      .getChannel("echo-channel")
      .call("echo", [bigPayload])) as Uint8Array;
    expect(received).not.toBeNull();
    expect(result.byteLength).toBe(bigPayload.length);
    expect(Buffer.from(result).equals(Buffer.from(bigPayload))).toBe(true);
  });

  it("flow 帧透传为 MessagePortProtocol 可识别的流控对象", () => {
    const harness = makeHarness();
    const states: string[] = [];
    const protocol = new MessagePortProtocol(harness.port);
    // MessagePortProtocol 只暴露 onMessage；flow 状态经其 onFlowState。
    protocol.onFlowState((state) => states.push(state));
    harness.port.handleMessageData({ t: "flow", state: "saturated" });
    harness.port.handleMessageData({ t: "flow", state: "drained" });
    expect(states).toEqual(["saturated", "drained"]);
    protocol.disconnect();
  });

  it("t 分流：plat/host 帧不进 RPC 通道（MessagePortProtocol 天然丢弃）", () => {
    const harness = makeHarness();
    const received: unknown[] = [];
    const protocol = new MessagePortProtocol(harness.port);
    protocol.onMessage((buffer) => received.push(buffer));
    harness.port.handleMessageData({ t: "host", kind: "theme", payload: 2 });
    harness.port.handleMessageData({ t: "plat-res", id: 1, ok: true, value: 1 });
    expect(received).toEqual([]);
    protocol.disconnect();
  });

  it("非法帧丢弃", () => {
    const harness = makeHarness();
    expect(() => harness.port.handleMessageData("garbage")).not.toThrow();
    expect(() => harness.port.handleMessageData({ t: "unknown" })).not.toThrow();
  });

  it("sendClientContext 发送 IPCServer ctx 身份帧", () => {
    const frames: unknown[] = [];
    const vscode = { postMessage: (m: unknown) => frames.push(m) };
    sendClientContext(vscode);
    expect(frames).toHaveLength(1);
    const frame = frames[0] as { t: string; b64: string };
    expect(frame.t).toBe("rpc");
    expect(base64ToBytes(frame.b64).byteLength).toBeGreaterThan(0);
  });
});

describe("PlatformRpcClient", () => {
  it("call → host 应答 plat-res(ok) → resolve", async () => {
    const harness = makeHarness();
    const value = await harness.rpc.call<string>("getDeviceId");
    expect(value).toBe("device-42");
  });

  it("plat-evt 分发到订阅者", async () => {
    const harness = makeHarness();
    const events: Array<[string, unknown]> = [];
    const dispose = harness.rpc.onEvent((event, payload) => events.push([event, payload]));
    // plat-* 帧由 PlatformRpcClient 分流（WebviewMessagePortLike 有意不转发 plat-*，
    // t 字段分流隔离是设计；真实装配 window message 广播给 port/rpc/hostFrames 三者）。
    harness.rpc.handleMessageData({ t: "plat-evt", event: "task-click", payload: "t1" });
    expect(events).toEqual([["task-click", "t1"]]);
    dispose();
    harness.rpc.handleMessageData({ t: "plat-evt", event: "task-click", payload: "t2" });
    expect(events).toEqual([["task-click", "t1"]]);
  });
});

describe("HostFrameBus", () => {
  it("host 帧订阅 + 最近一帧立即同步", () => {
    const bus = new HostFrameBus();
    bus.handleMessageData({ t: "host", kind: "theme", payload: 2 });
    const seen: unknown[] = [];
    bus.on("theme", (payload) => seen.push(payload));
    expect(seen).toEqual([2]);
  });

  it("新帧推送给全部订阅者", () => {
    const bus = new HostFrameBus();
    const seen: unknown[] = [];
    bus.on("workspace", (payload) => seen.push(payload));
    bus.handleMessageData({ t: "host", kind: "workspace", payload: { folders: ["/a"] } });
    expect(seen).toEqual([{ folders: ["/a"] }]);
  });
});
