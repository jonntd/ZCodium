import * as vscode from "vscode";
import type { OneShotTextOptions } from "./oneShotText";
import { log } from "./logger";

const SCHEME = "gode-quick-edit";

/** 虚拟文档内容：diff 两侧都通过它渲染，避免为了预览而临时落盘。 */
export class QuickEditContentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  set(uri: vscode.Uri, content: string): void {
    this.contents.set(uri.toString(), content);
    this.emitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }
}

export interface QuickEditDeps {
  /** 一次性文本生成（M2-6c：共享 server 的 workspace/generateText，见 oneShotText.ts）。 */
  readonly generateText: (prompt: string, options?: OneShotTextOptions) => Promise<string>;
  readonly contentProvider: QuickEditContentProvider;
}

export function createQuickEditContentProvider(): QuickEditContentProvider {
  return new QuickEditContentProvider();
}

/**
 * 编辑器内的一次性改写（Cmd+K）。
 *
 * 与「发给 Agent 让它自己改文件」不同：这里只让模型产出**替换后的代码文本**，
 * 由插件用 `vscode.diff` 给出可视对比，用户确认后才落 WorkspaceEdit。
 * 因此它不消耗工具调用、不产生会话回合，也不会在用户没看清前改动磁盘。
 */
export async function runQuickEdit(deps: QuickEditDeps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showInformationMessage("先打开一个文件并选中要改的代码。");
    return;
  }
  const selection = editor.selection;
  if (selection.isEmpty) {
    void vscode.window.showInformationMessage("请先选中要修改的代码。");
    return;
  }

  const document = editor.document;
  const original = document.getText(selection);
  const instruction = await vscode.window.showInputBox({
    title: "Zcodium 改写",
    prompt: "描述你想要的修改（Enter 生成，Esc 取消）",
    placeHolder: "例如：改成 early return 风格 / 补上空值判断 / 提取成独立函数",
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) return;

  const startLine = selection.start.line + 1;
  const endLine = selection.end.line + 1;
  const prompt = [
    "你是代码编辑助手。根据「修改要求」改写「原始代码」。",
    "输出规则：",
    "1. 只输出改写后的完整代码，不要任何解释、不要 Markdown 代码围栏；",
    "2. 保留原有的缩进风格、引号风格与命名约定；",
    "3. 不要省略未改动的部分，输出必须可以直接替换原始代码。",
    "",
    `语言：${document.languageId}`,
    `文件：${vscode.workspace.asRelativePath(document.uri)}（第 ${startLine}-${endLine} 行）`,
    "",
    "原始代码：",
    original,
    "",
    `修改要求：${instruction.trim()}`,
  ].join("\n");

  let rewritten: string;
  try {
    rewritten = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: "Zcodium 正在改写…",
        cancellable: true,
      },
      async (_progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());
        return deps.generateText(prompt, { signal: abort.signal });
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("quick-edit", message);
    void vscode.window.showErrorMessage(`改写失败：${message}`);
    return;
  }

  const cleaned = stripCodeFence(rewritten);
  if (!cleaned.trim()) {
    void vscode.window.showWarningMessage("模型没有返回可用的代码。");
    return;
  }
  if (cleaned.trim() === original.trim()) {
    void vscode.window.showInformationMessage("改写结果与原文一致，无需应用。");
    return;
  }

  // diff 两侧都走虚拟文档：左边固定为原文快照，右边是改写结果。
  const nonce = Date.now().toString(36);
  const relative = vscode.workspace.asRelativePath(document.uri);
  const beforeUri = vscode.Uri.parse(`${SCHEME}:/${encodeURIComponent(relative)}.before.${nonce}`);
  const afterUri = vscode.Uri.parse(`${SCHEME}:/${encodeURIComponent(relative)}.after.${nonce}`);
  deps.contentProvider.set(beforeUri, original);
  deps.contentProvider.set(afterUri, cleaned);

  await vscode.commands.executeCommand(
    "vscode.diff",
    beforeUri,
    afterUri,
    `Zcodium 改写预览：${relative}`,
    { preview: true },
  );

  const choice = await vscode.window.showInformationMessage(
    "应用这次改写？",
    { modal: false },
    "应用",
    "放弃",
  );
  if (choice !== "应用") {
    await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
    return;
  }

  const applied = await applySelectionRewrite(editor, cleaned);
  if (!applied) return;

  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
  void vscode.window.setStatusBarMessage("Zcodium：改写已应用", 4000);
}

async function applySelectionRewrite(
  editor: vscode.TextEditor,
  replacement: string,
): Promise<boolean> {
  const document = editor.document;
  const range = editor.selection;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, range, replacement);
  const ok = await vscode.workspace.applyEdit(edit);
  if (!ok) {
    void vscode.window.showErrorMessage("应用改写失败：文档已变更，请重试。");
    return false;
  }
  return true;
}

/** 模型偶尔仍会包一层围栏；这里剥掉，避免把 ``` 写进源码。 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n```$/u.exec(trimmed);
  return fenced?.[1] ?? trimmed;
}
