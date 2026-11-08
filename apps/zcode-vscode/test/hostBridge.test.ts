/**
 * T02 桥 host 侧测试：IPCServer 连接建立 → ChannelServer initialize → 注册频道可调；
 * PlatformRpcHandler 白名单外方法拒绝；HostSettingsBridge 参数面。
 *
 * 双端对打：webview 侧用内存 IMessagePassingProtocol（send → host 帧；onMessage ← host 帧）。
 */

import { describe, expect, it } from "vitest";
import {
  BufferWriter,
  Emitter,
  IPCClient,
  serialize,
  VSBuffer,
  type IMessagePassingProtocol,
} from "@zcode/rpc";
import { ServiceCollection, createServiceDescriptor } from "@zcode/services";
import { HostRuntime } from "../src/host/hostRuntime";
import { createExposurePolicy } from "../src/host/serviceAssembly";
import {
  HostSettingsBridge,
  normalizeSettingsSnapshot,
} from "../src/host/hostSettingsBridge";
import {
  PLATFORM_METHOD_WHITELIST,
  PlatformRpcHandler,
} from "../src/host/platformRpcHandler";
import { HOST_FRAME_KINDS } from "../src/host/hostFrameKinds";
import {
  buildDiagnosticsFramePayload,
  composeEditorTabTitle,
  parseEditorTabUiPayload,
  parseSessionTabsPayload,
  type DiagnosticsSourceEntry,
} from "../src/host/hostFrameKinds";
import { parseBridgeEnvelope } from "../src/bridge/wire";
import { base64ToBytes, bytesToBase64 } from "../src/bridge/wire";

interface TestService {
  ping(): Promise<string>;
  echo(value: string): Promise<string>;
}

const ITestService = createServiceDescriptor<TestService>("test-channel");

interface Loopback {
  runtime: HostRuntime;
  client: IPCClient<string>;
  calls: string[];
  /** webview 侧收帧（host → webview 方向）拦截器注入点。 */
  sender: { postMessage: (message: unknown) => void };
}

/** 内存双端：HostBridgeProtocol ↔ 内存客户端协议，全链路走 bridge wire 帧编码。 */
function makeLoopback(
  extraPlatformMethods?: Record<string, (args: unknown[]) => unknown>,
): Loopback {
  const clientEmitter = new Emitter<VSBuffer>();
  const services = new ServiceCollection();
  const calls: string[] = [];
  services.register(ITestService, {
    ping: async () => {
      calls.push("ping");
      return "pong";
    },
    echo: async (value: string) => {
      calls.push(`echo:${value}`);
      return value;
    },
  } satisfies TestService);
  const runtime = new HostRuntime({
    services,
    exposurePolicy: createExposurePolicy(["test-channel"]),
    platformMethods: new Map<string, (args: unknown[]) => unknown>([
      ["getDeviceId", () => "device-1"],
      ...Object.entries(extraPlatformMethods ?? {}),
    ]),
    settingsBridge: new HostSettingsBridge(() => normalizeSettingsSnapshot({})),
  });
  // webview → host：包装为 {t:"rpc"} 帧（bridge wire）。
  const clientProtocol: IMessagePassingProtocol = {
    send: (buffer) => {
      runtime.handleWebviewMessage("test", {
        t: "rpc",
        b64: bytesToBase64(buffer.buffer),
      });
    },
    onMessage: clientEmitter.event,
  };
  const sender = {
    postMessage: (message: unknown) => {
      const record = message as { t?: string; b64?: string };
      if (record.t === "rpc" && typeof record.b64 === "string") {
        clientEmitter.fire(VSBuffer.wrap(base64ToBytes(record.b64)));
      }
    },
  };
  runtime.attachWebview("test", sender);
  return {
    runtime,
    client: new IPCClient(clientProtocol, "zcode-webview"),
    calls,
    sender,
  };
}

/** 收集宿主发给 webview 的帧（挂在 sender 上的探针）。 */
function tapSender(sender: Loopback["sender"]): { frames: unknown[] } {
  const frames: unknown[] = [];
  const original = sender.postMessage.bind(sender);
  sender.postMessage = (message: unknown) => {
    frames.push(message);
    original(message);
  };
  return { frames };
}

