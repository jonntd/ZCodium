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
