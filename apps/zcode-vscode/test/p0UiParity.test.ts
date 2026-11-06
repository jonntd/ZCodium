/**
 * T05 渲染链路验收：P0-1..P0-10 渲染投影清单（vitest node 环境）。
 *
 * 锁「transport → ui store 投影 → 组件 props」协议面，不真渲染 DOM：
 *   ConversationTopicFrame（@zcode/shared schema 校验）
 *   → ConversationProjectionStore.handleFrame（ui 包真实投影，零改动）
 *   → 行投影/审批卡适配器 props（pendingInteractionAdapter）
 *   → resolveInteraction / retryTurn 命令信封（zcode-protocol-v4/command.ts）。
 *
 * P0 清单（docs/prd.md P0-1..P0-10）与本文件断言映射：
 * | P0    | 投影断言                                            |
 * |-------|-----------------------------------------------------|
 * | P0-1  | CLI/握手缺失 → store error 态（明确报错不静默）      |
 * | P0-2  | runtime 换代 → store 断开重连态（进程生命周期投影）  |
 * | P0-3  | sendText 信封 → userInput 行 sourceCommandId 关联   |
 * | P0-4  | 聊天流投影：userInput(realUser) 行进窗               |
 * | P0-5  | text_delta 流式追加 + reasoning 折叠行               |
 * | P0-6  | toolCall 状态机投影（inputStreaming→success+output） |
 * | P0-7  | permission 交互 → 审批卡 props（PermissionDialog 面）|
 * | P0-8  | 命令审批 options（allowOnce/allowAlways/deny）+ 写回面|
 * | P0-9  | turnHeader running→completedSuccess / failed+重试    |
 * | P0-10 | hello 版本守卫（旧 CLI 协议版本拒收）                |
 */