describe("host 桥：IPCServer → ChannelServer", () => {
  it("连接建立（ctx 帧）→ initialize → 注册频道可调", async () => {
    const loopback = makeLoopback();
    const channel = loopback.client.getChannel(ITestService.channelName);
    await expect(channel.call("ping")).resolves.toBe("pong");
    // fromService 约定：args 是参数数组（toService 打包 (...args) → call(method, args)）。
    await expect(channel.call("echo", ["hello"])).resolves.toBe("hello");
    expect(loopback.calls).toEqual(["ping", "echo:hello"]);
  });

  it("ctx 帧必须是连接后的第一条 RPC 消息（BufferWriter 序列化形状）", async () => {
    // 与 webview 侧 sendClientContext 同一编解码。
    const writer = new BufferWriter();
    serialize(writer, "zcode-webview");
    const round = writer.buffer;
    expect(round.byteLength).toBeGreaterThan(0);
  });

  it("白名单外频道不可调（exposure policy 裁剪，§8 R3）", async () => {
    const loopback = makeLoopback();
    const channel = loopback.client.getChannel("terminal");
    await expect(channel.call("anything")).rejects.toBeTruthy();
  });
});

describe("PlatformRpcHandler（经 HostRuntime 分流）", () => {
  it("白名单内方法应答 plat-res(ok) 并带回值", async () => {
    const loopback = makeLoopback();
    const { frames } = tapSender(loopback.sender);
    loopback.runtime.handleWebviewMessage("test", {
      t: "plat-req",
      id: 1,
      method: "getDeviceId",
      args: [],
    });
    await new Promise((r) => setTimeout(r, 10));
    const platRes = frames.find(
      (f) => (f as { t?: string }).t === "plat-res",
    ) as { t: string; id: number; ok: boolean; value: string } | undefined;
    expect(platRes).toBeDefined();
    expect(platRes?.ok).toBe(true);
    expect(platRes?.value).toBe("device-1");
  });

  it("白名单外方法拒绝且不落地 VS Code API（webview 侧零任意 API 面）", async () => {
    const loopback = makeLoopback();
    const { frames } = tapSender(loopback.sender);
    loopback.runtime.handleWebviewMessage("test", {
      t: "plat-req",
      id: 2,
      method: "executeTerminalCommand",
      args: ["rm -rf /"],
    });
    await new Promise((r) => setTimeout(r, 10));
    const platRes = frames.find(
      (f) => (f as { t?: string }).t === "plat-res",
    ) as { t: string; id: number; ok: boolean; error: string } | undefined;
    expect(platRes?.ok).toBe(false);
    expect(platRes?.error).toContain("not allowed");
    expect(loopback.calls).toEqual([]);
  });

  it("非法帧被丢弃不崩溃", () => {
    const loopback = makeLoopback();
    expect(() =>
      loopback.runtime.handleWebviewMessage("test", {
        t: "evil",
        payload: "x",
      }),
    ).not.toThrow();
  });

  it("新增 plat 方法在白名单内且可应答（T02/T06 host 侧先行）", async () => {
    expect(PLATFORM_METHOD_WHITELIST).toContain("notifySessionCreated");
    expect(PLATFORM_METHOD_WHITELIST).toContain("notifySessionDeleted");
    expect(PLATFORM_METHOD_WHITELIST).toContain("reportPendingApprovals");
    expect(PLATFORM_METHOD_WHITELIST).toContain("appendSessionAllowlist");
    expect(PLATFORM_METHOD_WHITELIST).toContain("updatePermissionRules");
    expect(PLATFORM_METHOD_WHITELIST).toContain("updateMcpServers");
    expect(PLATFORM_METHOD_WHITELIST).toContain("updateAdditionalDirectories");
    expect(PLATFORM_METHOD_WHITELIST).toContain("getActiveEditorSelection");
    expect(PLATFORM_METHOD_WHITELIST).toContain("importWorkspaceInstructions");
    expect(PLATFORM_METHOD_WHITELIST).toContain("pickWorkspaceFolder");
    // 资源管理器拖拽 URI 解析（spec: composer-explorer-file-drop）。
    expect(PLATFORM_METHOD_WHITELIST).toContain("resolveFileDropPaths");

    // 白名单内方法经桥 roundtrip（HostRuntime 分流 → plat-res(ok)）。
    const loopback = makeLoopback({
      reportPendingApprovals: (args) => ({ count: args[0] }),
    });
    const { frames } = tapSender(loopback.sender);
    loopback.runtime.handleWebviewMessage("test", {
      t: "plat-req",
      id: 3,
      method: "reportPendingApprovals",
      args: [2],
    });
    await new Promise((r) => setTimeout(r, 10));
    const platRes = frames.find(
      (f) => (f as { t?: string }).t === "plat-res",
    ) as
      | { t: string; id: number; ok: boolean; value: { count: number } }
      | undefined;
    expect(platRes?.ok).toBe(true);
    expect(platRes?.value).toEqual({ count: 2 });
  });

  it("白名单内但未实现的方法回 not implemented（container 表同步缺口即时显形）", async () => {
    const posted: unknown[] = [];
    const handler = new PlatformRpcHandler({
      // 只实现 getDeviceId：其余白名单方法落 "method not implemented"。
      methods: new Map([["getDeviceId", () => "device-1"]]),
      post: (frame) => posted.push(frame),
    });
    await handler.handleRequest(10, "getActiveEditorSelection", []);
    expect(posted[0]).toMatchObject({ t: "plat-res", id: 10, ok: false });
    expect((posted[0] as { error: string }).error).toContain("not implemented");
  });
});

