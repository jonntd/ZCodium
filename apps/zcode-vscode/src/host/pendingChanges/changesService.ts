/**
 * ChangesService — 单会话的 pending changes 编排（spec: docs/spec/vscode-pending-changes.md §3/§5）。
 *
 * 一个服务实例只追踪一个会话（构造时固定 sessionId）；多会话由 assembly 的
 * PendingChangesPool 按会话实例化（「文件改动历史」本就该汇集工作区全部会话的改动）。
 *
 * 职责：订阅该会话的 conversation 帧流（TopicWireFrameAssembler 解帧 + 订阅 ACK 前
 * 缓冲 + 进程换代强制重订），驱动 ChangesTracker；轮终态后拉每文件明细；撤销走
 * 「预检 → CAS 信封 → v4 命令」；持久化经注入回调（池按会话合并落盘）。
 *
 * 约束：订阅活在 CLI 进程内存，进程换代即静默失活——换代监听强制重订；运行时不可用
 * 降级为空状态 + 日志，不静默、不崩。本文件不直接 import vscode，全部 vscode 面
 * 经注入依赖，vitest 直测。
 */

import { TopicWireFrameAssembler } from "@zcode/shared/zcode-protocol-v4";
import type {
  ConversationTopicFrame,
  ConversationTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { conversationTopicFrameSchema } from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService } from "@zcode/services";
import { ChangesTracker, resolveChangePath } from "./changesTracker";
import { DebouncedPersister } from "./debouncedPersister";
import { buildApplyFileRewindEnvelope } from "./commandEnvelope";
import type {
  ChangeFileItem,
  ChangesSnapshot,
  HistoryFileEntry,
  HistoryTurnEntry,
  PendingFileChange,
  TrackedFrame,
  TrackedTurnHeader,
} from "./types";

/** 服务用到的 services 面（结构化子集，测试注内存实现）。 */
export interface ChangesAgentService {
  /** sessions-index 观察者三件套（sessionDiscovery 用；可选） */
  subscribeSessionsIndexV4?: IZCodeAgentService["subscribeSessionsIndexV4"];
  unsubscribeSessionsIndexV4?: IZCodeAgentService["unsubscribeSessionsIndexV4"];
  onDynamicSessionsIndexFrame?: IZCodeAgentService["onDynamicSessionsIndexFrame"];
  subscribeConversationV4: IZCodeAgentService["subscribeConversationV4"];
  unsubscribeConversationV4: IZCodeAgentService["unsubscribeConversationV4"];
  onDynamicConversationFrame: IZCodeAgentService["onDynamicConversationFrame"];
  onAgentRuntimeRestarted?: IZCodeAgentService["onAgentRuntimeRestarted"];
  conversationFileChangesV4: IZCodeAgentService["conversationFileChangesV4"];
  conversationFileRewindPreviewV4: IZCodeAgentService["conversationFileRewindPreviewV4"];
  sendConversationCommandV4: IZCodeAgentService["sendConversationCommandV4"];
}

export interface PersistedChanges {
  pending: PendingFileChange[];
  history: HistoryTurnEntry[];
}

export interface ChangesServiceOptions {
  agentService: ChangesAgentService;
  /** 本服务唯一追踪的会话（池按会话实例化，杜绝选错目标）。 */
  sessionId: string;
  /** 该会话归属的 workspace folder（订阅/路径解析/撤销全部用它）。 */
  workspaceRoot: () => string | null;
  readFile: (absPath: string) => Promise<string>;
  /** 宿主自持 clientId（容器持久化；服务端幂等表按提交端区分）。 */
  clientId: string;
  persist: (state: PersistedChanges) => void;
  loadPersisted: () => PersistedChanges | undefined;
  /** 预检不通过等用户可见警告（vscode showWarningMessage）。 */
  showWarning: (message: string) => void;
  /** diff 打开面（ChangesDiffOpener.openPendingDiff）。 */
  openDiff: (request: {
    resolvedPath: string;
    patches: readonly {
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      lines: readonly string[];
    }[];
  }) => Promise<void>;
  log: (message: string) => void;
  /** 注入时钟（测试确定性）。 */
  now?: () => number;
  /** 持久化合批窗口（性能审查 P1；<=0 同步直写，测试确定性用）。 */
  persistDebounceMs?: number;
}

