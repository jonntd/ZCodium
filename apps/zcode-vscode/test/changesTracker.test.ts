/**
 * ChangesTracker 状态机单测（spec: docs/spec/vscode-pending-changes.md §10）。
 * 覆盖：delta → pending 入列；keep/revert 流转；同路径新轮 superseded；
 * revertedPaths 幂等消费；snapshot 重建；持久化重放；CAS 水位递进。
 */

import { describe, expect, it } from "vitest";
import {
  ChangesTracker,
  HISTORY_TURN_LIMIT,
  resolveChangePath,
} from "../src/host/pendingChanges/changesTracker";
import type {
  HistoryTurnEntry,
  TrackedFrame,
  TrackedTurnHeader,
} from "../src/host/pendingChanges/types";

function turnHeader(overrides: Partial<TrackedTurnHeader> & { rowId: number }): TrackedTurnHeader {
  return {
    turnId: `turn-${overrides.rowId}`,
    state: "completedSuccess",
    entityId: `entity-${overrides.rowId}`,
    endedAt: overrides.rowId * 1000,
    ...overrides,
  };
}

function deltaFrame(
  turnHeaders: TrackedTurnHeader[],
  extra: Partial<Extract<TrackedFrame, { kind: "deltas" }>> = {},
): TrackedFrame {
  return {
    kind: "deltas",
    sessionId: "s-1",
    turnHeaders,
    ...extra,
  };
}

function detailItems(paths: string[]) {
  return paths.map((path) => ({
    path,
    additions: 3,
    deletions: 1,
    patches: [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 3, lines: ["-old", "+n1", "+n2", "+n3"] },
    ],
  }));
}

describe("resolveChangePath", () => {
  it("相对路径拼 workspaceRoot；workspace 内绝对路径原样", () => {
    expect(resolveChangePath("src/a.ts", "/ws")).toBe("/ws/src/a.ts");
    expect(resolveChangePath("/ws/abs/a.ts", "/ws")).toBe("/ws/abs/a.ts");
    expect(resolveChangePath("src/a.ts", "/ws/")).toBe("/ws/src/a.ts");
    expect(resolveChangePath("", "/ws")).toBe("/ws");
  });

  it("S2：逃逸 workspaceRoot 的路径 fail-closed 返回 null", () => {
    // 相对穿越逃逸。
    expect(resolveChangePath("../../etc/passwd", "/ws")).toBeNull();
    expect(resolveChangePath("a/../../../tmp/x", "/ws")).toBeNull();
    // workspace 外的绝对路径（CLI 产外部路径 = 撤销预检也会拦的外部改动）。
    expect(resolveChangePath("/etc/passwd", "/ws")).toBeNull();
    expect(resolveChangePath("/wsibling/a.ts", "/ws")).toBeNull();
  });
});

