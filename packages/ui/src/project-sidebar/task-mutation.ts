import { parseRemoteWorkspaceIdentity } from "@zcode/shared";
import type {
  ProjectTaskRef,
  IZCodeTaskService,
  IWindowControllerService,
  WindowHostControllerMutation,
  WindowHostTaskAddress,
} from "@/project-sidebar/contract.js";
export type ProjectTaskMutation = Exclude<
  WindowHostControllerMutation,
  { kind: "open" | "resume" }
>;
interface ProjectTaskPorts {
  service: IZCodeTaskService;
  controller?: IWindowControllerService;
}
function taskAddress(task: ProjectTaskRef, remoteSessionId?: string | null): WindowHostTaskAddress {
  const identity = parseRemoteWorkspaceIdentity(task.workspaceIdentity ?? "");
  return {
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
    ...(remoteSessionId ? { remoteSessionId } : {}),
    ...(identity?.kind === "server" ? { sourceServerId: identity.sourceServerId } : {}),
  };
}

/**
 * 纯本地任务判定：无 workspace identity、无远端 session、非 Source Server。
 * 修复原因（应用反馈「归档任务失败/删除不了任务」）：controller 代理恒为真值对象
 * （RemoteServiceAccess 无条件构造频道代理），而插件 host 的 ServiceCollection 不注册
 * IWindowControllerService——`ports.controller` 分支把本地任务的写操作发到不存在的
 * 频道，约 1s 后拒绝，表现成 toast「归档任务失败」且 host 侧零日志（CDP 自动化实测）。
 * 桌面 controller 对本地地址的解析终点同样是本机 task service，直连语义等价；
 * 远端/跨 Source 任务保持 controller 路由不变。
 */
function isLocalDirectTask(
  address: WindowHostTaskAddress,
  remoteSessionId?: string | null,
): boolean {
  return (
    !address.workspaceIdentity?.trim() &&
    !address.sourceServerId &&
    !remoteSessionId
  );
}

/** 已查看事件读取唯一 owner 的 marker；不借用 UI 行缓存，也不跨 Source 使用本机服务。 */
export function readProjectTaskMeta(
  ports: ProjectTaskPorts,
  task: ProjectTaskRef,
  remoteSessionId?: string,
) {
  const address = taskAddress(task, remoteSessionId);
  if (ports.controller && !isLocalDirectTask(address, remoteSessionId)) {
    return ports.controller.getTaskMeta({ address });
  }
  return ports.service.getTaskMeta({
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
  });
}
/** 两个列表入口共用完整地址与命令路由；组织态和 CLI 事实仍各自只由原 owner 写入。 */
export async function mutateProjectTask(
  ports: ProjectTaskPorts,
  task: ProjectTaskRef,
  mutation: ProjectTaskMutation,
  remoteSessionId?: string | null,
) {
  const target = {
    workspacePath: task.workspacePath,
    workspaceIdentity: task.workspaceIdentity,
    taskId: task.taskId,
  };
  const address = taskAddress(task, remoteSessionId);
  if (ports.controller && !isLocalDirectTask(address, remoteSessionId)) {
    return ports.controller.mutateTask({ address, mutation });
  }
  switch (mutation.kind) {
    case "archive":
      return mutation.archived
        ? ports.service.archiveTask(target)
        : ports.service.unarchiveTask(target);
    case "delete":
      await ports.service.deleteTask(target);
      return null;
    case "rename":
      return ports.service.renameTask({ ...target, title: mutation.title });
    case "pin":
      return ports.service.setTaskPinned({ ...target, pinned: mutation.pinned });
    case "mark-read":
      return ports.service.setTaskUnread({
        ...target,
        unread: false,
        expectedUnreadAt: mutation.expectedUnreadAt,
      });
    case "mark-unread":
      return ports.service.setTaskUnread({ ...target, unread: true });
  }
}
