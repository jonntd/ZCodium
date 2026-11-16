// @vitest-environment jsdom

import type { Hook } from "@zcode/shared";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { HooksSection } from "@/settings/HooksSection.js";

const hooksStateMock = vi.hoisted(() => ({
  workspacePath: "/workspace-a",
  workspaceIdentity: null as string | null,
  // 与 hooksStore.getHooksCacheKey 同格式（scope\0identity|path）：本机用户视图 =
  // "user\0/workspace-a"。提示的归属判定按此 key 比对，不再接受裸路径。
  loadedWorkspaceKey: "user\0/workspace-a" as string | null,
  hooks: [] as Hook[],
  loading: false,
  error: null as string | null,
  operatingHookId: null as string | null,
  initialize: vi.fn(async () => undefined),
  refresh: vi.fn(async () => undefined),
  addHook: vi.fn(async () => undefined),
  updateHook: vi.fn(async () => undefined),
  deleteHook: vi.fn(async () => undefined),
  toggleHook: vi.fn(async () => undefined),
  importHook: vi.fn(async () => undefined),
}));

const pluginStoreStateMock = vi.hoisted(() => ({
  plugins: [],
  availablePlugins: [],
  installedPlugins: [],
  marketplaceAvailabilityKnown: true,
  loading: false,
  error: null,
  initialize: vi.fn(async () => undefined),
}));

const serviceResolutionMock = vi.hoisted(() => ({
  rpcReady: true,
}));

vi.mock("@/store/hooksStore.js", async (importOriginal) => ({
  // 保留真实的 getHooksCacheKey：Trust 提示 key 比对依赖同一投影 key 格式，
  // 只替换 store 本体，避免 mock 漂移出第二套拼法。
  ...(await importOriginal<typeof import("@/store/hooksStore.js")>()),
  useHooksStore: () => hooksStateMock,
}));

vi.mock("@/store/pluginManagementStore.js", () => ({
  usePluginManagementStore: (selector: (state: typeof pluginStoreStateMock) => unknown) =>
    selector(pluginStoreStateMock),
}));

vi.mock("@/workspace-config-catalog/index.js", () => ({
  useConfigWorkspaceTargets: () => [],
  useConfigWorkspaceServicesResolution: () => ({
    rpcReady: serviceResolutionMock.rpcReady,
    services: {
      hooksService: {},
      pluginManagementService: {},
    },
  }),
}));

vi.mock("@/settings-scope/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/settings-scope/index.js")>();
  // Scope 的设备分组依赖 ServiceProvider / 平台能力 / 管理快照，本文件聚焦 Trust notice。
  // 桩不调用任何 hook，语义对齐真实本机帧：「本机 · 用户」ready，锚点为当前 workspace。
  return {
    ...actual,
    useSettingsScope: () => ({
      groups: [],
      selectedScopeKey: "user",
      setSelectedScopeKey: () => undefined,
      resolution: { status: "ready", key: "user", kind: "user", device: { kind: "local" } },
      device: { kind: "local" },
      deviceTargets: [],
      user: {
        status: "ready",
        target: { workspacePath: hooksStateMock.workspacePath, label: "" },
        unscopedServices: {},
      },
      syncSourceServerId: null,
      isActiveWorkspaceDevice: true,
      toLocalScopeKey: (key: string) => key,
      toPageScopeKey: (key: string) => key,
    }),
  };
});

vi.mock("@/hooks/useConfirmDialog.js", () => ({
  useConfirmDialog: () => vi.fn(async () => false),
}));

vi.mock("@/hooks/useZCodeSessionService.js", () => ({
  useZCodeSessionService: () => undefined,
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: { tabs: [] }) => unknown) => selector({ tabs: [] }),
}));

vi.mock("@/store/workspaceHookReviewStore.js", () => ({
  useWorkspaceHookReviewStore: (
    selector: (state: { bindings: Record<string, never> }) => unknown,
  ) => selector({ bindings: {} }),
}));

vi.mock("@/settings/useWorkspaceHookInlineTrust.js", () => ({
  useWorkspaceHookInlineTrust: () => ({
    trustActionAvailable: false,
    trustingHookId: null,
    trustHook: vi.fn(async () => undefined),
  }),
}));

