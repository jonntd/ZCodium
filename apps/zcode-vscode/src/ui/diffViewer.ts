/**
 * DiffViewer — 文件编辑审批的原生 diff 视图（P0-7）。
 *
 * - left = 磁盘当前内容，right = 提议内容，标题 `[待审批] <file>`；
 * - 提议内容不可从 permission.input 直接拿到时，退化为只读打开目标文件并提示；
 * - 应用后关闭对应 diff 标签页并提示。
 */

import { basename } from "node:path";
import type { TextDocumentContentProvider } from "vscode";
import { commands, Disposable, Uri, window, workspace } from "vscode";

const SCHEME = "zcodium-proposed";

/** 提议内容的内容提供器（diff 右侧虚拟文档）。 */
export class ProposedContentProvider implements TextDocumentContentProvider {
  /**
   * 内容上限（LRU）：审批 diff 的 close() 在审批流尚未接线时可能长期无人调用，
   * 无上限会随每次审批无界增长。范式同 pendingChanges/diffOpener（LRU 8）。
   */
  private static readonly MAX_CONTENTS = 8;
  private readonly contents = new Map<string, string>();

  provideTextDocumentContent(uri: Uri): string {
    return this.contents.get(uri.query) ?? "";
  }

  set(key: string, content: string): void {
    // Map 迭代按插入序：先删后放即 LRU 淘汰语义。
    this.contents.delete(key);
    this.contents.set(key, content);
    while (this.contents.size > ProposedContentProvider.MAX_CONTENTS) {
      const oldest = this.contents.keys().next().value;
      if (oldest === undefined) break;
      this.contents.delete(oldest);
    }
  }

  clear(key: string): void {
    this.contents.delete(key);
  }
}

export class DiffViewer {
  /**
   * openTabs 上限：close() 尚未接入审批流（2026-11-10 审查发现无调用方），
   * 超限时淘汰最老条目，防止 Map 随审批次数无界增长。
   */
  private static readonly MAX_OPEN_TABS = 16;
  private readonly openTabs = new Map<string, Uri>();
  private readonly provider = new ProposedContentProvider();
  private readonly providerDisposable: Disposable;

  constructor() {
    // 注册返回的 Disposable 必须留存并在 dispose() 注销：旧实现 void 丢弃后
    // provider 永远无法注销，违反「注册 Disposable 全量入 subscriptions」约定。
    this.providerDisposable = workspace.registerTextDocumentContentProvider(
      SCHEME,
      this.provider,
    );
  }

  dispose(): void {
    this.providerDisposable.dispose();
    this.openTabs.clear();
  }

  /** 从 permission.input 提取 {path, proposedContent}（键名按保守顺序探测）。 */
  static extractFileEdit(input: unknown): { path?: string; proposedContent?: string } {
    if (typeof input !== "object" || input === null) return {};
    const record = input as Record<string, unknown>;
    const pathKeys = ["path", "filePath", "file_path", "file", "absolute_path", "absolutePath"];
    const contentKeys = ["content", "newContent", "proposedContent", "proposed_content", "newString", "new_string"];
    let path: string | undefined;
    for (const key of pathKeys) {
      const value = record[key];
      if (typeof value === "string" && value.length > 0) {
        path = value;
        break;
      }
    }
    let proposedContent: string | undefined;
    for (const key of contentKeys) {
      const value = record[key];
      if (typeof value === "string") {
        proposedContent = value;
        break;
      }
    }
    return { path, proposedContent };
  }

  /**
   * 打开原生 diff。提议内容缺失时退化为只读打开目标文件。
   * 返回是否以 diff 形式打开（供 UI 提示）。
   */
  async open(requestId: string, path: string, proposedContent?: string): Promise<boolean> {
    const fileUri = Uri.file(path);
    if (proposedContent === undefined) {
      // 没有提议内容：只读打开文件供用户查看（审批仍走卡片）。
      try {
        await window.showTextDocument(fileUri, { preview: true });
      } catch {
        void window.showWarningMessage(`无法打开待审批文件：${path}`);
      }
      return false;
    }
    if (this.openTabs.size >= DiffViewer.MAX_OPEN_TABS) {
      const oldest = this.openTabs.keys().next().value;
      if (oldest !== undefined) {
        this.provider.clear(oldest);
        this.openTabs.delete(oldest);
      }
    }
    const proposedUri = Uri.parse(`${SCHEME}://proposal/${encodeURIComponent(path)}?${requestId}`);
    this.provider.set(requestId, proposedContent);
    this.openTabs.set(requestId, proposedUri);
    await workspace.openTextDocument(proposedUri);
    // 修复（2026-11-10 审查 B3）：旧实现只 openTextDocument(proposedUri)（内存建
    // 文档从不显示）+ showTextDocument(fileUri)，从未调用 vscode.diff——用户看到的
    // 是磁盘现状而非提议内容。补上原生双栏 diff（范式同 features/quickEdit.ts）。
    await commands.executeCommand(
      "vscode.diff",
      fileUri,
      proposedUri,
      `[待审批] ${basename(path)}`,
      { preview: true },
    );
    return true;
  }

  /** 应用（allow）后关闭对应 diff 标签页并提示。 */
  async close(requestId: string, path?: string): Promise<void> {
    const proposedUri = this.openTabs.get(requestId);
    this.provider.clear(requestId);
    this.openTabs.delete(requestId);
    if (proposedUri === undefined) return;
    for (const editor of window.tabGroups.all.flatMap((group) => group.tabs)) {
      const input = editor.input as { uri?: Uri; modified?: Uri } | undefined;
      // vscode.diff 页签的 input 是 TabInputTextDiff（modified = proposedUri）；
      // 旧实现只取 input.uri，对 diff 页签永远匹配不上、永远关不掉。
      const tabUri = input?.modified ?? input?.uri;
      if (tabUri?.toString() === proposedUri.toString()) {
        await window.tabGroups.close(editor);
      }
    }
    if (path !== undefined) {
      void window.showInformationMessage(`已应用变更：${path}`);
    }
  }
}
