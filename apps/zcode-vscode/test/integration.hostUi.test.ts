/**
 * T05 全链路集成测试（fake 服务桩替代桌面 Agent 进程，桥层等价物）：
 *
 * fake IZCodeAgentService（实现 v4 方法面 + 事件）注册进 ServiceCollection →
 * HostRuntime（IPCServer）→ WebviewMessagePortLike（base64 shim）→
 * MessagePortProtocol → ChannelClient → ProxyChannel 服务代理 →
 * ui 包 createAgentConversationTransport（对话数据层，真实实现零改动）。
 *
 * 验证：hello 握手 → subscribe → sendText 命令（ACK）→ 崩溃重启事件链 → 版本守卫。
 * （基线 P0 交互等价性在协议面锁定：旧 vanilla UI 退役前的等价回归，见 p0Equivalence.test.ts）
 */

import { describe, expect, it } from "vitest";
import {
  ChannelClient,
  Emitter,
  MessagePortProtocol,
  ProxyChannel,
  type Event,
  type IDisposable,
} from "@zcode/rpc";
import { ServiceCollection, createServiceDescriptor, IZCodeAgentService } from "@zcode/services";
import {
  commandAckSchema,
  commandEnvelopeSchema,
  V4_WIRE_PROTOCOL_VERSION,
  type CommandAck,
  type CommandEnvelope,
  type SubscribeParams,
} from "@zcode/shared/zcode-protocol-v4";
import { WebviewMessagePortLike, sendClientContext } from "../src/webview-react/bridge/webviewMessagePort";
import { PlatformRpcClient } from "../src/webview-react/bridge/platformRpcClient";
import { HostFrameBus } from "../src/webview-react/bridge/hostFrames";
import { VscodePlatformService } from "../src/webview-react/platform/vscodePlatformService";
import { createConversationTransport } from "../src/webview-react/session/conversationTransportFactory";
import { createWorkspaceSessions } from "../src/webview-react/session/workspaceSessions";
import { ExtensionStore } from "../src/store";
import { HostRuntime } from "../src/host/hostRuntime";
import type { PlatformMethodHandler } from "../src/host/platformRpcHandler";
import { createExposurePolicy } from "../src/host/serviceAssembly";
import { HostSettingsBridge, normalizeSettingsSnapshot } from "../src/host/hostSettingsBridge";

/** fake v4 hello（transport.ts helloMessageSchema 形状）。 */
function fakeHello() {
  return {
    kind: "hello" as const,
    protocolVersion: V4_WIRE_PROTOCOL_VERSION,
    connectionId: "conn-1",
    clientMode: "desktop-continuous" as const,
    deliveryProfile: "continuous" as const,
    serverTime: Date.now(),
    capabilities: {
      nativeDialogs: false,
      localTerminal: false,
      binaryFrames: true,
      compression: "none" as const,
    },
    auth: {},
  };
}

/** fake agent 服务：记录调用、支持事件注入（进程换代事件链）。 */
class FakeAgentService {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  private readonly dynamicFrameEmitters = new Map<string, Emitter<unknown>>();
  private readonly runtimeRestarted = new Emitter<{ workspaceKey: string }>();

  async helloConversationV4(): Promise<unknown> {
    this.calls.push({ method: "helloConversationV4", params: null });
    return fakeHello();
  }

  async initializeConversationV4(clientHello: unknown): Promise<void> {
    this.calls.push({ method: "initializeConversationV4", params: clientHello });
  }

  async subscribeConversationV4(params: { sessionId?: string }): Promise<unknown> {
    this.calls.push({ method: "subscribeConversationV4", params });
    // v4ConversationSubscribeResultSchema：strict，response 只含 ACK。
    return {
      ack: { subscriptionId: `sub-${params.sessionId}`, mode: "snapshot", logEpoch: "0" },
    };
  }

  async resyncConversationV4(params: unknown): Promise<unknown> {
    this.calls.push({ method: "resyncConversationV4", params });
    return { revision: 1 };
  }

  async unsubscribeConversationV4(params: unknown): Promise<void> {
    this.calls.push({ method: "unsubscribeConversationV4", params });
  }