import { describe, expect, it } from "vitest";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import { pendingPermissionToLegacyRequest } from "@/v4/pendingInteractionAdapter.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import type { ConversationTransport } from "@/v4/transport.js";
import {
  commandEnvelopeSchema,
  conversationTopicFrameSchema,
  helloMessageSchema,
  V4_WIRE_PROTOCOL_VERSION,
  type CommandEnvelope,
  type ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import { PLATFORM_METHOD_WHITELIST } from "../src/host/platformRpcHandler";
import {
  CAPABILITY_BINARY_FRAME_HINT,
  CAPABILITY_UNSUPPORTED_HINT,
  capabilitiesFrameFromProbe,
  capabilitiesFromHello,
  gatePaneCallbacksByCapability,
  probeCapabilitiesFrame,
  projectCapabilities,
  projectCapabilitiesPayload,
} from "../src/webview-react/capabilities";
import { isCapabilityMissingError, JSON_RPC_ERROR_CODES } from "../src/errors";
import { projectRestartBanner } from "../src/webview-react/banners/RuntimeRestartBanner";

// ── fixture：合法 ConversationSnapshot（conversationSnapshotSchema 校验通过） ──

const SESSION_ID = "s-parity";

function baseSnapshot(rows: unknown[] = [], seq = 0): Record<string, unknown> {
  return {
    protocolVersion: 1,
    sessionId: SESSION_ID,
    logEpoch: "epoch-0",
    seq,
    revision: 1,
    control: {
      phase: "running",
      sessionEnded: false,
      canStop: true,
      stopState: "stoppable",
      stopTargetKind: "unknown",
      activeWorks: [],
      lastError: null,
      apiRetry: null,
    },
    availability: {
      fork: { allowed: true },
      compact: { allowed: true },
      switchModelConfig: { allowed: true },
      setFollowupMode: { allowed: true },
      queueEdit: { allowed: true },
      sendQueuedNow: { allowed: true },
      pauseGoal: { allowed: true },
      resumeGoal: { allowed: true },
    },
    inputRouting: { mode: "startNow" },
    config: {
      provider: "glm",
      model: "glm-5.3",
      thought: "off",
      followupMode: "queue",
    },
    usage: {
      contextWindow: null,
      cumulative: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    },
    queue: { items: [], autoDrain: true },
    pendingInteractions: [],
    pendingCommands: [],
    backgroundWorks: [],
    goal: null,
    plan: null,
    rows: {
      window: rows,
      totalCount: rows.length,
      firstRowId: rows.length > 0 ? 1 : null,
    },
  };
}

function rowBase(rowId: number): Record<string, unknown> {
  return { rowId, turnId: "turn-1", createdAt: 1_000, createdAtSeq: rowId };
}

function userInputRow(commandId: string): Record<string, unknown> {
  return {
    ...rowBase(1),
    kind: "userInput",
    text: "帮我修一下测试",
    origin: "realUser",
    sourceCommandId: commandId,
  };
}

function turnHeaderRow(
  state: "running" | "completedSuccess" | "failed",
): Record<string, unknown> {
  return {
    ...rowBase(2),
    kind: "turnHeader",
    origin: "userInput",
    state,
    startedAt: 1_000,
    ...(state !== "running" ? { endedAt: 2_000 } : {}),
  };
}

const permissionInteraction = {
  interactionId: "int-1",
  kind: "permission",
  anchorRowId: 3,
  createdAt: 1_500,
  payload: {
    kind: "permission",
    toolCallId: "t-1",
    toolName: "bash",
    summary: "执行命令 npm test",
    detail: { command: "npm test" },
    options: [
      { optionId: "allow", label: "允许", kind: "allowOnce" },
      { optionId: "allowSession", label: "本次会话允许", kind: "allowAlways" },
      { optionId: "deny", label: "拒绝", kind: "deny" },
    ],
  },
};

function toolCallRow(status: string): Record<string, unknown> {
  return {
    ...rowBase(3),
    kind: "toolCall",
    toolCallId: "t-1",
    toolName: "bash",
    status,
    inputText: "npm test",
    ...(status === "pendingApproval" ? { approvalInteractionId: "int-1" } : {}),
    ...(status === "success" ? { output: { text: "all tests passed" } } : {}),
  };
}

// ── Stub transport：只承载 store 的订阅生命周期与帧路由协议面 ──

const SUBSCRIPTION_ID = "sub-parity";

class StubConversationTransport {
  readonly frameListeners = new Set<
    (frame: ConversationTopicFrame, context?: { deliveryKind: string }) => void
  >();
  readonly restartListeners = new Set<
    (reason?: "runtimeRestart" | "transportReplaced") => void
  >();
  subscribeImpl: (() => Promise<unknown>) | null = null;

  async subscribe(): Promise<unknown> {
    if (this.subscribeImpl) return this.subscribeImpl();
    return {
      ack: {
        subscriptionId: SUBSCRIPTION_ID,
        mode: "snapshot",
        logEpoch: "epoch-0",
      },
    };
  }
  activate(_subscriptionId: string): void {}
  async resync(): Promise<unknown> {
    // v4ConversationResyncResultSchema：{ ack } strict（same-sub recovery ACK 形状）。
    return {
      ack: {
        subscriptionId: SUBSCRIPTION_ID,
        mode: "snapshot",
        logEpoch: "epoch-0",
      },
    };
  }
  async unsubscribe(_subscriptionId: string): Promise<void> {}
  async sendCommand(_envelope: CommandEnvelope): Promise<unknown> {
    return {
      commandId: _envelope.commandId,
      status: "accepted",
      revisionAtDecision: 1,
    };
  }
  async queryCommands(): Promise<unknown> {
    return { commands: [] };
  }
  async rowsRange(): Promise<unknown> {
    return { rows: [] };
  }
  async plans(): Promise<unknown> {
    return { plans: [] };
  }
  async workflowRunEvents(): Promise<unknown> {
    return { events: [] };
  }
  async workflowRuns(): Promise<unknown> {
    return { runs: [] };
  }
  async workflowRunArtifacts(): Promise<unknown> {
    return { artifacts: [] };
  }
  async workflowRunArtifactData(): Promise<unknown> {
    return { data: null };
  }
  async workflowRunArtifactRead(): Promise<unknown> {
    return { data: null };
  }
  async workflowRunWorkspace(): Promise<unknown> {
    return { workspace: null };
  }
  async workflowRunNodeResult(): Promise<unknown> {
    return { result: null };
  }
  async fileChanges(): Promise<unknown> {
    return { changes: [] };
  }
  async fileRewindPreview(): Promise<unknown> {
    return { preview: null };
  }
  async attachmentPut(): Promise<unknown> {
    return { attachmentId: "a1" };
  }
  async attachmentRead(): Promise<unknown> {
    return { bytes: new Uint8Array(), mediaType: "text/plain" };
  }
  async attachmentReadRange(): Promise<unknown> {
    return {
      bytes: new Uint8Array(),
      mediaType: "text/plain",
      totalBytes: 0,
      nextOffset: null,
    };
  }
  onFrame(
    listener: (
      frame: ConversationTopicFrame,
      context?: { deliveryKind: string },
    ) => void,
  ): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }
  onAssemblyFault(_listener: (fault: unknown) => void): () => void {
    return () => {};
  }
  onRuntimeRestart(
    listener: (reason?: "runtimeRestart" | "transportReplaced") => void,
  ): () => void {
    this.restartListeners.add(listener);
    return () => this.restartListeners.delete(listener);
  }
  fireRuntimeRestart(): void {
    for (const listener of [...this.restartListeners]) listener();
  }
}

