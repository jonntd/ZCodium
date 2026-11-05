/**
 * DiffViewer — 文件编辑审批的原生 diff 视图（P0-7）。
 *
 * - left = 磁盘当前内容，right = 提议内容，标题 `[待审批] <file>`；
 * - 提议内容不可从 permission.input 直接拿到时，退化为只读打开目标文件并提示；
 * - 应用后关闭对应 diff 标签页并提示。
 */

import type { TextDocumentContentProvider } from "vscode";
import { Disposable, Uri, window, workspace } from "vscode";

const SCHEME = "zcodium-proposed";

/** 提议内容的内容提供器（diff 右侧虚拟文档）。 */
export class ProposedContentProvider implements TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly emitter: Disposable | null = null;

  provideTextDocumentContent(uri: Uri): string {
    return this.contents.get(uri.query) ?? "";
  }

  set(key: string, content: string): void {
    this.contents.set(key, content);
  }

  clear(key: string): void {
    this.contents.delete(key);
  }
}

export class DiffViewer {
  private readonly openTabs = new Map<string, Uri>();
  private readonly provider = new ProposedContentProvider();

  constructor() {
    void workspace.registerTextDocumentContentProvider(SCHEME, this.provider);
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
    const proposedUri = Uri.parse(`${SCHEME}://proposal/${encodeURIComponent(path)}?${requestId}`);
    this.provider.set(requestId, proposedContent);
    this.openTabs.set(requestId, proposedUri);
    await workspace.openTextDocument(proposedUri);
    await window.showTextDocument(fileUri, { preview: true, viewColumn: 1 });
    return true;
  }

  /** 应用（allow）后关闭对应 diff 标签页并提示。 */
  async close(requestId: string, path?: string): Promise<void> {
    const proposedUri = this.openTabs.get(requestId);
    this.provider.clear(requestId);
    this.openTabs.delete(requestId);
    if (proposedUri === undefined) return;
    for (const editor of window.tabGroups.all.flatMap((group) => group.tabs)) {
      const tabUri = (editor.input as { uri?: Uri } | undefined)?.uri;
      if (tabUri?.toString() === proposedUri.toString()) {
        await window.tabGroups.close(editor);
      }
    }
    if (path !== undefined) {
      void window.showInformationMessage(`已应用变更：${path}`);
    }
  }
}
