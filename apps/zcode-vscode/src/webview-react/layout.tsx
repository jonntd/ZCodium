/**
 * 插件顶栏（PRD §6 ASCII 稿的 Webview 窄幅装配，T04/T06/⑤）。
 *
 * - folder 切换（P1-2.1）：多根工作区显示切换入口（App 经组2 pickWorkspaceFolder
 *   plat 方法），单根退化为纯展示；替换 v0.2.0 初版的 folderLabel 纯展示。
 * - 会话列表入口（P1-1）：列表面板由 App 装配（SessionListPanel）。
 * - PluginPanels 槽位（⑤）：modelSelect/usage/mcpSettings/workspaceInstructions/
 *   sessionParams/importClaude/subagents 七个缺省 null 的面板渲染位；
 *   面板实现与 index.tsx 组装归组4，本组只预留位。
 */

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.js";

/** 插件面板槽位（缺省渲染 null；装配归组4）。 */
export interface PluginPanels {
  /** 模型/思考档位选择。 */
  modelSelect: ReactNode | null;
  /** 用量入口（P1-7）。 */
  usage: ReactNode | null;
  /** MCP 设置（P1-8）。 */
  mcpSettings: ReactNode | null;
  /** workspace 指令（P1-10）。 */
  workspaceInstructions: ReactNode | null;
  /** 会话参数。 */
  sessionParams: ReactNode | null;
  /** Claude 会话导入（P1-9 需求 9）。 */
  importClaude: ReactNode | null;
  /** 子代理面板。 */
  subagents: ReactNode | null;
}

/** 全空槽位（App 缺省；组4 组装时按位注入）。 */
export function createEmptyPluginPanels(): PluginPanels {
  return {
    modelSelect: null,
    usage: null,
    mcpSettings: null,
    workspaceInstructions: null,
    sessionParams: null,
    importClaude: null,
    subagents: null,
  };
}

export interface PluginHeaderProps {
  folderLabel: string;
  folders: readonly string[];
  sessionId: string | null;
  /** 会话列表面板展开态（App 持有状态）。 */
  sessionListOpen?: boolean;
  onToggleSessionList?: () => void;
  /** 多根 folder 切换入口回调（App 经组2 pickWorkspaceFolder plat 方法）。 */
  onPickFolder?: () => void;
  /** 面板槽位（缺省全空）。 */
  panels?: PluginPanels;
}

export function PluginHeader({
  folderLabel,
  folders,
  sessionId,
  sessionListOpen = false,
  onToggleSessionList,
  onPickFolder,
  panels = createEmptyPluginPanels(),
}: PluginHeaderProps) {
  // P1-2.1：多根工作区显示 folder 切换入口；单根不显示（纯展示）。
  const multiRoot = folders.length > 1;
  return (
    <header className="shrink-0 border-b border-card-border bg-card text-ui-xs">
      {/* min-w-0 + flex-wrap：窄幅侧栏防溢出（实测固定行在多根 folder 长名下横向截断）。 */}
      <div className="flex min-h-9 flex-wrap items-center gap-1 px-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 enabled:cursor-pointer"
          title={
            multiRoot
              ? `切换 workspace folder（当前 ${folderLabel}，共 ${folders.length} 个）`
              : `当前 workspace：${folderLabel}`
          }
          onClick={multiRoot ? onPickFolder : undefined}
          disabled={multiRoot && !onPickFolder}
        >
          {multiRoot ? `${folderLabel} ▾` : folderLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 px-2 enabled:cursor-pointer"
          title={sessionId ? `会话 ${sessionId}` : "草稿会话"}
          onClick={onToggleSessionList}
          disabled={!onToggleSessionList}
        >
          {sessionListOpen ? "收起会话" : "会话列表"}
        </Button>
        <span className="ml-auto text-foreground-subtle">
          {sessionId ? "已连接" : "新会话"}
        </span>
      </div>
      {/* ⑤ 面板槽位渲染位：组4 注入的非空槽位逐个落在自己的容器里。 */}
      <PluginPanelSlot name="modelSelect" content={panels.modelSelect} />
      <PluginPanelSlot name="usage" content={panels.usage} />
      <PluginPanelSlot name="mcpSettings" content={panels.mcpSettings} />
      <PluginPanelSlot name="workspaceInstructions" content={panels.workspaceInstructions} />
      <PluginPanelSlot name="sessionParams" content={panels.sessionParams} />
      <PluginPanelSlot name="importClaude" content={panels.importClaude} />
      <PluginPanelSlot name="subagents" content={panels.subagents} />
    </header>
  );
}

function PluginPanelSlot({ name, content }: { name: string; content: ReactNode | null }) {
  if (content === null || content === undefined) return null;
  return (
    <div data-plugin-panel-slot={name} className="border-t border-card-border px-2 py-1">
      {content}
    </div>
  );
}