/** 建立已 ACK 的 store（snapshot initial 帧由调用方喂入）。 */
async function makeLiveStore(
  transport: StubConversationTransport,
): Promise<ConversationProjectionStore> {
  const store = new ConversationProjectionStore(
    `conversation/${SESSION_ID}`,
    transport as unknown as ConversationTransport,
  );
  await store.connect();
  expect(store.getState().status).toBe("live");
  expect(store.getState().subscriptionId).toBe(SUBSCRIPTION_ID);
  return store;
}

function snapshotFrame(
  seq: number,
  snapshot: Record<string, unknown>,
): ConversationTopicFrame {
  return conversationTopicFrameSchema.parse({
    topic: `conversation/${SESSION_ID}`,
    subscriptionId: SUBSCRIPTION_ID,
    fromSeq: 0,
    toSeq: seq,
    sentAt: Date.now(),
    payload: { kind: "snapshot", snapshot },
  });
}

function deltasFrame(
  fromSeq: number,
  deltas: Record<string, unknown>[],
): ConversationTopicFrame {
  return conversationTopicFrameSchema.parse({
    topic: `conversation/${SESSION_ID}`,
    subscriptionId: SUBSCRIPTION_ID,
    fromSeq,
    toSeq: fromSeq + deltas.length,
    sentAt: Date.now(),
    payload: { kind: "deltas", deltas },
  });
}

/** 帧投递（SessionDataLayer 路由面的等价物）：直接喂 store.handleFrame。 */
type DeliveryKind = "initial" | "recovery" | "online";
function deliver(
  store: ConversationProjectionStore,
  frame: ConversationTopicFrame,
  deliveryKind: DeliveryKind,
): void {
  store.handleFrame(frame, { deliveryKind });
}

// ── P0-1..P0-10 渲染投影清单 ──

