/**
 * workspace → 会话归属（T05；P1-2 每 folder 独立会话的键控基础）。
 *
 * 纯模块：folder 键控的会话索引读写，持久化归 ExtensionStore（globalState）。
 */

export interface WorkspaceSessions {
  /** folder fsPath → 最近活跃会话 ID。 */
  get(folder: string): string | undefined;
  set(folder: string, sessionId: string | undefined): void;
}

/** 基于 ExtensionStore（SessionIdStore）的实现：per-folder 最近会话（P1-1.5 / P1-2.4）。 */
export function createWorkspaceSessions(store: {
  getSessionId(workspaceKey: string): string | undefined;
  setSessionId(workspaceKey: string, id: string | undefined): void;
}): WorkspaceSessions {
  return {
    get: (folder) => store.getSessionId(folder),
    set: (folder, sessionId) => store.setSessionId(folder, sessionId),
  };
}

/** workspaceKey 归一化：多根工作区以 fsPath 为键（Windows 大小写不敏感场景按原样保留）。 */
export function folderKey(fsPath: string): string {
  return fsPath.trim();
}
