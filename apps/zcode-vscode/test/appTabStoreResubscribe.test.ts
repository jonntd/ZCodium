// @vitest-environment jsdom
// App 层 tabStore 实例重订阅接线回归（spec: composer-insert-delivery「tabStore 实例
// 生命周期」2026-11-22 修订；d556388d 修复）。
//
// 回归现场：Root 带 key 重挂载（session-switch/new-session 帧、restore 失败重挂）重建
// TabStoreProvider → 新 store 实例；App.tsx 标题/会话上报 effect 的 tabStore subscription
// 若仍停在旧实例，切页签触发的重算静默失效，延迟到下一次 session-store 事件才自愈。
//
// 本测试驱动真实 App（仅 mock @zcode/ui 的 Root 壳——内嵌真实 TabStoreProvider，
// 其余 provider 全在 App effect 关心面之外）：
// 1. 挂载基线：上报 bootstrap folder 的活动会话；
// 2. host session-switch 帧 → App 递增 key 重挂 Root → 模块镜像指向新实例、epoch 递增；
// 3. 重挂载后切页签（【新】实例上的 tabStore 变化）→ 标题/归属立即跟随新工作区。
//    修复前（订阅停在旧实例）第 3 步收不到任何回调——本断言即回归锁。
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App, type SessionReportingPort } from "../src/webview-react/App";
import type { IPlatformService } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { HostFrameBus } from "../src/webview-react/bridge/hostFrames";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  getCurrentWindowTabStore,
  getTabStoreEpoch,
} from "@/store/TabStoreProvider.js";
import { getDefaultWorkspaceState } from "@/store/zcodeSessionStoreTypes.js";

// React 19 act() 环境声明（无 @testing-library，手动 createRoot 渲染需要）。
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@zcode/ui", async () => {
  const React = await import("react");
  const { TabStoreProvider } = await import("@/store/TabStoreProvider.js");
  const Passthrough = ({ children }: { children?: unknown }) => children as never;
  return {
    AppErrorBoundary: Passthrough,
    ZCodeIntlProvider: Passthrough,
    // 只保留 App 关心的真实面：TabStoreProvider（登记/epoch 的来源）。12 层 provider
    // 栈与会话 UI 与本测试的 effect 无关，用占位 div 代替。
    Root: () =>
      React.createElement(
        TabStoreProvider,
        null,
        React.createElement("div", { "data-testid": "mock-root" }),
      ),
  };
});

vi.mock("../src/webview-react/banners/RuntimeRestartBanner", () => ({
  RuntimeRestartBanner: () => null,
}));

/** 内存帧总线：on/emit 同款签名，测试里驱动 host 帧（session-switch 等）。 */
function makeFrameBus() {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on: vi.fn((type: string, handler: (payload: unknown) => void) => {
      let set = handlers.get(type);
      if (!set) {
        set = new Set();
        handlers.set(type, set);
      }
      set.add(handler);
      return () => {
        handlers.get(type)?.delete(handler);
      };
    }),
    // followThemeFrames 订阅时以最近一帧同步一次（内存总线无历史帧 → undefined）。
    lastPayload: vi.fn(() => undefined),
    emit: (type: string, payload: unknown): void => {
      for (const handler of handlers.get(type) ?? []) handler(payload);
    },
  } as unknown as HostFrameBus & { emit: (type: string, payload: unknown) => void };
}

const AAA = "/w/aaa";
const BBB = "/w/bbb";

function seedWorkspace(path: string, taskId: string, title: string): void {
  useZCodeSessionStore.setState({
    workspaces: {
      ...useZCodeSessionStore.getState().workspaces,
      [path]: {
        ...getDefaultWorkspaceState(),
        activeTaskId: taskId,
        taskListCache: [{ taskId, title }] as never,
      },
    },
  });
}

function makePlatformStub() {
  return {
    notifyEditorTabUi: vi.fn(),
    notifySessionCreated: vi.fn().mockResolvedValue(undefined),
    notifySessionDeleted: vi.fn().mockResolvedValue({}),
  };
}