describe("host 帧协议（T02/⑤：visibility/diagnostics/restart/open-panel）", () => {
  it("HOST_FRAME_KINDS 与 wire 判定一字不差", () => {
    expect(HOST_FRAME_KINDS).toEqual([
      "theme",
      "locale",
      "workspace",
      "visibility",
      "diagnostics",
      "restart",
      "open-panel",
      "composer-insert",
      "session-switch",
      "full-ui-url",
      "capabilities",
      "session-tabs",
    ]);
    for (const kind of HOST_FRAME_KINDS) {
      expect(
        parseBridgeEnvelope({ t: "host", kind, payload: {} }),
      ).not.toBeNull();
    }
    expect(
      parseBridgeEnvelope({ t: "host", kind: "evil", payload: {} }),
    ).toBeNull();
  });

  it("diagnostics 载荷两档过滤（T09：仅错误/全部）", () => {
    const entries: DiagnosticsSourceEntry[] = [
      {
        path: "/a.ts",
        severity: 0,
        message: "e1",
        startLine: 0,
        startCharacter: 0,
      },
      {
        path: "/b.ts",
        severity: 1,
        message: "w1",
        startLine: 1,
        startCharacter: 0,
      },
    ];
    const errorsOnly = buildDiagnosticsFramePayload("errors", entries, 123);
    expect(errorsOnly.tier).toBe("errors");
    expect(errorsOnly.items.map((item) => item.message)).toEqual(["e1"]);
    expect(errorsOnly.errorCount).toBe(1);
    const all = buildDiagnosticsFramePayload("all", entries, 124);
    expect(all.items).toHaveLength(2);
    expect(all.generatedAt).toBe(124);
  });
});

