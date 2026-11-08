// mutateProjectTask/readProjectTaskMeta 路由契约（spec: docs/spec/sidebar-task-service-resolution.md）。
// 锚点：controller 代理恒真值——纯本地任务必须直连 service，否则插件（host 未注册
// window-controller 频道）的归档/删除打空频道 ~1s 拒绝；远端/跨 Source 保持 controller 路由。
import { describe, expect, it, vi } from "vitest";
import {
  mutateProjectTask,
  readProjectTaskMeta,
} from "@/project-sidebar/task-mutation.js";
import type { IZCodeTaskService, IWindowControllerService } from "@/project-sidebar/contract.js";

function ports() {
  const service = {
    getTaskMeta: vi.fn(async () => null),
    archiveTask: vi.fn(async () => ({ taskId: "t", title: "", workspacePath: "/w" }) as never),
    unarchiveTask: vi.fn(async () => ({}) as never),
    deleteTask: vi.fn(async () => undefined),
    renameTask: vi.fn(async () => ({}) as never),
    setTaskPinned: vi.fn(async () => ({}) as never),
    setTaskUnread: vi.fn(async () => ({}) as never),
  };
  const controller = {
    getTaskMeta: vi.fn(async () => null),
    mutateTask: vi.fn(async () => null),
  };
  return {
    service: service as unknown as IZCodeTaskService,
    controller: controller as unknown as IWindowControllerService,
    serviceMocks: service,
    controllerMocks: controller,
  };
}

const LOCAL_TASK = { workspacePath: "/Volumes/date/augment", taskId: "t1" };
const REMOTE_TASK = {
  workspacePath: "/remote",
  taskId: "t2",
  workspaceIdentity: "remote:ssh:dev:22:user:/remote",
};

describe("mutateProjectTask 本地直连路由", () => {
  it("本地任务（controller 在场）→ 直连 service.archiveTask，不经 controller", async () => {
    const p = ports();
    await mutateProjectTask(
      p,
      LOCAL_TASK,
      { kind: "archive", archived: true },
      undefined,
    );
    expect(p.serviceMocks.archiveTask).toHaveBeenCalledWith({
      workspacePath: "/Volumes/date/augment",
      workspaceIdentity: undefined,
      taskId: "t1",
    });
    expect(p.controllerMocks.mutateTask).not.toHaveBeenCalled();
  });

  it("远端任务 → 走 controller.mutateTask（保持跨 Source 路由）", async () => {
    const p = ports();
    await mutateProjectTask(p, REMOTE_TASK, { kind: "archive", archived: true }, "remote-sess");
    expect(p.controllerMocks.mutateTask).toHaveBeenCalledTimes(1);
    expect(p.serviceMocks.archiveTask).not.toHaveBeenCalled();
    const call = p.controllerMocks.mutateTask.mock.calls[0]?.[0];
    expect(call?.address.sourceServerId).toBeUndefined();
    expect(call?.address.remoteSessionId).toBe("remote-sess");
  });

  it("Source Server 身份任务 → 走 controller（即使无 remoteSessionId）", async () => {
    const p = ports();
    await mutateProjectTask(
      p,
      {
        workspacePath: "/srv-ws",
        taskId: "t3",
        workspaceIdentity: "server:src1:/srv-ws",
      },
      { kind: "delete" },
      undefined,
    );
    expect(p.controllerMocks.mutateTask).toHaveBeenCalledTimes(1);
    expect(p.serviceMocks.deleteTask).not.toHaveBeenCalled();
  });

  it("readProjectTaskMeta 同口径：本地直连，远端走 controller", async () => {
    const p = ports();
    await readProjectTaskMeta(p, LOCAL_TASK, undefined);
    expect(p.serviceMocks.getTaskMeta).toHaveBeenCalledTimes(1);
    expect(p.controllerMocks.getTaskMeta).not.toHaveBeenCalled();
    await readProjectTaskMeta(p, REMOTE_TASK, "remote-sess");
    expect(p.controllerMocks.getTaskMeta).toHaveBeenCalledTimes(1);
  });
});
