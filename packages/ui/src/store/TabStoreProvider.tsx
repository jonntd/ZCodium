/**
 * TabStoreProvider —— 初始化 Tab Zustand store 并通过 React Context 提供
 *
 * 每个窗口独立挂载，tab 状态不跨窗口广播。
 */
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { useStore } from "zustand";
import { shouldExposeE2EStoreBridge } from "@/lib/e2eStoreBridge.js";
import { createTabStore, type TabStore, type TabStoreState } from "./tabStore.js";

declare global {
  interface Window {
    __zcodeTabStoreE2E?: TabStore;
  }
}

const TabStoreContext = createContext<TabStore | null>(null);
const fallbackTabStore = createTabStore(null);

/**
 * 当前窗口已挂载的 tab store（模块级只读镜像）。
 *
 * React 树外的 host 帧消费者无法进 Context：vscode webview 的 composer-insert /
 * diagnostics 帧处理注册在 Provider 之外（webview-react/index.tsx），落点 key 需要
 * 与可见对话区同源（spec: composer-insert-delivery 落点 key 规则），只能按窗口读
 * 当前实例。Provider 挂载时登记、卸载时清除；与 window.__zcodeTabStoreE2E 同一
 * 「Provider 是事实源、模块面只读」的口径。
 */
let currentWindowTabStore: TabStore | null = null;
let tabStoreEpoch = 0;
const tabStoreEpochListeners = new Set<() => void>();

/** 当前窗口已挂载的 tab store；Provider 未挂载（React 未挂树）时为 null。 */
export function getCurrentWindowTabStore(): TabStore | null {
  return currentWindowTabStore;
}

/**
 * 当前登记实例版本（Provider 挂载/卸载各递增一次）。
 *
 * Root 带 key 重挂载（session-switch / new-session 帧）会重建 TabStoreProvider →
 * 新 store 实例。模块镜像本身会跟着指向新实例，但已在旧实例上建立 subscription 的
 * effect（如 vscode App.tsx 的标题/会话上报）不会重跑——deps 不含实例身份。跨实例
 * 订阅方必须把 epoch 纳入 effect deps（配合 useSyncExternalStore），实例切换时清理
 * 旧订阅并重挂到当前实例（审查 2026-11-22 发现，spec: composer-insert-delivery
 * 落点 key 规则）。
 */
export function getTabStoreEpoch(): number {
  return tabStoreEpoch;
}

/** 订阅实例版本变化（useSyncExternalStore 的 subscribe 入参口径）。 */
export function subscribeTabStoreEpoch(listener: () => void): () => void {
  tabStoreEpochListeners.add(listener);
  return () => {
    tabStoreEpochListeners.delete(listener);
  };
}

/** 登记当前实例并递增版本（同值幂等）；通知跨实例订阅方。 */
function setWindowTabStore(next: TabStore | null): void {
  if (currentWindowTabStore === next) return;
  currentWindowTabStore = next;
  tabStoreEpoch += 1;
  for (const notify of tabStoreEpochListeners) notify();
}

export function TabStoreProvider({ children }: { children: ReactNode }) {
  // 只在首次渲染时创建 store，避免 HMR 重复创建
  const storeRef = useRef<TabStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = createTabStore();
  }

  useEffect(() => {
    // 模块级当前窗口实例登记（见 getCurrentWindowTabStore 注释）：挂载即登记，卸载
    // 时只在仍指向本实例的情况下清除（防旧 Provider 迟到的 cleanup 误清新实例）。
    // 登记经 setWindowTabStore 递增 epoch，跨实例订阅方据此重订阅。
    const store = storeRef.current;
    setWindowTabStore(store);
    return () => {
      if (currentWindowTabStore === store) setWindowTabStore(null);
    };
  }, []);

  useEffect(() => {
    if (!shouldExposeE2EStoreBridge() || !storeRef.current) {
      return;
    }

    const store = storeRef.current;
    // V4 draft 没有 taskId，E2E 若按 activeTaskId=null 反查 workspace，
    // 多 workspace 会命中任意草稿桶。只在 E2E 构建暴露当前窗口导航 store，供 helper
    // 按 workspaceIdentity?.trim() || workspacePath 精确读取当前草稿。
    window.__zcodeTabStoreE2E = store;
    return () => {
      if (window.__zcodeTabStoreE2E === store) {
        delete window.__zcodeTabStoreE2E;
      }
    };
  }, []);

  return <TabStoreContext.Provider value={storeRef.current}>{children}</TabStoreContext.Provider>;
}

/**
 * 消费 Tab store 的 hook
 *
 * 用法：
 *   const tabs = useTabStore(s => s.tabs);
 *   const addTab = useTabStore(s => s.addTab);
 */
export function useTabStore<T>(selector: (state: TabStoreState) => T): T {
  const store = useContext(TabStoreContext);
  if (!store) {
    throw new Error("useTabStore 必须在 TabStoreProvider 内使用");
  }
  return useStore(store, selector);
}

/** 供可独立渲染的展示组件读取；无 Root provider 时回退为空 tab 状态。 */
export function useOptionalTabStore<T>(selector: (state: TabStoreState) => T): T {
  const store = useContext(TabStoreContext);
  return useStore(store ?? fallbackTabStore, selector);
}

/**
 * 获取 tab store 的原始引用（用于非 React 上下文，如 useEffect 中的订阅）
 */
export function useTabStoreApi(): TabStore {
  const store = useContext(TabStoreContext);
  if (!store) {
    throw new Error("useTabStoreApi 必须在 TabStoreProvider 内使用");
  }
  return store;
}
