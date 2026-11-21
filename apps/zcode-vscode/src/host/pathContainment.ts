/**
 * 路径包含校验（纯层）：webview 可达的文件读/stat 面必须收敛到 workspace 内。
 *
 * 背景（安全审查 S1/S2）：`openPatchDiffInEditor` 会把任意路径的文件内容读进
 * diff 面板——没有包含校验时，webview 侧的漏洞即可升级为任意文件读取。
 * 校验语义：normalize 后逐段前缀匹配（`/a/b` 不匹配 `/a/bc`，只匹配其子路径）；
 * 本体匹配（路径 == folder）视为包含。Windows 盘符路径与 UNC 路径大小写不敏感；
 * POSIX 大小写敏感。`\` 仅在 Windows 形路径（盘符/UNC）上作分隔符——POSIX 上它是
 * 合法文件名字符，折叠会把 `/a/b\x` 与 `/a/b/x` 混同（fail-open 越界放行）。
 *
 * 本文件不含 vscode 依赖，vitest 直接覆盖；container 用
 * `workspace.workspaceFolders.map(f => f.uri.fsPath)` 喂入。
 */

/** 判断原始路径是否 Windows 形（盘符路径或 UNC 路径），决定 `\` 是否作分隔符与大小写口径。 */
function isWindowsLikePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

/** 归一化路径：统一分隔符为 `/`，折叠 `.`/`..` 段与重复分隔符，去尾部 `/`。 */
export function normalizeFsPath(path: string): string {
  const isWindowsLike = isWindowsLikePath(path);
  const drive = isWindowsLike ? (path.match(/^[A-Za-z]:/)?.[0] ?? "").toLowerCase() : "";
  // 修复（安全）：`\` 只有 Windows 形路径才当分隔符。此前 POSIX 路径也按 [\\/]+ 折叠，
  // 文件名含 `\` 时包含判定失真：`/a/b\x`（实际在 `/a` 下）被误判进 `/a/b`（fail-open），
  // 反向还会把真实目录 `/a/b\c` 与 `/a/b/c` 混同。
  const separatorPattern = isWindowsLike ? /[\\/]+/ : /\/+/;
  const segments: string[] = [];
  for (const segment of path.slice(drive.length).split(separatorPattern)) {
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

/**
 * 比较 key：Windows 盘符路径与 UNC 路径大小写不敏感（底层文件系统大小写不敏感），
 * 其余（POSIX）敏感。修复依据：此前只对盘符路径做小写归一，
 * UNC 工作区 `\\SERVER\share` 与 `\\server\share` 被按大小写敏感比较而误拒。
 * 注意：入参必须是原始路径——归一化后的 UNC 与 POSIX 形状相同，
 * Windows 口径标志只能从原始路径判定。
 */
function compareKey(rawPath: string): string {
  const normalized = normalizeFsPath(rawPath);
  return isWindowsLikePath(rawPath) ? normalized.toLowerCase() : normalized;
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
  const key = compareKey(path);
  return workspaceFolders.some((folder) => {
    if (typeof folder !== "string" || folder.length === 0) return false;
    const folderKey = compareKey(folder);
    // 修复：folder 为根（POSIX `/` 或盘符根 `c:/`）时，`${folderKey}/` 会拼出 `//`/`c://`
    // 永不匹配，除根本体外的全部合法子路径被误拒（fail-closed 误伤所有读面）。
    const prefix = folderKey.endsWith("/") ? folderKey : `${folderKey}/`;
    return key === folderKey || key.startsWith(prefix);
  });
}
