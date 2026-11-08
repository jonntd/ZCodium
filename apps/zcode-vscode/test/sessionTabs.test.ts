/** 会话标签栏状态机单测：拖拽重排、锁定、关闭、持久化容错。 */
import { describe, expect, it } from "vitest";
import {
  bindActiveSession,
  canCloseSessionTab,
  closeSessionTab,
  createSessionTab,
  normalizeSessionTabs,
  parseStoredSessionTabs,
  reorderSessionTabs,
  toggleSessionTabPinned,
  type SessionTab,
} from "../src/webview-react/sessionTabs";

function tabs(...ids: string[]): SessionTab[] {
  return ids.map((id, index) => ({
    id,
    title: `会话 ${index + 1}`,
    sessionId: `session-${index + 1}`,
    pinned: false,
  }));
}

describe("reorderSessionTabs（可随意挪动）", () => {
  it("把标签从中间拖到最前", () => {
    const next = reorderSessionTabs(tabs("a", "b", "c"), "c", "a");
    expect(next.map((tab) => tab.id)).toEqual(["c", "a", "b"]);
  });

  it("把标签拖到末尾", () => {
    const next = reorderSessionTabs(tabs("a", "b", "c"), "a", "c");
    expect(next.map((tab) => tab.id)).toEqual(["b", "c", "a"]);
  });

  it("源或落点为锁定标签时不动，且不改变原数组引用", () => {
    const base = tabs("a", "b", "c");
    const pinned: SessionTab[] = [{ ...base[0]!, pinned: true }, base[1]!, base[2]!];
    expect(reorderSessionTabs(pinned, "a", "c")).toBe(pinned);
    expect(reorderSessionTabs(pinned, "b", "a")).toBe(pinned);
  });

  it("拖到自身、未知 id 均不动", () => {
    const base = tabs("a", "b");
    expect(reorderSessionTabs(base, "a", "a")).toBe(base);
    expect(reorderSessionTabs(base, "x", "a")).toBe(base);
  });

  it("锁定标签恒在最前，重排只影响可移动区间", () => {
    const base = tabs("a", "b", "c", "d");
    const pinned: SessionTab[] = [
      { ...base[2]!, pinned: true },
      base[0]!,
      base[1]!,
      base[3]!,
    ];
    const next = reorderSessionTabs(pinned, "d", "a");
    expect(next.map((tab) => tab.id)).toEqual(["c", "d", "a", "b"]);
  });
});

describe("锁定 / 关闭", () => {
  it("切换锁定后归位到最前，取消锁定回到可移动区", () => {
    const base = tabs("a", "b", "c");
    const pinned = toggleSessionTabPinned(base, "c");
    expect(pinned.map((tab) => tab.id)).toEqual(["c", "a", "b"]);
    expect(pinned[0]!.pinned).toBe(true);
    const unpinned = toggleSessionTabPinned(pinned, "c");
    expect(unpinned[0]!.pinned).toBe(false);
    expect(unpinned.map((tab) => tab.id)).toEqual(["c", "a", "b"]);
  });

  it("锁定标签不可关闭，未锁定可关闭并给出相邻激活项", () => {
    const base = tabs("a", "b", "c");
    expect(canCloseSessionTab({ ...base[0]!, pinned: true })).toBe(false);
    const locked: SessionTab[] = [{ ...base[1]!, pinned: true }, base[0]!, base[2]!];
    expect(closeSessionTab(locked, "b").tabs).toHaveLength(3);
    const closed = closeSessionTab(base, "b");
    expect(closed.tabs.map((tab) => tab.id)).toEqual(["a", "c"]);
    expect(closed.nextActiveId).toBe("c");
  });

  it("关闭最后一个标签时回退到左邻", () => {
    const closed = closeSessionTab(tabs("a", "b", "c"), "c");
    expect(closed.nextActiveId).toBe("b");
  });
});

describe("会话绑定与持久化", () => {
  it("activeTaskId 变化把当前标签绑到会话，无变化返回原引用", () => {
    const base = tabs("a", "b");
    const draft: SessionTab[] = [{ ...base[0]!, sessionId: null }, base[1]!];
    const bound = bindActiveSession(draft, "a", "session-new");
    expect(bound[0]!.sessionId).toBe("session-new");
    expect(bindActiveSession(bound, "a", "session-new")).toBe(bound);
  });

  it("脏数据 / 非法 JSON 不抛错，锁定项归位", () => {
    expect(parseStoredSessionTabs("not-json")).toEqual([]);
    expect(parseStoredSessionTabs("null")).toEqual([]);
    const stored = parseStoredSessionTabs(
      JSON.stringify([
        { id: "x", title: "X", sessionId: "s-x", pinned: false },
        { id: "y", title: "Y", sessionId: "s-y", pinned: true },
        { nonsense: true },
      ]),
    );
    expect(stored.map((tab) => tab.id)).toEqual(["y", "x"]);
    expect(normalizeSessionTabs(stored)[0]!.pinned).toBe(true);
  });

  it("createSessionTab 生成草稿标签且 id 唯一", () => {
    const a = createSessionTab();
    const b = createSessionTab();
    expect(a.sessionId).toBeNull();
    expect(a.pinned).toBe(false);
    expect(a.id).not.toBe(b.id);
  });
});