vi.mock("@/settings/SettingsSearchInput.js", () => ({
  SettingsSearchInput: ({
    onChange,
    placeholder,
    value,
  }: {
    onChange: (event: { target: { value: string } }) => void;
    placeholder: string;
    value: string;
  }) => createElement("input", { "aria-label": "hooks-search", onChange, placeholder, value }),
}));

// 只替换 React 组件，两个纯函数（getPluginWorkspaceKey / isPluginScopeWorkspaceConnected）
// 走真实实现。此前手写整份 mock，导致源码新增 isPluginScopeWorkspaceConnected 后本用例直接崩
// （"No export is defined on the mock"）；用 importOriginal 可以从结构上避免这类漂移。
vi.mock("@/settings/PluginScopeMenu.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/settings/PluginScopeMenu.js")>()),
  PluginScopeMenu: () => null,
}));

vi.mock("@/settings/HookForm.js", () => ({ HookForm: () => null }));
vi.mock("@/settings/SettingsHeaderBreadcrumb.js", () => ({
  SettingsBreadcrumbReporter: () => null,
}));
vi.mock("@/settings/SettingsResourceHeaderActions.js", () => ({
  SettingsResourceHeaderActions: () => null,
}));
vi.mock("@/settings/HooksList.js", () => ({ HooksList: () => null }));
vi.mock("@/settings/pluginStoreListing.js", () => ({
  formatCanonicalPluginName: (name: string) => name,
}));
vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children }: { children?: unknown }) => createElement("button", null, children),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/lib/zcodeDraftSkillInvalidation.js", () => ({
  invalidateDeferredDraftSessionForRuntimeChange: vi.fn(async () => undefined),
}));
vi.mock("@/settings/PluginInstallEmptyState.js", () => ({
  PluginLoadingState: ({ label }: { label: string }) => createElement("div", null, label),
  PluginSearchEmptyState: ({ label }: { label: string }) => createElement("div", null, label),
}));

function workspaceHook(): Hook {
  return {
    id: "workspace-pending",
    event: "PreToolUse",
    type: "command",
    command: "echo review",
    enabled: true,
    editable: false,
    location: {
      source: "zcode",
      scope: "user",
      directoryPath: "/workspace-a/.zcode",
      projectPath: "/workspace-a",
    },
    workspaceHook: {
      sourceRootEnabled: true,
      declarationEnabled: true,
      runtimeHooksEnabled: true,
      configuredEnabled: true,
      sourcePath: "/workspace-a/.zcode/config.json",
      reviewItemId: "review-pending",
      workspaceIdentity: "/workspace-a",
      bundleDigest: "a".repeat(64),
      hookDeclarationDigest: "b".repeat(64),
      sourceFileIndex: 0,
      trustState: "pending_trust",
    },
  };
}

function renderHooksSection() {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(HooksSection, { workspacePath: hooksStateMock.workspacePath }),
    ),
  );
}

describe("HooksSection workspace Hook Trust notice", () => {
  beforeEach(() => {
    hooksStateMock.workspacePath = "/workspace-a";
    hooksStateMock.workspaceIdentity = null;
    hooksStateMock.loadedWorkspaceKey = "user\0/workspace-a";
    hooksStateMock.hooks = [workspaceHook()];
    hooksStateMock.loading = false;
    hooksStateMock.error = null;
    serviceResolutionMock.rpcReady = true;
  });

  afterEach(() => cleanup());

  it("keeps the scope notice visible when search filters every hook row", async () => {
    renderHooksSection();

    fireEvent.change(screen.getByLabelText("hooks-search"), {
      target: { value: "does-not-match" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("workspace-hook-trust-notice")).toBeTruthy();
    });
  });

  it("hides the old snapshot notice while the target workspace is connecting", () => {
    hooksStateMock.workspacePath = "/workspace-b";
    hooksStateMock.loadedWorkspaceKey = "/workspace-a";
    serviceResolutionMock.rpcReady = false;

    renderHooksSection();

    expect(screen.queryByTestId("workspace-hook-trust-notice")).toBeNull();
  });
});
