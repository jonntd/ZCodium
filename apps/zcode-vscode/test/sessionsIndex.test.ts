/**
 * T06/T09 host 半：SessionsIndexBridge（per-folder 会话索引聚合 + 多根 QuickPick）。
 *
 * - 聚合复用白名单内 zcode-session 频道（listSessions），逐 folder 降级不整批失败；
 * - 最近会话键控复用 workspaceSessions（ExtensionStore per-folder 键空间，只读语义）；
 * - pickWorkspaceFolder：单 folder 直接命中 / 多根走注入 QuickPick / 取消返回 null。
 *
 * 纯层测试：SessionsIndexBridge 不 import vscode（QuickPick 以接口注入）。
 */

import { describe, expect, it } from "vitest";
import {
  SessionsIndexBridge,
  type FolderSessionsIndex,
  type SessionIndexEntry,
} from "../src/host/sessionsIndexBridge";
import { createWorkspaceSessions } from "../src/webview-react/session/workspaceSessions";
import type { ZCodeSessionInfo } from "@zcode/shared";

/** 内存 per-folder 会话键空间（与 ExtensionStore 同形）。 */
function memoryWorkspaceSessions() {
  const ids = new Map<string, string | undefined>();
  return {
    sessions: createWorkspaceSessions({
      getSessionId: (key) => ids.get(key),
      setSessionId: (key, id) => {
        if (id === undefined) ids.delete(key);
        else ids.set(key, id);
      },
    }),
    ids,
  };
}

function sessionInfo(overrides: Partial<ZCodeSessionInfo> & { sessionId: string }): ZCodeSessionInfo {
  return {
    workspace: { path: "/repo" },
    sessionKind: "chat",
    title: `标题 ${overrides.sessionId}`,
    mode: "build",
    status: "idle",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  } as ZCodeSessionInfo;
}

interface Fixture {
  bridge: SessionsIndexBridge;
  ids: Map<string, string | undefined>;
  listSessionsCalls: Array<{ workspacePath: string; limit?: number }>;
  setListSessions(impl: (params: { workspacePath: string; limit?: number }) => Promise<ZCodeSessionInfo[]>): void;
}

function makeFixture(options?: {
  folders?: string[];
  pick?: (folders: string[]) => Promise<string | null | undefined> | string | null | undefined;
  skipPickWhenSingleFolder?: boolean;
}): Fixture {
  const { sessions, ids } = memoryWorkspaceSessions();
  const listSessionsCalls: Array<{ workspacePath: string; limit?: number }> = [];
  let listSessionsImpl: (params: {
    workspacePath: string;
    limit?: number;
  }) => Promise<ZCodeSessionInfo[]> = async () => [sessionInfo({ sessionId: "s-1" })];
  const bridge = new SessionsIndexBridge({
    sessionService: {
      // 调用记录在分发层：setListSessions 只换实现，不丢记录。
      listSessions: (params) => {
        listSessionsCalls.push(params);
        return listSessionsImpl(params);
      },
    },
    workspaceSessions: sessions,
    listFolders: () => options?.folders ?? [],
    pickFolder: options?.pick ?? (() => null),
    ...(options?.skipPickWhenSingleFolder === undefined
      ? {}
      : { skipPickWhenSingleFolder: options.skipPickWhenSingleFolder }),
  });
  return {
    bridge,
    ids,
    listSessionsCalls,
    setListSessions(impl) {
      listSessionsImpl = impl;
    },
  };
}

describe("per-folder 会话索引聚合（zcode-session 频道复用）", () => {
  it("逐 folder 调 listSessions 并收敛为索引条目 + 最近会话键", async () => {
    const fixture = makeFixture({ folders: ["/repo-a", "/repo-b"] });
    fixture.ids.set("/repo-a", "s-latest");
    fixture.setListSessions(async ({ workspacePath, limit }) => {
      expect(limit).toBe(50);
      return workspacePath === "/repo-a"
        ? [sessionInfo({ sessionId: "s-1", status: "idle" }), sessionInfo({ sessionId: "s-2", status: "running" })]
        : [sessionInfo({ sessionId: "s-3", mode: "plan" })];
    });
    const index = await fixture.bridge.aggregate();
    expect(fixture.listSessionsCalls.map((c) => c.workspacePath)).toEqual(["/repo-a", "/repo-b"]);
    const a = index.find((f) => f.folder === "/repo-a") as FolderSessionsIndex;
    const b = index.find((f) => f.folder === "/repo-b") as FolderSessionsIndex;
    expect(a.latestSessionId).toBe("s-latest");
    expect(a.sessions?.map((s) => s.sessionId)).toEqual(["s-1", "s-2"]);
    expect(a.error).toBeUndefined();
    expect(b.sessions?.[0]).toMatchObject<Partial<SessionIndexEntry>>({
      sessionId: "s-3",
      mode: "plan",
    });
  });

  it("单 folder listSessions 失败降级为 sessions=undefined（不整批失败，键控面独立）", async () => {
    const fixture = makeFixture({ folders: ["/repo-a", "/repo-b"] });
    fixture.setListSessions(async ({ workspacePath }) => {
      if (workspacePath === "/repo-a") throw new Error("channel unavailable");
      return [sessionInfo({ sessionId: "s-3" })];
    });
    const index = await fixture.bridge.aggregate();
    const a = index.find((f) => f.folder === "/repo-a") as FolderSessionsIndex;
    const b = index.find((f) => f.folder === "/repo-b") as FolderSessionsIndex;
    expect(a.sessions).toBeUndefined();
    expect(a.error).toContain("channel unavailable");
    expect(b.sessions).toHaveLength(1);
  });
});

describe("多根 QuickPick（P1-2 host 半）", () => {
  it("单 folder 直接命中（不弹 QuickPick）", async () => {
    const fixture = makeFixture({
      folders: ["/only"],
      pick: () => {
        throw new Error("单 folder 不应弹 QuickPick");
      },
    });
    await expect(fixture.bridge.pickWorkspaceFolder()).resolves.toBe("/only");
  });

  it("多根走注入的 QuickPick；取消返回 null；无 folder 返回 null", async () => {
    const picked: string[][] = [];
    const fixture = makeFixture({
      folders: ["/a", "/b"],
      pick: (folders) => {
        picked.push(folders);
        return folders[1] ?? null;
      },
    });
    await expect(fixture.bridge.pickWorkspaceFolder()).resolves.toBe("/b");
    expect(picked).toEqual([["/a", "/b"]]);

    const cancelFixture = makeFixture({ folders: ["/a", "/b"], pick: () => null });
    await expect(cancelFixture.bridge.pickWorkspaceFolder()).resolves.toBeNull();

    const emptyFixture = makeFixture({ folders: [] });
    await expect(emptyFixture.bridge.pickWorkspaceFolder()).resolves.toBeNull();
  });

  it("skipPickWhenSingleFolder=false 时单 folder 也走 QuickPick", async () => {
    const fixture = makeFixture({
      folders: ["/only"],
      pick: (folders) => folders[0] ?? null,
      skipPickWhenSingleFolder: false,
    });
    await expect(fixture.bridge.pickWorkspaceFolder()).resolves.toBe("/only");
  });
});
