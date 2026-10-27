// @vitest-environment jsdom
// ComputerUseSection 的 win32 触发链接通（lazy-startup spec §9.2-D3）。
//
// 故障背景（2026-10-27 Windows 实机）：win32 上 supportsLocalMacWorkspace=false 使
// useCuaPermissionStatus 收到 null path 从不查询、开关切换后的 refresh() 也被跳过——
// getStatus 是托管 host fork helper 的触发者，这条链不通时输入框入口隐藏的用户没有任何
// helper 启动路径，电脑控制永远 "permission broker socket is not accepting connections"。
// 这里验证修复后的门控：Windows 本地 workspace 下 hook 收到真实 path、开关切换触发
// refresh、TCC 权限行仍只在 macOS 渲染。
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => {
  const pluginState = {
    plugins: [
      { id: "computer-use@zcode-plugins-official", name: "computer-use", enabled: false },
    ],
    loading: false,
    error: null as string | null,
    togglingPluginId: null as string | null,
    workspacePath: "/workspace",
    workspaceIdentity: "workspace-id",
    configScope: null,
    initialize: vi.fn(async () => {}),
    // 复刻 store 的乐观切换契约：置 togglingPluginId → 服务确认 → 回落。真实 store 的
    // setEnabled 内部还会 loadInto + notify，mock 只需保证 isCurrent 链成立即可。
    setEnabled: vi.fn(async (pluginId: string, enabled: boolean) => {
      pluginState.togglingPluginId = pluginId;
      pluginState.plugins[0]!.enabled = enabled;
      pluginState.togglingPluginId = null;
      return true;
    }),
  };
  // hook 层观测：记录每次 useCuaPermissionStatus 收到的 path 参数。
  const hookPaths: Array<string | null> = [];
  const refresh = vi.fn();
  return { hookPaths, pluginState, refresh };
});

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    executeDesktopCommand: vi.fn(async () => ({ kind: "macos-supported" })),
    openCuaPermissionOnboarding: vi.fn(async () => ({ success: true })),
  }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({
    pluginManagementService: {},
    cuaPermissionService: {
      getStatus: vi.fn(async () => ({ available: false, reason: "idle", idle: true })),
      restartHelper: vi.fn(async () => ({ ok: true })),
    },
  }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: { computerUseComposerEntryHidden: true },
    update: vi.fn(async () => {}),
  }),
}));
vi.mock("@/hooks/useCuaPermissionStatus.js", () => ({
  useCuaPermissionStatus: (workspacePath: string | null, _workspaceIdentity?: string) => {
    h.hookPaths.push(workspacePath);
    return { status: null, fresh: false, settled: true, refresh: h.refresh };
  },
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/store/pluginManagementStore.js", () => ({
  usePluginManagementStore: Object.assign(
    (selector: (state: typeof h.pluginState) => unknown) => selector(h.pluginState),
    { getState: () => h.pluginState },
  ),
}));
vi.mock("@zcode/services", () => ({
  isCuaPermissionStatusAvailable: () => false,
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));

import { ComputerUseSection } from "@/settings/ComputerUseSection.js";

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.pluginState.plugins[0]!.enabled = false;
  h.hookPaths.length = 0;
});

function renderSection(props: Record<string, unknown> = {}) {
  return render(
    createElement(ComputerUseSection, {
      isDesktop: true,
      workspacePath: "/workspace",
      workspaceIdentity: "workspace-id",
      ...props,
    }),
  );
}

describe("ComputerUseSection win32 触发链", () => {
  it("Windows 本地 workspace 下权限状态 hook 收到真实 path（不再 null 短路）", () => {
    renderSection({ isMacDesktop: false, isWindowsDesktop: true });
    expect(h.hookPaths).toContain("/workspace");
  });

  it("Windows 下打开插件开关触发 refresh（getStatus 拉起 helper 的入口）", async () => {
    renderSection({ isMacDesktop: false, isWindowsDesktop: true });
    const toggle = screen.getByRole("switch", {
      name: "settings.computerUse.toggleLabel",
    });
    fireEvent.click(toggle);
    await waitFor(() => expect(h.refresh).toHaveBeenCalled());
  });

  it("Windows 下不渲染 TCC 权限行（无 TCC 语义，只保留开关卡）", () => {
    renderSection({ isMacDesktop: false, isWindowsDesktop: true });
    expect(screen.queryByText("cuaPermission.perm.accessibility")).toBeNull();
  });

  it("macOS 下行为不变：插件启用时 hook 收到 path 且 TCC 权限行照常渲染", () => {
    // mock store 非响应式，点击开关不触发重渲染；预置启用态直接断言渲染分支。
    h.pluginState.plugins[0]!.enabled = true;
    renderSection({ isMacDesktop: true });
    expect(h.hookPaths).toContain("/workspace");
    expect(screen.queryByText("cuaPermission.perm.accessibility")).not.toBeNull();
  });
});