interface Subscription {
  subscriptionId: string;
  listener: { dispose(): void };
}

export class ChangesService {
  private readonly tracker = new ChangesTracker();
  /** 诊断出口：暴露给宿主接日志（撤销路径收敛的帧级证据）。 */
  get trackerDiagnostics(): (message: string) => void {
    return (message: string) => this.tracker.diagnosticSink?.(message);
  }
  set trackerDiagnostics(sink: (message: string) => void | undefined) {
    this.tracker.diagnosticSink = sink ?? undefined;
  }
  private readonly options: ChangesServiceOptions;
  private subscription: Subscription | null = null;
  private subscribed = false;
  private forceResubscribeOnNextSync = false;
  /** 换代事件限流（真机教训：崩溃循环每秒一发，无条件重建会放大风暴）。 */
  private restartTimestamps: number[] = [];
  private lastForceResubscribeAt = 0;
  private started = false;
  private disposed = false;
  /** 显式重指的会话覆盖（setSession 写入；空 = 未指定，跟随兜底）。 */
  private sessionOverride: { sessionId: string; folder: string } | null = null;
  private readonly restartDisposable: { dispose(): void } | null;
  private readonly changeListeners = new Set<(snapshot: ChangesSnapshot) => void>();
  /** 明细拉取去重（同一轮并发只发一次查询）。 */
  private readonly fetchingTargets = new Set<string>();
  private readonly persister: DebouncedPersister;

  constructor(options: ChangesServiceOptions) {
    this.options = options;
    // tracker 变化 → 持久化（P1：trailing 合批 + 指纹去重，防流式期间每帧全量
    // workspaceState.update）+ 下游刷新（树/状态栏/上下文键经 changeListeners）。
    this.persister = new DebouncedPersister(
      (state) => this.options.persist(state as PersistedChanges),
      options.persistDebounceMs ?? 250,
    );
    this.tracker.onChange((snapshot) => {
      this.persister.push({
        pending: [...snapshot.pending],
        history: [...snapshot.history],
      });
      for (const listener of this.changeListeners) listener(snapshot);
    });
    // 进程换代 → 订阅静默失活，强制重建（spec §9 场景 9；同会话也不可复用死订阅）。
    // 两个护栏（真机教训）：
    // 1) workspaceKey 过滤——事件总线是全局的，别的 workspace 换代不归我管；
    // 2) 限流——运行时崩溃循环时换代事件每秒一发，无条件重建会放大风暴。
    this.restartDisposable =
      this.options.agentService.onAgentRuntimeRestarted?.((event) => {
        const folder = this.options.workspaceRoot();
        if (!folder || event.workspaceKey !== folder) return;
        const now = Date.now();
        this.restartTimestamps = this.restartTimestamps.filter((t) => now - t < 10_000);
        this.restartTimestamps.push(now);
        if (now - this.lastForceResubscribeAt < 5_000) {
          this.options.log("[pending-changes] 换代风暴限流：5s 内跳过重建");
          return;
        }
        this.lastForceResubscribeAt = now;
        this.options.log("[pending-changes] Agent 进程换代：重建 conversation 订阅");
        this.forceResubscribeOnNextSync = true;
        this.syncSession();
      }) ?? null;
  }

  /** 订阅变化（树/状态栏/上下文键）。 */
  onChange(listener: (snapshot: ChangesSnapshot) => void): { dispose(): void } {
    this.changeListeners.add(listener);
    listener(this.tracker.snapshot());
    return {
      dispose: () => {
        this.changeListeners.delete(listener);
      },
    };
  }

  snapshot(): ChangesSnapshot {
    return this.tracker.snapshot();
  }

  pendingCount(): number {
    return this.tracker.pendingCount();
  }

  /** 活动编辑器命中判定（resolvedPath）。 */
  isPendingPath(resolvedPath: string): boolean {
    return this.tracker.isPendingPath(resolvedPath);
  }

