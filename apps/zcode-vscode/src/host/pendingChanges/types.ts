/**
 * Pending Changes 类型面（spec: docs/spec/vscode-pending-changes.md）。
 *
 * 本文件零 vscode / 零运行时依赖：ChangesTracker 与 diff 重构是 headless 纯逻辑，
 * vitest 直测；协议行 → TrackedTurnHeader 的收窄在 frame 适配处完成，tracker 不感知
 * zod schema 版本。
 */

/** 与 `@zcode/shared/zcode-protocol-v4` readonlyDiffHunkSchema 同形的只读 hunk。 */
export interface ChangeHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly string[];
}

/** 轮内单文件明细（v4/conversation/fileChanges items 的子集）。 */
export interface ChangeFileItem {
  /** artifact 原始路径（rawPath，相对/绝对同 CLI artifact；per-file-rewind.md §2）。 */
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  readonly patches: readonly ChangeHunk[];
}

/** turnHeader 行上 tracker 关心的字段子集。 */
export interface TrackedTurnHeader {
  readonly rowId: number;
  readonly turnId: string;
  /** 新 CLI 每行必传；旧帧缺席时 row target 不可用，该轮不进 pending。 */
  readonly entityId?: string;
  readonly state: "running" | "completedSuccess" | "completedInterrupted" | "failed";
  readonly endedAt?: number;
  readonly fileChanges?: {
    readonly additions: number;
    readonly deletions: number;
    readonly files: number;
    readonly state?: "active" | "reverted";
    readonly revertedPaths?: readonly string[];
  };
  /** 同 turnId 的 userInput 行文本（历史树轮节点标题；缺席时树按时间呈现）。 */
  readonly userText?: string;
}

/** tracker 的帧输入（service 从 conversation 帧流收窄而来）。 */
export type TrackedFrame =
  | {
      kind: "snapshot";
      sessionId: string;
      logEpoch: string;
      revision: number;
      turnHeaders: readonly TrackedTurnHeader[];
      /** userInput 行收窄（turnId → 提问文本），历史树轮节点标题数据源。 */
      userTexts?: readonly { readonly turnId: string; readonly text: string }[];
    }
  | {
      kind: "deltas";
      sessionId: string;
      turnHeaders: readonly TrackedTurnHeader[];
      userTexts?: readonly { readonly turnId: string; readonly text: string }[];
      /** 结构性批次末尾的 state.updated{revision}（attachRevision 保证）。 */
      revision?: number;
      /** row.removed(fromRowId)：该 rowId 及之后全部失效。 */
      removedFromRowId?: number;
    };

/** 单文件撤销账本态（spec §4）。 */
export type FileReviewState = "pending" | "kept" | "reverted" | "superseded";

/** 待审查文件（pending 的最小单位，spec §4）。 */
export interface PendingFileChange {
  readonly path: string;
  /** 解析后的绝对路径（相对则 resolve(workspaceRoot, path)，同 CLI file-rewind 归一）。 */
  readonly resolvedPath: string;
  readonly sessionId: string;
  readonly target: { readonly rowId: number; readonly entityId: string };
  readonly turnRowId: number;
  readonly turnTitle?: string;
  readonly turnEndedAt?: number;
  readonly additions: number;
  readonly deletions: number;
  readonly patches: readonly ChangeHunk[];
}

/** 历史轮内的文件条目。 */
export interface HistoryFileEntry {
  readonly path: string;
  readonly resolvedPath: string;
  readonly additions: number;
  readonly deletions: number;
  readonly state: FileReviewState;
}

/** 历史轮（跨轮次浏览与恢复的最小展示单位）。 */
export interface HistoryTurnEntry {
  readonly sessionId: string;
  readonly target: { readonly rowId: number; readonly entityId: string };
  readonly rowId: number;
  readonly turnTitle?: string;
  readonly endedAt?: number;
  readonly files: readonly HistoryFileEntry[];
}

/**
 * 有轮级 fileChanges 汇总、但每文件明细尚未加载的轮。
 * 聊天里能看到「N 个文件已更改 +A -D」，而明细查询可能因 entityId 缺席 /
 * CAS 水位未就绪 / 查询失败拿不到；此时 TreeView 不能是一片空白——用摘要态
 * 把同一事实呈现出来，并给出可点击的刷新入口。
 */
export interface UndetailedTurn {
  readonly rowId: number;
  readonly title?: string;
  readonly endedAt?: number;
  readonly fileCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly reason: "missing-entity-id" | "pending-details" | "details-failed";
}

/** tracker 的不可变状态快照（树/状态栏/持久化的统一读取面）。 */
export interface ChangesSnapshot {
  readonly sessionId?: string;
  readonly pending: readonly PendingFileChange[];
  readonly history: readonly HistoryTurnEntry[];
  readonly undetailedTurns?: readonly UndetailedTurn[];
}

/** applyFrame 的返回效果：service 据此拉取每文件明细。 */
export interface TrackerEffects {
  /** 轮已终态、files>0、state=active，且尚无文件明细的轮（按 endedAt 降序）。 */
  readonly turnsNeedingDetails?: readonly {
    readonly sessionId: string;
    readonly target: { readonly rowId: number; readonly entityId: string };
  }[];
  /** row.removed 触发的失效（含 pending 清理），service 仅用于日志。 */
  readonly invalidatedFromRowId?: number;
}
