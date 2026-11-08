import type { IZCodeAgentService } from "@zcode/services";
import { useServices } from "@/hooks/useServices.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";

export function useZCodeAgentService(
  workspacePath?: string,
  preferredRemoteSessionId?: string | null,
  workspaceIdentity?: string | null,
): IZCodeAgentService {
  // 修复原因：与 useZCodeSessionService 同型——按 workspacePath 真值条件调用 hooks，
  // workspacePath 跨渲染翻转时 hook 顺序错位（React deps 比较器读 undefined.length 崩溃）。
  // 两个 hook 无条件调用、按条件选择结果，顺序恒定，语义不变。
  const contextServices = useServices();
  const scopedServices = useWorkspaceServices(
    workspacePath,
    preferredRemoteSessionId,
    workspaceIdentity,
  );
  const services = workspacePath ? scopedServices : contextServices;
  return services.zcodeAgentService;
}
