import * as vscode from "vscode";
import type { ServerHost } from "./serverHost";
import { log } from "../features/logger";

/**
 * 在编辑器标签页里打开**完整界面**。
 *
 * 打开的是仓库现成的 Web UI（`packages/web` 构建产物），由本机
 * `@zcode/server` 托管 —— 与桌面端同一套服务、同一份组件，因此能力不打折：
 * 会话历史、模型选择、diff 审阅、Git 面板、终端、MCP/技能设置全都在。
 *
 * 用内置的 Simple Browser 承载，而不是自建 webview：少一层 CSP 与资源路径适配，
 * 且天然支持新标签页、前进后退与刷新。
 */
export async function openFullUi(server: ServerHost): Promise<void> {
  // 存储锁门（源实现的 decideAgentStorageConflict）不在插件内复刻：数据根为共享口径
  // （$HOME/.zcodium，与桌面端/侧栏服务栈同根，docs/architecture.md §7.9），并发运行时
  // 存在 agents-state.json.lock 争用可能，属共享模式的已知取舍（container.ts 服务装配注释）。

  let url: string;
  try {
    url = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "正在启动 Zcodium 完整界面…",
        cancellable: false,
      },
      () => server.ensureStarted(),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("full-ui", message);
    void vscode.window.showErrorMessage(`无法启动完整界面：${message}`);
    return;
  }

  try {
    await vscode.commands.executeCommand("simpleBrowser.show", url);
  } catch {
    // 极简发行版可能没有 Simple Browser；退回系统浏览器，能力一致只是脱离编辑器。
    log.warn("full-ui", "Simple Browser 不可用，改用外部浏览器打开");
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }
}
