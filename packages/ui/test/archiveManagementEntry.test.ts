// @vitest-environment jsdom
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSettingsPageConfig } from "@/settings/settingsPageConfig.js";
import {
  consumePendingSettingsSection,
  readLastSettingsSectionPreference,
  setPendingSettingsSection,
  writeLastSettingsSectionPreference,
} from "@/lib/settingsNavigation.js";
import { ArchiveManagement } from "@/project-sidebar/ArchiveManagement.js";
import type { ProjectTask } from "@/project-sidebar/contract.js";

const { directory, controller, taskService, confirm, removeTaskState } = vi.hoisted(() => ({
  directory: {
    tree: { projects: [], tasks: [] as ProjectTask[] },
    directory: { hosts: [] },
    loading: false,
    error: null,
    refresh: vi.fn(async () => undefined),
  },
  controller: { mutateTask: vi.fn(async () => undefined) },
  taskService: {
    unarchiveTask: vi.fn(async () => undefined),
    deleteTask: vi.fn(async () => undefined),
    archiveTask: vi.fn(async () => undefined),
  },
  confirm: vi.fn(async () => false),
  removeTaskState: vi.fn(),
}));
vi.mock("@/project-sidebar/ProjectDirectoryProvider.js", () => ({
  ProjectDirectoryProvider: ({ children }: { children: ReactNode }) => children,
  useProjectDirectory: () => directory,
}));
vi.mock("@/project-sidebar/RemoteHostSection.js", () => ({ remoteHostLabel: () => undefined }));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  // 双通道：本地直连任务走 zcodeTaskService，远端/跨 Source 任务走 windowControllerService
  // （task-mutation.isLocalDirectTask 的语义，修「归档任务失败」后生效）。
  useBaseWorkspaceServices: () => ({
    zcodeTaskService: taskService,
    windowControllerService: controller,
  }),
}));
vi.mock("@/hooks/useResolvedRemoteWorkspaceSessionId.js", () => ({
  resolveRemoteWorkspaceSessionIdForTarget: () => undefined,
}));
vi.mock("@/store/remoteWorkspaceSessionStore.js", () => ({
  useRemoteWorkspaceSessionStore: { getState: () => ({}) },
}));
vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: (selector: (state: unknown) => unknown) => selector({ removeTaskState }),
}));
vi.mock("@/hooks/useConfirmDialog.js", () => ({ useConfirmDialog: () => confirm }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  directory.tree.tasks = ["restore", "delete"].map((id) => ({
    taskId: id,
    title: id,
    hostId: "local",
    projectId: null,
    workspacePath: "/navigation-fixture",
    pinned: false,
    archived: true,
    mode: "build",
    traceId: id,
    createdAt: 1,
    updatedAt: 2,
  }));
  confirm.mockResolvedValue(false);
});
afterEach(cleanup);

describe("#99 归档入口与既有管理路径", () => {
  it.each([{}, { isDesktop: true }, { isWindowsDesktop: true }, { isMacDesktop: true }])(
    "设置数据与统计在 %j 注册归档管理，导航意图和重启偏好不丢失",
    (options) => {
      const config = createSettingsPageConfig(options);
      expect(config.settingsSectionGroups.find((g) => g.id === "dataAndStats")?.sections).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "archives", titleId: "archives.nav" }),
        ]),
      );
      writeLastSettingsSectionPreference("archives");
      expect(readLastSettingsSectionPreference()).toBe("archives");
      setPendingSettingsSection("archives");
      expect(consumePendingSettingsSection()).toBe("archives");
    },
  );

  it("搜索/展开后取消归档直连本机 task service（本地直连不经 controller），刷新后该行消失", async () => {
    const view = render(createElement(ArchiveManagement));
    fireEvent.change(screen.getByTestId("archive-search"), { target: { value: "restore" } });
    fireEvent.click(screen.getByTestId("archive-group-toggle"));
    expect(screen.getAllByTestId("archive-task")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("archive-unarchive"));
    await waitFor(() => expect(directory.refresh).toHaveBeenCalledOnce());
    // 本地任务（无 identity、无 Source、无 session）按 isLocalDirectTask 语义直连本机
    // task service：controller 代理恒为真值但插件 host 不注册该频道，走 controller 会把
    // 写操作发到不存在的频道（应用反馈「归档任务失败/删除不了任务」的根因）。
    expect(taskService.unarchiveTask).toHaveBeenCalledExactlyOnceWith({
      workspacePath: "/navigation-fixture",
      workspaceIdentity: undefined,
      taskId: "restore",
    });
    expect(controller.mutateTask).not.toHaveBeenCalled();
    expect(removeTaskState).not.toHaveBeenCalled();
    directory.tree = {
      ...directory.tree,
      tasks: directory.tree.tasks.map((task) =>
        task.taskId === "restore" ? { ...task, archived: false } : task,
      ),
    };
    view.rerender(createElement(ArchiveManagement));
    expect(screen.queryByTestId("archive-task")).toBeNull();
  });

  it("取消删除不发命令，确认后只删除目标并清理该会话 UI", async () => {
    render(createElement(ArchiveManagement));
    fireEvent.click(screen.getByTestId("archive-group-toggle"));
    const row = screen.getAllByTestId("archive-task").find((el) => el.dataset.taskId === "delete")!;
    fireEvent.click(within(row).getByTestId("archive-delete"));
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(within(row).getByTestId("archive-delete").hasAttribute("disabled")).toBe(false),
    );
    expect(taskService.deleteTask).not.toHaveBeenCalled();
    confirm.mockResolvedValueOnce(true);
    fireEvent.click(within(row).getByTestId("archive-delete"));
    await waitFor(() => expect(directory.refresh).toHaveBeenCalledOnce());
    expect(taskService.deleteTask).toHaveBeenCalledExactlyOnceWith({
      workspacePath: "/navigation-fixture",
      workspaceIdentity: undefined,
      taskId: "delete",
    });
    expect(controller.mutateTask).not.toHaveBeenCalled();
    expect(removeTaskState).toHaveBeenCalledExactlyOnceWith(
      "/navigation-fixture",
      "delete",
      undefined,
    );
  });

  it("远端任务（带 workspace identity）保持 controller 路由并携带完整地址", async () => {
    directory.tree = {
      ...directory.tree,
      tasks: directory.tree.tasks.map((task) =>
        task.taskId === "restore"
          ? {
              ...task,
              workspacePath: "/remote/repo",
              workspaceIdentity: "remote:ssh:dev:/remote/repo",
            }
          : task,
      ),
    };
    render(createElement(ArchiveManagement));
    fireEvent.change(screen.getByTestId("archive-search"), { target: { value: "restore" } });
    fireEvent.click(screen.getByTestId("archive-group-toggle"));
    fireEvent.click(screen.getByTestId("archive-unarchive"));
    await waitFor(() => expect(directory.refresh).toHaveBeenCalledOnce());
    expect(controller.mutateTask).toHaveBeenCalledExactlyOnceWith({
      address: {
        workspacePath: "/remote/repo",
        workspaceIdentity: "remote:ssh:dev:/remote/repo",
        taskId: "restore",
      },
      mutation: { kind: "archive", archived: false },
    });
    expect(taskService.unarchiveTask).not.toHaveBeenCalled();
  });
});
