import type { CodeViewerWorkspaceScope } from "@/lib/codeViewerWorkspaceScope.js";
import type { MultiFileDiffCodeViewerSource } from "@/lib/codeViewer.js";

/**
 * 与当前文件对比（spec: docs/spec/side-pane-file-preview.md §8）的纯组装逻辑：
 * 基线（内嵌预览当前文件）→ 目标（右键的文件行），产出 multi-file-diff source
 * 交给既有 code-viewer 标签链路。sourceKey 会纳入双方内容哈希，同一对文件
 * 重复对比复用同一标签，任一侧内容变化则新开。
 */
export function buildFileCompareDiffSource(params: {
  baseline: { path: string; title: string };
  target: { path: string; title: string };
  baselineContent: string;
  targetContent: string;
  scope: CodeViewerWorkspaceScope;
}): MultiFileDiffCodeViewerSource {
  return {
    type: "multi-file-diff",
    title: `${params.baseline.title} → ${params.target.title}`,
    path: params.target.path,
    beforeContent: params.baselineContent,
    afterContent: params.targetContent,
    ...params.scope,
  };
}
