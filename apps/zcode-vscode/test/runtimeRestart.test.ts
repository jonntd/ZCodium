/**
 * T02/①+P1-6 host 编排链路：Agent 进程换代 → 自动 resume（恒带约束）→ 横幅帧 → 失败降级。
 *
 * 复用 test/integration.hostUi.test.ts 的内存双端模式：
 * FakeAgentService → ServiceCollection → HostRuntime（IPCServer）→ WebviewMessagePortLike
 * → MessagePortProtocol → ChannelClient → ProxyChannel 代理，RuntimeController 挂代理面。
 * 注意：makeHarness 必须先 sendClientContext（内存环回同步派发的 ctx 竞态）。
 */

import { describe, expect, it } from "vitest";
import { ChannelClient, Emitter, MessagePortProtocol, ProxyChannel, type Event, type IDisposable } from "@zcode/rpc";
import { ServiceCollection, IZCodeAgentService } from "@zcode/services";
import { WebviewMessagePortLike, sendClientContext } from "../src/webview-react/bridge/webviewMessagePort";
import { HostRuntime } from "../src/host/hostRuntime";
import { createExposurePolicy } from "../src/host/serviceAssembly";
import {
  HostSettingsBridge,
  normalizeSettingsSnapshot,
  type HostSettingsSnapshot,
} from "../src/host/hostSettingsBridge";
import { createWorkspaceSessions } from "../src/webview-react/session/workspaceSessions";
import {
  RuntimeController,
  type RuntimeRestartOutcome,
  type RuntimeUiState,
} from "../src/runtimeController";
import type { RestartHostFramePayload } from "../src/host/hostFrameKinds";

/** fake agent 服务：记录调用、支持换代事件注入与 resume 失败注入。 */
class FakeAgentService {
  readonly calls: Array<{ method: string; params: unknown }> = [];
  resumeError: string | null = null;
  private readonly runtimeRestarted = new Emitter<{ workspaceKey: string }>();

  async createSession(params: {
    workspacePath: string;
    mode?: string;
    model?: unknown;
    toolAllowlist?: string[];
    toolDenylist?: string[];
    mcpServers?: unknown[];
    additionalDirectories?: string[];
  }): Promise<unknown> {
    this.calls.push({ method: "createSession", params });
    return { session: { sessionId: `s-created-${this.calls.length}` } };
  }

