import * as vscode from "vscode";
import { contextFromRange, type PendingContext } from "./contextCollector";

export interface CodeActionEntry {
  /** 带上下文直接向对话发一条指令。 */
  submit(instruction: string, context: readonly PendingContext[]): Promise<void>;
  /** 只把上下文放进输入框，不自动发送。 */
  addContext(items: readonly PendingContext[]): Promise<void>;
}

const INSTRUCTIONS = {
  explain:
    "请解释这段代码：解决什么问题、关键控制流、隐含假设与风险。只做说明，不要修改文件。",
  fix: "这段代码有问题。先定位根因，再直接修改文件修复；最后说明根因证据、改了什么、为什么。",
  refactor:
    "请在不改变对外行为的前提下重构这段代码，保持与周边风格一致，改完说明结构变化。",
  tests: "请为这段代码补测试，先确认仓库现有测试框架与命名约定，再按同样风格新增用例。",
} as const;

/**
 * 编辑器里的「灯泡」入口。
 *
 * 与右键菜单共用同一组指令，但代码操作能在**诊断所在位置**直接出现，
 * 用户不用先选中再找菜单 —— 这是 Claude Code / Augment 那种「随手可得」的关键。
 */
export class GodeCodeActionProvider implements vscode.CodeActionProvider {
  /**
   * 用 getter 而不是静态字段：静态字段会在模块加载期求值，等于让整个扩展包
   * 在 import 时就依赖 `vscode.CodeActionKind`。getter 把依赖推迟到真正注册时，
   * 也让这个模块能被离线脚本直接加载。
   */
  static get metadata(): vscode.CodeActionProviderMetadata {
    return {
      providedCodeActionKinds: [
        vscode.CodeActionKind.QuickFix,
        vscode.CodeActionKind.RefactorRewrite,
      ],
    };
  }

  constructor(private readonly entry: CodeActionEntry) {}

  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const actions: vscode.CodeAction[] = [];

    // 有诊断时优先给「修这个报错」，并把诊断原文一并带给模型。
    if (context.diagnostics.length > 0) {
      const action = new vscode.CodeAction("用 Gode 修复此问题", vscode.CodeActionKind.QuickFix);
      action.diagnostics = [...context.diagnostics];
      action.isPreferred = true;
      action.command = {
        command: "gode.fixDiagnostics",
        title: "用 Gode 修复此问题",
        arguments: [document.uri, range, context.diagnostics.map(describeDiagnostic)],
      };
      actions.push(action);
    }

    const selectionContext = contextFromRange(document, range);
    if (!selectionContext) return actions;

    actions.push(
      this.createAction("用 Gode 解释选中代码", "gode.codeAction", vscode.CodeActionKind.RefactorRewrite, {
        document,
        range,
        instruction: INSTRUCTIONS.explain,
      }),
      this.createAction("用 Gode 重构选中代码", "gode.codeAction", vscode.CodeActionKind.RefactorRewrite, {
        document,
        range,
        instruction: INSTRUCTIONS.refactor,
      }),
      this.createAction("用 Gode 写测试", "gode.codeAction", vscode.CodeActionKind.RefactorRewrite, {
        document,
        range,
        instruction: INSTRUCTIONS.tests,
      }),
      this.createAction("加入 Gode 对话", "gode.addRangeToChat", vscode.CodeActionKind.RefactorRewrite, {
        document,
        range,
      }),
    );
    return actions;
  }

  private createAction(
    title: string,
    command: string,
    kind: vscode.CodeActionKind,
    args: unknown,
  ): vscode.CodeAction {
    const action = new vscode.CodeAction(title, kind);
    action.command = { command, title, arguments: [args] };
    return action;
  }
}

export function describeDiagnostic(diagnostic: vscode.Diagnostic): string {
  const severity = vscode.DiagnosticSeverity[diagnostic.severity] ?? "unknown";
  return `- [${severity}] line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`;
}

/** 诊断修复：把「文件 + 报错 + 附近代码」一起交给 Agent，让它直接改文件。 */
export async function runDiagnosticsFix(
  entry: CodeActionEntry,
  uri: vscode.Uri,
  range: vscode.Range,
  diagnostics: readonly string[],
): Promise<void> {
  let document: vscode.TextDocument;
  try {
    document = await vscode.workspace.openTextDocument(uri);
  } catch {
    void vscode.window.showWarningMessage("无法读取该文件。");
    return;
  }

  const context: PendingContext[] = [];
  const selection = contextFromRange(document, expandToLines(document, range, 20));
  if (selection) context.push(selection);
  context.push({
    chip: { id: `diag-${Date.now()}`, label: `诊断 ${diagnostics.length} 条` },
    text: `<diagnostics path="${vscode.workspace.asRelativePath(uri)}">\n${diagnostics.join("\n")}\n</diagnostics>`,
  });

  const instruction = [
    "上面是文件里报错的代码与诊断信息。",
    "请先定位根因（不要只看报错表象），再直接修改文件修复；",
    "改完说明：根因证据、改了哪些文件、为什么这样改、如何验证。",
  ].join("\n");

  await entry.submit(instruction, context);
}

/** 诊断常常只有一行，但改法要看上下文；这里按行数扩一圈。 */
function expandToLines(
  document: vscode.TextDocument,
  range: vscode.Range,
  padding: number,
): vscode.Range {
  const startLine = Math.max(0, range.start.line - padding);
  const endLine = Math.min(document.lineCount - 1, range.end.line + padding);
  return new vscode.Range(
    new vscode.Position(startLine, 0),
    document.lineAt(endLine).range.end,
  );
}
