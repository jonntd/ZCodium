/**
 * 工作区侧栏显隐偏好（用户反馈：点「+」新建会话/页签时侧栏总是自动展开）。
 *
 * 原本 `isSidebarVisible` 是纯内存 useState(true)：每个 webview 实例（IDE 页签重建、
 * 点「+」新建页签、重启）都从「展开」重来。修复后：默认收起 + 三层记忆
 * （宿主 globalState seed → localStorage → 模块级兜底）。
 *
 * 顺序敏感：首个用例必须在模块级记忆仍为空时执行（module 顶层变量跨用例共享）。
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  applyWorkspaceSidebarVisibleFromHost,
  persistWorkspaceSidebarVisible,
  readWorkspaceSidebarVisible,
  setWorkspaceSidebarVisibleReporter,
  setWorkspaceSidebarVisibleSeed,
  subscribeWorkspaceSidebarVisible,
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

test("从未设置过偏好时默认收起（不再自动展开）", () => {
  installStorage();
  assert.equal(readWorkspaceSidebarVisible(), false);
});

test("宿主未注入 seed 时不受影响；注入 seed 后跨 webview 读到宿主值", () => {
  installStorage();
  setWorkspaceSidebarVisibleSeed(true);
  assert.equal(readWorkspaceSidebarVisible(), true);
  setWorkspaceSidebarVisibleSeed(false);
  assert.equal(readWorkspaceSidebarVisible(), false);
  setWorkspaceSidebarVisibleSeed(null);
});

test("localStorage 的显式值优先于宿主 seed", () => {
  installStorage({ [STORAGE_KEY]: "0" });
  setWorkspaceSidebarVisibleSeed(true);
  assert.equal(readWorkspaceSidebarVisible(), false);
  setWorkspaceSidebarVisibleSeed(null);
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

test("读取必须真读 localStorage，不能被模块级记忆短路", () => {
  // 回归护栏：上一版 read() 第一行就 `if (memory !== null) return memory`，
  // 于是「落盘 → 重新读取」这条路径永远测不到（假绿），外部写盘也不生效。
  persistWorkspaceSidebarVisible(true);
  installStorage({ [STORAGE_KEY]: "0" });
  assert.equal(readWorkspaceSidebarVisible(), false);
});

test("偏好变更会回传宿主（跨 webview 共享的唯一可靠通道）", () => {
  installStorage();
  const seen: boolean[] = [];
  setWorkspaceSidebarVisibleReporter((visible) => seen.push(visible));
  persistWorkspaceSidebarVisible(true);
  persistWorkspaceSidebarVisible(false);
  setWorkspaceSidebarVisibleReporter(null);
  assert.deepEqual(seen, [true, false]);
});

test("上报面抛异常不影响本地交互", () => {
  const storage = installStorage();
  setWorkspaceSidebarVisibleReporter(() => {
    throw new Error("bridge disposed");
  });
  assert.doesNotThrow(() => persistWorkspaceSidebarVisible(true));
  setWorkspaceSidebarVisibleReporter(null);
  assert.equal(storage.getItem(STORAGE_KEY), "1");
});

test("localStorage 不可用时不抛异常（读写均静默降级）", () => {  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.doesNotThrow(() => persistWorkspaceSidebarVisible(true));
  assert.doesNotThrow(() => readWorkspaceSidebarVisible());
  // 同上下文记忆兜住用户这次的选择（即使磁盘写不进去）
  assert.equal(readWorkspaceSidebarVisible(), true);
});

test("宿主回推的偏好同步本页 + 回写缓存，且不再上报（否则是回声环）", () => {
  const storage = installStorage();
  const seen: boolean[] = [];
  const reported: boolean[] = [];
  setWorkspaceSidebarVisibleReporter((visible) => reported.push(visible));
  const unsubscribe = subscribeWorkspaceSidebarVisible((visible) => seen.push(visible));

  applyWorkspaceSidebarVisibleFromHost(true);
  unsubscribe();
  // 退订后不再通知订阅者，但缓存与记忆仍要更新（下次重载才不会翻回旧值）。
  applyWorkspaceSidebarVisibleFromHost(false);
  setWorkspaceSidebarVisibleReporter(null);

  assert.deepEqual(seen, [true]);
  assert.equal(storage.getItem(STORAGE_KEY), "0");
  assert.equal(readWorkspaceSidebarVisible(), false);
  // 值本来就是宿主推来的：再上报会形成「A 推给 B → B 回报宿主 → 再推给 A」的回声。
  assert.deepEqual(reported, []);
});

test("单个订阅者抛异常不影响其它订阅者与本地状态", () => {
  const storage = installStorage();
  const seen: boolean[] = [];
  const off1 = subscribeWorkspaceSidebarVisible(() => {
    throw new Error("listener boom");
  });
  const off2 = subscribeWorkspaceSidebarVisible((visible) => seen.push(visible));

  assert.doesNotThrow(() => applyWorkspaceSidebarVisibleFromHost(true));
  off1();
  off2();

  assert.deepEqual(seen, [true]);
  assert.equal(storage.getItem(STORAGE_KEY), "1");
});