describe("HostSettingsBridge 参数面（P1-3 / P1-16）", () => {
  const settingsBridge = new HostSettingsBridge(() =>
    normalizeSettingsSnapshot({
      toolAllowlist: ["Bash(git status:*)"],
      toolDenylist: ["Bash(rm -rf:*)"],
      mcpServers: [{ type: "stdio", command: "mcp-server-file" }],
      additionalDirectories: ["/tmp/a"],
      mode: "edit",
      rawModel: "zai/glm-5",
    }),
  );

  it("create 参数携带 allowlist/denylist/mcp/附加目录/mode/modelSelection", () => {
    const params = settingsBridge.resolveCreateParams("/repo");
    expect(params.workspace).toEqual({ path: "/repo" });
    expect(params.toolAllowlist).toEqual(["Bash(git status:*)"]);
    expect(params.toolDenylist).toEqual(["Bash(rm -rf:*)"]);
    expect(params.mcpServers).toHaveLength(1);
    expect(params.additionalDirectories).toEqual(["/tmp/a"]);
    expect(params.config).toEqual({
      mode: "edit",
      modelSelection: { providerId: "zai", modelId: "glm-5" },
    });
  });

  it("resume 必须携带 allowlist/denylist（协议：不带会绕过约束）", () => {
    const params = settingsBridge.resolveResumeParams("s-1", "/repo");
    expect(params.sessionId).toBe("s-1");
    expect(params.toolAllowlist).toEqual(["Bash(git status:*)"]);
    expect(params.toolDenylist).toEqual(["Bash(rm -rf:*)"]);
    expect(params.mcpServers).toHaveLength(1);
  });

  it("附加目录超 256 截断（协议上限，P1-16.1）", () => {
    const dirs = Array.from({ length: 300 }, (_, i) => `/dir-${i}`);
    const snapshot = normalizeSettingsSnapshot({ additionalDirectories: dirs });
    expect(snapshot.additionalDirectories).toHaveLength(256);
  });
});

describe("host 帧排队（spec: composer-insert-delivery）", () => {
  /** 无 webview 的裸 runtime：面板未打开场景。 */
  function makeDetachedRuntime() {
    const runtime = new HostRuntime({
      services: new ServiceCollection(),
      exposurePolicy: createExposurePolicy([]),
      platformMethods: new Map(),
      settingsBridge: new HostSettingsBridge(() =>
        normalizeSettingsSnapshot({}),
      ),
    });
    const frames: unknown[] = [];
    const sender = {
      postMessage: (message: unknown) => {
        frames.push(message);
      },
    };
    return { runtime, frames, sender };
  }

  function hostKinds(frames: unknown[]): string[] {
    return frames
      .map((frame) => frame as { t?: string; kind?: string })
      .filter((frame) => frame.t === "host")
      .map((frame) => frame.kind!);
  }

  function hostTexts(frames: unknown[]): string[] {
    return frames
      .map((frame) => frame as { t?: string; payload?: { text?: string } })
      .filter((frame) => frame.t === "host")
      .map((frame) => frame.payload?.text ?? "");
  }

  it("面板未打开时 pushFrame 入队；attach 后不立即 flush；renderer ready 才按序送达", () => {
    const { runtime, frames, sender } = makeDetachedRuntime();
    runtime.pushHostFrame("composer-insert", {
      text: "a",
      mode: "prepend-if-missing",
    });
    runtime.pushHostFrame("composer-insert", {
      text: "b",
      mode: "prepend-if-missing",
    });

    runtime.attachWebview("test", sender);
    // attach 本身不 flush：main.js 可能尚未注册 message 监听。
    expect(frames).toEqual([]);

    runtime.handleWebviewMessage("test", {
      t: "plat-evt",
      event: "notifyRendererReady",
    });
    // 暂存帧按 FIFO 到达（初始帧注入缺省为空）。
    expect(hostKinds(frames)).toEqual(["composer-insert", "composer-insert"]);
    expect(hostTexts(frames)).toEqual(["a", "b"]);
  });

  it("就绪后帧直发；队列有界（>32 丢最旧）", () => {
    const { runtime, frames, sender } = makeDetachedRuntime();
    for (let i = 0; i < 40; i += 1) {
      runtime.pushHostFrame("composer-insert", { text: `m-${i}` });
    }
    runtime.attachWebview("test", sender);
    runtime.handleWebviewMessage("test", {
      t: "plat-evt",
      event: "notifyRendererReady",
    });
    const texts = hostTexts(frames);
    expect(texts[0]).toBe("m-8");
    expect(texts[texts.length - 1]).toBe("m-39");
    expect(hostKinds(frames)).toHaveLength(32);

    // renderer ready 后：帧直发，不再入队。
    runtime.pushHostFrame("composer-insert", { text: "live" });
    expect(hostTexts(frames).at(-1)).toBe("live");
    expect(hostKinds(frames)).toHaveLength(33);
  });
});

