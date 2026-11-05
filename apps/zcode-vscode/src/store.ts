/**
 * ExtensionStore（架构：globalState/workspaceState，只存会话 ID 与 UI 偏好）。
 *
 * 会话 ID 按 workspace folder 键控存 globalState（跨窗口可恢复）；
 * 除会话 ID 与 reasoning 显示开关外不持久化任何业务数据（架构 §7.6）。
 */

import type { ExtensionContext, Memento } from "vscode";

const SESSION_ID_PREFIX = "zcodium.sessionId.";

/** 会话 ID 存储接口（测试用内存实现替换）。 */
export interface SessionIdStore {
  getSessionId(workspaceKey: string): string | undefined;
  setSessionId(workspaceKey: string, id: string | undefined): void;
}

export class ExtensionStore implements SessionIdStore {
  constructor(private readonly globalState: Memento) {}

  static fromContext(context: ExtensionContext): ExtensionStore {
    return new ExtensionStore(context.globalState);
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
}
