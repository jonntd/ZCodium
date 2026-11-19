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

export async function activate(context: ExtensionContext): Promise<{
  __hostSmokeProbe: typeof __hostSmokeProbe;
}> {
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
  // exports = activate() 返回值：宿主冒烟经 ext.exports 拿只读探针。
  return { __hostSmokeProbe };
}

/**
 * 宿主冒烟只读探针（scripts/extension-host-smoke.cjs 经 ext.exports 消费）。
 *
 * 隔离实例里 `vscode.window.tabGroups` 对 webview 页签跨进程同步不可靠，
 * 冒烟的「是否新建了页签 / 侧栏是否挂桥」断言改读容器内的同一事实源
 * （面板存活表 + hostRuntime 连接表）。只读、无副作用，不暴露服务内部。
 */
export function __hostSmokeProbe(): {
  chatEditorTabCount: number;
  sidebarAttached: boolean;
} {
  return {
    chatEditorTabCount: container?.chatEditorPanel.tabCount() ?? 0,
    sidebarAttached: container
      ? container.hostRuntime.hasConnection(ChatPanel.viewId)
      : false,
  };
}

export async function deactivate(): Promise<void> {
  await container?.dispose();
  container = null;
}
