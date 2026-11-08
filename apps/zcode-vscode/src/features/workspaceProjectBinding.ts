/**
 * IDE 工作区 → 本地工程绑定（spec: ide-workspace-project-binding）。
 *
 * 插件是 workspace-first 入口：聊天面没有项目导航上下文，任务创建时 projectId 为空，
 * 侧栏「项目」分组里看不到 IDE 当前打开的工程，用户感知为「新建任务不识别当前工程」。
 * 这里在服务装配完成后把 IDE 打开的每个 folder 注册为本地工程（幂等：已有声明该根
 * 目录的工程就复用），配合 reserveCreatedTask 的按根目录精确归属，新任务落进该工程。
 * 注册失败只记诊断日志——绑定缺失降级为现状（任务未归类），不阻断对话面。
 */

import { resolve } from "node:path";
import type { IProjectService } from "@zcode/services";
import { log } from "./logger";
import { isTransientWorkspacePath } from "./transientWorkspacePath";

export interface WorkspaceProjectBindingDeps {
  /** IDE 当前打开的全部 folder 绝对路径（每次调用取实时快照）。 */
  readonly listFolders: () => readonly string[];
  /** 工程服务（未装配完成/不可用时返回 undefined，绑定静默跳过）。 */
  readonly getProjectService: () => IProjectService | undefined;
}

/**
 * 根目录比对键（**唯一口径**）。
 *
 * 不能用 `normalize`：`normalize("/a/b/") === "/a/b/"`、`normalize("/a/b") === "/a/b"`
 * ——尾斜杠不归一（已实测），同一工程用两种写法就会各注册一次，产出 ws(1)/ws(2) 这类
 * 空工程（与"任务列表无限创建 ws (N)"同一类数据污染）。
 * `resolve` 会补全绝对路径、折叠 `.`/`..` 并**去掉尾斜杠**，是稳定的比对键。
 * 注意它不解析 symlink（与现实路径语义一致：VS Code 给的 folder 已是 realpath）。
 */
function rootKey(rootPath: string): string {
  return resolve(rootPath);
}

/**
 * 幂等注册：已有非软删工程精确声明该根目录 → 复用；未命中 → saveProject 新建
 * （不传 name，工程名按 basename 自动派生且 name_overridden=0，用户可后续改名）。
 * 单 folder 失败不影响其余 folder；整体失败也不抛出（调用方 fire-and-forget）。
 */
export async function ensureWorkspaceProjectBinding(
  deps: WorkspaceProjectBindingDeps,
): Promise<void> {
  const service = deps.getProjectService();
  if (!service) return;
  const folders = [...new Set(deps.listFolders())]
    .filter((folder) => folder.trim())
    .filter((folder) => {
      if (!isTransientWorkspacePath(folder)) return true;
      log.debug("project-binding", `跳过临时工作区（不登记工程）：${folder}`);
      return false;
    });
  if (folders.length === 0) return;
  try {
    const tree = await service.readTree({ includeDeleted: false });
    // saveProject 会 normalize roots；比对必须在同一口径下做（见 rootKey 注释）。
    const claimedRoots = new Set(
      tree.projects
        .filter((project) => !project.deleted)
        .flatMap((project) => project.roots.map((root) => rootKey(root.rootPath))),
    );
    for (const folder of folders) {
      const key = rootKey(folder);
      if (claimedRoots.has(key)) continue;
      await service.saveProject({ roots: [folder], primaryRoot: folder });
      // **必须回写**：同一批 folders 里若有两个等价写法（尾斜杠/相对段），
      // 不回写就会各自再注册一次，产出重复空工程。
      claimedRoots.add(key);
      log.debug("project-binding", `已注册 IDE 工程：${folder}`);
    }
  } catch (error) {
    // 降级为现状（任务未归类），不阻断对话面；诊断里可查原因。
    log.warn(
      "project-binding",
      `IDE 工程注册失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