function renderApp(overrides: {
  platform?: ReturnType<typeof makePlatformStub>;
  workspacePath?: string;
  onActiveSessionChange?: (id: string | null) => void;
  frameBus?: HostFrameBus;
}): { unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let reactRoot: Root | null = null;
  act(() => {
    reactRoot = createRoot(container);
    reactRoot.render(
      createElement(App, {
        platform: (overrides.platform ??
          makePlatformStub()) as unknown as IPlatformService & SessionReportingPort,
        services: {
          settingService: null,
          broadcastService: null,
        } as unknown as IServiceAccessor,
        themeKind: 1,
        locale: "zh-CN",
        workspacePath: overrides.workspacePath ?? AAA,
        sessionId: null,
        hostFrames: overrides.frameBus ?? null,
        onActiveSessionChange: overrides.onActiveSessionChange,
      }),
    );
  });
  return {
    unmount: () => {
      act(() => {
        reactRoot?.unmount();
      });
      container.remove();
    },
  };
}

beforeEach(() => {
  useZCodeSessionStore.setState({ workspaces: {} });
  localStorage.clear();
});

afterEach(() => {
  // Provider 卸载 cleanup 已在测试内 unmount 时执行；兜底清空镜像防止用例间串扰。
  if (getCurrentWindowTabStore()) {
    getCurrentWindowTabStore()!.setState({ tabs: [], activeTabId: null, activeWorkspacePath: null, activeWorkspaceIdentity: null });
  }
});

describe("App × tabStore 实例 epoch 重订阅（Root 重挂载后切页签立即跟随）", () => {
  it("重挂载前：切页签立即触发归属上报与标题跟随（基线接线）", () => {
    seedWorkspace(AAA, "task-1", "AAA 任务");
    seedWorkspace(BBB, "task-2", "BBB 任务");
    const onActiveSessionChange = vi.fn();
    const view = renderApp({ onActiveSessionChange });

    // 挂载基线：上报 bootstrap folder 的活动会话。
    expect(onActiveSessionChange).toHaveBeenCalledWith("task-1");

    const tabStore = getCurrentWindowTabStore();
    expect(tabStore).not.toBeNull();
    vi.mocked(onActiveSessionChange).mockClear();

    act(() => {
      tabStore!.setState({
        tabs: [{ id: "t2", kind: "workspace", label: "bbb", workspacePath: BBB }],
        activeTabId: "t2",
        activeWorkspacePath: BBB,
        activeWorkspaceIdentity: null,
      });
    });
    expect(onActiveSessionChange).toHaveBeenCalledWith("task-2");
    view.unmount();
  });

  it("session-switch 重挂 Root 后：旧实例订阅失效，新实例切页签仍立即跟随（回归锁）", async () => {
    seedWorkspace(AAA, "task-1", "AAA 任务");
    seedWorkspace(BBB, "task-2", "BBB 任务");
    const onActiveSessionChange = vi.fn();
    const platform = makePlatformStub();
    const frameBus = makeFrameBus();
    const view = renderApp({
      platform,
      onActiveSessionChange,
      frameBus: frameBus as unknown as HostFrameBus,
    });

    const oldStore = getCurrentWindowTabStore();
    expect(oldStore).not.toBeNull();
    const epochBefore = getTabStoreEpoch();

    // host session-switch 帧 → App setSwitchTarget(seq+1) → Root 重挂 → 新实例登记。
    act(() => {
      frameBus.emit("session-switch", { sessionId: "task-1" });
    });
    const newStore = getCurrentWindowTabStore();
    expect(newStore).not.toBeNull();
    expect(newStore).not.toBe(oldStore);
    expect(getTabStoreEpoch()).toBeGreaterThan(epochBefore);

    // 重挂载当拍：基线重建（/w/aaa task-1），不产生迁移上报。
    vi.mocked(onActiveSessionChange).mockClear();

    // 【新】实例上切页签到 /w/bbb——修复前订阅停在旧实例，这里收不到任何回调。
    act(() => {
      newStore!.setState({
        tabs: [{ id: "t2", kind: "workspace", label: "bbb", workspacePath: BBB }],
        activeTabId: "t2",
        activeWorkspacePath: BBB,
        activeWorkspaceIdentity: null,
      });
    });

    expect(onActiveSessionChange).toHaveBeenCalledWith("task-2");
    // 归属上报：切页签 → created 重报到新 folder（host setActiveSession 幂等）。
    expect(platform.notifySessionCreated).toHaveBeenCalledWith("task-2", BBB);
    // 标题跟随：notifyEditorTabUi 反映新可见工作区的任务标题。
    expect(platform.notifyEditorTabUi).toHaveBeenCalledWith({ title: "BBB 任务", busy: false });
    // 旧工作区的会话不报删除（切页签不是删除）。
    expect(platform.notifySessionDeleted).not.toHaveBeenCalled();
    view.unmount();
  });
});
