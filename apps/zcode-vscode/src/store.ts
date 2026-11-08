/**
 * ExtensionStore（架构：globalState/workspaceState，只存会话 ID 与 UI 偏好）。
 *
 * 会话 ID 按 workspace folder 键控存 globalState（跨窗口可恢复）；
 * 除会话 ID 与 reasoning 显示开关外不持久化任何业务数据（架构 §7.6）。
 */

import type { ExtensionContext, Memento } from "vscode";
import { randomUUID } from "node:crypto";
import type { PersistedChanges } from "./host/pendingChanges/changesService";

const SESSION_ID_PREFIX = "gode.sessionId.";
const CHANGES_CLIENT_ID_KEY = "gode.pendingChanges.clientId";
const PENDING_CHANGES_KEY = "gode.pendingChanges.v1";

/** 会话 ID 存储接口（测试用内存实现替换）。 */
export interface SessionIdStore {
  getSessionId(workspaceKey: string): string | undefined;
  setSessionId(workspaceKey: string, id: string | undefined): void;
}

export class ExtensionStore implements SessionIdStore {
  constructor(
    private readonly globalState: Memento,
    /** pendingChanges/clientId 面（spec §8：workspaceState，per-window 生命周期）。 */
    private readonly workspaceState?: Memento,
  ) {}

  static fromContext(context: ExtensionContext): ExtensionStore {
    return new ExtensionStore(context.globalState, context.workspaceState);
  }

  getSessionId(workspaceKey: string): string | undefined {
    return this.globalState.get<string>(SESSION_ID_PREFIX + workspaceKey);
  }

  setSessionId(workspaceKey: string, id: string | undefined): void {
    void this.globalState.update(SESSION_ID_PREFIX + workspaceKey, id);
  }

  /**
   * sessionId → 持有它的 folder 键集合（notifySessionDeleted 反查用）。
   * 只遍历本前缀键空间（per-folder 键槽，见文件头），不做全局扫描。
   */
  findFoldersBySessionId(sessionId: string): string[] {
    const prefix = SESSION_ID_PREFIX;
    return this.globalState
      .keys()
      .filter((key) => key.startsWith(prefix) && this.globalState.get<string>(key) === sessionId)
      .map((key) => key.slice(prefix.length));
  }

  /**
   * 宿主自持的 v4 clientId（applyFileRewind 信封；服务端幂等表按提交端区分）。
   * 惰性生成并持久化，进程重启不变。
   */
  getChangesClientId(): string {
    if (!this.workspaceState) return `host-${randomUUID()}`;
    const existing = this.workspaceState.get<string>(CHANGES_CLIENT_ID_KEY);
    if (existing) return existing;
    const created = `host-${randomUUID()}`;
    void this.workspaceState.update(CHANGES_CLIENT_ID_KEY, created);
    return created;
  }

  getPendingChanges(): PersistedChanges | undefined {
    const state = this.workspaceState?.get<PersistedChanges | undefined>(PENDING_CHANGES_KEY);
    if (!state || (!Array.isArray(state.pending) && !Array.isArray(state.history))) return undefined;
    return {
      pending: Array.isArray(state.pending) ? state.pending : [],
      history: Array.isArray(state.history) ? state.history : [],
    };
  }

  setPendingChanges(state: PersistedChanges): void {
    void this.workspaceState?.update(PENDING_CHANGES_KEY, state);
  }
}
