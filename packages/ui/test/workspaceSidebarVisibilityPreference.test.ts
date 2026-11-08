/**
 * 工作区侧栏显隐偏好（用户反馈：点「+」新建会话/页签时侧栏总是自动展开）。
 *
 * 原本 `isSidebarVisible` 是纯内存 useState(true)：每个 webview 实例（IDE 页签重建、
 * 点「+」新建页签、重启）都从「展开」重来。修复后：默认收起 + 落盘记忆。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  persistWorkspaceSidebarVisible,
  readWorkspaceSidebarVisible,
} from "../src/hooks/useAppPanels.ts";

const STORAGE_KEY = "zcode:workspace-shell:sidebar-visible";

type FakeStorage = {
  store: Map<string, string>;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

function installStorage(initial?: Record<string, string>): FakeStorage {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  const fake: FakeStorage = {
    store,
    getItem: (key) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key, value) => {
      store.set(key, value);
    },
  };
  (globalThis as { localStorage?: unknown }).localStorage = fake;
  return fake;
}

// 顺序敏感：首个用例必须在模块级记忆仍为空时执行（module 顶层变量跨用例共享）。
test("从未设置过偏好时默认收起（不再自动展开）", () => {
  installStorage();
  assert.equal(readWorkspaceSidebarVisible(), false);
});

test("用户展开后落盘，重挂载读到展开", () => {
  const storage = installStorage();
  persistWorkspaceSidebarVisible(true);
  assert.equal(storage.getItem(STORAGE_KEY), "1");
  assert.equal(readWorkspaceSidebarVisible(), true);
});

test("用户收起后落盘为 0", () => {
  const storage = installStorage();
  persistWorkspaceSidebarVisible(false);
  assert.equal(storage.getItem(STORAGE_KEY), "0");
  assert.equal(readWorkspaceSidebarVisible(), false);
});

test("localStorage 不可用时不抛异常（读写均静默降级）", () => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.doesNotThrow(() => persistWorkspaceSidebarVisible(true));
  assert.doesNotThrow(() => readWorkspaceSidebarVisible());
});