  async sendConversationCommandV4(params: { envelope?: CommandEnvelope }): Promise<CommandAck> {
    this.calls.push({ method: "sendConversationCommandV4", params });
    // transport 的 wire 形状：sendConversationCommandV4({ ...workspace, ...context, envelope })。
    const ack: CommandAck = {
      commandId: params.envelope?.commandId ?? "",
      status: "accepted",
      revisionAtDecision: 1,
    };
    return commandAckSchema.parse(ack);
  }

  async queryConversationCommandsV4(params: unknown): Promise<unknown> {
    this.calls.push({ method: "queryConversationCommandsV4", params });
    return { commands: [] };
  }

  async conversationRowsRangeV4(params: unknown): Promise<unknown> {
    this.calls.push({ method: "conversationRowsRangeV4", params });
    return { rows: [] };
  }

  async conversationPlansV4(params: unknown): Promise<unknown> {
    this.calls.push({ method: "conversationPlansV4", params });
    return { plans: [] };
  }

  async conversationWorkflowRunEventsV4(params: unknown): Promise<unknown> {
    return { events: [] };
  }

  async conversationWorkflowRunsV4(params: unknown): Promise<unknown> {
    return { runs: [] };
  }

  async conversationWorkflowRunArtifactsV4(_params: unknown): Promise<unknown> {
    return { artifacts: [] };
  }

  async conversationWorkflowRunArtifactDataV4(_params: unknown): Promise<unknown> {
    return { data: null };
  }

  async conversationWorkflowRunArtifactReadV4(_params: unknown): Promise<unknown> {
    return { data: null };
  }

  async conversationWorkflowRunWorkspaceV4(_params: unknown): Promise<unknown> {
    return { workspace: null };
  }

  async conversationWorkflowRunNodeResultV4(_params: unknown): Promise<unknown> {
    return { result: null };
  }

  async conversationFileChangesV4(_params: unknown): Promise<unknown> {
    return { changes: [] };
  }

  async conversationFileRewindPreviewV4(_params: unknown): Promise<unknown> {
    return { preview: null };
  }

  async attachmentBeginV4(_params: unknown): Promise<unknown> {
    return { attachmentId: "a1" };
  }

  async attachmentChunkV4(_params: unknown): Promise<unknown> {
    return {};
  }

  async attachmentCommitV4(_params: unknown): Promise<unknown> {
    return {};
  }

  async attachmentAbortV4(_params: unknown): Promise<void> {}

  async attachmentPreviewSourceV4(_params: unknown): Promise<unknown> {
    return { source: null };
  }

  async attachmentReadV4(_params: unknown): Promise<unknown> {
    return { data: null };
  }

  onDynamicConversationFrame(params: { topic: string }): Event<unknown> {
    let emitter = this.dynamicFrameEmitters.get(params.topic);
    if (!emitter) {
      emitter = new Emitter<unknown>();
      this.dynamicFrameEmitters.set(params.topic, emitter);
    }
    return emitter.event;
  }

  onAgentRuntimeRestarted(listener: (event: { workspaceKey: string }) => void): IDisposable {
    return this.runtimeRestarted.event(listener);
  }

  /** 测试注入口：Agent 进程换代（P1-6 崩溃重建事件链源头）。 */
  emitRuntimeRestart(workspaceKey: string): void {
    this.runtimeRestarted.fire({ workspaceKey });
  }
}

interface Harness {
  fake: FakeAgentService;
  agentProxy: IZCodeAgentService;
  /** webview 侧平台 RPC 客户端（plat-req/plat-res 环回，P1-1.5 上报链用）。 */
  rpc: PlatformRpcClient;
  /** host 帧总线（host → webview 帧的 webview 半消费面）。 */
  hostFrames: HostFrameBus;
}

