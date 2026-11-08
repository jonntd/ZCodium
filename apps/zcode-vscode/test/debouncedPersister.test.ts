/**
 * DebouncedPersister 单测（性能审查 P1：trailing 合批 + 指纹去重 + flush 语义）。
 * 用 vi.useFakeTimers 驱动合批窗口，行为全部确定性。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DebouncedPersister } from "../src/host/pendingChanges/debouncedPersister";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("DebouncedPersister", () => {
  it("trailing 合批：持续变化期间只写最新状态", () => {
    const writes: unknown[] = [];
    const persister = new DebouncedPersister((state) => writes.push(state), 250);
    persister.push({ n: 1 });
    persister.push({ n: 2 });
    persister.push({ n: 3 });
    vi.advanceTimersByTime(249);
    expect(writes).toEqual([]); // 窗口内不写
    vi.advanceTimersByTime(1);
    expect(writes).toEqual([{ n: 3 }]); // 只写最新
  });

  it("指纹相同跳过：无实质变化不触发 write", () => {
    const writes: unknown[] = [];
    const persister = new DebouncedPersister((state) => writes.push(state), 250);
    persister.push({ a: 1 });
    vi.advanceTimersByTime(250);
    persister.push({ a: 1 }); // 同指纹
    vi.advanceTimersByTime(500);
    expect(writes).toEqual([{ a: 1 }]);
    persister.push({ a: 2 });
    vi.advanceTimersByTime(250);
    expect(writes).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("flush 立即落盘待写状态，之后同指纹不重写", () => {
    const writes: unknown[] = [];
    const persister = new DebouncedPersister((state) => writes.push(state), 250);
    persister.push({ a: 1 });
    persister.flush();
    expect(writes).toEqual([{ a: 1 }]);
    vi.advanceTimersByTime(500);
    expect(writes).toEqual([{ a: 1 }]); // 定时器已清，不二次写
    persister.push({ a: 1 }); // 同指纹不再写
    persister.flush();
    expect(writes).toEqual([{ a: 1 }]);
  });

  it("dispose flush 尾笔并停写（disposed 后 push 忽略）", () => {
    const writes: unknown[] = [];
    const persister = new DebouncedPersister((state) => writes.push(state), 250);
    persister.push({ a: 1 });
    persister.dispose();
    expect(writes).toEqual([{ a: 1 }]);
    persister.push({ a: 2 });
    vi.advanceTimersByTime(1000);
    expect(writes).toEqual([{ a: 1 }]);
  });

  it("delayMs=0 同步直写（测试确定性通道）", () => {
    const writes: unknown[] = [];
    const persister = new DebouncedPersister((state) => writes.push(state), 0);
    persister.push({ a: 1 });
    expect(writes).toEqual([{ a: 1 }]);
  });
});