describe("P0 投影清单：流式/推理/工具/审批/turn（P0-3..P0-9 主链）", () => {
  it("P0-3/P0-4/P0-5：snapshot initial → sendText 投影 → text_delta 流式 + reasoning 折叠", async () => {
    const transport = new StubConversationTransport();
    const store = await makeLiveStore(transport);

    const envelope = createCommandEnvelope({
      type: "sendText",
      payload: { text: "帮我修一下测试" },
      sessionId: SESSION_ID,
    });
    // 初始快照（空窗）→ 增量：userInput + assistantText 流式 + reasoning。
    deliver(store, snapshotFrame(0, baseSnapshot()), "initial");
    deliver(
      store,
      deltasFrame(0, [
        { op: "row.appended", row: userInputRow(envelope.commandId) },
        {
          op: "row.appended",
          row: {
            ...rowBase(4),
            kind: "assistantText",
            text: "你",
            state: "streaming",
          },
        },
        { op: "row.delta", rowId: 4, path: "text", append: "好" },
        {
          op: "row.appended",
          row: {
            ...rowBase(5),
            kind: "reasoning",
            text: "先看失败用例",
            state: "streaming",
          },
        },
      ]),
      "online",
    );

    const snapshot = store.getState().snapshot;
    expect(snapshot).not.toBeNull();
    expect(store.getState().status).toBe("live");
    // P0-3：sendText 信封 → 投影行按 sourceCommandId 关联（发送链路对账锚点）。
    const userInput = snapshot?.rows.window.find(
      (row) => row.kind === "userInput",
    );
    expect(
      userInput && "sourceCommandId" in userInput
        ? userInput.sourceCommandId
        : undefined,
    ).toBe(envelope.commandId);
    // P0-4：聊天流投影含 realUser 输入行。
    expect(
      userInput && "origin" in userInput ? userInput.origin : undefined,
    ).toBe("realUser");
    // P0-5：text_delta 流式追加（你 + 好 → 你好）。
    const assistant = snapshot?.rows.window.find(
      (row) => row.kind === "assistantText",
    );
    expect(assistant && "text" in assistant ? assistant.text : undefined).toBe(
      "你好",
    );
    expect(
      assistant && "state" in assistant ? assistant.state : undefined,
    ).toBe("streaming");
    // P0-5：reasoning 行进窗（折叠块数据源）。
    const reasoning = snapshot?.rows.window.find(
      (row) => row.kind === "reasoning",
    );
    expect(reasoning && "text" in reasoning ? reasoning.text : undefined).toBe(
      "先看失败用例",
    );
  });

  it("P0-6：工具时间线投影（pendingApproval → running(progress) → success+output）", async () => {
    const transport = new StubConversationTransport();
    const store = await makeLiveStore(transport);
    deliver(store, snapshotFrame(0, baseSnapshot()), "initial");
    deliver(
      store,
      deltasFrame(0, [
        { op: "row.appended", row: toolCallRow("pendingApproval") },
        { op: "row.upserted", row: toolCallRow("running") },
        {
          op: "row.upserted",
          row: {
            ...toolCallRow("running"),
            progress: { message: "running tests", updatedAt: 1_800 },
          },
        },
        { op: "row.upserted", row: toolCallRow("success") },
      ]),
      "online",
    );
    const tool = store
      .getState()
      .snapshot?.rows.window.find((row) => row.kind === "toolCall");
    expect(tool && "status" in tool ? tool.status : undefined).toBe("success");
    expect(
      tool && "output" in tool
        ? (tool.output as { text?: string } | undefined)?.text
        : undefined,
    ).toBe("all tests passed");
  });

  it("P0-7：permission 交互 → 审批卡组件 props（pendingPermissionToLegacyRequest 面）", async () => {
    const transport = new StubConversationTransport();
    const store = await makeLiveStore(transport);
    deliver(store, snapshotFrame(0, baseSnapshot()), "initial");
    deliver(
      store,
      deltasFrame(0, [
        { op: "row.appended", row: toolCallRow("pendingApproval") },
        {
          op: "state.updated",
          patch: { pendingInteractions: [permissionInteraction] },
        },
      ]),
      "online",
    );
    const pending = store.getState().snapshot?.pendingInteractions[0];
    expect(pending?.interactionId).toBe("int-1");
    expect(pending?.payload.kind).toBe("permission");
    if (!pending || pending.payload.kind !== "permission") return;

    // 审批卡组件 props：PermissionDialog 消费的 ZCodePermissionRequest。
    const props = pendingPermissionToLegacyRequest(SESSION_ID, {
      ...pending,
      kind: "permission" as const,
      payload: pending.payload,
    });
    expect(props.type).toBe("permission_request");
    expect(props.taskId).toBe(SESSION_ID);
    expect(props.requestId).toBe("int-1");
    expect(props.description).toBe("执行命令 npm test");
    expect(props.options.map((option) => option.optionId)).toEqual([
      "allow",
      "allowSession",
      "deny",
    ]);
    // P0-8：「本次会话允许」选项应答 → allowlist 写回面（plat 白名单承载）。
    const allowSession = props.options.find(
      (option) => option.optionId === "allowSession",
    );
    expect(allowSession?.response).toMatchObject({ decision: "allow" });
    expect(PLATFORM_METHOD_WHITELIST).toContain("appendSessionAllowlist");
  });

  it("P0-7/P0-8：resolveInteraction 信封按 command.ts schema 校验（审批应答命令面）", () => {
    const envelope = createCommandEnvelope({
      type: "resolveInteraction",
      payload: {
        interactionId: "int-1",
        answer: { optionId: "allowSession" },
      },
      sessionId: SESSION_ID,
    });
    const parsed = commandEnvelopeSchema.parse(envelope);
    expect(parsed.type).toBe("resolveInteraction");
    expect(parsed.sessionId).toBe(SESSION_ID);
    expect(parsed.payload).toMatchObject({
      interactionId: "int-1",
      answer: { optionId: "allowSession" },
    });
  });

  it("P0-9：turn 生命周期投影（running → completedSuccess；failed + retryTurn 重试信封）", async () => {
    const transport = new StubConversationTransport();
    const store = await makeLiveStore(transport);
    deliver(
      store,
      snapshotFrame(0, baseSnapshot([turnHeaderRow("running")], 2)),
      "initial",
    );
    expect(
      store
        .getState()
        .snapshot?.rows.window.find((row) => row.kind === "turnHeader")?.state,
    ).toBe("running");
    deliver(
      store,
      deltasFrame(2, [
        { op: "row.upserted", row: turnHeaderRow("completedSuccess") },
      ]),
      "online",
    );
    const turn = store
      .getState()
      .snapshot?.rows.window.find((row) => row.kind === "turnHeader");
    expect(turn?.state).toBe("completedSuccess");
    expect("endedAt" in turn! && turn.endedAt).toBe(2_000);

    // failed 投影 + 重试入口信封（P0-9 可读错误与重试按钮的协议面）。
    deliver(
      store,
      deltasFrame(3, [
        { op: "row.upserted", row: turnHeaderRow("failed") },
        {
          op: "state.updated",
          patch: {
            control: {
              phase: "error",
              sessionEnded: false,
              canStop: false,
              stopState: "idle",
              stopTargetKind: "unknown",
              activeWorks: [],
              lastError: {
                code: "provider.error",
                message: "上游超时",
                recoverable: true,
                at: 3_000,
                source: "provider",
              },
              apiRetry: null,
            },
          },
        },
      ]),
      "online",
    );
    const failed = store.getState().snapshot;
    expect(
      failed?.rows.window.find((row) => row.kind === "turnHeader")?.state,
    ).toBe("failed");
    expect(failed?.control.lastError?.message).toBe("上游超时");
    const retry = createCommandEnvelope({
      type: "retryTurn",
      payload: { target: { rowId: 2, entityId: "turn-1" } },
      sessionId: SESSION_ID,
      baseRevision: 1,
      baseLogEpoch: "epoch-0",
    });
    expect(commandEnvelopeSchema.parse(retry).type).toBe("retryTurn");
  });

  it("P1-7：usage 状态投影（turn 完成后的累计用量行数据源）", async () => {
    const transport = new StubConversationTransport();
    const store = await makeLiveStore(transport);
    deliver(store, snapshotFrame(0, baseSnapshot()), "initial");
    deliver(
      store,
      deltasFrame(0, [
        {
          op: "state.updated",
          patch: {
            usage: {
              contextWindow: null,
              cumulative: {
                inputTokens: 120,
                outputTokens: 1_200,
                cacheReadTokens: 300,
                cacheWriteTokens: 0,
              },
            },
          },
        },
      ]),
      "online",
    );
    expect(store.getState().snapshot?.usage.cumulative).toEqual({
      inputTokens: 120,
      outputTokens: 1_200,
      cacheReadTokens: 300,
      cacheWriteTokens: 0,
    });
  });
});