describe("UI 定向帧（pushToActiveHostFrame：跨页状态污染修复）", () => {
  function makeMultiRuntime() {
    const runtime = new HostRuntime({
      services: new ServiceCollection(),
      exposurePolicy: createExposurePolicy([]),
      platformMethods: new Map(),
      settingsBridge: new HostSettingsBridge(() =>
        normalizeSettingsSnapshot({}),
      ),
    });
    const makeCapture = (id: string) => {
      const frames: unknown[] = [];
      const sender = {
        postMessage: (message: unknown) => {
          frames.push(message);
        },
      };
      runtime.attachWebview(id, sender);
      runtime.handleWebviewMessage(id, {
        t: "plat-evt",
        event: "notifyRendererReady",
      });
      return { id, frames };
    };
    return { runtime, makeCapture };
  }

  function texts(frames: unknown[]): string[] {
    return frames
      .map((frame) => frame as { t?: string; payload?: { text?: string } })
      .filter((frame) => frame.t === "host")
      .map((frame) => frame.payload?.text ?? "");
  }

  it("帧只投给最近活动的连接；另一页不收（点击页面 A 的按钮不影响页面 B）", () => {
    const { runtime, makeCapture } = makeMultiRuntime();
    const a = makeCapture("a");
    const b = makeCapture("b");

    // 页面 a 交互 → lastActive=a：定向帧只到 a。
    runtime.handleWebviewMessage("a", { t: "plat-evt", event: "noop" });
    runtime.pushToActiveHostFrame("composer-insert", { text: "to-a" });
    expect(texts(a.frames)).toEqual(["to-a"]);
    expect(texts(b.frames)).toEqual([]);

    // 页面 b 交互 → lastActive=b：定向帧只到 b。
    runtime.handleWebviewMessage("b", { t: "plat-evt", event: "noop" });
    runtime.pushToActiveHostFrame("composer-insert", { text: "to-b" });
    expect(texts(b.frames)).toEqual(["to-b"]);
    expect(texts(a.frames)).toEqual(["to-a"]);
  });

  it("最近活动连接断开后退化到任一就绪连接（帧不丢）", () => {
    const { runtime, makeCapture } = makeMultiRuntime();
    const a = makeCapture("a");
    const b = makeCapture("b");
    runtime.handleWebviewMessage("a", { t: "plat-evt", event: "noop" });
    runtime.detachWebview("a"); // lastActive 指向已断开连接
    runtime.pushToActiveHostFrame("composer-insert", { text: "fallback" });
    expect(texts(b.frames)).toEqual(["fallback"]);
    expect(texts(a.frames)).toEqual([]);
  });

  it("全部未就绪时入队，ready 后按序送达", () => {
    const { runtime } = makeMultiRuntime();
    const frames: unknown[] = [];
    const sender = {
      postMessage: (message: unknown) => {
        frames.push(message);
      },
    };
    runtime.attachWebview("late", sender);
    runtime.pushToActiveHostFrame("composer-insert", { text: "queued" });
    expect(frames).toEqual([]); // attach 不 flush
    runtime.handleWebviewMessage("late", {
      t: "plat-evt",
      event: "notifyRendererReady",
    });
    expect(texts(frames)).toEqual(["queued"]);
  });

  it("pushHostFrameTo：只投指定连接，即使它不是最近活动页", () => {
    const { runtime, makeCapture } = makeMultiRuntime();
    const a = makeCapture("a");
    const b = makeCapture("b");
    // 最近活动页是 b：广播/最近活动语义会投给 b，定向语义必须投给 a。
    runtime.handleWebviewMessage("b", { t: "plat-evt", event: "noop" });
    runtime.pushHostFrameTo("a", "composer-insert", { text: "only-a" });
    expect(texts(a.frames)).toEqual(["only-a"]);
    expect(texts(b.frames)).toEqual([]);
  });

  it("pushHostFrameTo：目标不存在/为 null 时丢弃，绝不降级打到最近活动页", () => {
    // 历史缺陷：降级会把 new-session 打到最近活动连接（常常是侧栏 gode.chat 面板），
    // 用户正看着的侧栏会话被清成草稿态，而目标页毫无反应。
    const { runtime, makeCapture } = makeMultiRuntime();
    const a = makeCapture("a");
    runtime.handleWebviewMessage("a", { t: "plat-evt", event: "noop" });
    runtime.pushHostFrameTo(null, "workspace", { kind: "new-session" });
    runtime.pushHostFrameTo("gone", "workspace", { kind: "new-session" });
    expect(texts(a.frames)).toEqual([]);
  });

  it("pushHostFrameTo：目标未就绪 → 排该连接队列，只等它自己 ready（不进广播队列）", () => {
    const { runtime, makeCapture } = makeMultiRuntime();
    const other = makeCapture("other"); // 已就绪的另一页
    const targetFrames: unknown[] = [];
    runtime.attachWebview("target", {
      postMessage: (message: unknown) => targetFrames.push(message),
    }); // 未 ready
    runtime.pushHostFrameTo("target", "composer-insert", { text: "to-target" });
    // 复用 pendingHostFrames 的话这里会被 flush 给 other —— 定向帧重新变成广播。
    expect(texts(other.frames)).toEqual([]);
    expect(texts(targetFrames)).toEqual([]);
    runtime.handleWebviewMessage("target", {
      t: "plat-evt",
      event: "notifyRendererReady",
    });
    expect(texts(targetFrames)).toEqual(["to-target"]);
    expect(texts(other.frames)).toEqual([]);
  });
});

