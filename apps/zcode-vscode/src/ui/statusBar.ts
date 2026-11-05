/**
 * StatusBar — 状态栏呈现（P0-2/P0-9）：运行状态变色 + pending 审批角标 ⚠ n。
 * 原 session/sessionStateMachine 已删除：状态源改为 Agent 运行时生命周期事件
 * （services onAgentRuntimeLifecycle + 命令编排），本文件只定义呈现。
 */

import type { StatusBarItem } from "vscode";
import { StatusBarAlignment, ThemeColor, window } from "vscode";

/** 插件侧 UI 状态（投影自 Agent 运行时生命周期，不再持有会话状态机）。 */
export type ZcodiumUiState =
  | "inactive"
  | "starting"
  | "ready"
  | "busy"
  | "crashed"
  | "restarting";

const STATE_META: Record<ZcodiumUiState, { text: string; color?: ThemeColor; tooltip: string }> = {
  inactive: { text: "$(circle-slash) ZCodium", tooltip: "ZCodium Agent：未运行" },
  starting: { text: "$(sync~spin) ZCodium 启动中", tooltip: "正在启动 Agent…" },
  ready: {
    text: "$(circle-filled) ZCodium 运行中",
    tooltip: "ZCodium Agent：就绪",
    // ThemeColor token ID 必须经 new ThemeColor(id) 包装；string 形态会被按 CSS 颜色解释。
    color: new ThemeColor("statusBarItem.prominentBackground"),
  },
  busy: { text: "$(loading~spin) ZCodium 执行中", tooltip: "ZCodium Agent：任务执行中" },
  crashed: {
    text: "$(error) ZCodium 已崩溃",
    tooltip: "ZCodium Agent：进程异常，正在恢复",
    color: new ThemeColor("editorError.foreground"),
  },
  restarting: { text: "$(sync~spin) ZCodium 恢复中", tooltip: "ZCodium Agent：自动重启中" },
};

export class StatusBar {
  private readonly item: StatusBarItem;
  private pendingApprovals = 0;
  private state: ZcodiumUiState = "inactive";

  constructor() {
    this.item = window.createStatusBarItem(StatusBarAlignment.Left, 100);
    this.item.name = "ZCodium Agent";
    this.item.command = { command: "zcodium.openChat", title: "打开 ZCodium 对话" };
    this.render();
    this.item.show();
  }

  setState(state: ZcodiumUiState): void {
    this.state = state;
    this.render();
  }

  setPendingApprovals(count: number): void {
    this.pendingApprovals = count;
    this.render();
  }

  dispose(): void {
    this.item.dispose();
  }

  private render(): void {
    const meta = STATE_META[this.state];
    const badge = this.pendingApprovals > 0 ? ` ⚠ ${this.pendingApprovals}` : "";
    this.item.text = `${meta.text}${badge}`;
    this.item.tooltip = `${meta.tooltip}${this.pendingApprovals > 0 ? `（${this.pendingApprovals} 条待审批）` : ""}`;
    this.item.color = meta.color;
  }
}
