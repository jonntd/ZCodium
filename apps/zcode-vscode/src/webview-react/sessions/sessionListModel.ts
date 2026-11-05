/**
 * 会话列表投影模型（T06 webview 半；P1-1/P1-2 的纯逻辑面）。
 *
 * 数据源 = 组2 zcode-session 频道 listSessions（IZCodeSessionService，桥白名单频道），
 * 失败降级为 per-folder 最近会话 ID 列表（P1-1.1：无标题元数据，UI 不崩）。
 * 排序/键控/禁切/从列表移除均为纯函数，vitest 直测（test/sessionList.test.ts）；
 * SessionListPanel.tsx 只做装配呈现。
 */

import type { ZCodeSessionInfo } from "@zcode/shared";
import { folderKey } from "../session/workspaceSessions";

/** 列表条目（zcode-session 频道收敛投影，形状对齐组2 SessionIndexEntry 并补归属）。 */
export interface SessionListEntry {
  sessionId: string;
  title: string;
  status: string;
  mode: string;
  updatedAt: number;
  /** 归属 folder（fsPath 键控，P1-2.2 标注归属）。 */
  folder: string;
  /** 当前激活会话标记（切换入口的选中态）。 */
  active: boolean;
}

/** turn 进行中禁切（P1-1.3）：running 会话切换入口禁用 + 提示。 */
export function isSessionSwitchDisabled(turnRunning: boolean): boolean {
  return turnRunning;
}

export const SESSION_SWITCH_DISABLED_HINT = "turn 进行中，暂不可切换会话";

/** zcode-session listSessions 投影（P1-1.1：按最近活动排序 + 归属标注 + 选中态）。 */
export function projectSessionEntries(
  infos: readonly ZCodeSessionInfo[],
  folder: string,
  activeSessionId: string | null | undefined,
): SessionListEntry[] {
  const normalizedFolder = folderKey(folder);
  return infos
    .map((info) => ({
      sessionId: info.sessionId,
      title: info.title,
      status: info.status,
      mode: info.mode,
      updatedAt: info.updatedAt,
      folder: normalizedFolder,
      active: info.sessionId === activeSessionId,
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

/**
 * 失败降级（P1-1.1）：频道不可用时以 per-folder 最近会话 ID 拼 ID 列表
 * （无标题元数据，UI 不崩；归属标注保留）。
 */
export function degradeToLatestIdEntries(
  latestSessionIdByFolder: Readonly<Record<string, string | undefined>>,
  activeSessionId: string | null | undefined,
): SessionListEntry[] {
  return Object.entries(latestSessionIdByFolder)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1])
    .map(([folder, sessionId]) => ({
      sessionId,
      title: sessionId,
      status: "unknown",
      mode: "unknown",
      updatedAt: 0,
      folder: folderKey(folder),
      active: sessionId === activeSessionId,
    }))
    .sort((left, right) => left.folder.localeCompare(right.folder));
}

/**
 * 「删除」= 本地列表立即移除目标条目（真删除本体由 App 走 v4 deleteSession 命令面：
 * P1-1.4，CLI 拒绝时降级为仅从列表移除并在面板呈现原因）。纯集合操作：
 * 移除目标会话条目，其余保持序。
 */
export function removeSessionFromList(
  entries: readonly SessionListEntry[],
  sessionId: string,
): SessionListEntry[] {
  return entries.filter((entry) => entry.sessionId !== sessionId);
}

/** 状态徽标文案（P1-1.1 状态列；未知降级原样展示）。 */
export function sessionStatusLabel(status: string): string {
  switch (status) {
    case "running":
      return "运行中";
    case "waiting":
      return "等待输入";
    case "paused":
      return "已暂停";
    case "completed":
      return "已完成";
    case "error":
      return "出错";
    case "idle":
      return "空闲";
    default:
      return status;
  }
}
