/**
 * 路径包含校验（纯层）：webview 可达的文件读/stat 面必须收敛到 workspace 内。
 *
 * 背景（安全审查 S1/S2）：`openPatchDiffInEditor` 会把任意路径的文件内容读进
 * diff 面板——没有包含校验时，webview 侧的漏洞即可升级为任意文件读取。
 * 校验语义：normalize 后逐段前缀匹配（`/a/b` 不匹配 `/a/bc`，只匹配其子路径）；
 * 本体匹配（路径 == folder）视为包含。Windows 盘符大小写不敏感；POSIX 大小写敏感。
 *
 * 本文件不含 vscode 依赖，vitest 直接覆盖；container 用
 * `workspace.workspaceFolders.map(f => f.uri.fsPath)` 喂入。
 */

/** 归一化路径：统一分隔符为 `/`，折叠 `.`/`..` 段与重复分隔符，去尾部 `/`。 */
export function normalizeFsPath(path: string): string {
  const isWindowsLike = /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
  const drive = isWindowsLike ? (path.match(/^[A-Za-z]:/)?.[0] ?? "").toLowerCase() : "";
  const segments: string[] = [];
  for (const segment of path.slice(drive.length).split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      // 根（POSIX `/` 或 Windows 盘符根）的 ".." 停在根。
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  if (drive) return joined ? `${drive}/${joined}` : `${drive}/`;
  return joined ? `/${joined}` : "/";
}

/** 比较 key：Windows 盘符路径大小写不敏感，其余敏感。 */
function compareKey(path: string): string {
  return /^[A-Za-z]:\//.test(path) ? path.toLowerCase() : path;
}

/**
 * 路径是否位于任一 workspace folder 内（folder 本体也算）。
 * folders 为空（无工作区）→ 一律 false（fail-closed）。
 */
export function isPathInsideWorkspace(
  path: string,
  workspaceFolders: readonly string[],
): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  if (workspaceFolders.length === 0) return false;
  const normalized = normalizeFsPath(path);
  const key = compareKey(normalized);
  return workspaceFolders.some((folder) => {
    if (typeof folder !== "string" || folder.length === 0) return false;
    const folderKey = compareKey(normalizeFsPath(folder));
    return key === folderKey || key.startsWith(`${folderKey}/`);
  });
}
