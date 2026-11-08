/**
 * Gode Agent 扩展入口（薄壳，<80 行）。
 * activate：装配 Container → 注册 WebviewViewProvider 与命令。
 * deactivate：dispose（hostRuntime + services 串行释放）。
 */

import type { ExtensionContext } from "vscode";
import { window } from "vscode";
import { ChatPanel } from "./ui/chatPanel";
import { createContainer, registerCommands, type Container } from "./container";

let container: Container | null = null;

export async function activate(context: ExtensionContext): Promise<void> {
  try {
    container = await createContainer(context);
  } catch (error) {
    // §8 R3：服务装配失败必须明确呈现（不静默）。
    void window.showErrorMessage(
      `Gode Agent 服务装配失败，请查看诊断输出（Gode: 显示日志）：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    throw error;
  }
  context.subscriptions.push({
    dispose: () => {
      void container?.dispose();
    },
  });
  // 增量审查 X7：provider 与命令注册的 Disposable 全部入 subscriptions
  // （VS Code 官方订阅生命周期口径；扩展宿主回收本会兜底，但显式登记不依赖隐式行为）。
  context.subscriptions.push(
    window.registerWebviewViewProvider(ChatPanel.viewId, container.chatPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    ...registerCommands(container),
  );
}

export async function deactivate(): Promise<void> {
  await container?.dispose();
  container = null;
}
