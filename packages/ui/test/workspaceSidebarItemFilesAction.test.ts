import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testId, TID_WORKSPACE_SIDE_PANE_FILES_BUTTON } from "@zcode/shared";
import type { WorkspaceTabState } from "@/store/tabStore.js";

/**
 * 侧栏行按钮「打开文件面板」行为回归（docs/spec/sidebar-file-viewer.md §2 入口 B）。
 *
 * 背景：merge 11f63dc7 把 ShellLayout → WorkspaceSidebar 的 onOpenSidePaneFiles
 * 接线弄丢后按钮静默消失（prop 可选，typecheck 不报）。源码锁
 * workspaceSidebarFilesWiring.test.ts 锁上游链路；本文件渲染真实 WorkspaceSidebarItem
 * 锁下游行为：按钮挂载条件、点击回调参数、防折叠冒泡与只读/断连守卫。
 */

const { actionButtonCalls } = vi.hoisted(() => ({
  actionButtonCalls: [] as Array<Record<string, unknown>>,
}));

const stableServices = {
  zcodeTaskService: {
    archiveTask: async () => null,
    renameTask: async () => null,
    setTaskPinned: async () => null,
    setTaskUnread: async () => null,
  },
};

vi.mock("border-beam", () => ({
  BorderBeam: ({ children }: { children: ReactNode }) => createElement("div", null, children),
}));

vi.mock("lucide-react", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    createElement("svg", { "data-icon": name, ...props });

  return {
    CheckIcon: createIcon("check"),
    CircleAlert: createIcon("circle-alert"),
    Cloud: createIcon("cloud"),
    CopyIcon: createIcon("copy"),
    Ellipsis: createIcon("ellipsis"),
    Folder: createIcon("folder"),
    FolderOpen: createIcon("folder-open"),
    House: createIcon("house"),
    InfoIcon: createIcon("info"),
    ListTree: createIcon("list-tree"),
    LoaderCircle: createIcon("loader"),
    Loader2: createIcon("loader-2"),
    MessageCirclePlus: createIcon("message-circle-plus"),
    RefreshCwIcon: createIcon("refresh"),
    UploadCloud: createIcon("upload-cloud"),
    XIcon: createIcon("x"),
  };
});

vi.mock("@/workspace-grouped-tasks/task-row-action-button.js", () => ({
  TaskRowActionButton: (props: Record<string, unknown>) => {
    actionButtonCalls.push(props);
    return createElement("button", { "data-label": String(props.label) });
  },
}));

vi.mock("@/components/ui/button.js", () => ({
  Button: ({ children, ...props }: { children?: ReactNode }) =>
    createElement("button", props, children),
  buttonVariants: () => "",
}));

vi.mock("@/components/ui/collapsible.js", () => ({
  Collapsible: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  CollapsibleContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  CollapsibleTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuItem: ({ children, ...props }: { children: ReactNode }) =>
    createElement("div", props, children),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/tooltip.js", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  TooltipContent: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  TooltipProvider: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/TaskList.js", () => ({
  TaskList: () => null,
}));

vi.mock("@/WorkspaceSidebar/ReconnectingRemoteWorkspaceLogTooltip.js", () => ({
  ReconnectingRemoteWorkspaceLogTooltip: ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: ({ id }: { id: string }) => id,
    },
  }),
}));

vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => stableServices,
  useWorkspaceServices: () => stableServices,
}));

vi.mock("@/store/zcodeSessionStore.js", () => ({
  selectWorkspaceZCodeState: () => ({
    activeTaskId: null,
    selectedProvider: "codex",
  }),
  useZCodeSessionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      removeOptimisticTaskListItem: () => {},
      removeTaskState: () => {},
      setTaskUnreadIndicator: () => {},
      startDraft: () => {},
      upsertOptimisticTaskListItem: () => {},
    }),
}));

vi.mock("@/store/taskQueryCacheStore.js", () => ({
  applyTaskQueryCacheMutation: () => {},
  invalidateTaskQueryCacheByScopes: () => {},
}));

vi.mock("@/store/remotePinnedTaskStore.js", () => ({
  useRemotePinnedTaskStore: {
    getState: () => ({
      removeTask: () => {},
      upsertTask: () => {},
    }),
  },
}));

vi.mock("@/store/remoteTimelineTaskStore.js", () => ({
  useRemoteTimelineTaskStore: {
    getState: () => ({
      removeTask: () => {},
      upsertTask: () => {},
    }),
  },
}));

function createMinimalElement(ownerDocument: Document, tagName = "div") {
  const element = {
    addEventListener: () => {},
    appendChild: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    childNodes: [] as unknown[],
    getAttribute: () => null,
    insertBefore: (child: { parentNode?: unknown }) => {
      child.parentNode = element;
      return child;
    },
    nodeName: tagName.toUpperCase(),
    nodeType: 1,
    ownerDocument,
    parentNode: null as unknown,
    removeAttribute: () => {},
    removeChild: (child: { parentNode?: unknown }) => {
      child.parentNode = null;
      return child;
    },
    removeEventListener: () => {},
    setAttribute: () => {},
    style: {},
    tagName: tagName.toUpperCase(),
  };
  return element as unknown as Element;
}

