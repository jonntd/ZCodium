/**
 * folderSelector — 多根工作区 folder 切换 webview 半（T06；P1-2）。
 *
 * 组2 host 半（SessionsIndexBridge.pickWorkspaceFolder）经 plat 方法
 * `pickWorkspaceFolder` 暴露（PLATFORM_METHOD_WHITELIST，container 注入
 * window.showQuickPick）：单 folder 直接命中、多根走 QuickPick、取消返回 null。
 * webview 侧只做装配：plat 面缺失时明确降级（不猜语义、不本地弹 UI）。
 */

import { folderKey } from "../session/workspaceSessions";

/** 平台 folder 选择面（VscodePlatformService 实现；IPlatformService 插件扩展）。 */
export interface FolderPickerPort {
  pickWorkspaceFolder?(): Promise<string | null>;
}

/** 单 folder 直接命中（跳过 RPC，P1-2.1 单根不显示入口的兜底路径）。 */
export function singleFolderOrNull(folders: readonly string[]): string | null {
  if (folders.length === 0) return null;
  if (folders.length === 1) return folderKey(folders[0] ?? "");
  return null;
}

/**
 * 多根 folder 切换（P1-2）：单根直接命中；多根调组2 plat QuickPick；
 * plat 面缺失/取消 → null（调用方保持当前 folder）。
 */
export async function selectWorkspaceFolder(
  platform: FolderPickerPort,
  folders: readonly string[],
): Promise<string | null> {
  const single = singleFolderOrNull(folders);
  if (single !== null) return single;
  if (typeof platform.pickWorkspaceFolder === "function") {
    const picked = await platform.pickWorkspaceFolder();
    return typeof picked === "string" && picked ? folderKey(picked) : null;
  }
  return null;
}

/** 多根工作区判定（P1-2.1：单根隐藏切换入口）。 */
export function isMultiRootWorkspace(folders: readonly string[]): boolean {
  return folders.length > 1;
}

/** fsPath → 展示名（目录 basename；根路径回退原样）。 */
export function folderLabel(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}
