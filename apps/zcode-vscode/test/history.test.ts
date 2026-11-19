/**
 * pickSession（历史会话选择器，M2-6c）单测。
 *
 * 锁定 2026-11-09「点历史会话按钮没反应」修复后的交互口径：
 * 1. 点击瞬间 show（零延迟可见反馈）——先 show 再 await listSessions；
 * 2. accept/hide 监听在任何 await 之前注册（busy 阶段 ESC 也能结算，不挂死）；
 * 3. 失败/空列表/非数组都有明确呈现，绝不静默；
 * 4. finish 幂等（hide 触发的 onDidHide 与 accept 竞态不重复结算）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

interface FakePicker {
  busy: boolean;
  items: Array<{ label: string; description?: string; detail?: string; sessionId: string }>;
  selectedItems: Array<{ sessionId: string }>;
  show: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  onDidAccept: (fn: () => void) => void;
  onDidHide: (fn: () => void) => void;
  fireAccept: () => void;
  fireHide: () => void;
}

const { createQuickPick, showErrorMessage } = vi.hoisted(() => ({
  createQuickPick: vi.fn(),
  showErrorMessage: vi.fn(),
}));

vi.mock("vscode", () => ({
  window: { createQuickPick, showErrorMessage },
}));

import { pickSession, type SessionSummary } from "../src/features/history";

/** 闭包工厂：监听数组与 fire 方法同源，注册即生效，无需原型戏法。 */
function makeFakePicker(): FakePicker {
  const accept: Array<() => void> = [];
  const hide: Array<() => void> = [];
  return {
    busy: false,
    items: [],
    selectedItems: [],
    show: vi.fn(),
    hide: vi.fn(),
    dispose: vi.fn(),
    onDidAccept: (fn) => accept.push(fn),
    onDidHide: (fn) => hide.push(fn),
    fireAccept: () => accept.forEach((fn) => fn()),
    fireHide: () => hide.forEach((fn) => fn()),
  };
}

describe("pickSession：历史会话选择器", () => {
  let picker: FakePicker;

  beforeEach(() => {
    picker = makeFakePicker();
    createQuickPick.mockReset().mockImplementation(() => picker);
    showErrorMessage.mockReset();
  });

  it("点击瞬间 show（先于 listSessions 完成），数据到达后替换 items", async () => {
    const listSessions = vi.fn().mockImplementation(
      () =>
        new Promise<readonly SessionSummary[]>((resolve) =>
          setTimeout(
            resolve,
            20,
            [
              {
                sessionId: "s1",
                title: "修登录 bug",
                mode: "code",
                updatedAt: Date.now() - 30_000,
              },
            ] as const,
          ),
        ),
    );
    const pending = pickSession(listSessions);

    // listSessions 尚未返回：面板已 show 且 busy
    expect(picker.show).toHaveBeenCalledTimes(1);
    expect(picker.busy).toBe(true);

    picker.selectedItems = [{ sessionId: "s1" }];
    picker.fireAccept();
    expect(await pending).toBe("s1");
    expect(picker.busy).toBe(false);
    expect(picker.items[0]).toMatchObject({ label: "修登录 bug", sessionId: "s1" });
    expect(picker.dispose).toHaveBeenCalled();
  });

  it("busy 阶段 ESC（onDidHide）也能结算：不挂死、dispose 收尾、accept 不二次结算", async () => {
    const listSessions = vi.fn(
      () => new Promise<readonly SessionSummary[]>(() => undefined), // 永不 settle
    );
    const pending = pickSession(listSessions);

    picker.fireHide();
    expect(await pending).toBeUndefined();
    expect(picker.dispose).toHaveBeenCalled();
    // done 幂等：随后的 accept 不会再走 finish 分支（无副作用即无异常路径）
    picker.fireAccept();
  });

  it("空列表：占位项「暂无历史会话」留在面板内，不用通知打发", async () => {
    const pending = pickSession(vi.fn().mockResolvedValue([] as const));

    picker.fireAccept();
    expect(await pending).toBeUndefined();
    expect(picker.items[0]?.label).toBe("暂无历史会话");
    expect(picker.items[0]?.sessionId).toBe("");
    expect(showErrorMessage).not.toHaveBeenCalled();
  });

  it("listSessions 抛错：showErrorMessage 明确呈现并返回 undefined", async () => {
    const pending = pickSession(vi.fn().mockRejectedValue(new Error("CLI 未就绪")));

    expect(await pending).toBeUndefined();
    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("CLI 未就绪"));
  });

  it("服务返回非数组：同样明确报错（不静默）", async () => {
    const pending = pickSession(vi.fn().mockResolvedValue(undefined as never));

    expect(await pending).toBeUndefined();
    expect(showErrorMessage).toHaveBeenCalledWith(expect.stringContaining("非数组"));
  });

  it("无 title 会话回退「未命名会话」，相对时间分支（分钟/天）", async () => {
    const pending = pickSession(
      vi.fn().mockResolvedValue([
        { sessionId: "a", updatedAt: Date.now() - 120 * 1000 }, // 2 分钟前
        { sessionId: "b", updatedAt: Date.now() - 26 * 3_600_000 }, // 1 天前
        { sessionId: "c", title: "  " }, // 空白 title → 未命名
      ] as const),
    );

    picker.selectedItems = [{ sessionId: "a" }];
    picker.fireAccept();
    await pending;

    expect(picker.items[0]).toMatchObject({ label: "未命名会话", description: "2 分钟前" });
    expect(picker.items[1]?.description).toBe("1 天前");
    expect(picker.items[2]?.label).toBe("未命名会话");
  });
});
