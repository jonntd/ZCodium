/**
 * composer/mentionSource.ts — @file 补全数据源（T09 webview 半，降级口径）。
 *
 * 数据面：file 频道（IFileService.searchWorkspaceFiles，桥白名单频道）+ workspace
 * folders（bootstrap / host workspace 帧）。复用 ui fileMentionProvider 的投影规则
 * （label=basename、value=相对路径、markdown=[name](./path)），把「根目录 × 查询」
 * 收敛为去重的 MentionItem 列表。
 *
 * - @symbol、代码库索引：明确不做（PRD P1-4.3 降级口径）；
 * - 跨 root 命中保留绝对路径 mention（与 ui fileMentionProvider 同口径）；
 * - 纯函数 + 服务注入面：vitest 直测（test/injection.test.ts）。
 */

import type { IFileService } from "@zcode/services";
import type { WorkspaceFileEntry } from "@zcode/shared";

/** ui composer 消费的 mention 预填形状（ComposerMentionPrefill 结构面）。 */
export interface FileMentionItem {
  id: string;
  category: "files";
  label: string;
  value: string;
  markdown: string;
  description: string;
  data: { kind: "file" | "directory"; path: string; relativePath: string };
}

/** 单条文件命中 → mention item（与 ui fileMentionProvider.mapWorkspaceFileToMentionItem 同口径）。 */
export function toFileMentionItem(entry: WorkspaceFileEntry, workspacePath: string): FileMentionItem {
  const sameRoot = normalize(entry.path).startsWith(normalize(workspacePath));
  const mentionPath = sameRoot ? entry.relativePath : entry.path;
  const label = entry.name;
  return {
    id: `file:${entry.path}`,
    category: "files",
    label,
    value: mentionPath,
    markdown: buildMarkdown(mentionPath, label, entry.type),
    description: entry.relativePath,
    data: { kind: entry.type, path: entry.path, relativePath: entry.relativePath },
  };
}

/** 提及插入请求（requestComposerTextInsert 的 text+mention 组装；纯函数可测）。 */
export function buildMentionInsertRequest(item: FileMentionItem): {
  text: string;
  mention: { id: string; category: "files"; label: string; value: string; markdown: string; description: string; data: FileMentionItem["data"] };
} {
  return { text: `${item.markdown} `, mention: { ...item } };
}

/**
 * 多根查询：workspacePath 优先，folders 里剩余 root 各查一遍，按 path 去重。
 * 失败的 root 不拖垮整体（收集错误文本，UI 显示）。
 */
export async function searchWorkspaceFileMentions(params: {
  fileService: Pick<IFileService, "searchWorkspaceFiles">;
  workspacePath: string;
  folders: readonly string[];
  query: string;
  limit?: number;
}): Promise<{ items: FileMentionItem[]; errors: string[] }> {
  const limit = params.limit ?? 50;
  const roots = [...new Set([params.workspacePath, ...params.folders].filter(Boolean))];
  const errors: string[] = [];
  const byPath = new Map<string, FileMentionItem>();
  for (const rootPath of roots) {
    try {
      const entries = await params.fileService.searchWorkspaceFiles({
        rootPath,
        query: params.query,
        limit,
      });
      for (const entry of entries ?? []) {
        if (!byPath.has(entry.path)) {
          byPath.set(entry.path, toFileMentionItem(entry, params.workspacePath));
        }
      }
    } catch (error) {
      errors.push(`${rootPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { items: [...byPath.values()].slice(0, limit), errors };
}

// ── 本地工具（避免 import ui 组件链；格式与 ui mentionMarkdown 一字不差） ──

function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

function buildMarkdown(mentionPath: string, label: string, kind: "file" | "directory"): string {
  const normalized = kind === "directory"
    ? `${mentionPath.replace(/[\\/]+$/, "")}/`
    : mentionPath.trim();
  const destination = normalized.startsWith("/") || /^\w+:/.test(normalized)
    ? normalized
    : `./${normalized}`;
  const escapedLabel = label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  return `[${escapedLabel}](${destination.replaceAll(">", "\\>")})`;
}
