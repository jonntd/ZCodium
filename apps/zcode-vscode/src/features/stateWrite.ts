/**
 * Memento 写入的安静收口（globalState / workspaceState）。
 *
 * 为什么需要这一层：`void state.update(key, value)` 看起来是"发了就不管"，但
 * `update` 返回的是 **Thenable，失败会 reject**（存储配额、磁盘异常、扩展正在
 * 卸载）。`void` 只丢弃返回值，**不会**接住拒绝——那就是一条未捕获的 Promise 拒绝，
 * VS Code 会弹「Unhandled promise rejection」，而这类写入本身完全可以降级（下次再写）。
 *
 * 同类缺陷两次踩过：`executeCommand` 未接住拒绝 = IDE 红条（chatFullscreen），
 * 这里的 4 处 `void state.update(...)` 是同一族。统一走本函数：
 * 同步抛（已 dispose 的 Memento）与异步拒绝都在这里被接住并汇报，调用方不感知。
 */

/** 只依赖 update 的最小面（便于测试与宿主注入，不 import vscode）。 */
export interface StateWriteTarget {
  update(key: string, value: unknown): unknown;
}

/**
 * 写入并接住所有失败。
 *
 * @param state   目标 Memento（globalState / workspaceState）
 * @param key     存储键
 * @param value   存储值
 * @param onError 失败汇报面（通常是输出通道日志）；它自身抛异常也不会外泄
 */
export function writeStateQuietly(
  state: StateWriteTarget,
  key: string,
  value: unknown,
  onError?: (message: string) => void,
): void {
  const report = (error: unknown): void => {
    if (!onError) return;
    const detail = error instanceof Error ? error.message : String(error);
    try {
      onError(`[persist] ${key} 写入失败（下次写入会重试）：${detail}`);
    } catch {
      // 日志面自身异常（通道已 dispose）不能反过来影响调用方。
    }
  };
  try {
    // Thenable 未必是原生 Promise：包一层 Promise.resolve 后 `then(undefined, ...)`
    // 才可靠地挂在拒绝上（直接 .then 可能拿到不兼容的 thenable 实现）。
    void Promise.resolve(state.update(key, value)).then(undefined, report);
  } catch (error) {
    // 同步抛：Memento 已随扩展卸载而失效，同样只记一条，不让调用方崩。
    report(error);
  }
}