function installMinimalDom() {
  const documentMock = {
    addEventListener: () => {},
    createElement: (tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createElementNS: (_namespace: string, tagName: string) =>
      createMinimalElement(documentMock as unknown as Document, tagName),
    createTextNode: (nodeValue: string) => ({
      nodeType: 3,
      nodeValue,
      ownerDocument: documentMock,
      parentNode: null,
    }),
    nodeType: 9,
    removeEventListener: () => {},
  } as unknown as Document;
  const matchMediaStub = (query: string) => ({
    // 只对触屏判定返回 true（使行内 action 常驻挂载）；其余查询一律 false，
    // 避免误开组件里其它 matchMedia 分支（实测全 true 会拖慢用例 26s）。
    matches: query.includes("hover: none"),
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
  const windowMock = {
    addEventListener: () => {},
    clearTimeout,
    document: documentMock,
    HTMLIFrameElement: function HTMLIFrameElement() {},
    HTMLElement: function HTMLElement() {},
    Node: function Node() {},
    removeEventListener: () => {},
    setTimeout,
    // isHover_none 走 matchMedia("(hover: none)")：置 true 使行内 action 常驻挂载，
    // 无需真实 hover 才能渲染「打开文件面板」按钮。
    matchMedia: matchMediaStub,
  };
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentMock,
  });
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: windowMock,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
  });
  return createMinimalElement(documentMock);
}

function createWorkspaceTab(overrides: Partial<WorkspaceTabState> = {}): WorkspaceTabState {
  return {
    id: "workspace-1",
    kind: "workspace",
    label: "workspace",
    workspacePath: "/workspace",
    ...overrides,
  };
}

async function renderSidebarItem(tab: WorkspaceTabState, onOpenSidePaneFiles?: unknown) {
  const { WorkspaceSidebarItem } = await import("@/WorkspaceSidebarItem.js");
  const root: Root = createRoot(installMinimalDom());
  act(() => {
    root.render(
      createElement(WorkspaceSidebarItem, {
        activateTab: () => {},
        closeTab: () => {},
        isActiveWorkspace: true,
        isExpanded: true,
        itemStyle: { opacity: 1 },
        mobileActiveTaskKey: null,
        onOpenFileTree: () => {},
        ...(onOpenSidePaneFiles ? { onOpenSidePaneFiles } : {}),
        onReconnectRemoteWorkspace: async () => {},
        onSelectTask: () => {},
        onStartDraftInWorkspace: () => {},
        onShowMoreTasks: () => {},
        reconnectingRemoteWorkspaceKeys: [],
        reconnectingRemoteWorkspaceLogsByWorkspaceKey: {},
        remoteWorkspaceErrorByWorkspaceKey: {},
        tab,
        taskItems: [],
        taskListHasMore: true,
        taskListLoading: false,
        toggleWorkspaceExpanded: () => {},
      }),
    );
  });
  return {
    unmount: () => {
      act(() => {
        root.unmount();
      });
    },
  };
}

function findFilesActionButton() {
  return actionButtonCalls.find(
    (props) => props.label === "workspaceSidebar.openSidePaneFiles",
  );
}

describe("侧栏行按钮「打开文件面板」（入口 B）", () => {
  afterEach(() => {
    actionButtonCalls.length = 0;
    delete (globalThis as { document?: unknown }).document;
    delete (globalThis as { window?: unknown }).window;
    delete (globalThis as { IS_REACT_ACT_ENVIRONMENT?: unknown }).IS_REACT_ACT_ENVIRONMENT;
  });

  it("提供 onOpenSidePaneFiles 时挂载按钮，点击以整行 tab 调用回调", async () => {
    const tab = createWorkspaceTab();
    const onOpenSidePaneFiles = vi.fn();
    const handle = await renderSidebarItem(tab, onOpenSidePaneFiles);

    const button = findFilesActionButton();
    expect(button).toBeDefined();
    expect(button?.testId).toBe(testId(TID_WORKSPACE_SIDE_PANE_FILES_BUTTON, tab.workspacePath));

    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const onClick = button?.onClick as (event: unknown) => void | undefined;
    onClick?.({ preventDefault, stopPropagation });
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(onOpenSidePaneFiles).toHaveBeenCalledTimes(1);
    expect(onOpenSidePaneFiles).toHaveBeenCalledWith(tab);

    handle.unmount();
  });

  it("未接 onOpenSidePaneFiles 时不挂载按钮（ShellLayout 漏传即用户可见回归）", async () => {
    const handle = await renderSidebarItem(createWorkspaceTab());

    expect(findFilesActionButton()).toBeUndefined();

    handle.unmount();
  });

  it("断连的远程工作区不挂载按钮", async () => {
    const tab = createWorkspaceTab({ workspaceIdentity: "ws-identity" });
    const handle = await renderSidebarItem(tab, vi.fn());

    expect(findFilesActionButton()).toBeUndefined();

    handle.unmount();
  });

  it("本地目录不可用的只读工作区保留按钮但标注不可用原因", async () => {
    const tab = createWorkspaceTab({ availability: "unavailable-local-directory" });
    const onOpenSidePaneFiles = vi.fn();
    const handle = await renderSidebarItem(tab, onOpenSidePaneFiles);

    const button = findFilesActionButton();
    expect(button).toBeDefined();
    expect(button?.disabledReason).toBe("workspaceSidebar.unavailableLocalDirectory");

    handle.unmount();
  });
});
