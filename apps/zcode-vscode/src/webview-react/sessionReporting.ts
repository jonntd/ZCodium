/**
 * 会话归属上报的迁移决策面（纯函数，vitest 直测）。
 *
 * 事故背景（2026-11-22）：App.tsx 的上报读 App/bootstrap 层 key——面板页签切换后
 * 该 key 冻结在 bootstrap folder，别的 folder 创建的会话被记到错误 folder 名下
 * （per-folder 恢复键污染 + pending-changes 错绑），且可见工作区内的删除不可见。
 * 落点 key 修复后（spec: composer-insert-delivery「落点 key」规则），上报跟随
 * 可见对话区；本函数锁死迁移语义：
 *
 * - 挂载基线（previous=null）不报——host 已按恢复键 setActiveSession，重复上报
 *   只会多写一次幂等键；
 * - 切页签**不是删除**：旧会话仍活着、其 folder 恢复键保持不动；新页签有会话则
 *   重报归属（host setActiveSession/setSession 幂等，pending-changes 跟随可见会话）；
 * - 同工作区内 activeTaskId→null 不等于删除（「新建会话/回草稿」同样产生该迁移），
 *   是否报删除由调用方经 shouldReportSessionDeleted 判定面传入。
 */

export interface SessionReportAnchor {
  /** 会话归属的 workspace key（identity?.trim()||path 归一化后，仅用于相等比较）。 */
  workspaceKey: string;
  /** 创建上报用的原始 folder 路径（host 按 folderKey(folder) 归一，key ≠ path 场景不能混用）。 */
  folderPath: string;
  taskId: string | null;
}

export type SessionReportAction =
  | { kind: "none" }
  | { kind: "created"; folder: string; sessionId: string }
  | { kind: "deleted"; sessionId: string };

export function resolveSessionReportAction(
  previous: SessionReportAnchor | null,
  target: SessionReportAnchor,
  /** 删除判定面：会话确认已不在已知任务集时为 true（shouldReportSessionDeleted）。 */
  isDeleted: (sessionId: string) => boolean,
): SessionReportAction {
  if (!previous) return { kind: "none" };
  if (previous.workspaceKey === target.workspaceKey) {
    if (previous.taskId === target.taskId) return { kind: "none" };
    if (target.taskId) {
      return { kind: "created", folder: target.folderPath, sessionId: target.taskId };
    }
    // 同工作区内会话消失：确认真删才报（回草稿/新建不误清恢复键）。
    return previous.taskId && isDeleted(previous.taskId)
      ? { kind: "deleted", sessionId: previous.taskId }
      : { kind: "none" };
  }
  // 切页签：旧会话不报删除；新页签有会话则重报归属（幂等）。
  return target.taskId
    ? { kind: "created", folder: target.folderPath, sessionId: target.taskId }
    : { kind: "none" };
}
