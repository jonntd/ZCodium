/**
 * DebouncedPersister — trailing 合批持久化（性能审查 P1）。
 *
 * 问题：ChangesService 把 tracker.onChange 直连 persist——流式会话期间每条
 * conversation 帧都触发全量序列化 + workspaceState.update（IPC 到主进程），
 * 高频帧下是可观的持续开销。
 *
 * 语义：
 * - 内容指纹（JSON.stringify）相同 → 跳过（tracker 的若干操作即使无实质变化也会 emit）；
 * - trailing 合批：持续变化期间只保留最新状态，delayMs 后写一次；
 * - delayMs <= 0 同步直写（测试确定性 / 需要强落盘的场景）；
 * - flush() 立即落盘最新待写状态（dispose 与关键节点调用，防丢尾部一笔）。
 *
 * 纯类零依赖（不 import vscode/changesService，避免环），vitest 直测。
 */

export class DebouncedPersister {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastFingerprint: string | null = null;
  private staged: (() => void) | null = null;

  constructor(
    private readonly write: (state: unknown) => void,
    private readonly delayMs = 250,
  ) {}

  /** 收到新状态：指纹去重 + trailing 合批。 */
  push(state: unknown): void {
    if (this.disposed) return;
    const fingerprint = JSON.stringify(state);
    if (fingerprint === this.lastFingerprint) return;
    const run = (): void => {
      this.write(state);
      this.lastFingerprint = fingerprint;
    };
    if (this.delayMs <= 0) {
      this.staged = null;
      run();
      return;
    }
    this.staged = run;
    if (this.timer !== null) return; // 已有调度在等，只刷新 staged（trailing 语义）
    this.timer = setTimeout(() => {
      this.timer = null;
      const pending = this.staged;
      this.staged = null;
      pending?.();
    }, this.delayMs);
  }

  /** 立即落盘待写状态（无待写则 no-op）；写后同指纹的变化不再重写。 */
  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const pending = this.staged;
    this.staged = null;
    pending?.();
  }

  dispose(): void {
    this.flush();
    this.disposed = true;
  }

  private disposed = false;
}
