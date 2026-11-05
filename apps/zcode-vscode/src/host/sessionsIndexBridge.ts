/**
 * SessionsIndexBridge — per-folder 会话索引聚合 host 半（T06/T09；P1-1.5/P1-2）。
 *
 * - 会话列表复用白名单内的 zcode-session 频道（listSessions）；host 侧聚合为
 *   per-folder 索引快照（命令/诊断面消费），会话活性行帧仍归 zcode-agent 的
 *   sessions-index 通道，本桥不复制帧流。
 * - 最近会话键控复用 workspaceSessions（ExtensionStore per-folder 键空间，只读语义）。
 * - pickWorkspaceFolder：多根 QuickPick（P1-2 host 半）；QuickPick 以接口注入，
 *   本模块不 import vscode（container 注入 window.showQuickPick）。
 *
 * 纯层（无 vscode import）：vitest 以内存 fake 直测。
 */

import type { IZCodeSessionService } from "@zcode/services";
import type { ZCodeSessionInfo } from "@zcode/shared";
import { folderKey, type WorkspaceSessions } from "../webview-react/session/workspaceSessions";

/** 会话索引条目（zcode-session 频道 listSessions 的收敛投影）。 */
export interface SessionIndexEntry {
  sessionId: string;
  title: string;
  status: string;
  mode: string;
  updatedAt: number;
}

/** 单 folder 会话索引（列表失败降级为 sessions=undefined，不整批失败）。 */
export interface FolderSessionsIndex {
  folder: string;
  /** ExtensionStore 键控的最近活跃会话（P1-1.5）。 */
  latestSessionId: string | undefined;
  /** zcode-session 频道 listSessions 投影；频道不可用时 undefined。 */
  sessions: SessionIndexEntry[] | undefined;
  error?: string;
}

/** 多根 QuickPick 注入口（container 注入 window.showQuickPick 适配）。 */
export type PickFolderPort = (
  folders: string[],
) => Promise<string | null | undefined> | string | null | undefined;

export interface SessionsIndexBridgeOptions {
  sessionService: Pick<IZCodeSessionService, "listSessions">;
  workspaceSessions: WorkspaceSessions;
  /** 当前 workspace folders（vscode 注入）。 */
  listFolders: () => string[];
  /** 多根 QuickPick 实现（返回 null/undefined 表示取消）。 */
  pickFolder: PickFolderPort;
  log?: (message: string) => void;
  /** 单 folder 时跳过 QuickPick（P1-2：只有多根才需要选择）。默认 true。 */
  skipPickWhenSingleFolder?: boolean;
}

export class SessionsIndexBridge {
  constructor(private readonly options: SessionsIndexBridgeOptions) {}

  /**
   * per-folder 会话索引聚合：逐 folder 调白名单内 zcode-session 频道；
   * 单 folder 失败降级为 sessions=undefined + error（最近会话键控面独立，不整批失败）。
   */
  async aggregate(limit = 50): Promise<FolderSessionsIndex[]> {
    const folders = this.currentFolders();
    return Promise.all(
      folders.map(async (folder): Promise<FolderSessionsIndex> => {
        const latestSessionId = this.options.workspaceSessions.get(folder);
        try {
          const infos = await this.options.sessionService.listSessions({
            workspacePath: folder,
            limit,
          });
          return { folder, latestSessionId, sessions: infos.map(toIndexEntry) };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.options.log?.(
            `[sessions-index] ${folder} 会话列表失败（降级为最近会话条目）：${message}`,
          );
          return { folder, latestSessionId, sessions: undefined, error: message };
        }
      }),
    );
  }

  /**
   * 多根 QuickPick（P1-2 host 半）：单 folder 直接命中，多根走注入的 QuickPick，
   * 取消/无 folder 返回 null。
   */
  async pickWorkspaceFolder(): Promise<string | null> {
    const folders = this.currentFolders();
    if (folders.length === 0) return null;
    if (folders.length === 1 && this.options.skipPickWhenSingleFolder !== false) {
      return folders[0] ?? null;
    }
    const picked = await this.options.pickFolder(folders);
    return typeof picked === "string" && picked ? folderKey(picked) : null;
  }

  private currentFolders(): string[] {
    return this.options.listFolders().map(folderKey);
  }
}

function toIndexEntry(info: ZCodeSessionInfo): SessionIndexEntry {
  return {
    sessionId: info.sessionId,
    title: info.title,
    status: info.status,
    mode: info.mode,
    updatedAt: info.updatedAt,
  };
}
