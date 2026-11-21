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

  // 双层合批契约（container.ts dispose 顺序，审查 medium 修复）：ChangesService
  // 内层 persister 推给外层、外层写 store。必须先 dispose 内层（尾笔推进外层）
  // 再 dispose 外层（flush + 落闸），尾笔才同步落盘，不依赖 250ms 定时器。
  it("双层合批：先 dispose 内层再 dispose 外层，尾笔同步落盘", () => {
    const storeWrites: unknown[] = [];
    const outer = new DebouncedPersister((state) => storeWrites.push(state), 250);
    const inner = new DebouncedPersister((state) => outer.push(state), 250);

    inner.push({ v: 1 });
    vi.advanceTimersByTime(250); // 内层窗口到期 → 推进外层（staged，未落盘）
    expect(storeWrites).toEqual([]);
    inner.push({ v: 2 }); // dispose 前的最后一笔（内层 staged）

    inner.dispose(); // 内层 flush：尾笔推进外层
    outer.dispose(); // 外层 flush + 落闸：trailing 只写最新
    expect(storeWrites).toEqual([{ v: 2 }]);
    vi.advanceTimersByTime(1000);
    expect(storeWrites).toEqual([{ v: 2 }]);
  });

  // 历史缺陷存档（防回归）：先 flush 外层再 dispose 内层——外层 flush 只写得出
  // 内层此前已推来的笔，内层 dispose→flush 的尾笔经外层 push 重新进入 250ms
  // trailing 调度（外层只 flush 未 dispose），窗口关闭进程退出时 timer 未触发即丢。
  it("历史缺陷存档：先 flush 外层再 dispose 内层，尾笔只能等定时器", () => {
    const storeWrites: unknown[] = [];
    const outer = new DebouncedPersister((state) => storeWrites.push(state), 250);
    const inner = new DebouncedPersister((state) => outer.push(state), 250);

    inner.push({ v: 1 });
    vi.advanceTimersByTime(250);
    inner.push({ v: 2 });

    outer.flush();
    inner.dispose();
    // 尾笔此刻未落盘——只能等 250ms 定时器（进程退出即丢）；外层 dispose 后才收敛
    expect(storeWrites).toEqual([{ v: 1 }]);
    outer.dispose();
    expect(storeWrites).toEqual([{ v: 1 }, { v: 2 }]);
  });
});
