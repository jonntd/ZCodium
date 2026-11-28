/** fork no-telemetry 审计版垫片：上游遥测面按 AGENTS.md「已移除功能」约定移除后，
 *  为保留 v4.0.0 的调用点形状提供零上报实现——只走本地 logger，不产生任何网络请求。
 *  重新接通真实遥测时删除本垫片并恢复上游模块。 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

/** fork：首发配额提醒的本地去重状态（审计版无遥测，仅记录已读标记）。 */
export const useStartPlanQuotaReminderStore = create<{
  dismissedByTaskId: Record<string, boolean>;
  dismiss(taskId: string): void;
}>()(
  persist(
    (set) => ({
      dismissedByTaskId: {},
      dismiss: (taskId) =>
        set((state) => ({
          dismissedByTaskId: { ...state.dismissedByTaskId, [taskId]: true },
        })),
    }),
    { name: "start-plan-quota-reminder", storage: createJSONStorage(() => localStorage) },
  ),
);