  async resumeSession(params: {
    sessionId: string;
    workspacePath: string;
    toolAllowlist?: string[];
    toolDenylist?: string[];
    mcpServers?: unknown[];
    additionalDirectories?: string[];
  }): Promise<unknown> {
    this.calls.push({ method: "resumeSession", params });
    if (this.resumeError) throw new Error(this.resumeError);
    return { session: { sessionId: params.sessionId } };
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
  host: HostRuntime;
  /** host → webview 全量帧（横幅帧断言面）。 */
  hostFrames: Array<Record<string, unknown>>;
}

/** 完整内存双端（与 integration.hostUi.test.ts 的 makeHarness 同构 + 帧探针）。 */
function makeHarness(fake: FakeAgentService = new FakeAgentService()): Harness {
  const services = new ServiceCollection();
  services.register(IZCodeAgentService, fake as unknown as IZCodeAgentService);

  const host = new HostRuntime({
    services,
    exposurePolicy: createExposurePolicy(["zcode-agent"]),
    platformMethods: new Map(),
    settingsBridge: new HostSettingsBridge(() => normalizeSettingsSnapshot({})),
  });
  const hostFrames: Array<Record<string, unknown>> = [];
  const vscode = {
    postMessage: (message: unknown) => {
      host.handleWebviewMessage("test", message);
    },
  };
  const port = new WebviewMessagePortLike(vscode);
  host.attachWebview("test", {
    postMessage: (message: unknown) => {
      if (typeof message === "object" && message !== null) hostFrames.push(message as Record<string, unknown>);
      port.handleMessageData(message);
    },
  });
  const client = new ChannelClient(new MessagePortProtocol(port));
  // IPCServer 协议首消息 = ctx 身份帧（必须先于任何 call/listen 完成）。
  sendClientContext(vscode);
  const agentProxy = ProxyChannel.toService<IZCodeAgentService>(
    client.getChannel(IZCodeAgentService.channelName),
  );
  return { fake, agentProxy, host, hostFrames };
}

/** 可变 settings 快照（settings 变更 = 下次 resolve 生效）。 */
function mutableBridge(initial: Partial<HostSettingsSnapshot>): {
  bridge: HostSettingsBridge;
  setSnapshot(next: Partial<HostSettingsSnapshot>): void;
} {
  let current: Partial<HostSettingsSnapshot> = initial;
  return {
    bridge: new HostSettingsBridge(() => normalizeSettingsSnapshot(current)),
    setSnapshot(next) {
      current = next;
    },
  };
}

/** 内存 per-folder 会话键空间。 */
function memoryWorkspaceSessions() {
  const ids = new Map<string, string | undefined>();
  return {
    sessions: createWorkspaceSessions({
      getSessionId: (key) => ids.get(key),
      setSessionId: (key, id) => {
        if (id === undefined) ids.delete(key);
        else ids.set(key, id);
      },
    }),
    ids,
  };
}

interface ControllerFixture {
  controller: RuntimeController;
  ids: Map<string, string | undefined>;
  states: RuntimeUiState[];
  banners: RuntimeRestartOutcome[];
  logs: string[];
  dispose(): void;
}

function makeController(
  harness: Harness,
  options?: {
    bridge?: HostSettingsBridge;
    folders?: string[];
    presetSessions?: Record<string, string>;
  },
): ControllerFixture {
  const { sessions, ids } = memoryWorkspaceSessions();
  for (const [folder, sessionId] of Object.entries(options?.presetSessions ?? {})) {
    sessions.set(folder, sessionId);
  }
  const states: RuntimeUiState[] = [];
  const banners: RuntimeRestartOutcome[] = [];
  const logs: string[] = [];
  const controller = new RuntimeController({
    agentService: harness.agentProxy,
    settingsBridge:
      options?.bridge ??
      mutableBridge({
        toolAllowlist: ["Bash(git status:*)"],
        toolDenylist: ["Bash(rm -rf:*)"],
        mcpServers: [{ type: "stdio", command: "mcp-server-file" }],
        additionalDirectories: ["/tmp/a"],
      }).bridge,
    workspaceSessions: sessions,
    listFolders: () => options?.folders ?? ["/repo-a"],
    log: (message) => logs.push(message),
    events: {
      onStateChange: (state) => states.push(state),
      // 与 container 接线同构：编排结果 → host 横幅帧（restart 帧，P1-6）。
      onRuntimeRestart: (outcome) => {
        banners.push(outcome);
        harness.host.pushHostFrame("restart", outcome);
      },
    },
  });
  return {
    controller,
    ids,
    states,
    banners,
    logs,
    dispose: () => controller.dispose(),
  };
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("until: 条件超时");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** 事件订阅经桥异步落地（listen 命令），换代注入前先等待订阅链路稳定。 */
const SUBSCRIBE_SETTLE_MS = 50;

function restartFrames(harness: Harness): RestartHostFramePayload[] {
  return harness.hostFrames
    .filter((frame) => frame.t === "host" && frame.kind === "restart")
    .map((frame) => frame.payload as RestartHostFramePayload);
}

describe("RuntimeController 接线（T02/① + P1-6 编排链路）", () => {
  it("createSession 走完整参数面（mode/modelSelection/工具面/MCP/附加目录）", async () => {
    const harness = makeHarness();
    const fixture = makeController(harness, {
      bridge: mutableBridge({
        toolAllowlist: ["Read"],
        toolDenylist: ["Bash(rm -rf:*)"],
        mcpServers: [{ type: "stdio", command: "mcp-server-file" }],
        additionalDirectories: ["/tmp/a"],
        mode: "edit",
        rawModel: "zai/glm-5",
      }).bridge,
    });
    const { sessionId } = await fixture.controller.createSession("/repo-a");
    expect(sessionId).toBe("s-created-1");
    const call = harness.fake.calls.find((c) => c.method === "createSession");
    expect(call?.params).toMatchObject({
      workspacePath: "/repo-a",
      mode: "edit",
      model: { providerId: "zai", modelId: "glm-5" },
      toolAllowlist: ["Read"],
      toolDenylist: ["Bash(rm -rf:*)"],
      additionalDirectories: ["/tmp/a"],
    });
    expect((call?.params as { mcpServers: unknown[] }).mcpServers).toHaveLength(1);
    // 写穿透 per-folder 键空间（P1-1.5）。
    expect(fixture.ids.get("/repo-a")).toBe("s-created-1");
    fixture.dispose();
  }, 30_000);

  it("activate 后按 workspaceSessions 键控恢复最近会话（P1-1.5 host 半，resume 恒带约束）", async () => {
    const harness = makeHarness();
    const fixture = makeController(harness, { presetSessions: { "/repo-a": "s-9" } });
    await fixture.controller.restoreWorkspaceSessions();
    const call = harness.fake.calls.find((c) => c.method === "resumeSession");
    expect(call?.params).toMatchObject({
      sessionId: "s-9",
      workspacePath: "/repo-a",
      toolAllowlist: ["Bash(git status:*)"],
      toolDenylist: ["Bash(rm -rf:*)"],
      additionalDirectories: ["/tmp/a"],
    });
    expect((call?.params as { mcpServers: unknown[] }).mcpServers).toHaveLength(1);
    expect(fixture.states[0]).toBe("starting");
    expect(fixture.states.at(-1)).toBe("ready");
    fixture.dispose();
  }, 30_000);

  it("进程换代 → 自动 resume（恒带约束）→ 横幅帧 → 状态 ready", async () => {
    const harness = makeHarness();
    const fixture = makeController(harness, { presetSessions: { "/repo-a": "s-7" } });
    await new Promise((resolve) => setTimeout(resolve, SUBSCRIBE_SETTLE_MS));
    harness.fake.emitRuntimeRestart("/repo-a");
    await until(() => fixture.states.at(-1) === "ready" && restartFrames(harness).length > 0);
    // 自动 resume：沿约束面（不绕过）。
    const call = harness.fake.calls.find((c) => c.method === "resumeSession");
    expect(call?.params).toMatchObject({
      sessionId: "s-7",
      workspacePath: "/repo-a",
      toolAllowlist: ["Bash(git status:*)"],
      toolDenylist: ["Bash(rm -rf:*)"],
    });
    // 横幅帧（换代→横幅→自动恢复）。
    const banner = restartFrames(harness)[0]!;
    expect(banner).toMatchObject({ workspaceKey: "/repo-a", restored: ["s-7"], failures: [] });
    expect(fixture.states).toContain("restarting");
    fixture.dispose();
  }, 30_000);

  it("换代后沿用变更后的 settings 快照（不绕过新约束）", async () => {
    const harness = makeHarness();
    const snapshot = mutableBridge({ toolDenylist: ["Bash(old:*)"] });
    const fixture = makeController(harness, { bridge: snapshot.bridge, presetSessions: { "/repo-a": "s-1" } });
    await new Promise((resolve) => setTimeout(resolve, SUBSCRIBE_SETTLE_MS));
    snapshot.setSnapshot({ toolDenylist: ["Bash(new:*)"], toolAllowlist: ["Read"] });
    harness.fake.emitRuntimeRestart("/repo-a");
    await until(() => fixture.states.at(-1) === "ready");
    expect(harness.fake.calls.find((c) => c.method === "resumeSession")?.params).toMatchObject({
      sessionId: "s-1",
      toolDenylist: ["Bash(new:*)"],
      toolAllowlist: ["Read"],
    });
    fixture.dispose();
  }, 30_000);

  it("resume 失败降级：横幅 failures + crashed 语义 + 诊断日志（不静默）", async () => {
    const harness = makeHarness();
    const fixture = makeController(harness, { presetSessions: { "/repo-a": "s-8" } });
    await new Promise((resolve) => setTimeout(resolve, SUBSCRIBE_SETTLE_MS));
    harness.fake.resumeError = "cold resume refused";
    harness.fake.emitRuntimeRestart("/repo-a");
    await until(() => fixture.states.at(-1) === "crashed" && restartFrames(harness).length > 0);
    const banner = restartFrames(harness)[0]!;
    expect(banner.restored).toEqual([]);
    expect(banner.failures).toHaveLength(1);
    expect(banner.failures[0]).toMatchObject({ folder: "/repo-a", sessionId: "s-8" });
    expect(banner.failures[0]?.error).toContain("cold resume refused");
    expect(fixture.logs.some((line) => line.includes("自动恢复失败"))).toBe(true);
    fixture.dispose();
  }, 30_000);

  it("workspaceKey 未命中时对齐唯一有会话的 folder（兜底编排）", async () => {
    const harness = makeHarness();
    const fixture = makeController(harness, { presetSessions: { "/repo-a": "s-5" } });
    await new Promise((resolve) => setTimeout(resolve, SUBSCRIBE_SETTLE_MS));
    harness.fake.emitRuntimeRestart("/some-other-key");
    await until(() => fixture.states.at(-1) === "ready");
    expect(harness.fake.calls.find((c) => c.method === "resumeSession")?.params).toMatchObject({
      sessionId: "s-5",
      workspacePath: "/repo-a",
    });
    fixture.dispose();
  }, 30_000);

  it("dispose 后不再编排换代（事件解绑）", async () => {
    const harness = makeHarness();
    const fixture = makeController(harness, { presetSessions: { "/repo-a": "s-6" } });
    await new Promise((resolve) => setTimeout(resolve, SUBSCRIBE_SETTLE_MS));
    fixture.dispose();
    harness.fake.emitRuntimeRestart("/repo-a");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.fake.calls.some((c) => c.method === "resumeSession")).toBe(false);
  }, 30_000);
});
