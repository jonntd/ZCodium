// @vitest-environment jsdom
// tabStore 实例登记 epoch 契约（spec: composer-insert-delivery「tabStore 实例生命周期」
// 2026-11-22 修订）。
//
// 背景：Root 带 key 重挂载（session-switch / new-session 帧、restore 失败重挂）会重建
// TabStoreProvider → 新 store 实例。模块镜像 getCurrentWindowTabStore() 即时跟随，但
// 已在旧实例上建立 subscription 的 effect（vscode App.tsx 标题/会话上报）不会自动重跑
// ——审查发现切页签触发的重算在重挂载后静默失效。跨实例订阅方以 epoch 为 effect deps
// （useSyncExternalStore(subscribeTabStoreEpoch, getTabStoreEpoch)）。本测试锁死模块面
// 契约：登记/清除各递增一次、镜像即时跟随、旧实例 cleanup 不误清新实例、退订后不再通知。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import {
  TabStoreProvider,
  getCurrentWindowTabStore,
  getTabStoreEpoch,
  subscribeTabStoreEpoch,
} from "@/store/TabStoreProvider.js";

afterEach(() => {
  cleanup();
});

describe("tabStore 实例 epoch（跨实例订阅契约）", () => {
  it("Provider 挂载：epoch 递增、listener 收到通知、镜像指向新实例；卸载对称", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTabStoreEpoch(listener);
    const epochBefore = getTabStoreEpoch();

    const view = render(createElement(TabStoreProvider, null, createElement("div")));
    const mountedStore = getCurrentWindowTabStore();

    expect(getTabStoreEpoch()).toBe(epochBefore + 1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(mountedStore).not.toBeNull();

    view.unmount();
    // 卸载：epoch 再递增、镜像清 null（本实例仍是登记者）。
    expect(getTabStoreEpoch()).toBe(epochBefore + 2);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getCurrentWindowTabStore()).toBeNull();
    unsubscribe();
  });

  it("旧实例 cleanup 不误清新实例：仅登记者本人可清除", () => {
    const epochBefore = getTabStoreEpoch();
    const viewA = render(createElement(TabStoreProvider, null, createElement("div")));
    const storeA = getCurrentWindowTabStore();
    const viewB = render(createElement(TabStoreProvider, null, createElement("div")));
    const storeB = getCurrentWindowTabStore();

    expect(storeA).not.toBeNull();
    expect(storeB).not.toBe(storeA);
    expect(getTabStoreEpoch()).toBe(epochBefore + 2);

    // 旧实例 A 卸载：镜像仍指向 B、epoch 不动（守卫生效）。
    viewA.unmount();
    expect(getCurrentWindowTabStore()).toBe(storeB);
    expect(getTabStoreEpoch()).toBe(epochBefore + 2);

    // 登记者本人卸载：镜像清 null、epoch 递增。
    viewB.unmount();
    expect(getCurrentWindowTabStore()).toBeNull();
    expect(getTabStoreEpoch()).toBe(epochBefore + 3);
  });

  it("退订后不再收到通知", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTabStoreEpoch(listener);
    unsubscribe();

    const view = render(createElement(TabStoreProvider, null, createElement("div")));
    expect(listener).not.toHaveBeenCalled();
    view.unmount();
    expect(listener).not.toHaveBeenCalled();
  });
});