describe("P0 投影清单：生命周期守卫（P0-1/P0-2/P0-10）", () => {
  it("P0-1：握手/CLI 缺失 → store 明确 error 态（不静默）", async () => {
    const transport = new StubConversationTransport();
    transport.subscribeImpl = () =>
      Promise.reject(new Error("method not found: helloConversationV4"));
    const store = new ConversationProjectionStore(
      `conversation/${SESSION_ID}`,
      transport as unknown as ConversationTransport,
    );
    await store.connect();
    expect(store.getState().status).toBe("error");
    expect(store.getState().lastError).toContain("helloConversationV4");
  });

  it("P0-2：runtime 换代 → store 退订并回到 connecting（进程生命周期投影）", async () => {
    const transport = new StubConversationTransport();
    const store = await makeLiveStore(transport);
    deliver(store, snapshotFrame(0, baseSnapshot()), "initial");
    expect(store.getState().snapshot).not.toBeNull();
    transport.fireRuntimeRestart();
    expect(store.getState().status).toBe("connecting");
    expect(store.getState().subscriptionId).toBeNull();
    // 新进程 ACK 后恢复 live（重启回连投影）。
    await store.connect();
    expect(store.getState().status).toBe("live");
  });

  it("P0-10：hello 版本守卫——旧 CLI 协议版本拒收（helloMessageSchema literal 校验）", () => {
    const stale = {
      kind: "hello",
      protocolVersion: "v3-legacy",
      connectionId: "conn-1",
      clientMode: "desktop-continuous",
      deliveryProfile: "continuous",
      serverTime: Date.now(),
      capabilities: {
        nativeDialogs: false,
        localTerminal: false,
        binaryFrames: true,
        compression: "none",
      },
      auth: {},
    };
    expect(helloMessageSchema.safeParse(stale).success).toBe(false);
    // 当前版本 hello 通过（正样本）。
    expect(
      helloMessageSchema.safeParse({
        ...stale,
        protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      }).success,
    ).toBe(true);
  });

  it("P0-10：断档帧不猜（seq gap → 不应用、保持当前投影）", async () => {
    const transport = new StubConversationTransport();
    const store = await makeLiveStore(transport);
    deliver(store, snapshotFrame(0, baseSnapshot()), "initial");
    // fromSeq=5 与本地 seq=0 断档 → 丢弃（规则 2：断档不猜）。
    deliver(
      store,
      deltasFrame(5, [{ op: "row.appended", row: userInputRow("cmd-x") }]),
      "online",
    );
    expect(store.getState().snapshot?.rows.window).toHaveLength(0);
  });
});