  /**
   * 重指会话（notifySessionCreated 直传；共享 ext host 多窗口下 workspaceFolders[0]
   * 推断不可靠，真机教训 2026-11-07）。teardown 旧订阅 + tracker 重置 + 重订新会话。
   */
  setSession(sessionId: string | undefined, folder: string | null): void {
    const next = sessionId?.trim() || "";
    const nextFolder = folder && folder.trim() ? folder : null;
    if (next === this.sessionOverride?.sessionId && nextFolder === this.sessionOverride?.folder) {
      return;
    }
    this.sessionOverride = next ? { sessionId: next, folder: nextFolder ?? "" } : null;
    this.forceResubscribeOnNextSync = true;
    this.syncSession();
  }

  /** 激活（幂等）：读持久化 + 建立订阅。容器在 activate 与 restore 完成后调用。 */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    this.syncSession();
  }

  /** 等待在途重订编排收口（订阅生命周期测试与 dispose 前收尾用）。 */
  whenSettled(): Promise<void> {
    return this.resubscribeChain;
  }

  /**
   * 手动刷新（TreeView 标题栏「刷新」）：强制重建 conversation 订阅，重新拉一次
   * snapshot 帧。侧栏视图长期驻留，会话切换 / Agent 换代 / workspace 变化都可能让
   * 后台订阅静默失活；显式重订比只重画树更能恢复真实数据。状态由 tracker 从
   * 持久化 + 新 snapshot 重放，不会丢失用户已做出的「保留 / 撤销」决议。
   */
  forceResync(): void {
    this.forceResubscribeOnNextSync = true;
    this.syncSession();
  }

  /** 打开某待审文件的原生 diff（TreeView 点击 / 标题栏入口）。 */
  async openPendingDiff(resolvedPath: string): Promise<boolean> {
    const entry = this.tracker
      .snapshot()
      .pending.find((candidate) => candidate.resolvedPath === resolvedPath);
    if (!entry) return false;
    await this.options.openDiff({
      resolvedPath: entry.resolvedPath,
      patches: entry.patches,
    });
    return true;
  }

  /** 保留：pending → 历史 kept。 */
  keepFiles(turnRowId: number, rawPaths: readonly string[]): void {
    this.tracker.keepFiles(turnRowId, rawPaths);
  }

  keepTurn(turnRowId: number): void {
    const paths = this.pathsOfTurn(turnRowId);
    if (paths.length > 0) this.tracker.keepFiles(turnRowId, paths);
  }

  /**
   * 撤销：预检（安全裁决唯一来源）→ CAS 信封 → applyFileRewind。
   * 返回是否已执行撤销（false = 预检/命令失败，已向用户说明）。
   */
  async revertFiles(turnRowId: number, rawPaths: readonly string[]): Promise<boolean> {
    const sessionId = this.effectiveSessionId();
    const workspaceRoot = this.effectiveFolder();
    if (!sessionId || !workspaceRoot) {
      this.options.showWarning("当前没有活跃会话，无法撤销文件改动。");
      return false;
    }
    const target = this.targetOfTurn(turnRowId);
    if (!target) {
      this.options.showWarning("找不到该轮次的定位信息，无法撤销。");
      return false;
    }
    const baseRevision = this.tracker.currentRevision;
    const baseLogEpoch = this.tracker.currentLogEpoch;
    if (baseRevision === undefined || !baseLogEpoch) {
      this.options.showWarning("会话状态尚未就绪，请稍后重试。");
      return false;
    }

    // 1) 预检：v4 预览是整轮粒度（无 paths 入参），返回每文件 safe/unsafe；
    //    目标路径必须全部落在 safeFiles 才派发，CLI 端 applyFileRewind 会再按子集复检。
    let preview;
    try {
      preview = await this.options.agentService.conversationFileRewindPreviewV4({
        workspacePath: workspaceRoot,
        sessionId,
        target,
        baseRevision,
        baseLogEpoch,
      });
    } catch (error) {
      this.options.showWarning(
        `撤销预检失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    const safePaths = new Set(preview.safeFiles.map((file) => file.path));
    const unsafeTargets = preview.unsafeFiles.filter((file) => rawPaths.includes(file.path));
    const missingTargets = rawPaths.filter(
      (path) => !safePaths.has(path) && !unsafeTargets.some((file) => file.path === path),
    );
    if (unsafeTargets.length > 0 || missingTargets.length > 0) {
      const reasons = [
        ...unsafeTargets.map((file) => ({ path: file.path, reason: file.reason })),
        ...missingTargets.map((path) => ({ path, reason: "checkpoint_missing" })),
      ];
      this.options.showWarning(describeUnsafe(reasons));
      return false;
    }

    // 2) CAS 信封 + v4 命令（与 webview transport 同一 sendConversationCommandV4 面）。
    let ack;
    try {
      const envelope = buildApplyFileRewindEnvelope({
        sessionId,
        target,
        paths: rawPaths,
        baseRevision,
        baseLogEpoch,
        clientId: this.options.clientId,
        now: (this.options.now ?? Date.now)(),
      });
      ack = await this.options.agentService.sendConversationCommandV4({
        workspacePath: workspaceRoot,
        envelope,
      });
    } catch (error) {
      this.options.showWarning(
        `撤销命令发送失败：${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    const accepted = ack.status === "accepted" || ack.status === "duplicate";
    const result = ack.result?.type === "applyFileRewind" ? ack.result : undefined;
    if (!accepted || (result && result.applied === false)) {
      const reason =
        (result?.response as string | undefined) ?? ack.reasonCode ?? "命令被拒绝";
      this.options.showWarning(`撤销未执行：${reason}`);
      return false;
    }
    // 3) 本地账本立即收敛；CLI 的 RewindTriggered 投影随后幂等确认。
    this.tracker.markReverted(turnRowId, rawPaths);
    return true;
  }

  /** 历史轮恢复入口（TreeView）：target 取自历史条目。 */
  async revertHistory(turn: HistoryTurnEntry, rawPaths: readonly string[]): Promise<boolean> {
    return this.revertFiles(turn.rowId, rawPaths);
  }

  dispose(): void {
    this.disposed = true;
    // 合批中的最后一笔先落盘（防丢尾部变化），再拆订阅。
    this.persister.dispose();
    this.teardownSubscription();
    this.restartDisposable?.dispose();
    this.changeListeners.clear();
  }

  // ── 内部：订阅与帧处理 ─────────────────────────────────

  private resubscribeChain: Promise<void> = Promise.resolve();

  /** 幂等订阅本服务的固定会话（池在创建与换代重订时调用）。 */
  syncSession(): void {
    if (this.disposed) return;
    const force = this.forceResubscribeOnNextSync;
    this.forceResubscribeOnNextSync = false;
    this.resubscribeChain = this.resubscribeChain
      .then(() => this.resubscribeInternal(force))
      .catch((error: unknown) => {
        this.options.log(
          `[pending-changes] 重订编排异常：${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private effectiveSessionId(): string {
    return this.sessionOverride?.sessionId ?? this.options.sessionId;
  }

  private effectiveFolder(): string | null {
    return this.sessionOverride?.folder || this.options.workspaceRoot();
  }

  private async resubscribeInternal(force: boolean): Promise<void> {
    const sessionId = this.effectiveSessionId();
    if (!force && this.subscribed) return;
    this.teardownSubscription();
    this.tracker.resetForSession(sessionId);
    const workspaceRoot = this.effectiveFolder();
    if (!sessionId || !workspaceRoot) return;
    // 路径同形收敛的前提：撤销匹配需要 workspaceRoot 把相对 revertedPaths 解析成
    // 绝对形态。必须在 importPersisted / 订阅快照之前注入（否则重启重放时
    // ingestTurns 解析不了相对路径，已撤销文件复活进待审）。
    this.tracker.setWorkspaceRoot(workspaceRoot);

    // 重启恢复（spec §8）：先重放持久化（含 patches），真实帧随后幂等校验。
    const persisted = this.options.loadPersisted();
    if (persisted && (persisted.pending.length > 0 || persisted.history.length > 0)) {
      this.tracker.importPersisted(persisted, sessionId);
    }

    const assembler = new TopicWireFrameAssembler(conversationTopicFrameSchema);
    const topic = `conversation/${sessionId}`;
    const early: ConversationTopicWireCandidate[] = [];
    let subscriptionId: string | undefined;
    // 话题级监听（修复帧断流）：CLI 的订阅所有权语义是「同 connectionId 重复
    // subscribe 即作废旧订阅」，聊天 webview 连接后会在同一条连接上订阅同一
    // topic，把我们的后台订阅顶掉（实测 wire subId 从 -1 变 -2，旧流停帧）。
    // 如果按 subId 过滤就会永久断流；如果反过来重订阅又会顶掉聊天面，陷入
    // 所有权战争。因此这里按 topic 采纳「当前活跃流」：每当出现新 subId 就
    // 换新组装器从头接收（新订阅者的首帧是完整 resume/snapshot，状态可重建，
    // tracker.applyFrame 对 snapshot 幂等），永不主动重订阅。
    let activeSubId: string | undefined;
    let assemblerActive = assembler;
    const accept = (wire: ConversationTopicWireCandidate): void => {
      if (wire.topic !== topic) return;
      if (subscriptionId === undefined) {
        // 订阅 ACK 可能晚于首帧；先缓冲，取得 ownership 后回放（observeRuntime 范式）。
        if (early.length < 128) early.push(wire);
        return;
      }
      if (wire.subscriptionId !== activeSubId) {
        activeSubId = wire.subscriptionId;
        assemblerActive = new TopicWireFrameAssembler(conversationTopicFrameSchema);
        this.options.log(
          `[pending-changes] 采纳会话流 subId=${activeSubId ?? "无"}（自有订阅=${subscriptionId}）`,
        );
      }
      for (const event of assemblerActive.accept(wire)) {
        if (event.kind === "fault") {
          this.options.log(`[pending-changes] 帧组装故障：${event.fault.reasonCode ?? "unknown"}`);
          continue;
        }
        this.handleFrame(event.frame);
      }
    };
    const listener = this.options.agentService.onDynamicConversationFrame({
      workspacePath: workspaceRoot,
    })(accept);
    try {
      const result = await this.options.agentService.subscribeConversationV4({
        workspacePath: workspaceRoot,
        sessionId,
        visibility: "background",
      });
      // 订阅竞态收口：等待期间已 dispose → 立刻释放，不留下后台订阅。
      if (this.disposed) {
        await this.options.agentService
          .unsubscribeConversationV4({
            workspacePath: workspaceRoot,
            subscriptionId: result.ack.subscriptionId,
          })
          .catch(() => undefined);
        listener.dispose();
        return;
      }
      subscriptionId = result.ack.subscriptionId;
      this.subscription = { subscriptionId, listener };
      this.subscribed = true;
      // ACK 自带 logEpoch：快照缺席时兜底 CAS 水位（快照帧仍是权威来源）。
      this.tracker.seedLogEpoch(result.ack.logEpoch);
      for (const wire of early.splice(0)) accept(wire);
      this.options.log(`[pending-changes] 已订阅 conversation/${sessionId}`);
    } catch (error) {
      listener.dispose();
      // 降级不静默：运行时不可用/会话失效时 pending 面保持持久化内容，撤销以预检兜底。
      this.options.log(
        `[pending-changes] 订阅失败（降级）：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private teardownSubscription(): void {
    const subscription = this.subscription;
    this.subscription = null;
    this.subscribed = false;
    if (!subscription) return;
    subscription.listener.dispose();
    const workspaceRoot = this.effectiveFolder();
    if (workspaceRoot) {
      void this.options.agentService
        .unsubscribeConversationV4({
          workspacePath: workspaceRoot,
          subscriptionId: subscription.subscriptionId,
        })
        .catch(() => undefined);
    }
  }

  private handleFrame(frame: ConversationTopicFrame): void {
    const tracked = toTrackedFrame(frame);
    if (!tracked) return;
    const effects = this.tracker.applyFrame(tracked);
    const pendingTurns = effects.turnsNeedingDetails ?? [];
    if (pendingTurns.length === 0) {
      // 摘要态会让树里仍能看到本轮改动；这里说明为什么没走到明细查询，避免
      // 「聊天有改动、树里只有汇总」变成无法诊断的静默状态。
      const undetailed = this.tracker.snapshot().undetailedTurns ?? [];
      if (undetailed.length > 0) {
        this.options.log(
          `[pending-changes] 轮改动已入摘要态但明细查询未触发：` +
            undetailed
              .map((turn) => `rowId=${turn.rowId}(${turn.fileCount} 文件, ${turn.reason})`)
              .join(", "),
        );
      }
      return;
    }
    for (const turn of pendingTurns) {
      void this.fetchTurnDetails(turn.sessionId, turn.target);
    }
  }

  /** 轮终态后拉每文件明细（去重；失败降级为历史缺明细，不阻塞对话面）。 */
  private async fetchTurnDetails(
    sessionId: string,
    target: { rowId: number; entityId: string },
  ): Promise<void> {
    const workspaceRoot = this.effectiveFolder();
    const baseRevision = this.tracker.currentRevision;
    const baseLogEpoch = this.tracker.currentLogEpoch;
    // 旧实现三个条件合并成一个静默 return：CAS 水位/工作区未就绪时既无明细也无日志，
    // 用户只能看到一棵空树。逐项给出原因，树里同时保留摘要态。
    if (!workspaceRoot || baseRevision === undefined || !baseLogEpoch) {
      const skipReason = !workspaceRoot
        ? "无工作区根"
        : baseRevision === undefined
          ? "CAS revision 未就绪"
          : "logEpoch 未就绪";
      this.options.log(
        `[pending-changes] 轮明细跳过（rowId=${target.rowId}）：${skipReason}；保留摘要态，可点视图刷新重试`,
      );
      return;
    }
    const key = `${sessionId}:${target.rowId}`;
    if (this.fetchingTargets.has(key)) return;
    this.fetchingTargets.add(key);
    try {
      const result = await this.options.agentService.conversationFileChangesV4({
        workspacePath: workspaceRoot,
        sessionId,
        target,
        baseRevision,
        baseLogEpoch,
      });
      this.tracker.applyTurnDetails({
        sessionId,
        target,
        workspaceRoot,
        items: result.items as ChangeFileItem[],
      });
      this.options.log(
        `[pending-changes] 轮明细已加载（rowId=${target.rowId}，${result.items.length} 文件）`,
      );
    } catch (error) {
      this.options.log(
        `[pending-changes] 轮明细拉取失败（rowId=${target.rowId}）：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      this.fetchingTargets.delete(key);
    }
  }

  // ── 内部：查询辅助 ─────────────────────────────────────

  private pathsOfTurn(turnRowId: number): string[] {
    const snapshot = this.tracker.snapshot();
    const pending = snapshot.pending.filter((entry) => entry.turnRowId === turnRowId);
    if (pending.length > 0) return pending.map((entry) => entry.path);
    const turn = snapshot.history.find((entry) => entry.rowId === turnRowId);
    return (turn?.files ?? [])
      .filter((file) => file.state === "pending" || file.state === "kept")
      .map((file) => file.path);
  }

  private targetOfTurn(turnRowId: number): { rowId: number; entityId: string } | undefined {
    const snapshot = this.tracker.snapshot();
    const pending = snapshot.pending.find((entry) => entry.turnRowId === turnRowId);
    if (pending) return pending.target;
    const turn = snapshot.history.find((entry) => entry.rowId === turnRowId);
    return turn?.target;
  }
}

// ── 帧 → TrackedFrame 收窄（headless，测试直测） ────────────

export function toTrackedFrame(frame: ConversationTopicFrame): TrackedFrame | null {
  if (frame.payload.kind === "snapshot") {
    const snapshot = frame.payload.snapshot;
    const collected = collectTurnHeaders(snapshot.rows.window);
    return {
      kind: "snapshot",
      sessionId: snapshot.sessionId,
      logEpoch: snapshot.logEpoch,
      revision: snapshot.revision,
      turnHeaders: collected.turnHeaders,
      ...(collected.userTexts.length > 0 ? { userTexts: collected.userTexts } : {}),
    };
  }
  let revision: number | undefined;
  let removedFromRowId: number | undefined;
  const turnHeaders: TrackedTurnHeader[] = [];
  const userTexts: { turnId: string; text: string }[] = [];
  for (const delta of frame.payload.deltas) {
    if (delta.op === "row.appended" || delta.op === "row.upserted") {
      collectFromRow(delta.row, turnHeaders, userTexts);
    } else if (delta.op === "row.removed") {
      removedFromRowId = delta.fromRowId;
    } else if (delta.op === "state.updated" && typeof delta.patch.revision === "number") {
      revision = delta.patch.revision;
    }
  }
  return {
    kind: "deltas",
    sessionId: sessionIdFromTopic(frame.topic),
    turnHeaders,
    ...(userTexts.length > 0 ? { userTexts } : {}),
    ...(revision !== undefined ? { revision } : {}),
    ...(removedFromRowId !== undefined ? { removedFromRowId } : {}),
  };
}

function sessionIdFromTopic(topic: string): string {
  return topic.startsWith("conversation/") ? topic.slice("conversation/".length) : topic;
}

function collectTurnHeaders(rows: readonly unknown[]): {
  turnHeaders: TrackedTurnHeader[];
  userTexts: { turnId: string; text: string }[];
} {
  const turnHeaders: TrackedTurnHeader[] = [];
  const userTexts: { turnId: string; text: string }[] = [];
  for (const row of rows) collectFromRow(row, turnHeaders, userTexts);
  return { turnHeaders, userTexts };
}

type MutableTurnHeaderRow = {
  kind?: unknown;
  rowId?: unknown;
  turnId?: unknown;
  entityId?: unknown;
  state?: unknown;
  endedAt?: unknown;
  fileChanges?: unknown;
};

type MutableUserInputRow = {
  kind?: unknown;
  turnId?: unknown;
  text?: unknown;
};

function collectFromRow(
  row: unknown,
  turnHeaders: TrackedTurnHeader[],
  userTexts: { turnId: string; text: string }[],
): void {
  if (typeof row !== "object" || row === null) return;
  const record = row as MutableTurnHeaderRow & MutableUserInputRow;
  if (
    record.kind === "turnHeader" &&
    typeof record.rowId === "number" &&
    typeof record.turnId === "string"
  ) {
    const fileChanges = normalizeFileChanges(record.fileChanges);
    turnHeaders.push({
      rowId: record.rowId,
      turnId: record.turnId,
      ...(typeof record.entityId === "string" ? { entityId: record.entityId } : {}),
      state:
        record.state === "completedSuccess" ||
        record.state === "completedInterrupted" ||
        record.state === "failed"
          ? record.state
          : "running",
      ...(typeof record.endedAt === "number" ? { endedAt: record.endedAt } : {}),
      ...(fileChanges ? { fileChanges } : {}),
    });
    return;
  }
  if (
    record.kind === "userInput" &&
    typeof record.turnId === "string" &&
    typeof record.text === "string"
  ) {
    userTexts.push({ turnId: record.turnId, text: record.text });
  }
}

function normalizeFileChanges(value: unknown): TrackedTurnHeader["fileChanges"] {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as {
    additions?: unknown;
    deletions?: unknown;
    files?: unknown;
    state?: unknown;
    revertedPaths?: unknown;
  };
  if (typeof record.files !== "number" || record.files <= 0) return undefined;
  return {
    additions: typeof record.additions === "number" ? record.additions : 0,
    deletions: typeof record.deletions === "number" ? record.deletions : 0,
    files: record.files,
    ...(record.state === "active" || record.state === "reverted" ? { state: record.state } : {}),
    ...(Array.isArray(record.revertedPaths)
      ? {
          revertedPaths: record.revertedPaths.filter((path): path is string =>
            typeof path === "string",
          ),
        }
      : {}),
  };
}

export function describeUnsafe(
  unsafeFiles: readonly { path: string; reason?: string }[],
): string {
  if (unsafeFiles.length === 0) return "撤销被安全预检阻止。";
  const detail = unsafeFiles
    .map((file) => {
      const reason =
        file.reason === "external_modified"
          ? "文件在改动后被外部修改"
          : file.reason === "checkpoint_missing" || file.reason === "checkpoint_unreadable"
            ? "检查点不可用"
            : file.reason === "unsupported_checkpoint"
              ? "该改动不支持自动恢复"
              : "文件读取失败";
      return `${file.path}（${reason}）`;
    })
    .join("、");
  return `已阻止撤销以保护你的改动：${detail}。可手动处理后再试。`;
}

/** 便捷：rawPath → 绝对路径（树/命令装配用；与 tracker 内部语义一致）。
 *  穿越逃逸（解析结果不在 workspaceRoot 内）返回 null（安全审查 S2 fail-closed）。 */
export function resolveChangeFilePath(
  rawPath: string,
  workspaceRoot: string,
): string | null {
  return resolveChangePath(rawPath, workspaceRoot);
}

export type { HistoryFileEntry, HistoryTurnEntry, PendingFileChange };
