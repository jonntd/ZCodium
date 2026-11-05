/**
 * T06 会话列表 webview 半测试（P1-1/P1-2 纯逻辑面）。
 *
 * 锁定：键控（folderKey per-folder 键空间）/ 禁切（turn 进行中）/ 从列表移除
 * （PRD 降级口径）/ 多根 QuickPick（组2 pickWorkspaceFolder plat mock）/
 * zcode-session 频道收敛投影与失败降级 ID 列表。
 */

import { describe, expect, it } from "vitest";
import type { ZCodeSessionInfo } from "@zcode/shared";
import { createWorkspaceSessions, folderKey } from "../src/webview-react/session/workspaceSessions";
import {
  SESSION_SWITCH_DISABLED_HINT,
  degradeToLatestIdEntries,
  isSessionSwitchDisabled,
  projectSessionEntries,
  removeSessionFromList,
  sessionStatusLabel,
} from "../src/webview-react/sessions/sessionListModel";
import {
  folderLabel,
  isMultiRootWorkspace,
  selectWorkspaceFolder,
  singleFolderOrNull,
  type FolderPickerPort,
} from "../src/webview-react/sessions/folderSelector";
import { SessionListPanel } from "../src/webview-react/sessions/SessionListPanel";

/** 合法 ZCodeSessionInfo fixture（zcodeSessionInfoSchema 形状）。 */
function makeSessionInfo(overrides: Partial<ZCodeSessionInfo> & { sessionId: string }): ZCodeSessionInfo {
  return {
    workspace: { workspacePath: "/repo-a", workspaceKey: "/repo-a" },
    sessionKind: "interactive",
    title: overrides.sessionId,
    mode: "build",
    status: "idle",
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  } as ZCodeSessionInfo;
}

describe("键控：folderKey per-folder 键空间（P1-1.5/P1-2.4）", () => {
  it("folderKey 归一化（trim；多根以 fsPath 为键）", () => {
    expect(folderKey("/repo-a")).toBe("/repo-a");
    expect(folderKey(" /repo-a ")).toBe("/repo-a");
    expect(folderKey("/repo-a")).not.toBe(folderKey("/repo-b"));
  });

  it("WorkspaceSessions 经 SessionIdStore 写穿透（键控读写与清除）", () => {
    const ids = new Map<string, string | undefined>();
    const sessions = createWorkspaceSessions({
      getSessionId: (key) => ids.get(key),
      setSessionId: (key, id) => {
        if (id === undefined) ids.delete(key);
        else ids.set(key, id);
      },
    });
    sessions.set("/repo-a", "s-1");
    sessions.set("/repo-b", "s-2");
    expect(sessions.get("/repo-a")).toBe("s-1");
    expect(sessions.get("/repo-b")).toBe("s-2");
    // notifySessionDeleted 写回路径：清键后回落草稿。
    sessions.set("/repo-a", undefined);
    expect(sessions.get("/repo-a")).toBeUndefined();
    expect(sessions.get("/repo-b")).toBe("s-2");
  });
});

describe("禁切：turn 进行中（P1-1.3）", () => {
  it("isSessionSwitchDisabled：running=true 禁用；false/空列表放行", () => {
    expect(isSessionSwitchDisabled(true)).toBe(true);
    expect(isSessionSwitchDisabled(false)).toBe(false);
    expect(SESSION_SWITCH_DISABLED_HINT).toContain("turn 进行中");
  });

  it("listSessions 活跃会话 status=running → 面板推导禁切（面板 prop 契约）", () => {
    const entries = projectSessionEntries(
      [
        makeSessionInfo({ sessionId: "s-1", status: "running", updatedAt: 3_000 }),
        makeSessionInfo({ sessionId: "s-2", status: "idle", updatedAt: 2_000 }),
      ],
      "/repo-a",
      "s-1",
    );
    const derived = entries.some((e) => e.sessionId === "s-1" && e.status === "running");
    expect(isSessionSwitchDisabled(derived)).toBe(true);
  });
});