describe("T07 投影：restart 横幅与 capabilities 显隐（P1-6/P1-10.3）", () => {
  it("restart 帧投影：全部恢复 → info；部分失败 → warn + 失败明细；空载荷不呈现", () => {
    expect(projectRestartBanner(null).visible).toBe(false);
    const restored = projectRestartBanner({
      workspaceKey: "/repo",
      restored: ["s-1"],
      failures: [],
    });
    expect(restored.visible).toBe(true);
    expect(restored.tone).toBe("info");
    expect(restored.message).toContain("已恢复");
    const partial = projectRestartBanner({
      workspaceKey: "/repo",
      restored: [],
      failures: [{ folder: "/repo", sessionId: "s-2", error: "会话损坏" }],
    });
    expect(partial.tone).toBe("warn");
    expect(partial.failures[0]?.sessionId).toBe("s-2");
  });

  it("capabilities 显隐投影：hello 缺失整体降级；binaryFrames=false 给链路降级提示", () => {
    // 旧 CLI / 握手未达：入口隐藏 + 「当前 CLI 版本不支持」。
    const degraded = projectCapabilities(null);
    expect(degraded.showTerminalEntry).toBe(false);
    expect(degraded.showNativeDialogEntry).toBe(false);
    expect(degraded.unsupportedHint).toBe(CAPABILITY_UNSUPPORTED_HINT);
    // hello 在场：按位投影。
    const projection = projectCapabilities({
      nativeDialogs: false,
      localTerminal: false,
      binaryFrames: true,
      compression: "none",
    });
    expect(projection).toEqual({
      showTerminalEntry: false,
      showNativeDialogEntry: false,
      binaryFrameHint: null,
      unsupportedHint: null,
    });
    const noBinary = projectCapabilities({
      nativeDialogs: false,
      localTerminal: false,
      binaryFrames: false,
      compression: "none",
    });
    expect(noBinary.binaryFrameHint).toBe(CAPABILITY_BINARY_FRAME_HINT);
    // capabilitiesFromHello：hello 载荷收敛（integration fake hello 同形）。
    expect(
      capabilitiesFromHello({
        capabilities: {
          nativeDialogs: false,
          localTerminal: false,
          binaryFrames: true,
          compression: "none",
        },
      }),
    ).toMatchObject({ binaryFrames: true });
    expect(capabilitiesFromHello({ capabilities: null })).toBeNull();
    expect(capabilitiesFromHello(null)).toBeNull();
  });
});

// ── capabilities 投影接线（closeout-2：T07「接线后行为」+ FR-A13 残余吸收） ──
// 链路：host 探测（hello / runtime/capabilities 复核）→ capabilitiesFrameFromProbe
// → capabilities 帧（wire "capabilities"）→ projectCapabilitiesPayload → App 消费
// （降级提示渲染 + showTerminalEntry 门控 onOpenBackgroundBash）。

const HELLO_ALL_ON = {
  kind: "hello",
  capabilities: {
    nativeDialogs: true,
    localTerminal: true,
    binaryFrames: true,
    compression: "none",
  },
};

