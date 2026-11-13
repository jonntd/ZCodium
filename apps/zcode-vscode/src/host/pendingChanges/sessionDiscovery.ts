/**
 * SessionDiscovery — workspace 级会话发现（sessions-index 观察者）。
 *
 * 真机教训（2026-11-07）：notifySessionCreated 在 Antigravity fork 的 webview 里
 * 不可靠（activeTaskId 订阅可能不触发），唯一稳定的会话发现是 CLI 主动推送的
 * workspace 级 sessions-index 帧。runtimePolicy=existing-only 不为订阅拉起 Agent。
 *
 * 纯协调器：发现新会话 → onSessionDiscovered 回调。零 vscode 依赖。
 */

import { TopicWireFrameAssembler } from "@zcode/shared/zcode-protocol-v4";
import type {
  SessionsIndexTopicFrame,
  SessionsIndexTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";
import { sessionsIndexTopicFrameSchema } from "@zcode/shared/zcode-protocol-v4";
import type { IZCodeAgentService } from "@zcode/services";
import { setTimeout as sleep } from "node:timers/promises";

const RETRY_INTERVAL_MS = 15_000;

export interface SessionDiscoveryOptions {
  agentService: Partial<
    Pick<
      IZCodeAgentService,
      "subscribeSessionsIndexV4" | "unsubscribeSessionsIndexV4" | "onDynamicSessionsIndexFrame"
    >
  >;
  /** 观察的 workspace folder（CLI 按 workspacePath 解析 sessions-index）。 */
  workspaceRoot: () => string | null;
  /** 发现最新活跃会话时回调（sessionId 变化时才触发）。 */
  onSessionDiscovered: (sessionId: string, workspaceRoot: string) => void;
  log: (message: string) => void;
}

export class SessionDiscovery {
  private subscription: {
    subscriptionId: string;
    workspaceRoot: string;
    listener: { dispose(): void };
    assembler: TopicWireFrameAssembler<SessionsIndexTopicFrame>;
  } | null = null;
  private failureLogged = false;
  private chain: Promise<void> = Promise.resolve();
  private disposed = false;
  private discoveredSessionId: string | undefined;

  constructor(private readonly options: SessionDiscoveryOptions) {}

  /** 启动观察（幂等：失败自动 15s 重试，成功后静默监听 delta）。 */
  start(): void {
    if (this.disposed || this.subscription) return;
    this.chain = this.chain
      .then(() => this.subscribe())
      .catch((error: unknown) => {
        this.options.log(
          `[session-discovery] 编排异常：${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  /** 停止观察并释放资源。 */
  dispose(): void {
    this.disposed = true;
    const sub = this.subscription;
    this.subscription = null;
    if (!sub) return;
    sub.listener.dispose();
    void this.options.agentService.unsubscribeSessionsIndexV4
      ?.call(this.options.agentService, {
        workspacePath: sub.workspaceRoot,
        subscriptionId: sub.subscriptionId,
      })
      .catch(() => undefined);
  }

  private async subscribe(): Promise<void> {
    const { subscribeSessionsIndexV4, unsubscribeSessionsIndexV4, onDynamicSessionsIndexFrame } =
      this.options.agentService;
    if (!subscribeSessionsIndexV4 || !unsubscribeSessionsIndexV4 || !onDynamicSessionsIndexFrame) {
      return;
    }
    const root = this.options.workspaceRoot();
    if (!root) return;
    const assembler = new TopicWireFrameAssembler(sessionsIndexTopicFrameSchema);
    const early: SessionsIndexTopicWireCandidate[] = [];
    let subscriptionId: string | undefined;
    const accept = (wire: SessionsIndexTopicWireCandidate): void => {
      if (subscriptionId === undefined) {
        if (early.length < 64) early.push(wire);
        return;
      }
      if (wire.subscriptionId !== subscriptionId) return;
      for (const event of assembler.accept(wire)) {
        if (event.kind === "fault") continue;
        this.handleFrame(event.frame);
      }
    };
    const frameSource = onDynamicSessionsIndexFrame({
      workspacePath: root,
    });
    const listener = frameSource(accept);
    try {
      const result = await subscribeSessionsIndexV4({
        workspacePath: root,
        visibility: "background",
        subscriberScope: "pending-changes",
        runtimePolicy: "existing-only",
      });
      if (this.disposed) {
        await unsubscribeSessionsIndexV4({
          workspacePath: root,
          subscriptionId: result.ack.subscriptionId,
        }).catch(() => undefined);
        listener.dispose();
        return;
      }
      subscriptionId = result.ack.subscriptionId;
      this.subscription = { subscriptionId, workspaceRoot: root, listener, assembler };
      this.failureLogged = false;
      for (const wire of early.splice(0)) accept(wire);
      this.options.log(`[session-discovery] 已建立（${root}）`);
    } catch (error) {
      listener.dispose();
      const message = error instanceof Error ? error.message : String(error);
      if (!this.failureLogged) {
        this.failureLogged = true;
        this.options.log(
          `[session-discovery] 暂不可用（每 ${RETRY_INTERVAL_MS / 1000}s 重试）：${message}`,
        );
      }
      await sleep(RETRY_INTERVAL_MS);
      if (!this.disposed) {
        this.subscription = null;
        this.start();
      }
    }
  }

  private handleFrame(frame: SessionsIndexTopicFrame): void {
    const sessions =
      frame.payload.kind === "snapshot"
        ? frame.payload.snapshot.sessions
        : frame.payload.deltas
            .filter((delta) => delta.op === "session.upserted")
            .map((delta) => delta.session);
    const alive = sessions.filter((s) => s.phase !== "draft");
    if (alive.length === 0) return;
    const latest = [...alive].sort(
      (a, b) => (b.lastActivityAt ?? b.createdAt ?? 0) - (a.lastActivityAt ?? a.createdAt ?? 0),
    )[0];
    if (!latest || latest.sessionId === this.discoveredSessionId) return;
    this.discoveredSessionId = latest.sessionId;
    this.options.log(`[session-discovery] 发现会话：${latest.sessionId}`);
    this.options.onSessionDiscovered(latest.sessionId, this.discoveredSessionId ? (this.options.workspaceRoot() ?? "") : "");
  }
}
