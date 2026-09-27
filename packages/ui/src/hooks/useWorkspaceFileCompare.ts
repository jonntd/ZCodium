import { useCallback } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { CodeViewerWorkspaceScope } from "@/lib/codeViewerWorkspaceScope.js";
import type { MultiFileDiffCodeViewerSource } from "@/lib/codeViewer.js";
import { buildFileCompareDiffSource } from "@/workspace-file-tree/fileCompare.js";

export interface FileCompareEndpoint {
  path: string;
  title: string;
}

/**
 * 与当前文件对比（spec: docs/spec/side-pane-file-preview.md §8）：读取基线与目标
 * 两个文件的全文（fileService.readTextFile 各自受 256KB 上限约束），组装
 * multi-file-diff source。任一文件为二进制或被截断（超上限）时抛错，由调用方
 * toast 失败文案；内容读取一律经 workspace 作用域的 fileService，远程 workspace
 * 由正确 host 读取。
 */
export function useWorkspaceFileCompare(options: {
  services: IServiceAccessor;
  scope: CodeViewerWorkspaceScope;
}) {
  const { services, scope } = options;
  return useCallback(
    async (
      baseline: FileCompareEndpoint,
      target: FileCompareEndpoint,
    ): Promise<MultiFileDiffCodeViewerSource> => {
      const [before, after] = await Promise.all([
        services.fileService.readTextFile({ path: baseline.path }),
        services.fileService.readTextFile({ path: target.path }),
      ]);
      // 截断（>256KB）或二进制文件的 diff 会误导（内容不完整/乱码），直接判失败。
      if (before.isBinary || after.isBinary || before.truncated || after.truncated) {
        throw new Error("file-compare-unavailable");
      }
      return buildFileCompareDiffSource({
        baseline,
        target,
        baselineContent: before.content,
        targetContent: after.content,
        scope,
      });
    },
    [services, scope],
  );
}