describe("capabilitiesFrameFromProbe：host 探测结果 → 帧载荷", () => {
  it("hello 成功 → capabilitiesFromHello 收敛，capabilityMissing=false", () => {
    expect(
      capabilitiesFrameFromProbe({ ok: true, hello: HELLO_ALL_ON }),
    ).toEqual({
      capabilities: {
        nativeDialogs: true,
        localTerminal: true,
        binaryFrames: true,
        compression: "none",
      },
      capabilityMissing: false,
    });
  });

  it("hello 失败且 -32601（ZCodeProtocolClientError 带 code，RPC passthrough 形状）→ 能力缺失", () => {
    const frame = capabilitiesFrameFromProbe({
      ok: false,
      error: Object.assign(
        new Error("method not found: runtime/capabilities"),
        { code: -32601 },
      ),
    });
    expect(frame.capabilities).toBeNull();
    expect(frame.capabilityMissing).toBe(true);
  });

  it("hello 失败且无 code 的 'Method not found'（旧 server dist 未重建形状）→ 同判能力缺失", () => {
    expect(
      capabilitiesFrameFromProbe({
        ok: false,
        error: new Error("Method not found"),
      }),
    ).toEqual({
      capabilities: null,
      capabilityMissing: true,
    });
    expect(
      capabilitiesFrameFromProbe({ ok: false, error: "Method not found" }),
    ).toEqual({
      capabilities: null,
      capabilityMissing: true,
    });
  });

  it("hello 失败为暂时性错误 + runtime/capabilities 复核再失败且 -32601 → 能力缺失（FR-A13 复核）", () => {
    const frame = capabilitiesFrameFromProbe({
      ok: false,
      error: new Error("ZCode agent stdio transport is closed"),
      runtimeProbeError: Object.assign(new Error("no such method"), {
        code: -32601,
      }),
    });
    expect(frame).toEqual({ capabilities: null, capabilityMissing: true });
  });

  it("hello 暂时性失败 + 复核可达（不抛）→ capabilityMissing=false（UI 静默不诬告）", () => {
    expect(
      capabilitiesFrameFromProbe({
        ok: false,
        error: new Error("ZCode agent stdio transport is closed"),
      }),
    ).toEqual({ capabilities: null, capabilityMissing: false });
  });

  it("hello 到了但 capabilities 面缺失/形状非法 → 整体降级（P1-10.3 不做部分猜测）", () => {
    expect(
      capabilitiesFrameFromProbe({ ok: true, hello: { kind: "hello" } }),
    ).toEqual({
      capabilities: null,
      capabilityMissing: true,
    });
  });
});

describe("projectCapabilitiesPayload：capabilities 帧 → App 投影（静默规则）", () => {
  it("帧未到（undefined）→ null：App 不渲染任何提示、不门控", () => {
    expect(projectCapabilitiesPayload(undefined)).toBeNull();
  });

  it("hello 帧 → 入口显隐按位投影（App 消费 showTerminalEntry/showNativeDialogEntry/binaryFrameHint）", () => {
    const projection = projectCapabilitiesPayload({
      capabilities: {
        nativeDialogs: true,
        localTerminal: true,
        binaryFrames: false,
        compression: "none",
      },
      capabilityMissing: false,
    });
    expect(projection).toEqual({
      showTerminalEntry: true,
      showNativeDialogEntry: true,
      binaryFrameHint: CAPABILITY_BINARY_FRAME_HINT,
      unsupportedHint: null,
    });
  });

  it("{null, capabilityMissing:true} → 整体降级 + unsupportedHint（P1-10.3 标注）", () => {
    expect(
      projectCapabilitiesPayload({
        capabilities: null,
        capabilityMissing: true,
      }),
    ).toEqual({
      showTerminalEntry: false,
      showNativeDialogEntry: false,
      binaryFrameHint: null,
      unsupportedHint: CAPABILITY_UNSUPPORTED_HINT,
    });
  });

  it("{null, capabilityMissing:false}（暂时不可得）→ null：静默，不诬告「不支持」", () => {
    expect(
      projectCapabilitiesPayload({
        capabilities: null,
        capabilityMissing: false,
      }),
    ).toBeNull();
  });
});

describe("gatePaneCallbacksByCapability：投影 → pane 回调门控（真实入口显隐）", () => {
  const callbacks = { onOpenBackgroundBash: () => undefined };

  it("showTerminalEntry=false → onOpenBackgroundBash 置空（ui 按回调缺席隐藏终端入口）", () => {
    const gated = gatePaneCallbacksByCapability(
      callbacks,
      projectCapabilities(null),
    );
    expect(gated.onOpenBackgroundBash).toBeUndefined();
  });

  it("showTerminalEntry=true → 回调保留（入口可见）", () => {
    const gated = gatePaneCallbacksByCapability(
      callbacks,
      projectCapabilities({
        nativeDialogs: false,
        localTerminal: true,
        binaryFrames: true,
        compression: "none",
      }),
    );
    expect(gated.onOpenBackgroundBash).toBe(callbacks.onOpenBackgroundBash);
  });

  it("投影未就绪（帧未到/暂时不可得）→ 不门控，维持现状回调", () => {
    expect(
      gatePaneCallbacksByCapability(callbacks, null).onOpenBackgroundBash,
    ).toBe(callbacks.onOpenBackgroundBash);
  });
});

