/**
 * Memento 写入收口（writeStateQuietly）的行为契约。
 *
 * 缺陷背景：`void state.update(...)` 只丢返回值、**不接住拒绝**，失败时就是一条
 * 未捕获的 Promise 拒绝（VS Code 通知区报 Unhandled promise rejection），而这类
 * 写入本可以降级。4 处调用（会话标签、侧栏偏好、上手卡标记、设备 id）此前都是这个写法。
 */
import { describe, expect, it, vi } from "vitest";

import { writeStateQuietly } from "../src/features/stateWrite";

function makeState(update: (key: string, value: unknown) => unknown) {
  return { update: vi.fn(update) };
}

/** 让已排队的微任务跑完（拒绝回调挂在 then 上）。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("writeStateQuietly：写入失败不外泄", () => {
  it("成功写入：原样透传 key/value，不报错", async () => {
    const state = makeState(() => Promise.resolve());
    const onError = vi.fn();

    writeStateQuietly(state, "k", { a: 1 }, onError);
    await flush();

    expect(state.update).toHaveBeenCalledWith("k", { a: 1 });
    expect(onError).not.toHaveBeenCalled();
  });

  it("异步拒绝：被接住并汇报（不产生未捕获拒绝）", async () => {
    const state = makeState(() => Promise.reject(new Error("quota exceeded")));
    const onError = vi.fn();

    writeStateQuietly(state, "k", 1, onError);
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toContain("quota exceeded");
    expect(onError.mock.calls[0]![0]).toContain("k");
  });

  it("同步抛（Memento 已 dispose）：同样只汇报，不向调用方抛", () => {
    const state = makeState(() => {
      throw new Error("extension unloaded");
    });
    const onError = vi.fn();

    expect(() => writeStateQuietly(state, "k", 1, onError)).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toContain("extension unloaded");
  });

  it("非 Promise 的 thenable 也能挂上拒绝处理", async () => {
    const thenable = {
      then(_onFulfilled: unknown, onRejected: (error: unknown) => void) {
        onRejected(new Error("thenable boom"));
      },
    };
    const state = makeState(() => thenable);
    const onError = vi.fn();

    writeStateQuietly(state, "k", 1, onError);
    await flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toContain("thenable boom");
  });

  it("汇报面自身抛异常也不会外泄（输出通道已 dispose）", async () => {
    const state = makeState(() => Promise.reject(new Error("disk")));

    expect(() =>
      writeStateQuietly(state, "k", 1, () => {
        throw new Error("channel disposed");
      }),
    ).not.toThrow();
    await flush();
  });
});
