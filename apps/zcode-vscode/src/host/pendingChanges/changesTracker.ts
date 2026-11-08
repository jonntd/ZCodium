/**
 * ChangesTracker — pending/history 的唯一状态所有者（spec §3）。
 *
 * 纯状态机，零 vscode / 零协议运行时依赖：
 * - applyFrame：消费 conversation 帧流收窄后的 TrackedFrame（snapshot 全量重建 /
 *   deltas 增量），识别「轮终态 + files>0 + state=active」产出待拉明细清单；
 * - applyTurnDetails：消费 v4/conversation/fileChanges 明细，落 pending + 历史；
 * - keep / markReverted / consumeRevertedPaths：文件级账本流转；
 * - 路径同形契约：pending/history 全部携带 rawPath 与 resolvedPath，revertedPaths
 *   按 rawPath 精确匹配（per-file-rewind.md §2）。
 *
 * 同路径多轮语义：pending 恒指向最新写入轮；旧轮该文件标记 superseded（恢复会被
 * CLI 的 external_modified 预检拦截，UI 直接呈现不可恢复，语义一致）。
 */

import { isPathInsideWorkspace } from "../pathContainment";
import type {
  ChangeFileItem,
  HistoryFileEntry,
  HistoryTurnEntry,
  PendingFileChange,
  TrackedFrame,
  TrackedTurnHeader,
  TrackerEffects,
  ChangesSnapshot,
  UndetailedTurn,
} from "./types";

/** 历史轮保留上限（spec §8；FIFO 裁剪，不静默删最新）。 */
export const HISTORY_TURN_LIMIT = 100;

/**
 * rawPath → 绝对路径：绝对原样、相对拼 workspaceRoot（同 CLI file-rewind 归一语义）。
 * 安全审查 S2：解析结果必须仍落在 workspaceRoot 内（防 `../` 逃逸），fail-closed
 * 返回 null（调用方按脏数据跳过该文件）——CLI 可信但纵深防御不缺席，且与撤销
 * 预检的 external_modified 口径一致（外部路径本就不可恢复）。
 */
export function resolveChangePath(rawPath: string, workspaceRoot: string): string | null {
  if (rawPath.length === 0) return workspaceRoot;
  // POSIX 绝对判定即可：CLI 侧 resolveWorkspacePath 产出的绝对路径必以 / 开头。
  const resolved = rawPath.startsWith("/")
    ? rawPath
    : `${workspaceRoot.replace(/\/+$/, "")}/${rawPath}`;
  if (!isPathInsideWorkspace(resolved, [workspaceRoot])) return null;
  return resolved;
}

interface TurnRecord {
  rowId: number;
  turnId: string;
  entityId?: string;
  state: TrackedTurnHeader["state"];
  endedAt?: number;
  userText?: string;
  fileChanges?: TrackedTurnHeader["fileChanges"];
  /** 明细已拉取（pending 已建 / 历史已落）。 */
  hasDetails: boolean;
}

export class ChangesTracker {
  private sessionId: string | undefined;
  private logEpoch: string | undefined;
  private revision: number | undefined;
  private readonly turns = new Map<number, TurnRecord>();
  /** rawPath → pending。 */
  private readonly pending = new Map<string, PendingFileChange>();
  /** rowId → 历史轮。 */
  private readonly history = new Map<number, HistoryTurnEntry>();
  private readonly listeners = new Set<(snapshot: ChangesSnapshot) => void>();

  /** CAS 水位（查询与命令信封统一取用；帧流未就绪时为 undefined，调用方必须等待）。 */
  get currentRevision(): number | undefined {
    return this.revision;
  }

  get currentLogEpoch(): string | undefined {
    return this.logEpoch;
  }