/** 完整内存双端：ServiceCollection → HostRuntime → 桥 shim → ChannelClient 代理。 */
function makeHarness(
  fake: FakeAgentService = new FakeAgentService(),
  platformMethods?: ReadonlyMap<string, PlatformMethodHandler>,
): Harness {
  const services = new ServiceCollection();
  services.register(IZCodeAgentService, fake as unknown as IZCodeAgentService);

  const host = new HostRuntime({
    services,
    exposurePolicy: createExposurePolicy(["zcode-agent"]),
    platformMethods: platformMethods ?? new Map(),
    settingsBridge: new HostSettingsBridge(() => normalizeSettingsSnapshot({})),
  });
  const vscode = {
    postMessage: (message: unknown) => {
      host.handleWebviewMessage("test", message);
    },
  };
  const port = new WebviewMessagePortLike(vscode);
  const rpc = new PlatformRpcClient(vscode);
  const hostFrames = new HostFrameBus();
  host.attachWebview("test", {
    postMessage: (message: unknown) => {
      // 与 index.tsx 同款 t 字段三分流：rpc/flow → port；plat-res/plat-evt → rpc；host 帧 → 总线。
      port.handleMessageData(message);
      rpc.handleMessageData(message);
      hostFrames.handleMessageData(message);
    },
  });
  // webview 侧：port → MessagePortProtocol → ChannelClient → 类型安全服务代理。
  const client = new ChannelClient(new MessagePortProtocol(port));
  // IPCServer 协议首消息 = ctx 身份帧（sendClientContext）。内存环回是同步派发，
  // 必须先完成 ChannelClient 订阅再发 ctx，否则 host 回发的 Initialize 在
  // whenInitialized 挂起前到达会丢（真实 webview 跨进程异步无此竞态）。
  sendClientContext(vscode);
  const agentProxy = ProxyChannel.toService<IZCodeAgentService>(
    client.getChannel(IZCodeAgentService.channelName),
  );
  return { fake, agentProxy, rpc, hostFrames };
}

function sendTextEnvelope(sessionId: string, text: string): CommandEnvelope {
  return commandEnvelopeSchema.parse({
    commandId: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    clientId: "vitest",
    sessionId,
    type: "sendText",
    payload: { text },
    issuedAt: Date.now(),
  });
}

describe("对话数据层接线（T05）：桥 → services 代理 → ui transport", () => {
  it("createConversationTransport 全链路：hello 握手 + sendText ACK", async () => {
    const { fake, agentProxy } = makeHarness();
    const transport = createConversationTransport(agentProxy, { workspacePath: "/repo" });
    const ack = await transport.sendCommand(sendTextEnvelope("session-1", "你好"));
    expect(ack.status).toBe("accepted");
    expect(fake.calls.some((c) => c.method === "helloConversationV4")).toBe(true);
    expect(fake.calls.some((c) => c.method === "sendConversationCommandV4")).toBe(true);
  }, 30_000);

  it("subscribe（conversation/<sessionId> topic）抵达 fake 服务", async () => {
    const { fake, agentProxy } = makeHarness();
    const transport = createConversationTransport(agentProxy, { workspacePath: "/repo" });
    await transport.subscribe({ topic: "conversation/session-1" } satisfies SubscribeParams);
    const call = fake.calls.find((c) => c.method === "subscribeConversationV4");
    expect(call).toBeDefined();
    // transport 的 wire 形状：topic 解析为 sessionId 后随 workspace 发送。
    expect((call?.params as { sessionId?: string }).sessionId).toBe("session-1");
  }, 30_000);

  it("Agent 进程换代事件经桥触达 transport.onRuntimeRestart（P1-6 事件链）", async () => {
    const { fake, agentProxy } = makeHarness();
    const transport = createConversationTransport(agentProxy, { workspacePath: "/repo" });
    const restarts: unknown[] = [];
    transport.onRuntimeRestart((reason?: "runtimeRestart" | "transportReplaced") => restarts.push(reason));
    fake.emitRuntimeRestart("/repo");
    await new Promise((r) => setTimeout(r, 10));
    expect(restarts).toHaveLength(1);
  }, 30_000);

  it("老 CLI（无 v4）：hello 失败 → sendCommand 明确报错（版本守卫，R7）", async () => {
    const failingFake = new FakeAgentService();
    failingFake.helloConversationV4 = async () => {
      throw new Error("method not found: helloConversationV4");
    };
    const { agentProxy } = makeHarness(failingFake);
    const transport = createConversationTransport(agentProxy, { workspacePath: "/repo" });
    await expect(
      transport.sendCommand(sendTextEnvelope("session-1", "x")),
    ).rejects.toBeTruthy();
  }, 30_000);
});

/**
 * P1-1.5 会话恢复闭环 webview 半（T06/②）：
 * onSessionCreated → platform.notifySessionCreated → plat-req → HostRuntime
 * → PlatformRpcHandler（白名单）→ host 处理器写 ExtensionStore per-folder 键空间
 * → plat-res 回环。窗口重开时 chatPanel 读同一键空间注入 bootstrap data-session-id。
 */
