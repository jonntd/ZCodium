/**
 * ChangesService 编排单测（spec: docs/spec/vscode-pending-changes.md §10）。
 * 帧链路走真实 TopicWireFrameAssembler（shared schema 校验），services/deps 全内存假件。
 * 覆盖：轮终态 delta → 明细查询；撤销预检 safe/unsafe 双路 + 信封形状；进程换代强制重订；
 * 会话切换重订；持久化重放。
 */

import { describe, expect, it, vi } from "vitest";
import type { ConversationTopicWireCandidate } from "@zcode/shared/zcode-protocol-v4";
import { ChangesService, describeUnsafe } from "../src/host/pendingChanges/changesService";
import type { ChangesAgentService } from "../src/host/pendingChanges/changesService";
import type { PersistedChanges } from "../src/host/pendingChanges/changesService";
import type { PendingFileChange } from "../src/host/pendingChanges/types";

const WORKSPACE_ROOT = "/ws";

function turnHeaderDelta(rowId: number, files = 1) {
  return {
    op: "row.upserted" as const,
    row: {
      kind: "turnHeader",
      rowId,
      turnId: `turn-${rowId}`,
      entityId: `entity-${rowId}`,
      createdAt: 1,
      createdAtSeq: 1,
      startedAt: 1,
      origin: "userInput",
      state: "completedSuccess",
      endedAt: rowId * 1000,
      fileChanges: { additions: 3, deletions: 1, files, state: "active" },
    },
  };
}

const REVISION_DELTA = { op: "state.updated" as const, patch: { revision: 5 } };

function deltaWire(
  deltas: unknown[],
  subscriptionId = "sub-1",
  ordinal = 1,
  sessionId = "s-1",
): ConversationTopicWireCandidate {
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind: "initial",
    logicalFrameId: `frame-${ordinal}`,
    logicalFrameOrdinal: ordinal,
    topic: `conversation/${sessionId}`,
    subscriptionId,
    frame: {
      topic: `conversation/${sessionId}`,
      subscriptionId,
      fromSeq: 0,
      toSeq: ordinal,
      sentAt: 1,
      payload: { kind: "deltas", deltas },
    },
  } as ConversationTopicWireCandidate;
}

function snapshotWire(
  turnHeaders: Array<{ rowId?: number } & Record<string, unknown>>,
  subscriptionId = "sub-1",
  revision = 5,
): ConversationTopicWireCandidate {
  return {
    wireVersion: 3,
    kind: "complete",
    deliveryKind: "initial",
    logicalFrameId: `snapshot-${revision}`,
    logicalFrameOrdinal: 1,
    topic: "conversation/s-1",
    subscriptionId,
    frame: {
      topic: "conversation/s-1",
      subscriptionId,
      fromSeq: 0,
      toSeq: 1,
      sentAt: 1,
      payload: {
        kind: "snapshot",
        snapshot: {
          protocolVersion: 1,
          sessionId: "s-1",
          logEpoch: "epoch-1",
          seq: 1,
          revision,
          control: {
            phase: "completedSuccess",
            sessionEnded: true,
            canStop: false,
            stopState: "idle",
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
          config: { provider: "p", model: "m", thought: "standard", followupMode: "guide" },
          usage: {
            contextWindow: null,
            cumulative: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
          },
          queue: { items: [], autoDrain: true },
          pendingInteractions: [],
          pendingCommands: [],
          backgroundWorks: [],
          goal: null,
          plan: null,
          rows: { window: turnHeaders, totalCount: turnHeaders.length, firstRowId: turnHeaders[0]?.rowId ?? null },
        },
      },
    },
  } as ConversationTopicWireCandidate;
}

const FILE_CHANGES_RESULT = {
  files: 1,
  additions: 3,
  deletions: 1,
  state: "active" as const,
  items: [
    {
      path: "src/a.ts",
      additions: 3,
      deletions: 1,
      writeCount: 1,
      toolNames: ["Edit"],
      patches: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 3, lines: ["-old", "+n1", "+n2", "+n3"] },
      ],
    },
  ],
};

