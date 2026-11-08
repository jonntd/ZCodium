import type { IZCodeSessionService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeSessionService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeSessionService {
  // 修复原因：此前按 workspacePath 真值条件调用 useWorkspaceServices/useServices，
  // 两次渲染间 workspacePath 翻转（如任务乐观更新触发的重渲染）时 hook 数量变化，
  // React hook 顺序错位——useCallback 落到非 callback 槽位，deps 比较器读
  // undefined.length 抛 TypeError（实测表现为侧栏任意 setState 后「归档任务失败」，
  // 自动化 CDP 复现堆栈 LUe ← BAt[useCallback] ← useZCodeSessionService ← useSettingsSync）。
  // 两个 hook 改为无条件调用、按条件选择结果：hook 顺序恒定，语义与原先一致
  //（有 path 用 workspace 解析，无 path 用当前上下文 services）。
  const contextServices = useServices();
  const scopedServices = useWorkspaceServices(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  return (workspacePath ? scopedServices : contextServices).zcodeSessionService;
}
