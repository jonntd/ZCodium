/**
 * resolveFileDropPaths 平台方法的 vscode/fs 接线（adapters 层）。
 *
 * 过滤语义（去重/目录/缺失过滤）在纯层 fileDropResolver.ts；Windows 盘符/UNC 与
 * 百分号编码转换统一在此经 vscode.Uri.parse(fsPath) 承担（spec: composer-explorer-file-drop）。
 * 无独立单测：vscode 依赖不可入 vitest，行为由纯层测试 + E2E 拖拽覆盖。
 */

import { stat } from "node:fs/promises";
import { Uri } from "vscode";
import {
  resolveFileDropUris,
  type FileDropResolverIo,
} from "./fileDropResolver";

/** PlatformMethodHandler 形态：(args) => unknown | Promise<unknown>（platformRpcHandler）。 */
export function createResolveFileDropPathsMethod(): (
  args: unknown[],
) => Promise<unknown> {
  const io: FileDropResolverIo = {
    uriToPath: (uri) => {
      let parsed: Uri;
      try {
        parsed = Uri.parse(uri);
      } catch {
        return null;
      }
      return parsed.scheme === "file" ? parsed.fsPath : null;
    },
    statFile: async (path) => {
      try {
        const info = await stat(path);
        return info.isFile() ? { isFile: true, sizeBytes: info.size } : null;
      } catch {
        return null;
      }
    },
  };
  return async (args) => {
    const uris = args[0];
    if (
      !Array.isArray(uris) ||
      uris.length === 0 ||
      uris.some((uri) => typeof uri !== "string")
    ) {
      throw new Error("resolveFileDropPaths: uris 必须为非空字符串数组");
    }
    return resolveFileDropUris(uris, io);
  };
}
