import { create } from "zustand";

/**
 * 工作台顶栏状态提示（spec: workspace-header-status-hint）。
 *
 * 宿主壳层（VS Code/Antigravity 插件 webview 等）把链路降级、能力缺失等
 * 非操作型通知写入这里；WorkspaceHeader 只读渲染为标题区与操作区之间的紧凑 chip。
 * 通道用模块级 zustand 单例而非 prop 穿透：Root→RootWorkspaceContent→App→
 * ShellLayout→Header 五层共享组件链只为一枚 chip 穿线，改动面不成比例。
 * 桌面/Web 入口从不写入 → 恒为 null → header 零视觉变化。
 */
export interface WorkspaceHeaderHint {
  message: string;
  /** warning = 能力面缺失等需要警惕的降级；info = 弱化的链路/传输降级提示。 */
  tone: "warning" | "info";
}

interface WorkspaceHeaderHintState {
  hint: WorkspaceHeaderHint | null;
  /** 全量覆写（无 TTL、无累加）；传 null 即清除。 */
  setWorkspaceHeaderHint: (hint: WorkspaceHeaderHint | null) => void;
}

export const useWorkspaceHeaderHintStore = create<WorkspaceHeaderHintState>(
  (set) => ({
    hint: null,
    setWorkspaceHeaderHint: (hint) => set({ hint }),
  }),
);

export function useWorkspaceHeaderHint(): WorkspaceHeaderHint | null {
  return useWorkspaceHeaderHintStore((state) => state.hint);
}
