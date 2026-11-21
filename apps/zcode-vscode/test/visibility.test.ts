/**
 * 渲染可见性双源 gate（架构 §2.2；审查 medium 修复的接线语义锁定）：
 *
 * - document 隐藏 → 暂停（自证源，恒可读）；
 * - host visibility 帧 visible=false → 暂停（chatPanel onDidChangeVisibility 生产）；
 * - host 帧缺失（null）→ 按可见处理（避免初始隐藏态锁死渲染）。
 *
 * App.tsx 消费 useRenderPaused 的返回值经 content-visibility 挂起 Root 子树
 * （保持 DOM 状态，不卸载）。
 */

import { describe, expect, it, vi } from "vitest";
import { combineVisibility, subscribeRenderVisibility } from "../src/webview-react/lifecycle/visibility";

/** 内存双源（HostFrameBus 最小面 + document 桩）。 */
function makeHarness() {
  const listeners = new Map<string, Array<(payload: unknown) => void>>();
  const source = {
    on: (kind: "visibility", handler: (payload: unknown) => void) => {
      const list = listeners.get(kind) ?? [];
      list.push(handler);
      listeners.set(kind, list);
      return () => {
        listeners.set(kind, (listeners.get(kind) ?? []).filter((fn) => fn !== handler));
      };
    },
    lastPayload: () => undefined,
  };
  let hidden = false;
  let documentListener: (() => void) | undefined;
  const doc = {
    get hidden() {
      return hidden;
    },
    get visibilityState() {
      return hidden ? "hidden" : "visible";
    },
    addEventListener: (kind: string, handler: () => void) => {
      if (kind === "visibilitychange") documentListener = handler;
    },
    removeEventListener: vi.fn(),
  } as unknown as Document;

  /** 触发 host visibility 帧。 */
  const emitHostFrame = (visible: boolean): void => {
    for (const handler of listeners.get("visibility") ?? []) handler({ visible });
  };
  /** 触发 document visibilitychange。 */
  const emitDocumentChange = (nextHidden: boolean): void => {
    hidden = nextHidden;
    documentListener?.();
  };
  return { source, doc, emitHostFrame, emitDocumentChange };
}

describe("可见性双源 gate（渲染暂停）", () => {
  it("host 帧声明隐藏 → 暂停；恢复可见 → 取消暂停", () => {
    const harness = makeHarness();
    const states: boolean[] = [];
    const off = subscribeRenderVisibility(harness.source, harness.doc, (paused) =>
      states.push(paused),
    );

    harness.emitHostFrame(false);
    harness.emitHostFrame(true);

    // 初值（可见）+ 隐藏 + 恢复
    expect(states).toEqual([false, true, false]);
    off();
  });

  it("document 隐藏 → 暂停；host 帧缺失不影响（自证源兜底）", () => {
    const harness = makeHarness();
    const states: boolean[] = [];
    const off = subscribeRenderVisibility(null, harness.doc, (paused) => states.push(paused));

    harness.emitDocumentChange(true);
    harness.emitDocumentChange(false);

    expect(states).toEqual([false, true, false]);
    off();
  });

  it("combineVisibility：任一源隐藏即暂停；host 帧缺失按可见", () => {
    expect(combineVisibility(false, true)).toBe(true);
    expect(combineVisibility(false, false)).toBe(true);
    expect(combineVisibility(null, true)).toBe(true);
    expect(combineVisibility(null, false)).toBe(false);
    expect(combineVisibility(true, false)).toBe(false);
  });
});