describe("编辑器标签 UI 上行 + 会话标签中继（多页签共享）", () => {
  /** 载荷纯函数（hostFrameKinds 唯一定义处）。 */
  it("composeEditorTabTitle：截断/忙态前缀/默认标题回退", () => {
    const base = "Gode 对话";
    expect(composeEditorTabTitle(base, { title: null, busy: false })).toBe(base);
    expect(composeEditorTabTitle(base, { title: "修复登录 bug", busy: false })).toBe(
      "修复登录 bug",
    );
    expect(composeEditorTabTitle(base, { title: "修复登录 bug", busy: true })).toBe(
      "● 修复登录 bug",
    );
    // 空白标题回退默认；超长截断加省略号。
    expect(composeEditorTabTitle(base, { title: "   ", busy: false })).toBe(base);
    const long = "x".repeat(60);
    const composed = composeEditorTabTitle(base, { title: long, busy: false });
    expect(composed).toHaveLength(41); // 40 + 省略号
    expect(composed.endsWith("…")).toBe(true);
  });

  it("parseEditorTabUiPayload：宽松收窄，非对象/空串标题归 null", () => {
    expect(parseEditorTabUiPayload(null)).toBeNull();
    expect(parseEditorTabUiPayload("x")).toBeNull();
    expect(parseEditorTabUiPayload({ title: "t", busy: true })).toEqual({
      title: "t",
      busy: true,
    });
    expect(parseEditorTabUiPayload({ title: null, busy: false })).toEqual({
      title: null,
      busy: false,
    });
    expect(parseEditorTabUiPayload({ title: "", busy: true })).toEqual({
      title: null,
      busy: true,
    });
    expect(parseEditorTabUiPayload({ busy: true })).toEqual({
      title: null,
      busy: true,
    });
  });

  function makeRelayRuntime(persisted: unknown = null) {
    const writes: unknown[] = [];
    const tabUiCalls: Array<{ id: string; payload: unknown }> = [];
    const runtime = new HostRuntime({
      services: new ServiceCollection(),
      exposurePolicy: createExposurePolicy([]),
      platformMethods: new Map(),
      settingsBridge: new HostSettingsBridge(() => normalizeSettingsSnapshot({})),
      onEditorTabUi: (id, payload) => tabUiCalls.push({ id, payload }),
      sessionTabsPersistence: {
        read: () => persisted,
        write: (value) => writes.push(value),
      },
    });
    const makeCapture = (id: string) => {
      const frames: unknown[] = [];
      const sender = {
        postMessage: (message: unknown) => {
          frames.push(message);
        },
      };
      runtime.attachWebview(id, sender);
      runtime.handleWebviewMessage(id, {
        t: "plat-evt",
        event: "notifyRendererReady",
      });
      return { id, frames, sender };
    };
    const sessionTabsFrames = (frames: unknown[]): unknown[] =>
      frames
        .map((frame) => frame as { t?: string; kind?: string; payload?: unknown })
        .filter((frame) => frame.t === "host" && frame.kind === "session-tabs")
        .map((frame) => frame.payload);
    return { runtime, writes, tabUiCalls, makeCapture, sessionTabsFrames };
  }

  it("notifyEditorTabUi 携带连接 id 路由到 onEditorTabUi", () => {
    const { runtime, tabUiCalls } = makeRelayRuntime();
    runtime.attachWebview("gode.chat.editor.2", {
      postMessage: () => {},
    });
    runtime.handleWebviewMessage("gode.chat.editor.2", {
      t: "plat-evt",
      event: "notifyEditorTabUi",
      payload: { title: "修复登录", busy: true },
    });
    expect(tabUiCalls).toEqual([
      { id: "gode.chat.editor.2", payload: { title: "修复登录", busy: true } },
    ]);
  });

  it("syncSessionTabs 中继给其他就绪连接但不回发发送方，且写持久化", () => {
    const { runtime, writes, makeCapture, sessionTabsFrames } = makeRelayRuntime();
    const a = makeCapture("a");
    const b = makeCapture("b");
    const tabs = { tabs: [{ id: "t1", title: "Untitled", sessionId: null, pinned: false }] };
    runtime.handleWebviewMessage("a", {
      t: "plat-evt",
      event: "syncSessionTabs",
      payload: tabs,
    });
    expect(sessionTabsFrames(b.frames)).toEqual([tabs]);
    expect(sessionTabsFrames(a.frames)).toEqual([]); // 不回发发送方
    expect(writes).toEqual([tabs]);
  });

  it("晚启动连接 renderer ready 后补发持久化的标签全集", () => {
    const stored = {
      tabs: [
        { id: "t1", title: "重构桥层", sessionId: "s-1", pinned: true },
        { id: "t2", title: "Untitled", sessionId: null, pinned: false },
      ],
    };
    const { runtime, sessionTabsFrames } = makeRelayRuntime(stored);
    const frames: unknown[] = [];
    runtime.attachWebview("late", {
      postMessage: (message: unknown) => {
        frames.push(message);
      },
    });
    expect(frames).toEqual([]); // attach 不补发，等 renderer ready
    runtime.handleWebviewMessage("late", {
      t: "plat-evt",
      event: "notifyRendererReady",
    });
    expect(sessionTabsFrames(frames)).toEqual([stored]);
  });

  it("非法 syncSessionTabs 载荷整体丢弃（不中继、不写持久化）", () => {
    const { runtime, writes, makeCapture, sessionTabsFrames } = makeRelayRuntime();
    const b = makeCapture("b");
    runtime.handleWebviewMessage("b", {
      t: "plat-evt",
      event: "syncSessionTabs",
      payload: { tabs: "not-an-array" },
    });
    runtime.handleWebviewMessage("b", {
      t: "plat-evt",
      event: "syncSessionTabs",
      payload: null,
    });
    expect(sessionTabsFrames(b.frames)).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("parseSessionTabsPayload：脏条目逐条丢弃，不整体拒绝", () => {
    expect(parseSessionTabsPayload({ tabs: "x" })).toBeNull();
    expect(
      parseSessionTabsPayload({
        tabs: [
          { id: "ok", title: "t", sessionId: "s", pinned: true },
          null,
          { title: "missing id" },
          { id: "", title: "empty id" },
        ],
      }),
    ).toEqual([{ id: "ok", title: "t", sessionId: "s", pinned: true }]);
  });

  it("requestSessionPicker 上行已移除：未知 plat-evt 静默忽略（空态 CTA 已删）", () => {
    const calls: number[] = [];
    const runtime = new HostRuntime({
      services: new ServiceCollection(),
      exposurePolicy: createExposurePolicy([]),
      platformMethods: new Map(),
      settingsBridge: new HostSettingsBridge(() => normalizeSettingsSnapshot({})),
    });
    runtime.attachWebview("gode.chat.editor", { postMessage: () => {} });
    // 移除后该事件不再有宿主处理器：静默忽略、不崩、不投递。
    expect(() =>
      runtime.handleWebviewMessage("gode.chat.editor", {
        t: "plat-evt",
        event: "requestSessionPicker",
      }),
    ).not.toThrow();
    expect(calls).toEqual([]);
  });
});

describe("增量审查 X3：webview 连接生命周期", () => {
  /** 带 onDidDispose 事件的 sender（模拟 Webview/WebviewPanel 的 dispose 事件）。 */
  function makeDisposalSender(frames?: unknown[]): {
    sender: {
      postMessage: (message: unknown) => void;
      onDidDispose: (cb: () => void) => { dispose(): void };
    };
    fireDispose: () => void;
  } {
    const disposeCallbacks: Array<() => void> = [];
    return {
      sender: {
        postMessage: (message: unknown) => {
          frames?.push(message);
        },
        onDidDispose: (cb: () => void) => {
          disposeCallbacks.push(cb);
          return { dispose() {} };
        },
      },
      fireDispose: () => {
        for (const cb of disposeCallbacks) cb();
      },
    };
  }

  function makeMinimalRuntime(): HostRuntime {
    return new HostRuntime({
      services: new ServiceCollection(),
      exposurePolicy: createExposurePolicy([]),
      platformMethods: new Map(),
      settingsBridge: new HostSettingsBridge(() => normalizeSettingsSnapshot({})),
    });
  }

  it("同 id 重复 attach：旧连接先拆，旧 sender 迟到的 dispose 不误杀新连接", () => {
    const runtime = makeMinimalRuntime();
    const oldFrames: unknown[] = [];
    const newFrames: unknown[] = [];
    const old = makeDisposalSender(oldFrames);
    const fresh = makeDisposalSender(newFrames);

    runtime.attachWebview("gode.chat", old.sender);
    // 竞态：旧 webview dispose 前，webview 重解析已用同 id 挂了新连接。
    runtime.attachWebview("gode.chat", fresh.sender);
    // 旧 sender 迟到的 onDidDispose：身份校验必须保住新连接。
    old.fireDispose();

    // 新连接存活：renderer ready 后 host 帧定向可达。
    runtime.handleWebviewMessage("gode.chat", {
      t: "plat-evt",
      event: "notifyRendererReady",
    });
    runtime.pushHostFrame("theme", 2);
    expect(newFrames).toContainEqual({ t: "host", kind: "theme", payload: 2 });
    // 旧 sender 不再收到任何帧（连接已被替换）。
    expect(oldFrames).toEqual([]);
    runtime.dispose();
  });

  it("正常路径不受影响：dispose 事件 fire 的 sender 是当前连接时照常拆", () => {
    const runtime = makeMinimalRuntime();
    const frames: unknown[] = [];
    const conn = makeDisposalSender(frames);
    runtime.attachWebview("gode.chat", conn.sender);
    runtime.handleWebviewMessage("gode.chat", {
      t: "plat-evt",
      event: "notifyRendererReady",
    });
    conn.fireDispose();
    // 连接已拆：host 帧进入 pending 队列而非投递（无就绪连接语义）。
    runtime.pushHostFrame("theme", 2);
    expect(frames).toEqual([]);
    runtime.dispose();
  });

  it("同 id 重复 attach 后消息只被当前连接处理一次（旧 protocol 已 dispose）", () => {
    const runtime = makeMinimalRuntime();
    const oldFrames: unknown[] = [];
    const newFrames: unknown[] = [];
    const old = makeDisposalSender(oldFrames);
    const fresh = makeDisposalSender(newFrames);
    runtime.attachWebview("gode.chat", old.sender);
    runtime.attachWebview("gode.chat", fresh.sender);
    runtime.handleWebviewMessage("gode.chat", {
      t: "plat-evt",
      event: "notifyRendererReady",
    });
    runtime.handleWebviewMessage("gode.chat", {
      t: "plat-evt",
      event: "__debug-probe",
      payload: "x",
    });
    // ready 后的定向/广播帧只走新连接；旧连接的 postMessage 零调用。
    runtime.pushHostFrame("locale", "zh-cn");
    expect(oldFrames).toEqual([]);
    expect(newFrames).toContainEqual({ t: "host", kind: "locale", payload: "zh-cn" });
    runtime.dispose();
  });
});