interface Harness {
  service: ChangesService;
  frameListeners: Set<(wire: ConversationTopicWireCandidate) => void>;
  indexFrameListeners: Set<(wire: unknown) => void>;
  restartListeners: Set<(event: { workspaceKey: string }) => void>;
  calls: {
    subscribe: Array<{ sessionId: string }>;
    unsubscribe: string[];
    indexSubscribe: number;
    indexUnsubscribe: string[];
    fileChanges: Array<{ target: unknown; baseRevision: number; baseLogEpoch: string }>;
    previews: Array<{ target: unknown; baseRevision: number }>;
    commands: Array<{ envelope: Record<string, unknown> }>;
  };
  previewResult: {
    canApply: boolean;
    ignoredFiles: unknown[];
    safeFiles: Array<{ action: "restore" | "delete"; operationCount: number; path: string; toolNames: string[] }>;
    unsafeFiles: Array<{ path: string; reason?: string }>;
    revertedPaths?: string[];
  };
  warnings: string[];
  persisted: PersistedChanges | undefined;
  session: string | null;
}

function makeHarness(initialSession: string | null = "s-1"): Harness {
  const frameListeners = new Set<(wire: ConversationTopicWireCandidate) => void>();
  const indexFrameListeners = new Set<(wire: unknown) => void>();
  const restartListeners = new Set<(event: { workspaceKey: string }) => void>();
  const calls = {
    subscribe: [] as Array<{ sessionId: string }>,
    indexSubscribe: 0,
    indexUnsubscribe: [] as string[],
    unsubscribe: [] as string[],
    fileChanges: [] as Array<{ target: unknown; baseRevision: number; baseLogEpoch: string }>,
    previews: [] as Array<{ target: unknown; baseRevision: number }>,
    commands: [] as Array<{ envelope: Record<string, unknown> }>,
  };
  const previewResult: Harness["previewResult"] = {
    canApply: true,
    ignoredFiles: [],
    safeFiles: [
      { action: "restore", operationCount: 1, path: "src/a.ts", toolNames: ["Edit"] },
    ],
    unsafeFiles: [],
  };
  const warnings: string[] = [];
  let persisted: PersistedChanges | undefined;
  const state = { session: initialSession };

  const agentService = {
    subscribeConversationV4: async (params: { sessionId: string }) => {
      calls.subscribe.push(params);
      return { ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "epoch-1" } };
    },
    unsubscribeConversationV4: async (params: { subscriptionId: string }) => {
      calls.unsubscribe.push(params.subscriptionId);
    },
    onDynamicConversationFrame:
      (_target: unknown) =>
      (listener: (wire: ConversationTopicWireCandidate) => void) => {
        frameListeners.add(listener);
        return { dispose: () => frameListeners.delete(listener) };
      },
    onAgentRuntimeRestarted: (listener: (event: { workspaceKey: string }) => void) => {
      restartListeners.add(listener);
      return { dispose: () => restartListeners.delete(listener) };
    },
    subscribeSessionsIndexV4: async () => {
      calls.indexSubscribe += 1;
      return { ack: { subscriptionId: "idx-1", mode: "snapshot", logEpoch: "epoch-1" } };
    },
    unsubscribeSessionsIndexV4: async (params: { subscriptionId: string }) => {
      calls.indexUnsubscribe.push(params.subscriptionId);
    },
    onDynamicSessionsIndexFrame:
      (_target: unknown) =>
      (listener: (wire: unknown) => void) => {
        indexFrameListeners.add(listener);
        return { dispose: () => indexFrameListeners.delete(listener) };
      },
    conversationFileChangesV4: async (params: {
      target: unknown;
      baseRevision: number;
      baseLogEpoch: string;
    }) => {
      calls.fileChanges.push(params);
      return FILE_CHANGES_RESULT;
    },
    conversationFileRewindPreviewV4: async (params: {
      target: unknown;
      baseRevision: number;
    }) => {
      calls.previews.push(params);
      return previewResult;
    },
    sendConversationCommandV4: async (params: { envelope: Record<string, unknown> }) => {
      calls.commands.push(params);
      return { status: "accepted", result: { type: "applyFileRewind", applied: true } };
    },
  } as unknown as ChangesAgentService;

  const service = new ChangesService({
    agentService,
    sessionId: state.session ?? "",
    workspaceRoot: () => WORKSPACE_ROOT,
    readFile: async () => "",
    clientId: "host-test",
    // P1 合批持久化在测试里关掉（同步直写），断言保持确定性。
    persistDebounceMs: 0,
    persist: (next) => {
      persisted = next;
    },
    loadPersisted: () => persisted,
    showWarning: (message) => warnings.push(message),
    openDiff: async () => undefined,
    log: (message) => console.warn(`[DBG] ${message}`),
    now: () => 1000,
  });

  return {
    service,
    frameListeners,
    indexFrameListeners,
    restartListeners,
    calls,
    previewResult,
    warnings,
    get persisted() {
      return persisted;
    },
    get session() {
      return state.session;
    },
    set session(value: string | null) {
      state.session = value;
    },
  };
}