describe("isCapabilityMissingError：-32601 / Method not found 双形状识别（FR-A13）", () => {
  it("带 code=-32601 的错误对象识别为能力缺失；其余 code 不误判", () => {
    expect(
      isCapabilityMissingError(
        Object.assign(new Error("x"), {
          code: JSON_RPC_ERROR_CODES.methodNotFound,
        }),
      ),
    ).toBe(true);
    expect(
      isCapabilityMissingError(Object.assign(new Error("x"), { code: -32603 })),
    ).toBe(false);
  });

  it("无 code 的 'Method not found' 文本（Error/string）同判；普通错误不误判", () => {
    expect(
      isCapabilityMissingError(
        new Error("Method not found: runtime/capabilities"),
      ),
    ).toBe(true);
    expect(isCapabilityMissingError("Method not found")).toBe(true);
    expect(
      isCapabilityMissingError(
        new Error("ZCode agent stdio transport is closed"),
      ),
    ).toBe(false);
    expect(isCapabilityMissingError(undefined)).toBe(false);
    expect(isCapabilityMissingError(null)).toBe(false);
  });
});

describe("probeCapabilitiesFrame：host 探测编排（fake agent service，hello/错误帧 → 帧载荷）", () => {
  const TARGET = { workspacePath: "/repo" };
  const okService = (overrides: {
    hello?: () => Promise<unknown>;
    runtimeCapabilities?: () => Promise<unknown>;
  }) =>
    ({
      helloConversationV4: overrides.hello ?? (async () => HELLO_ALL_ON),
      ...(overrides.runtimeCapabilities
        ? { runtimeCapabilities: overrides.runtimeCapabilities }
        : {}),
    }) as Parameters<typeof probeCapabilitiesFrame>[0]["agentService"];

  it("hello 成功 → 帧载荷取 hello 收敛（不触发 runtime/capabilities 复核）", async () => {
    let probeCalls = 0;
    const frame = await probeCapabilitiesFrame({
      agentService: okService({
        runtimeCapabilities: async () => {
          probeCalls += 1;
          return {};
        },
      }),
      workspaceTarget: TARGET,
    });
    expect(frame.capabilityMissing).toBe(false);
    expect(frame.capabilities).toMatchObject({ localTerminal: true });
    expect(probeCalls).toBe(0);
  });

  it("hello 抛 -32601 → 直接判能力缺失（跳过复核）", async () => {
    const frame = await probeCapabilitiesFrame({
      agentService: okService({
        hello: async () => {
          throw Object.assign(new Error("method not found"), { code: -32601 });
        },
      }),
      workspaceTarget: TARGET,
    });
    expect(frame).toEqual({ capabilities: null, capabilityMissing: true });
  });

  it("hello 暂时性失败 + 复核可达 → 静默帧（capabilityMissing=false）", async () => {
    const logs: string[] = [];
    const frame = await probeCapabilitiesFrame({
      agentService: okService({
        hello: async () => {
          throw new Error("ZCode agent stdio transport is closed");
        },
        runtimeCapabilities: async () => ({}),
      }),
      workspaceTarget: TARGET,
      log: (message) => logs.push(message),
    });
    expect(frame).toEqual({ capabilities: null, capabilityMissing: false });
    expect(logs.some((line) => line.includes("暂不判能力缺失"))).toBe(true);
  });

  it("hello 暂时性失败 + 复核遇 -32601 → 能力缺失（FR-A13 复核收敛）", async () => {
    const logs: string[] = [];
    const frame = await probeCapabilitiesFrame({
      agentService: okService({
        hello: async () => {
          throw new Error("ZCode agent stdio transport is closed");
        },
        runtimeCapabilities: async () => {
          throw Object.assign(new Error("no such method"), { code: -32601 });
        },
      }),
      workspaceTarget: TARGET,
      log: (message) => logs.push(message),
    });
    expect(frame).toEqual({ capabilities: null, capabilityMissing: true });
    expect(logs.some((line) => line.includes("均失败"))).toBe(true);
  });

  it("旧 CLI 无 runtimeCapabilities 方法（optional 缺席）→ 复核按可达处理 → 静默帧", async () => {
    const frame = await probeCapabilitiesFrame({
      agentService: okService({
        hello: async () => {
          throw new Error("ZCode agent stdio transport is closed");
        },
      }),
      workspaceTarget: TARGET,
    });
    expect(frame).toEqual({ capabilities: null, capabilityMissing: false });
  });
});