describe("ChangesTracker", () => {
  it("轮终态帧 → turnsNeedingDetails；applyTurnDetails 后 pending 入列并触发 onChange", () => {
    const tracker = new ChangesTracker();
    tracker.resetForSession("s-1");
    const seen: number[] = [];
    tracker.onChange((snapshot) => seen.push(snapshot.pending.length));

    const effects = tracker.applyFrame(
      deltaFrame([
        turnHeader({ rowId: 7, fileChanges: { additions: 3, deletions: 1, files: 2, state: "active" } }),
      ]),
    );
    expect(effects.turnsNeedingDetails).toEqual([
      { sessionId: "s-1", target: { rowId: 7, entityId: "entity-7" } },
    ]);

    tracker.applyTurnDetails({
      sessionId: "s-1",
      target: { rowId: 7, entityId: "entity-7" },
      workspaceRoot: "/ws",
      items: detailItems(["src/a.ts", "src/b.ts"]),
    });
    const snapshot = tracker.snapshot();
    expect(snapshot.pending.map((entry) => entry.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(snapshot.pending[0]?.resolvedPath).toBe("/ws/src/a.ts");
    expect(snapshot.pending[0]?.target).toEqual({ rowId: 7, entityId: "entity-7" });
    expect(seen).toEqual([2]);
  });

  it("keepFiles：pending 移除、历史标记 kept", () => {
    const tracker = new ChangesTracker();
    tracker.resetForSession("s-1");
    tracker.applyFrame(deltaFrame([turnHeader({ rowId: 7, fileChanges: { additions: 3, deletions: 1, files: 1, state: "active" } })]));
    tracker.applyTurnDetails({
      sessionId: "s-1",
      target: { rowId: 7, entityId: "entity-7" },
      workspaceRoot: "/ws",
      items: detailItems(["src/a.ts"]),
    });

    tracker.keepFiles(7, ["src/a.ts"]);
    const snapshot = tracker.snapshot();
    expect(snapshot.pending).toHaveLength(0);
    expect(snapshot.history[0]?.files[0]?.state).toBe("kept");
  });

  it("markReverted：pending 移除、历史标记 reverted；consumeRevertedPaths 幂等", () => {
    const tracker = new ChangesTracker();
    tracker.resetForSession("s-1");
    tracker.applyFrame(deltaFrame([turnHeader({ rowId: 7, fileChanges: { additions: 3, deletions: 1, files: 1, state: "active" } })]));
    tracker.applyTurnDetails({
      sessionId: "s-1",
      target: { rowId: 7, entityId: "entity-7" },
      workspaceRoot: "/ws",
      items: detailItems(["src/a.ts"]),
    });

    tracker.markReverted(7, ["src/a.ts"]);
    expect(tracker.snapshot().pending).toHaveLength(0);
    // CLI 投影随后到达同一 revertedPaths：不得重复计数或报错。
    tracker.consumeRevertedPaths(7, ["src/a.ts"]);
    expect(tracker.snapshot().history[0]?.files[0]?.state).toBe("reverted");
  });

  it("CLI 权威 revertedPaths：另一窗口撤销后本宿主 pending 收敛", () => {
    const tracker = new ChangesTracker();
    tracker.resetForSession("s-1");
    tracker.applyFrame(deltaFrame([turnHeader({ rowId: 7, fileChanges: { additions: 3, deletions: 1, files: 1, state: "active" } })]));
    tracker.applyTurnDetails({
      sessionId: "s-1",
      target: { rowId: 7, entityId: "entity-7" },
      workspaceRoot: "/ws",
      items: detailItems(["src/a.ts"]),
    });

    tracker.applyFrame(
      deltaFrame([
        turnHeader({
          rowId: 7,
          fileChanges: {
            additions: 3,
            deletions: 1,
            files: 1,
            state: "active",
            revertedPaths: ["src/a.ts"],
          },
        }),
      ]),
    );
    expect(tracker.snapshot().pending).toHaveLength(0);
    expect(tracker.snapshot().history[0]?.files[0]?.state).toBe("reverted");
  });

  it("同路径新轮：pending 指向最新轮，旧轮标记 superseded", () => {
    const tracker = new ChangesTracker();
    tracker.resetForSession("s-1");
    tracker.applyFrame(deltaFrame([turnHeader({ rowId: 7, fileChanges: { additions: 3, deletions: 1, files: 1, state: "active" } })]));
    tracker.applyTurnDetails({
      sessionId: "s-1",
      target: { rowId: 7, entityId: "entity-7" },
      workspaceRoot: "/ws",
      items: detailItems(["src/a.ts"]),
    });
    tracker.applyFrame(deltaFrame([turnHeader({ rowId: 8, fileChanges: { additions: 5, deletions: 2, files: 1, state: "active" } })]));
    tracker.applyTurnDetails({
      sessionId: "s-1",
      target: { rowId: 8, entityId: "entity-8" },
      workspaceRoot: "/ws",
      items: detailItems(["src/a.ts"]),
    });

    const snapshot = tracker.snapshot();
    expect(snapshot.pending).toHaveLength(1);
    expect(snapshot.pending[0]?.turnRowId).toBe(8);
    const oldTurn = snapshot.history.find((turn) => turn.rowId === 7);
    expect(oldTurn?.files[0]?.state).toBe("superseded");
  });

  it("running 轮与 reverted 轮不进 turnsNeedingDetails；isPendingPath 按 resolvedPath 匹配", () => {
    const tracker = new ChangesTracker();
    tracker.resetForSession("s-1");
    const effects = tracker.applyFrame(
      deltaFrame([
        turnHeader({ rowId: 1, state: "running", fileChanges: { additions: 1, deletions: 0, files: 1, state: "active" } }),
        turnHeader({ rowId: 2, fileChanges: { additions: 1, deletions: 0, files: 1, state: "reverted" } }),
      ]),
    );
    expect(effects.turnsNeedingDetails ?? []).toHaveLength(0);

    tracker.applyTurnDetails({
      sessionId: "s-1",
      target: { rowId: 7, entityId: "entity-7" },
      workspaceRoot: "/ws",
      items: detailItems(["src/a.ts"]),
    });
    expect(tracker.isPendingPath("/ws/src/a.ts")).toBe(true);
    expect(tracker.isPendingPath("/ws/other.ts")).toBe(false);
  });

  it("snapshot 帧全量重建：重建后 turnsNeedingDetails 面向快照内活跃轮", () => {
    const tracker = new ChangesTracker();
    tracker.resetForSession("s-1");
    const effects = tracker.applyFrame({
      kind: "snapshot",
      sessionId: "s-1",
      logEpoch: "epoch-1",
      revision: 42,
      turnHeaders: [
        turnHeader({ rowId: 9, fileChanges: { additions: 2, deletions: 2, files: 1, state: "active" } }),
      ],
    });
    expect(tracker.currentRevision).toBe(42);
    expect(tracker.currentLogEpoch).toBe("epoch-1");
    expect(effects.turnsNeedingDetails).toEqual([
      { sessionId: "s-1", target: { rowId: 9, entityId: "entity-9" } },
    ]);
  });

  it("row.removed：该 rowId 及之后全部失效（含 pending 与历史）", () => {
    const tracker = new ChangesTracker();
    tracker.resetForSession("s-1");
    tracker.applyFrame(deltaFrame([turnHeader({ rowId: 7, fileChanges: { additions: 3, deletions: 1, files: 1, state: "active" } })]));
    tracker.applyTurnDetails({
      sessionId: "s-1",
      target: { rowId: 7, entityId: "entity-7" },
      workspaceRoot: "/ws",
      items: detailItems(["src/a.ts"]),
    });
    tracker.applyFrame(deltaFrame([], { removedFromRowId: 7 }));
    expect(tracker.snapshot().pending).toHaveLength(0);
    expect(tracker.snapshot().history).toHaveLength(0);
  });

  it("importPersisted：同会话整包重放；异会话忽略", () => {
    const tracker = new ChangesTracker();
    tracker.resetForSession("s-1");
    tracker.importPersisted(
      {
        pending: [
          {
            path: "src/a.ts",
            resolvedPath: "/ws/src/a.ts",
            sessionId: "s-1",
            target: { rowId: 7, entityId: "entity-7" },
            turnRowId: 7,
            additions: 3,
            deletions: 1,
            patches: [],
          },
        ],
        history: [],
      },
      "s-1",
    );
    expect(tracker.snapshot().pending).toHaveLength(1);
    tracker.importPersisted(
      {
        pending: [
          {
            path: "src/b.ts",
            resolvedPath: "/ws/src/b.ts",
            sessionId: "s-OTHER",
            target: { rowId: 9, entityId: "e-9" },
            turnRowId: 9,
            additions: 1,
            deletions: 0,
            patches: [],
          },
        ],
        history: [],
      },
      "s-1",
    );
    // 异会话与同路径重复都不入账。
    expect(tracker.snapshot().pending.map((entry) => entry.path)).toEqual(["src/a.ts"]);
  });

  it("历史保留上限：超过 HISTORY_TURN_LIMIT 裁最旧", () => {
    const tracker = new ChangesTracker();
    tracker.resetForSession("s-1");
    for (let rowId = 1; rowId <= HISTORY_TURN_LIMIT + 5; rowId += 1) {
      tracker.applyFrame(deltaFrame([turnHeader({ rowId, fileChanges: { additions: 1, deletions: 0, files: 1, state: "active" } })]));
      tracker.applyTurnDetails({
        sessionId: "s-1",
        target: { rowId, entityId: `entity-${rowId}` },
        workspaceRoot: "/ws",
        items: detailItems([`src/f${rowId}.ts`]),
      });
      tracker.keepFiles(rowId, [`src/f${rowId}.ts`]);
    }
    const history = tracker.snapshot().history;
    expect(history.length).toBe(HISTORY_TURN_LIMIT);
    // 裁的是最旧（rowId 小），最新保留。
    expect(history.some((turn) => turn.rowId === 1)).toBe(false);
    expect(history.some((turn) => turn.rowId === HISTORY_TURN_LIMIT + 5)).toBe(true);
  });

  it("userText 关联：userInput 行文本成为轮标题（先到先得）", () => {
    const tracker = new ChangesTracker();
    tracker.resetForSession("s-1");
    tracker.applyFrame(
      deltaFrame(
        [turnHeader({ rowId: 7, fileChanges: { additions: 1, deletions: 0, files: 1, state: "active" } })],
        { userTexts: [{ turnId: "turn-7", text: "帮我修复这个报错" }] },
      ),
    );
    tracker.applyTurnDetails({
      sessionId: "s-1",
      target: { rowId: 7, entityId: "entity-7" },
      workspaceRoot: "/ws",
      items: detailItems(["src/a.ts"]),
    });
    expect(tracker.snapshot().pending[0]?.turnTitle).toBe("帮我修复这个报错");
  });

  it("entityId 缺席导致明细拿不到时，snapshot 仍给出与聊天一致的摘要态", () => {
    const tracker = new ChangesTracker();
    tracker.resetForSession("s-1");
    const effects = tracker.applyFrame(
      deltaFrame([
        turnHeader({
          rowId: 7,
          entityId: undefined,
          userText: "修改 demo.ts 几行代码",
          fileChanges: { additions: 22, deletions: 4, files: 1, state: "active" },
        }),
      ]),
    );
    // 明细查询不会被触发（缺 entityId），但树不能因此一片空白。
    expect(effects.turnsNeedingDetails ?? []).toHaveLength(0);
    const undetailed = tracker.snapshot().undetailedTurns;
    expect(undetailed).toHaveLength(1);
    expect(undetailed?.[0]).toMatchObject({
      rowId: 7,
      fileCount: 1,
      additions: 22,
      deletions: 4,
      reason: "missing-entity-id",
    });

    // 明细一旦补上，摘要态自动消失，避免与真实文件节点重复。
    tracker.applyTurnDetails({
      sessionId: "s-1",
      target: { rowId: 7, entityId: "entity-7" },
      workspaceRoot: "/ws",
      items: detailItems(["demo.ts"]),
    });
    expect(tracker.snapshot().undetailedTurns).toBeUndefined();
    expect(tracker.snapshot().pending).toHaveLength(1);
  });
});

describe("importPersisted 裁剪（性能审查 P2）", () => {
  function historyTurn(rowId: number): HistoryTurnEntry {
    return {
      sessionId: "s-1",
      target: { rowId, entityId: `entity-${rowId}` },
      rowId,
      endedAt: rowId * 1000,
      files: [
        { path: `f${rowId}.ts`, resolvedPath: `/ws/f${rowId}.ts`, additions: 1, deletions: 0, state: "kept" },
      ],
    };
  }

  it("持久化历史超 HISTORY_TURN_LIMIT 时导入后裁最旧", () => {
    const tracker = new ChangesTracker();
    tracker.resetForSession("s-1");
    const overLimit = HISTORY_TURN_LIMIT + 5;
    const history = Array.from({ length: overLimit }, (_, index) => historyTurn(index + 1));
    tracker.importPersisted({ pending: [], history }, "s-1");
    const snapshot = tracker.snapshot();
    expect(snapshot.history).toHaveLength(HISTORY_TURN_LIMIT);
    // 裁最旧（endedAt 升序最小者）：rowId 1..5 消失，最新保留。
    const rowIds = new Set(snapshot.history.map((turn) => turn.rowId));
    expect(rowIds.has(1)).toBe(false);
    expect(rowIds.has(overLimit)).toBe(true);
  });

  it("未超限导入不裁剪", () => {
    const tracker = new ChangesTracker();
    tracker.resetForSession("s-1");
    tracker.importPersisted(
      { pending: [], history: [historyTurn(1), historyTurn(2)] },
      "s-1",
    );
    expect(tracker.snapshot().history).toHaveLength(2);
  });
});