async function settle(harness: Harness): Promise<void> {
  await harness.service.whenSettled();
}

async function waitFor<T>(probe: () => T | undefined): Promise<T> {
  return vi.waitFor(() => {
    const value = probe();
    if (value === undefined) throw new Error("condition not met yet");
    return value;
  });
}

describe("ChangesService", () => {
  it("轮终态 delta → 触发明细查询（带 CAS 水位）→ pending 落账并持久化", async () => {
    const harness = makeHarness();
    harness.service.start();
    await settle(harness);
    expect(harness.calls.subscribe[0]).toMatchObject({ sessionId: "s-1" });

    harness.frameListeners.forEach((listener) =>
      listener(deltaWire([turnHeaderDelta(7), REVISION_DELTA])),
    );
    await waitFor(() =>
      harness.calls.fileChanges.length === 1 ? harness.calls.fileChanges : undefined,
    );
    expect(harness.calls.fileChanges[0]).toMatchObject({
      baseRevision: 5,
      baseLogEpoch: "epoch-1",
      target: { rowId: 7, entityId: "entity-7" },
    });

    const snapshot = await waitFor(() =>
      harness.service.snapshot().pending.length === 1 ? harness.service.snapshot() : undefined,
    );
    expect(snapshot.pending[0]).toMatchObject({ path: "src/a.ts", turnRowId: 7 });
    expect(harness.persisted?.pending).toHaveLength(1);
  });

  it("订阅被顶掉（webview 新 subId）→ 话题级采纳新流，帧继续处理不断流", async () => {
    // 回归：CLI 语义「同 connectionId 重复 subscribe 作废旧订阅」，聊天 webview
    // 会在同连接上订阅同一 topic（subId 由 -1 变 -2），旧流停帧。按 subId 过滤
    // 会导致永久断流；正确行为是采纳新活跃流（spec §3 订阅所有权）。
    const harness = makeHarness();
    harness.service.start();
    await settle(harness);

    // webview 顶掉我们之后：帧以新 subId 到达
    harness.frameListeners.forEach((listener) =>
      listener(deltaWire([turnHeaderDelta(9), REVISION_DELTA], "sub-2-webview", 1)),
    );
    await waitFor(() =>
      harness.calls.fileChanges.length === 1 ? harness.calls.fileChanges : undefined,
    );
    expect(harness.calls.fileChanges[0]).toMatchObject({
      target: { rowId: 9, entityId: "entity-9" },
    });
    expect(harness.service.snapshot().pending[0]).toMatchObject({ path: "src/a.ts", turnRowId: 9 });
  });

  it("撤销：整轮预检 safe → CAS 信封正确 → pending 收敛", async () => {
    const harness = makeHarness();
    harness.service.start();
    await settle(harness);
    harness.frameListeners.forEach((listener) =>
      listener(deltaWire([turnHeaderDelta(7), REVISION_DELTA])),
    );
    await waitFor(() => (harness.service.snapshot().pending.length === 1 ? true : undefined));

    const applied = await harness.service.revertFiles(7, ["src/a.ts"]);
    expect(applied).toBe(true);
    expect(harness.calls.previews).toHaveLength(1);
    expect(harness.calls.previews[0]).toMatchObject({ baseRevision: 5 });
    expect(harness.calls.commands).toHaveLength(1);
    const envelope = harness.calls.commands[0]?.envelope;
    expect(envelope).toMatchObject({
      sessionId: "s-1",
      baseRevision: 5,
      baseLogEpoch: "epoch-1",
      clientId: "host-test",
      type: "applyFileRewind",
      issuedAt: 1000,
      payload: {
        target: { rowId: 7, entityId: "entity-7" },
        paths: ["src/a.ts"],
      },
    });
    expect(typeof envelope?.commandId).toBe("string");
    expect(harness.service.snapshot().pending).toHaveLength(0);
  });

  it("预检 unsafe（external_modified）→ 不发命令 + 中文警告", async () => {
    const harness = makeHarness();
    harness.service.start();
    await settle(harness);
    harness.frameListeners.forEach((listener) =>
      listener(deltaWire([turnHeaderDelta(7), REVISION_DELTA])),
    );
    await waitFor(() => (harness.service.snapshot().pending.length === 1 ? true : undefined));

    harness.previewResult.canApply = false;
    harness.previewResult.safeFiles = [];
    harness.previewResult.unsafeFiles = [
      { path: "src/a.ts", reason: "external_modified" },
    ];

    const applied = await harness.service.revertFiles(7, ["src/a.ts"]);
    expect(applied).toBe(false);
    expect(harness.calls.commands).toHaveLength(0);
    expect(harness.warnings[0]).toContain("外部修改");
    // 失败不动账本：文件仍待审。
    expect(harness.service.snapshot().pending).toHaveLength(1);
  });

  it("目标文件不在 safeFiles（missing）→ 拦截并说明", async () => {
    const harness = makeHarness();
    harness.service.start();
    await settle(harness);
    harness.frameListeners.forEach((listener) =>
      listener(deltaWire([turnHeaderDelta(7), REVISION_DELTA])),
    );
    await waitFor(() => (harness.service.snapshot().pending.length === 1 ? true : undefined));

    harness.previewResult.safeFiles = [];
    const applied = await harness.service.revertFiles(7, ["src/other.ts"]);
    expect(applied).toBe(false);
    expect(harness.calls.commands).toHaveLength(0);
    expect(harness.warnings[0]).toContain("src/other.ts");
  });

  it("进程换代：同会话也强制重建订阅；普通 syncSession 不重复订阅", async () => {
    const harness = makeHarness();
    harness.service.start();
    await settle(harness);
    expect(harness.calls.subscribe).toHaveLength(1);

    // 同会话 syncSession：不重订。
    harness.service.syncSession();
    await settle(harness);
    expect(harness.calls.subscribe).toHaveLength(1);

    // 换代事件：强制重建。
    harness.restartListeners.forEach((listener) => listener({ workspaceKey: WORKSPACE_ROOT }));
    await settle(harness);
    expect(harness.calls.subscribe).toHaveLength(2);
  });

  it("会话切换：退订旧会话、订新会话", async () => {
    const harness = makeHarness();
    harness.service.start();
    await settle(harness);
    harness.service.setSession("s-2", WORKSPACE_ROOT);
    await settle(harness);
    expect(harness.calls.unsubscribe).toContain("sub-1");
    expect(harness.calls.subscribe.at(-1)?.sessionId).toBe("s-2");
  });

  it("重启恢复：持久化 pending 先重放（不依赖帧）", async () => {
    const persistedEntry: PendingFileChange = {
      path: "src/a.ts",
      resolvedPath: `${WORKSPACE_ROOT}/src/a.ts`,
      sessionId: "s-1",
      target: { rowId: 7, entityId: "entity-7" },
      turnRowId: 7,
      additions: 3,
      deletions: 1,
      patches: FILE_CHANGES_RESULT.items[0]?.patches ?? [],
    };
    const harness = makeHarnessWithPersisted({ pending: [persistedEntry], history: [] });
    harness.service.start();
    await settle(harness);
    // 未发送任何帧，持久化已重放为 pending。
    expect(harness.service.snapshot().pending).toHaveLength(1);
    expect(harness.service.pendingCount()).toBe(1);
  });

  it("snapshot 帧：全量重建 + CAS 水位 + 终态轮拉明细（不依赖 deltas）", async () => {
    const harness = makeHarness();
    harness.service.start();
    await settle(harness);
    harness.frameListeners.forEach((listener) =>
      listener(
        snapshotWire([
          {
            kind: "turnHeader",
            rowId: 7,
            turnId: "turn-7",
            entityId: "entity-7",
            createdAt: 1,
            createdAtSeq: 1,
            startedAt: 1,
            origin: "userInput",
            state: "completedSuccess",
            endedAt: 7000,
            fileChanges: { additions: 3, deletions: 1, files: 1, state: "active" },
          },
        ]),
      ),
    );
    await waitFor(() => (harness.service.snapshot().pending.length === 1 ? true : undefined));
    expect(harness.calls.fileChanges[0]).toMatchObject({
      baseRevision: 5,
      baseLogEpoch: "epoch-1",
      target: { rowId: 7, entityId: "entity-7" },
    });
    // CAS 水位来自 snapshot.revision（撤销信封可用）。
    harness.previewResult.safeFiles = [
      { action: "restore", operationCount: 1, path: "src/a.ts", toolNames: ["Edit"] },
    ];
    expect(await harness.service.revertFiles(7, ["src/a.ts"])).toBe(true);
    expect(harness.calls.commands[0]?.envelope).toMatchObject({
      baseRevision: 5,
      baseLogEpoch: "epoch-1",
      type: "applyFileRewind",
    });
  });

  it("snapshot 重放收敛：revertedPaths 到达后 pending 清空", async () => {
    const harness = makeHarness();
    harness.service.start();
    await settle(harness);
    const turnHeader = {
      kind: "turnHeader",
      rowId: 7,
      turnId: "turn-7",
      entityId: "entity-7",
      createdAt: 1,
      createdAtSeq: 1,
      startedAt: 1,
      origin: "userInput",
      state: "completedSuccess",
      endedAt: 7000,
    };
    harness.frameListeners.forEach((listener) =>
      listener(
        snapshotWire([
          { ...turnHeader, fileChanges: { additions: 3, deletions: 1, files: 1, state: "active" } },
        ]),
      ),
    );
    await waitFor(() => (harness.service.snapshot().pending.length === 1 ? true : undefined));
    // 第二次订阅换代后快照带 revertedPaths：整体重建并收敛（CLI 权威账本）。
    harness.restartListeners.forEach((listener) => listener({ workspaceKey: WORKSPACE_ROOT }));
    await settle(harness);
    harness.frameListeners.forEach((listener) =>
      listener(
        snapshotWire(
          [
            {
              ...turnHeader,
              fileChanges: {
                additions: 3,
                deletions: 1,
                files: 1,
                state: "active",
                revertedPaths: ["src/a.ts"],
              },
            },
          ],
          "sub-1",
          6,
        ),
      ),
    );
    await waitFor(() =>
      harness.calls.fileChanges.length >= 2 ? true : undefined,
    );
    // 重建后 revertedPaths 已在快照中：该轮不再进入 turnsNeedingDetails → 无第二次明细查询。
    expect(harness.service.snapshot().pending).toHaveLength(0);
  });

  it("setSession 直传：notifySessionCreated 驱动订阅与路径解析（共享 ext host 场景）", async () => {
    const harness = makeHarness(null); // 无显式通知时 options.sessionId 为空 → 不订阅
    harness.service.start();
    await settle(harness);
    expect(harness.calls.subscribe).toHaveLength(0); // 无通知不订阅

    harness.service.setSession("s-9", "/tmp/gode-ui-test");
    await settle(harness);
    expect(harness.calls.subscribe).toHaveLength(1);
    expect(harness.calls.subscribe[0]).toMatchObject({ sessionId: "s-9" });
    // 显式通知优先：兜底 getSessionId()（此处返回 null）不参与裁决

    // 帧先到（订阅后）：模拟 turn 完成
    harness.frameListeners.forEach((listener) =>
      listener(deltaWire([turnHeaderDelta(3), REVISION_DELTA], "sub-1", 1, "s-9")),
    );
    await waitFor(() => (harness.calls.fileChanges.length >= 1 ? true : undefined));
  });

  it("describeUnsafe：external_modified 有中文语义", () => {
    const message = describeUnsafe([{ path: "src/a.ts", reason: "external_modified" }]);
    expect(message).toContain("src/a.ts");
    expect(message).toContain("外部修改");
  });
});

