import * as vscode from "vscode";
import type { PendingContext } from "./contextCollector";

/**
 * 把终端里的选中内容（通常是报错栈）送进对话。
 *
 * VS Code 没有「读取终端选区」的 API，只能借 `copySelection` 走一次剪贴板：
 * 先保存并恢复用户原有剪贴板内容，避免把用户的复制历史冲掉。
 */
export async function sendTerminalSelection(
  submit: (instruction: string, context: readonly PendingContext[]) => Promise<void>,
): Promise<void> {
  const terminal = vscode.window.activeTerminal;
  if (!terminal) {
    void vscode.window.showInformationMessage("先聚焦一个终端，并选中要发送的内容。");
    return;
  }

  const previous = await Promise.resolve(vscode.env.clipboard.readText()).catch(() => "");
  await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
  const selection = (await Promise.resolve(vscode.env.clipboard.readText()).catch(() => "")).trim();
  // 恢复用户剪贴板：发送完就不该再留副作用。
  await Promise.resolve(vscode.env.clipboard.writeText(previous)).catch(() => undefined);

  if (!selection) {
    void vscode.window.showInformationMessage("终端里没有选中内容。");
    return;
  }

  const context: PendingContext = {
    chip: { id: `terminal-${Date.now()}`, label: `终端输出 ${selection.split("\n").length} 行` },
    text: `<terminal-output>\n${selection}\n</terminal-output>`,
  };

  await submit(
    [
      "上面是终端里的输出/报错。",
      "请定位根因（区分「表面报错」与「真正失败点」），再直接修改文件修复；",
      "如果需要复现或验证，说明要跑什么命令。",
    ].join("\n"),
    [context],
  );
}
