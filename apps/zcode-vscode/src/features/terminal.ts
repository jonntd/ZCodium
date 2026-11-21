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
  // 修复（审查 medium）：内核 `workbench.action.terminal.copySelection` 在终端无选区时
  // **不写剪贴板**、只弹警告——随后读回的正是用户原有剪贴板内容，旧内容被包装成
  // <terminal-output> 发送，且下方「终端里没有选中内容」防护分支永不触发。
  // 哨兵探测：先写哨兵，复制后读回——仍是哨兵 ⇒ 内核没有复制 ⇒ 按无选区处理。
  // （不能用「与复制前一致」判定：用户剪贴板恰好等于选中文本时会误判。）
  const probe = `gode-terminal-probe-${Date.now().toString(36)}`;
  await Promise.resolve(vscode.env.clipboard.writeText(probe)).catch(() => undefined);
  await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
  const copied = await Promise.resolve(vscode.env.clipboard.readText()).catch(() => probe);
  const selection = copied === probe ? "" : copied.trim();
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