describe("zcode-session 频道收敛投影（P1-1.1/P1-2.2）", () => {
  it("按最近活动降序排序 + 归属标注 + 选中态", () => {
    const entries = projectSessionEntries(
      [
        makeSessionInfo({ sessionId: "s-old", title: "旧会话", status: "completed", updatedAt: 1_000 }),
        makeSessionInfo({ sessionId: "s-new", title: "新会话", status: "running", updatedAt: 9_000 }),
      ],
      "/repo-a",
      "s-old",
    );
    expect(entries.map((e) => e.sessionId)).toEqual(["s-new", "s-old"]);
    expect(entries.every((e) => e.folder === "/repo-a")).toBe(true);
    expect(entries.find((e) => e.sessionId === "s-old")?.active).toBe(true);
    expect(entries.find((e) => e.sessionId === "s-new")?.active).toBe(false);
  });

  it("失败降级：per-folder 最近会话 ID 列表（无标题元数据，UI 不崩）", () => {
    const entries = degradeToLatestIdEntries(
      { "/repo-b": "s-2", "/repo-a": "s-1" },
      "s-2",
    );
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.folder)).toEqual(["/repo-a", "/repo-b"]);
    expect(entries.find((e) => e.sessionId === "s-1")?.status).toBe("unknown");
    expect(entries.find((e) => e.sessionId === "s-2")?.active).toBe(true);
  });

  it("sessionStatusLabel 映射覆盖 zcodeSessionStatus 词表，未知原样展示", () => {
    expect(sessionStatusLabel("running")).toBe("运行中");
    expect(sessionStatusLabel("waiting")).toBe("等待输入");
    expect(sessionStatusLabel("completed")).toBe("已完成");
    expect(sessionStatusLabel("error")).toBe("出错");
    expect(sessionStatusLabel("mystery")).toBe("mystery");
  });
});

describe("从列表移除（真删除经 v4 deleteSession 命令面，App 接线；被拒时降级仅列表移除）", () => {
  it("removeSessionFromList 只移除目标，其余保持序", () => {
    const entries = [
      { sessionId: "s-1", title: "a", status: "idle", mode: "build", updatedAt: 1, folder: "/r", active: false },
      { sessionId: "s-2", title: "b", status: "idle", mode: "build", updatedAt: 2, folder: "/r", active: true },
      { sessionId: "s-3", title: "c", status: "idle", mode: "build", updatedAt: 3, folder: "/r", active: false },
    ];
    const next = removeSessionFromList(entries, "s-2");
    expect(next.map((e) => e.sessionId)).toEqual(["s-1", "s-3"]);
    // 移除目标不存在时原样返回（幂等）。
    expect(removeSessionFromList(next, "s-2")).toHaveLength(2);
  });

  it("面板组件面：onRemove/onSwitch/turnRunning props 契约可静态断言（不渲染 DOM）", () => {
    // SessionListPanel 的契约由组件 props 类型锁定：onRemove 移除条目、
    // turnRunning 缺省由 listSessions 状态推导（面板内部轮询保鲜）。
    const sample: Partial<Parameters<typeof SessionListPanel>[0]> = {
      folders: ["/repo-a"],
      sessionId: "s-1",
      turnRunning: true,
      onSwitch: () => {},
      onRemove: () => {},
    };
    expect(sample.onRemove).toBeTypeOf("function");
    expect(sample.turnRunning).toBe(true);
    expect(SessionListPanel).toBeTypeOf("function");
  });
});

describe("多根 QuickPick：组2 pickWorkspaceFolder plat mock（P1-2）", () => {
  it("单根直接命中，不经 plat RPC（跳过 QuickPick）", async () => {
    const plat: FolderPickerPort = {
      pickWorkspaceFolder: () => {
        throw new Error("单根不应触发 plat QuickPick");
      },
    };
    await expect(selectWorkspaceFolder(plat, ["/repo-a"])).resolves.toBe("/repo-a");
    expect(singleFolderOrNull(["/repo-a"])).toBe("/repo-a");
  });

  it("多根走组2 plat 方法并透传结果；取消（null/undefined）返回 null", async () => {
    const calls: number[] = [];
    const plat: FolderPickerPort = {
      pickWorkspaceFolder: () => {
        calls.push(calls.length);
        return Promise.resolve("/repo-b");
      },
    };
    await expect(selectWorkspaceFolder(plat, ["/repo-a", "/repo-b"])).resolves.toBe("/repo-b");
    expect(calls).toHaveLength(1);
    const cancelled: FolderPickerPort = { pickWorkspaceFolder: () => Promise.resolve(null) };
    await expect(selectWorkspaceFolder(cancelled, ["/repo-a", "/repo-b"])).resolves.toBeNull();
    const undefinedPick: FolderPickerPort = {
      pickWorkspaceFolder: () => Promise.resolve(undefined as unknown as string | null),
    };
    await expect(
      selectWorkspaceFolder(undefinedPick, ["/repo-a", "/repo-b"]),
    ).resolves.toBeNull();
  });

  it("plat 面缺失：明确降级 null（不猜语义、不本地弹 UI）", async () => {
    await expect(selectWorkspaceFolder({}, ["/repo-a", "/repo-b"])).resolves.toBeNull();
  });

  it("多根判定与 folder 展示名（P1-2.1 单根隐藏入口）", () => {
    expect(isMultiRootWorkspace(["/a"])).toBe(false);
    expect(isMultiRootWorkspace(["/a", "/b"])).toBe(true);
    expect(folderLabel("/Users/dev/repo-a")).toBe("repo-a");
    expect(folderLabel("C:\\dev\\repo-b")).toBe("repo-b");
    expect(folderLabel("/")).toBe("/");
  });
});
