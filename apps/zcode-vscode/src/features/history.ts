import * as vscode from "vscode";
import { log } from "./logger";

interface SessionQuickPickItem extends vscode.QuickPickItem {
  readonly sessionId: string;
}

/** `zcodeAgentService.listSessions` 返回的本插件关心的字段（strict schema 的子集）。 */
export interface SessionSummary {
  readonly sessionId: string;
  readonly title?: string;
  readonly mode?: string;
  readonly updatedAt?: number;
}

/**
 * 历史会话选择器（M2-6c）。
 *
 * 会话由 CLI 持久化（`session/list`），插件不另存一份 —— 所以桌面端聊过的会话
 * 在这里也能看到并接续，这正是「还原 Gode 全部能力」的一部分。
 */
export async function pickSession(
  listSessions: () => Promise<readonly SessionSummary[]>,
): Promise<string | undefined> {
  let sessions;
  try {
    sessions = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: "读取历史会话…" },
      listSessions,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("history", message);
    void vscode.window.showErrorMessage(`读取历史会话失败：${message}`);
    return undefined;
  }

  if (sessions.length === 0) {
    void vscode.window.showInformationMessage("还没有历史会话。");
    return undefined;
  }

  const items: SessionQuickPickItem[] = sessions.map((session) => ({
    label: session.title?.trim() || "未命名会话",
    description: formatRelativeTime(session.updatedAt),
    detail: session.mode,
    sessionId: session.sessionId,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: "Gode 历史会话",
    placeHolder: "选择要接续的会话",
    matchOnDescription: true,
  });
  return picked?.sessionId;
}

function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return "";
  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 60_000) return "刚刚";
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)} 分钟前`;
  if (deltaMs < 86_400_000) return `${Math.floor(deltaMs / 3_600_000)} 小时前`;
  return `${Math.floor(deltaMs / 86_400_000)} 天前`;
}
