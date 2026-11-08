/**
 * ChangesDiffOpener — 待审改动的原生双栏 diff（spec §5）。
 *
 * 左栏 = 改动前内容（当前磁盘内容反向应用 patch 重构，zcode-before 虚拟文档）；
 * 右栏 = 当前磁盘文件；文件被 AI 删除时右栏为空虚拟文档。
 * 范式同 features/quickEdit.ts 的 vscode.diff 用法；自持 scheme 与内容表，
 * 不复用 DiffViewer 的 zcodium-proposed（避免与审批 diff 生命周期互相干扰）。
 */

import type { Disposable, TextDocumentContentProvider } from "vscode";
import { Uri, commands, workspace } from "vscode";
import { reverseApplyPatches } from "./beforeContent";

const SCHEME = "zcode-before";

/** 内容缓存上限（安全/性能审查 P3）：每次打开 diff 缓存整文件内容（before +
 * deleted 两份），不淘汰则长会话多次打开 = 无界增长（内存泄漏）。LRU 容量 8：
 * 只服务当前打开的 diff 面板（preview 复用同 key），8 个远超同屏可见面板数。 */
const MAX_DIFF_CACHE_ENTRIES = 8;

export class ChangesDiffOpener {
  private readonly contents = new Map<string, string>();
  private seq = 0;

  /** 注册内容提供器（容器 activate 时调用一次并纳入 subscriptions）。 */
  register(): Disposable {
    const provider: TextDocumentContentProvider = {
      provideTextDocumentContent: (uri: Uri): string => this.contents.get(uri.fragment) ?? "",
    };
    return workspace.registerTextDocumentContentProvider(SCHEME, provider);
  }

  dispose(): void {
    this.contents.clear();
  }

  /** 写缓存 + LRU 淘汰：Map 迭代序即插入序，淘汰最旧条目（读不刷新，容量小无需真 LRU）。 */
  private cacheSet(key: string, value: string): void {
    this.contents.set(key, value);
    while (this.contents.size > MAX_DIFF_CACHE_ENTRIES) {
      const oldest = this.contents.keys().next();
      if (oldest.done) break;
      this.contents.delete(oldest.value);
    }
  }

  /**
   * 打开待审 diff。before 重构失败（patches 与当前内容对不上）时降级：
   * 左栏为空并提示用户以聊天内文件卡片为准。
   */
  async openPendingDiff(request: {
    resolvedPath: string;
    patches: readonly { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: readonly string[] }[];
  }): Promise<void> {
    const { resolvedPath, patches } = request;
    this.seq += 1;
    const key = `before-${this.seq}`;
    let currentContent: string | null = null;
    try {
      currentContent = new TextDecoder().decode(await workspace.fs.readFile(Uri.file(resolvedPath)));
    } catch {
      currentContent = null;
    }
    const beforeContent =
      currentContent !== null ? reverseApplyPatches(currentContent, patches) : null;
    this.cacheSet(key, beforeContent ?? "");

    const beforeUri = Uri.parse(`${SCHEME}:/${encodeURIComponent(key)}.before#${key}`);
    // 文件已被 AI 删除：右栏用空虚拟文档（同 scheme），diff 呈现「整文件新增/删除」。
    const rightUri =
      currentContent !== null
        ? Uri.file(resolvedPath)
        : Uri.parse(`${SCHEME}:/deleted.right#${key}`);
    if (currentContent === null) this.cacheSet(`deleted.right#${key}`, "");

    const relative = workspace.asRelativePath(Uri.file(resolvedPath));
    await commands.executeCommand(
      "vscode.diff",
      beforeUri,
      rightUri,
      beforeContent === null
        ? `${relative}（改动前内容无法重构，请以聊天内文件卡片为准）`
        : `${relative}（改动前 ↔ 当前）`,
      { preview: true },
    );
  }
}
