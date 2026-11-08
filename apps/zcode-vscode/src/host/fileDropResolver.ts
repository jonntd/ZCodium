/**
 * FileDropResolver — 资源管理器拖拽 URI → 可附加本地文件的纯层（spec: composer-explorer-file-drop）。
 *
 * 职责边界：uri→路径转换与 stat 都经注入 IO 提供，本文件不含 vscode / fs 依赖，
 * 便于在 vitest 中用假 IO 覆盖全部过滤语义。container.ts 负责接线
 * （`vscode.Uri.parse(uri).fsPath` + `fs.promises.stat`），保证 Windows 盘符/UNC
 * 与百分号编码语义在 host 侧唯一处理。
 */

export interface FileDropEntry {
  path: string;
  sizeBytes: number;
}

export interface FileDropResolverIo {
  /** file:// URI → 本机路径；非 file scheme 或解析失败返回 null。 */
  uriToPath(uri: string): string | null;
  /** 单路径 stat；缺失/不可访问返回 null，isFile=false 表示目录等非普通文件。 */
  statFile(
    path: string,
  ): Promise<{ isFile: boolean; sizeBytes: number } | null>;
}

/** 单文件大小上限（性能审查 P4）：超限文件静默过滤（composer 不产生 chip）。
 * 附件走 CLI 上下文注入，20MB 已远超实用文本面；不设上限则误拖大文件
 * （视频/数据集/虚拟机镜像）会直接进入附件链路拖垮会话。 */
export const MAX_FILE_DROP_BYTES = 20 * 1024 * 1024;

/**
 * 逐条解析拖拽 URI：URI 去重（保持原序）→ 过滤非 file:// → 路径去重 →
 * 过滤缺失/目录/不可访问/超限。单条失败不影响其余条目；全部不可用返回空数组
 * （composer 静默不产生 chip）。
 */
export async function resolveFileDropUris(
  uris: readonly string[],
  io: FileDropResolverIo,
  options: { maxFileBytes?: number } = {},
): Promise<FileDropEntry[]> {
  const maxFileBytes = options.maxFileBytes ?? MAX_FILE_DROP_BYTES;
  const entries: FileDropEntry[] = [];
  const seenUris = new Set<string>();
  const seenPaths = new Set<string>();
  for (const uri of uris) {
    if (typeof uri !== "string" || !uri || seenUris.has(uri)) {
      continue;
    }
    seenUris.add(uri);
    const path = io.uriToPath(uri);
    if (!path || seenPaths.has(path)) {
      continue;
    }
    seenPaths.add(path);
    try {
      const stat = await io.statFile(path);
      if (!stat?.isFile || stat.sizeBytes > maxFileBytes) {
        continue;
      }
      entries.push({ path, sizeBytes: stat.sizeBytes });
    } catch {
      // 单条 stat 异常（权限/竞争删除）按缺失处理，不中断其余条目。
      continue;
    }
  }
  return entries;
}
