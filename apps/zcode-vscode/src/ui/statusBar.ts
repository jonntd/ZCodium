/**
 * StatusBar — 状态栏呈现（P0-2/P0-9）：运行状态变色 + pending 审批角标 ⚠ n。
 * 原 session/sessionStateMachine 已删除：状态源改为 Agent 运行时生命周期事件
 * （services onAgentRuntimeLifecycle + 命令编排），本文件只定义呈现。
 */

import type { StatusBarItem } from "vscode";
import { StatusBarAlignment, ThemeColor, window } from "vscode";

/** 插件侧 UI 状态（投影自 Agent 运行时生命周期，不再持有会话状态机）。 */
export type GodeUiState =
  | "inactive"
  | "starting"
  | "ready"
  | "busy"
  | "crashed"
  | "restarting";

const STATE_META: Record<GodeUiState, { text: string; color?: ThemeColor; tooltip: string }> = {
  inactive: { text: "$(circle-slash) Gode", tooltip: "Gode Agent：未运行" },
  starting: { text: "$(sync~spin) Gode 启动中", tooltip: "正在启动 Agent…" },
  ready: {
    text: "$(circle-filled) Gode 运行中",
    tooltip: "Gode Agent：就绪",
    // ThemeColor token ID 必须经 new ThemeColor(id) 包装；string 形态会被按 CSS 颜色解释。
    color: new ThemeColor("statusBarItem.prominentBackground"),
  },
  busy: { text: "$(loading~spin) Gode 执行中", tooltip: "Gode Agent：任务执行中" },
  crashed: {
    text: "$(error) Gode 已崩溃",
    tooltip: "Gode Agent：进程异常，正在恢复",
    color: new ThemeColor("editorError.foreground"),
  },
  restarting: { text: "$(sync~spin) Gode 恢复中", tooltip: "Gode Agent：自动重启中" },
};

export class StatusBar {
  private readonly item: StatusBarItem;
  /** 新建对话页签按钮（底部常驻入口：点击总是创建一个新的对话编辑器标签）。 */
  private readonly newTabItem: StatusBarItem;
  /** 待审文件计数 item（spec: docs/spec/vscode-pending-changes.md §7；点击打开对话，审查入口在会话卡）。 */
  private readonly changesItem: StatusBarItem;
  private pendingApprovals = 0;
  private pendingChanges = 0;
  private state: GodeUiState = "inactive";

  constructor() {
    this.item = window.createStatusBarItem(StatusBarAlignment.Left, 100);
    this.item.name = "Gode Agent";
    this.item.command = { command: "gode.openChat", title: "打开 Gode 对话" };
    this.render();
    this.item.show();
    // 底部入口放状态栏右侧：与 Claude Code 等扩展状态项同侧（用户参考图红圈位置），
    // 左侧留给 Gode 运行状态/待审计数等自有信息。
    this.newTabItem = window.createStatusBarItem(StatusBarAlignment.Right, 100);
    this.newTabItem.name = "Gode 新建对话页签";
    this.newTabItem.text = "$(plus) Gode 对话";
    this.newTabItem.tooltip = "新建 Gode 对话页签（编辑器标签，可随意拖动）";
    this.newTabItem.command = {
      command: "gode.newChatTab",
      title: "新建对话页签",
    };
    this.newTabItem.show();
    this.changesItem = window.createStatusBarItem(StatusBarAlignment.Left, 99);
    this.changesItem.name = "Gode 待审文件";
    // 注意：不可指向视图容器聚焦命令——那会展开 Gode 侧栏（与「编辑器标签为唯一
    // 主形态」冲突）；审查/打开入口在对话会话卡内。
    this.changesItem.command = {
      command: "gode.openChat",
      title: "查看待审文件（对话内审查）",
    };
  }

  setState(state: GodeUiState): void {
    this.state = state;
    this.render();
  }

  setPendingApprovals(count: number): void {
    this.pendingApprovals = count;
    this.render();
  }

  /** 待审文件数（pendingChanges 模块投影；>0 显示、=0 隐藏）。 */
  setPendingChanges(count: number): void {
    this.pendingChanges = Math.max(0, Math.trunc(count));
    this.renderChanges();
  }

  dispose(): void {
    this.item.dispose();
    this.newTabItem.dispose();
    this.changesItem.dispose();
  }

  private render(): void {
    const meta = STATE_META[this.state];
    const badge = this.pendingApprovals > 0 ? ` ⚠ ${this.pendingApprovals}` : "";
    this.item.text = `${meta.text}${badge}`;
    this.item.tooltip = `${meta.tooltip}${this.pendingApprovals > 0 ? `（${this.pendingApprovals} 条待审批）` : ""}`;
    this.item.color = meta.color;
  }

  private renderChanges(): void {
    if (this.pendingChanges <= 0) {
      this.changesItem.hide();
      return;
    }
    this.changesItem.text = `$(diff-multiple) ${this.pendingChanges} 待审`;
    this.changesItem.tooltip = `Gode：${this.pendingChanges} 个文件改动待审查（点击打开对话，在会话卡中审查）`;
    this.changesItem.show();
  }
}