function makeHarnessWithPersisted(seed: PersistedChanges): Harness {
  const harness = makeHarness();
  const service = new ChangesService({
    agentService: proxyAgent(harness),
    sessionId: "s-1",
    workspaceRoot: () => WORKSPACE_ROOT,
    readFile: async () => "",
    clientId: "host-test",
    persist: () => undefined,
    loadPersisted: () => seed,
    showWarning: () => undefined,
    openDiff: async () => undefined,
    log: () => undefined,
    now: () => 1000,
  });
  return { ...harness, service };
}

function proxyAgent(harness: Harness): ChangesAgentService {
  // 复用 makeHarness 的假件（订阅计数继续累计）。
  return {
    subscribeConversationV4: async (params: { sessionId: string }) => {
      harness.calls.subscribe.push(params);
      return { ack: { subscriptionId: "sub-1", mode: "snapshot", logEpoch: "epoch-1" } };
    },
    unsubscribeConversationV4: async (params: { subscriptionId: string }) => {
      harness.calls.unsubscribe.push(params.subscriptionId);
    },
    onDynamicConversationFrame:
      (_target: unknown) =>
      (listener: (wire: ConversationTopicWireCandidate) => void) => {
        harness.frameListeners.add(listener);
        return { dispose: () => harness.frameListeners.delete(listener) };
      },
    conversationFileChangesV4: async () => FILE_CHANGES_RESULT,
    conversationFileRewindPreviewV4: async () => harness.previewResult,
    sendConversationCommandV4: async (params: { envelope: Record<string, unknown> }) => {
      harness.calls.commands.push(params);
      return { status: "accepted", result: { type: "applyFileRewind", applied: true } };
    },
  } as unknown as ChangesAgentService;
}