describe("会话恢复闭环 webview 半：plat 上报 → store 写回（P1-1.5）", () => {
  /** 内存 Memento（ExtensionStore 的 globalState 面，keys() 供反查）。 */
  function makeMemento() {
    const map = new Map<string, unknown>();
    return {
      get: <T>(key: string): T | undefined => map.get(key) as T | undefined,
      update: async (key: string, value: unknown): Promise<void> => {
        if (value === undefined) map.delete(key);
        else map.set(key, value);
      },
      keys: (): string[] => [...map.keys()],
    };
  }

  /** container.notifySessionCreated/Deleted 的 store 写回语义（同形复刻）。 */
  function makeSessionPlatformMethods(store: ExtensionStore): Map<string, PlatformMethodHandler> {
    const workspaceSessions = createWorkspaceSessions(store);
    return new Map<string, PlatformMethodHandler>([
      [
        "notifySessionCreated",
        (async (args: unknown[]) => {
          const sessionId = args[0];
          if (typeof sessionId !== "string" || !sessionId.trim()) {
            throw new Error("notifySessionCreated: sessionId 必须为非空字符串");
          }
          const folder = typeof args[1] === "string" && args[1].trim() ? args[1] : "/repo";
          workspaceSessions.set(folder, sessionId);
          return { folder, sessionId };
        }) as PlatformMethodHandler,
      ],
      [
        "notifySessionDeleted",
        (async (args: unknown[]) => {
          const sessionId = args[0];
          if (typeof sessionId !== "string" || !sessionId.trim()) {
            throw new Error("notifySessionDeleted: sessionId 必须为非空字符串");
          }
          const folders = store.findFoldersBySessionId(sessionId);
          for (const folder of folders) {
            workspaceSessions.set(folder, undefined);
          }
          return { sessionId, folders };
        }) as PlatformMethodHandler,
      ],
    ]);
  }

  it("onSessionCreated → notifySessionCreated 经桥写穿透 per-folder 键空间", async () => {
    const store = new ExtensionStore(makeMemento() as never);
    const { rpc, hostFrames } = makeHarness(
      new FakeAgentService(),
      makeSessionPlatformMethods(store),
    );
    const platform = new VscodePlatformService({ rpc, hostFrames });

    // ui onSessionCreated 回调链（App.handleSessionCreated 同形调用）。
    const result = await platform.notifySessionCreated("s-9", "/repo");
    expect(result).toEqual({ folder: "/repo", sessionId: "s-9" });
    expect(store.getSessionId("/repo")).toBe("s-9");

    // 第二个 folder 各自键控（P1-2.4 per-folder 最近会话）。
    await platform.notifySessionCreated("s-10", "/repo-b");
    expect(store.getSessionId("/repo-b")).toBe("s-10");
    expect(store.getSessionId("/repo")).toBe("s-9");
  }, 30_000);

  it("onSessionDeleted → notifySessionDeleted 反查 folder 清键（从列表移除写回面）", async () => {
    const store = new ExtensionStore(makeMemento() as never);
    const { rpc, hostFrames } = makeHarness(
      new FakeAgentService(),
      makeSessionPlatformMethods(store),
    );
    const platform = new VscodePlatformService({ rpc, hostFrames });
    await platform.notifySessionCreated("s-9", "/repo");
    await platform.notifySessionCreated("s-9", "/repo-b");

    const result = await platform.notifySessionDeleted("s-9");
    expect(result.folders.sort()).toEqual(["/repo", "/repo-b"]);
    expect(store.getSessionId("/repo")).toBeUndefined();
    expect(store.getSessionId("/repo-b")).toBeUndefined();
  }, 30_000);

  it("非法上报（空 sessionId）经桥回明确错误（不静默失败）", async () => {
    const store = new ExtensionStore(makeMemento() as never);
    const { rpc, hostFrames } = makeHarness(
      new FakeAgentService(),
      makeSessionPlatformMethods(store),
    );
    const platform = new VscodePlatformService({ rpc, hostFrames });
    await expect(platform.notifySessionCreated("", "/repo")).rejects.toThrow(/非空字符串/);
    expect(store.getSessionId("/repo")).toBeUndefined();
  }, 30_000);

  it("白名单外方法经桥被拒（plat 帧守卫面）", async () => {
    const { rpc } = makeHarness(new FakeAgentService());
    await expect(rpc.call("executeArbitraryCode")).rejects.toThrow();
  }, 30_000);
});