  onChange(listener: (snapshot: ChangesSnapshot) => void): { dispose(): void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  snapshot(): ChangesSnapshot {
    // 摘要态是 turn 记录的纯派生：明细一旦落账（hasDetails=true）自动消失，
    // 不引入第二份状态，也不会与持久化账本产生分歧。聊天里显示「N 个文件已更改」
    // 时，即使明细查询拿不到，树里也必须能看到同一事实 + 下一步操作入口。
    const undetailedTurns: UndetailedTurn[] = [];
    for (const record of this.turns.values()) {
      const changes = record.fileChanges;
      if (
        record.hasDetails ||
        record.state === "running" ||
        !changes ||
        changes.files <= 0 ||
        changes.state === "reverted"
      ) {
        continue;
      }
      undetailedTurns.push({
        rowId: record.rowId,
        ...(record.userText ? { title: record.userText } : {}),
        ...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
        fileCount: changes.files,
        additions: changes.additions,
        deletions: changes.deletions,
        reason: record.entityId ? "pending-details" : "missing-entity-id",
      });
    }
    undetailedTurns.sort(
      (left, right) =>
        (right.endedAt ?? 0) - (left.endedAt ?? 0) || right.rowId - left.rowId,
    );
    return {
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      pending: [...this.pending.values()],
      history: [...this.history.values()].sort(compareHistoryDesc),
      ...(undetailedTurns.length > 0 ? { undetailedTurns } : {}),
    };
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /** 活动编辑器命中判定（resolvedPath 精确比对）。 */
  isPendingPath(resolvedPath: string): boolean {
    for (const entry of this.pending.values()) {
      if (entry.resolvedPath === resolvedPath) return true;
    }
    return false;
  }

  /** 重订/换代：整体重置后由 service 重放持久化与 snapshot。 */
  resetForSession(sessionId: string | undefined): void {
    this.sessionId = sessionId;
    this.logEpoch = undefined;
    this.revision = undefined;
    this.turns.clear();
    this.pending.clear();
    this.history.clear();
    this.emit();
  }

  /**
   * 订阅 ACK 的 logEpoch 种子（快照缺席时兜底）：仅在未持有时写入，
   * snapshot 帧仍是权威来源。
   */
  seedLogEpoch(logEpoch: string): void {
    if (!this.logEpoch) this.logEpoch = logEpoch;
  }

  /**
   * 重启恢复（spec §8）：整包重放 workspaceState 持久化的 pending/history。
   * 校验以预检为准（撤销前必过 conversationFileRewindPreviewV4），这里只做会话匹配。
   */
  importPersisted(
    state: { pending: readonly PendingFileChange[]; history: readonly HistoryTurnEntry[] },
    sessionId: string,
  ): void {
    for (const entry of state.pending) {
      if (entry.sessionId !== sessionId || this.pending.has(entry.path)) continue;
      this.pending.set(entry.path, entry);
      this.turns.set(entry.turnRowId, {
        rowId: entry.turnRowId,
        turnId: `persisted-${entry.turnRowId}`,
        entityId: entry.target.entityId,
        state: "completedSuccess",
        ...(entry.turnEndedAt !== undefined ? { endedAt: entry.turnEndedAt } : {}),
        ...(entry.turnTitle ? { userText: entry.turnTitle } : {}),
        hasDetails: true,
      });
    }
    for (const turn of state.history) {
      if (turn.sessionId !== sessionId || this.history.has(turn.rowId)) continue;
      this.history.set(turn.rowId, turn);
    }
    // P2：导入后统一裁剪到保留上限——旧实现不做裁剪，持久化超限（如旧版本
    // 未裁剪或历史被外部扩大）时全量载入，内存与后续快照序列化都被放大。
    if (this.history.size > HISTORY_TURN_LIMIT) {
      const ordered = [...this.history.values()].sort(compareHistoryAsc);
      for (const turn of ordered.slice(0, this.history.size - HISTORY_TURN_LIMIT)) {
        this.history.delete(turn.rowId);
      }
    }
    this.emit();
  }

  applyFrame(frame: TrackedFrame): TrackerEffects {
    if (frame.kind === "snapshot") {
      if (frame.sessionId !== this.sessionId) this.resetForSession(frame.sessionId);
      this.logEpoch = frame.logEpoch;
      this.revision = frame.revision;
      this.ingestTurns(frame.turnHeaders);
      this.ingestUserTexts(frame.userTexts);
    } else {
      if (frame.sessionId !== this.sessionId) return {};
      if (frame.revision !== undefined) this.revision = frame.revision;
      if (frame.removedFromRowId !== undefined) {
        this.invalidateFromRow(frame.removedFromRowId);
      }
      this.ingestTurns(frame.turnHeaders);
      this.ingestUserTexts(frame.userTexts);
    }
    return { turnsNeedingDetails: this.collectTurnsNeedingDetails() };
  }

  /**
   * 消费每文件明细（轮终态后拉取 / 持久化重放共用）。
   * 对每个文件：入 pending（最新轮）或 superseded 旧轮；同时维护该轮历史条目。
   */
  applyTurnDetails(params: {
    sessionId: string;
    target: { rowId: number; entityId: string };
    workspaceRoot: string;
    items: readonly ChangeFileItem[];
    fromPersistence?: boolean;
  }): void {
    void params.fromPersistence; // 预留：持久化重放与实时明细将来可区分呈现。
    const record = this.turns.get(params.target.rowId);
    if (!record) {
      // snapshot 窗口外的持久化重放：按持久化轮信息自建记录（细节以预检为准）。
      this.turns.set(params.target.rowId, {
        rowId: params.target.rowId,
        turnId: `persisted-${params.target.rowId}`,
        entityId: params.target.entityId,
        state: "completedSuccess",
        hasDetails: true,
      });
    } else if (!record.hasDetails) {
      record.hasDetails = true;
    }
    const resolvedTarget = {
      rowId: params.target.rowId,
      entityId: params.target.entityId,
    };
    const title = record?.userText;
    // CLI 权威账本：部分撤销（state 仍 active + revertedPaths）后重建时，
    // 已撤销路径不得重新入 pending（真实 bug：重启恢复会把已撤销文件复活）。
    const revertedPaths = new Set(record?.fileChanges?.revertedPaths ?? []);
    for (const item of params.items) {
      const resolvedPath = resolveChangePath(item.path, params.workspaceRoot);
      if (resolvedPath === null) {
        // S2：解析结果逃逸 workspaceRoot → 脏数据不入账（撤销预检也会拦截外部路径）。
        continue;
      }
      if (revertedPaths.has(item.path)) {
        this.setHistoryFileState(params.target.rowId, item.path, "reverted");
        continue;
      }
      this.upsertHistoryFile(resolvedTarget, params.sessionId, record, {
        path: item.path,
        resolvedPath,
        additions: item.additions,
        deletions: item.deletions,
        state: "pending",
      });
      const existing = this.pending.get(item.path);
      if (existing && existing.turnRowId !== params.target.rowId) {
        // 旧轮同路径：标记 superseded（历史态在 upsertHistoryFile 已写）。
        this.pending.delete(item.path);
      }
      if (!existing || existing.turnRowId !== params.target.rowId) {
        this.pending.set(item.path, {
          path: item.path,
          resolvedPath,
          sessionId: params.sessionId,
          target: resolvedTarget,
          turnRowId: params.target.rowId,
          ...(title ? { turnTitle: title } : {}),
          ...(record?.endedAt !== undefined ? { turnEndedAt: record.endedAt } : {}),
          additions: item.additions,
          deletions: item.deletions,
          patches: item.patches,
        });
      }
    }
    this.emit();
  }

  /** 用户保留：pending → 历史 kept。 */
  keepFiles(turnRowId: number, rawPaths: readonly string[]): void {
    for (const path of rawPaths) {
      const entry = this.pending.get(path);
      if (!entry || entry.turnRowId !== turnRowId) continue;
      this.pending.delete(path);
      this.setHistoryFileState(turnRowId, path, "kept");
    }
    this.emit();
  }

  /** 撤销成功（ack applied）：pending → 历史 reverted。 */
  markReverted(turnRowId: number, rawPaths: readonly string[]): void {
    for (const path of rawPaths) {
      const entry = this.pending.get(path);
      if (entry && entry.turnRowId === turnRowId) this.pending.delete(path);
      this.setHistoryFileState(turnRowId, path, "reverted");
    }
    this.emit();
  }

  /**
   * 消费 CLI 投影的 revertedPaths（row.upserted 的 fileChanges）：撤销可来自本宿主、
   * 聊天内文件卡片或另一窗口——账本以 CLI 事件为权威，幂等收敛。
   */
  consumeRevertedPaths(turnRowId: number, rawPaths: readonly string[]): void {
    let touched = false;
    for (const path of rawPaths) {
      if (this.pending.has(path)) {
        this.pending.delete(path);
        touched = true;
      }
      const turn = this.history.get(turnRowId);
      const file = turn?.files.find((candidate) => candidate.path === path);
      if (turn && file && file.state !== "reverted") {
        this.setHistoryFileState(turnRowId, path, "reverted");
        touched = true;
      }
    }
    if (touched) this.emit();
  }

  // ── 内部 ───────────────────────────────────────────────

  /** userInput 行 → 轮标题：先到先得（edit 重发的新文本不回写旧标题，保持稳定）。 */
  private ingestUserTexts(
    userTexts: readonly { turnId: string; text: string }[] | undefined,
  ): void {
    if (!userTexts || userTexts.length === 0) return;
    for (const { turnId, text } of userTexts) {
      if (!turnId || !text) continue;
      const title = text.length > 80 ? `${text.slice(0, 80)}…` : text;
      for (const record of this.turns.values()) {
        if (record.turnId !== turnId || record.userText) continue;
        record.userText = title;
        const turn = this.history.get(record.rowId);
        if (turn && !turn.turnTitle) {
          this.history.set(record.rowId, { ...turn, turnTitle: title });
        }
        break;
      }
    }
  }

  private ingestTurns(headers: readonly TrackedTurnHeader[]): void {
    for (const header of headers) {
      const existing = this.turns.get(header.rowId);
      const record: TurnRecord = {
        rowId: header.rowId,
        turnId: header.turnId,
        ...(header.entityId ? { entityId: header.entityId } : {}),
        state: header.state,
        ...(header.endedAt !== undefined ? { endedAt: header.endedAt } : {}),
        ...(header.userText ?? existing?.userText
          ? { userText: header.userText ?? existing?.userText }
          : {}),
        ...(header.fileChanges ? { fileChanges: header.fileChanges } : {}),
        hasDetails: existing?.hasDetails ?? false,
      };
      this.turns.set(header.rowId, record);

      // CLI 权威账本：revertedPaths 幂等收敛。
      const reverted = header.fileChanges?.revertedPaths;
      if (reverted && reverted.length > 0) {
        for (const path of reverted) {
          if (this.pending.has(path)) this.pending.delete(path);
        }
        const turn = this.history.get(header.rowId);
        if (turn) {
          const files = turn.files.map(
            (file): HistoryFileEntry =>
              reverted.includes(file.path) ? { ...file, state: "reverted" } : file,
          );
          this.history.set(header.rowId, { ...turn, files });
        }
      }
      // 整轮 reverted：pending 全清（旧事件兼容面）。
      if (header.fileChanges?.state === "reverted") {
        for (const [path, entry] of this.pending) {
          if (entry.turnRowId === header.rowId) {
            this.pending.delete(path);
            this.setHistoryFileState(header.rowId, path, "reverted");
          }
        }
      }
    }
  }

  private collectTurnsNeedingDetails(): NonNullable<TrackerEffects["turnsNeedingDetails"]> {
    if (!this.sessionId) return [];
    const results: {
      sessionId: string;
      target: { rowId: number; entityId: string };
    }[] = [];
    const candidates = [...this.turns.values()]
      .filter(
        (record) =>
          record.hasDetails === false &&
          record.state !== "running" &&
          record.fileChanges !== undefined &&
          record.fileChanges.files > 0 &&
          record.fileChanges.state !== "reverted" &&
          record.entityId !== undefined,
      )
      .sort((left, right) => (right.endedAt ?? 0) - (left.endedAt ?? 0));
    for (const record of candidates) {
      // entityId 由 ingestTurns 收窄保证非空（上方过滤），此处仅类型收窄。
      if (record.entityId === undefined) continue;
      results.push({
        sessionId: this.sessionId,
        target: { rowId: record.rowId, entityId: record.entityId },
      });
    }
    return results;
  }

  private invalidateFromRow(fromRowId: number): void {
    for (const rowId of this.turns.keys()) {
      if (rowId >= fromRowId) this.turns.delete(rowId);
    }
    for (const [path, entry] of this.pending) {
      if (entry.turnRowId >= fromRowId) this.pending.delete(path);
    }
    // Map 迭代中删除当前/未访问键是安全的（迭代器跳过已删除项）。
    for (const rowId of this.history.keys()) {
      if (rowId >= fromRowId) this.history.delete(rowId);
    }
  }

  private upsertHistoryFile(
    target: { rowId: number; entityId: string },
    sessionId: string,
    record: TurnRecord | undefined,
    file: HistoryFileEntry,
  ): void {
    const existing = this.history.get(target.rowId);
    const files = existing ? [...existing.files] : [];
    const index = files.findIndex((candidate) => candidate.path === file.path);
    if (index >= 0) files[index] = { ...files[index], ...file };
    else files.push(file);
    this.history.set(target.rowId, {
      sessionId,
      target,
      rowId: target.rowId,
      ...(record?.userText ? { turnTitle: record.userText } : {}),
      ...(record?.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
      files,
    });
    // 同路径出现在新轮：旧轮该文件标记 superseded（若仍是 pending/kept）。
    // P2：先命中判定再重建——无该文件或已 superseded/reverted 的轮不 set 新对象
    // （旧实现每落一个文件就全量遍历重建所有轮，一轮 F 个文件 → O(T×F²)）。
    for (const [rowId, turn] of this.history) {
      if (rowId === target.rowId) continue;
      const hit = turn.files.some(
        (candidate) =>
          candidate.path === file.path &&
          (candidate.state === "pending" || candidate.state === "kept"),
      );
      if (!hit) continue;
      const oldFiles = turn.files.map(
        (candidate): HistoryFileEntry =>
          candidate.path === file.path && (candidate.state === "pending" || candidate.state === "kept")
            ? { ...candidate, state: "superseded" }
            : candidate,
      );
      this.history.set(rowId, { ...turn, files: oldFiles });
    }
    // 保留上限（spec §8）：超限裁最旧（endedAt 升序的最小者），不静默删最新。
    if (this.history.size > HISTORY_TURN_LIMIT) {
      const oldest = [...this.history.values()].sort(compareHistoryAsc)[0];
      if (oldest) this.history.delete(oldest.rowId);
    }
  }

  private setHistoryFileState(turnRowId: number, path: string, state: HistoryFileEntry["state"]): void {
    const turn = this.history.get(turnRowId);
    if (!turn) return;
    this.history.set(turnRowId, {
      ...turn,
      files: turn.files.map((file) => (file.path === path ? { ...file, state } : file)),
    });
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

function compareHistoryDesc(left: HistoryTurnEntry, right: HistoryTurnEntry): number {
  return (right.endedAt ?? 0) - (left.endedAt ?? 0) || right.rowId - left.rowId;
}

function compareHistoryAsc(left: HistoryTurnEntry, right: HistoryTurnEntry): number {
  return (left.endedAt ?? 0) - (right.endedAt ?? 0) || left.rowId - right.rowId;
}
