/**
 * composer/selectionChip.tsx — 活动编辑器选区 chip（T09 webview 半，P1-4.2）。
 *
 * 数据面：组2 plat 方法 getActiveEditorSelection（extension host 读 activeTextEditor）。
 * - 纯投影：plat 原始形状 → chip 状态（相对路径 + `L12-L40` 标记，多根 folder 归一）；
 * - 组件：面板可见期间低频轮询（无编辑器推送面，plat 是 pull 面）；有非空状态时渲染
 *   「附带选中代码」chip，点击即把 PRD 定稿注入块预填进 composer（requestComposerTextInsert）。
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import { appendInjection, buildSelectionInjection } from "./injection";

/** plat getActiveEditorSelection 的原始返回形状（container.ts 同形状）。 */
export interface ActiveEditorSelectionRaw {
  path: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  isEmpty: boolean;
  text: string;
}

/** chip 状态（空选区/无编辑器 = null，chip 隐藏）。 */
export interface SelectionChipState {
  path: string;
  relativePath: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** 选区轮询间隔（plat pull 面；面板可见期间保鲜）。 */
export const SELECTION_POLL_MS = 2_500;

/** 多根工作区相对路径：命中 folder 前缀则裁掉（P1-4 多根口径），否则保留原路径。 */
export function toWorkspaceRelativePath(path: string, folders: readonly string[]): string {
  const normalized = path.replaceAll("\\", "/");
  for (const folder of folders) {
    const normalizedFolder = folder.replaceAll("\\", "/").replace(/\/+$/, "");
    if (!normalizedFolder) continue;
    if (normalized === normalizedFolder) return normalizedFolder.split("/").at(-1) ?? path;
    if (normalized.startsWith(`${normalizedFolder}/`)) {
      return normalized.slice(normalizedFolder.length + 1);
    }
  }
  return path;
}

/** plat 原始选区 → chip 状态；无编辑器/无选区文本返回 null（chip 隐藏）。 */
export function projectSelectionChip(
  raw: ActiveEditorSelectionRaw | null | undefined,
  folders: readonly string[],
): SelectionChipState | null {
  if (!raw || raw.isEmpty || !raw.text.trim()) return null;
  return {
    path: raw.path,
    relativePath: toWorkspaceRelativePath(raw.path, folders),
    startLine: raw.startLine,
    endLine: raw.endLine,
    text: raw.text,
  };
}

/** chip 展示文案：`文件名 L12-L40`（相对路径 basename 优先）。 */
export function selectionChipLabel(state: SelectionChipState): string {
  const name = state.relativePath.split(/[\\/]/).at(-1) ?? state.relativePath;
  const from = state.startLine + 1;
  const range =
    state.startLine === state.endLine ? `L${from}` : `L${from}-L${state.endLine + 1}`;
  return `${name} ${range}`;
}

/** 注入块（injection.buildSelectionInjection 的 chip 入参适配）。 */
export function buildSelectionInjectionText(state: SelectionChipState): string {
  return buildSelectionInjection({
    relativePath: state.relativePath,
    startLine: state.startLine,
    endLine: state.endLine,
    text: state.text,
  });
}

/** 预填动作参数（组件与测试共用；workspacePath 由装配层给当前对话 workspace）。 */
export interface SelectionPrefillRequest {
  workspacePath: string;
  /** 既有草稿文本（追加注入用；空串直接以注入块开头）。 */
  currentText: string;
  state: SelectionChipState;
}

/** 纯函数：chip 点击 → requestComposerTextInsert 入参。 */
export function buildSelectionPrefill(
  request: SelectionPrefillRequest,
): { workspacePath: string; text: string } {
  return {
    workspacePath: request.workspacePath,
    text: appendInjection(request.currentText, buildSelectionInjectionText(request.state)),
  };
}

export interface SelectionChipProps {
  /** plat 调用面（PlatformRpcClient.call 或等价物）。 */
  plat: { call<T>(method: string, ...args: unknown[]): Promise<T> };
  workspacePath: string;
  folders: readonly string[];
  /** 既有草稿文本读取面（composer 草稿由 ui store 持有；缺省空串）。 */
  readCurrentDraftText?: () => string;
  /** 轮询间隔（测试可注入 0 关闭定时器）。 */
  pollMs?: number;
}

export function SelectionChip({
  plat,
  workspacePath,
  folders,
  readCurrentDraftText,
  pollMs = SELECTION_POLL_MS,
}: SelectionChipProps) {
  const [selection, setSelection] = useState<SelectionChipState | null>(null);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const raw = await plat.call<ActiveEditorSelectionRaw | null>("getActiveEditorSelection");
        if (active) setSelection(projectSelectionChip(raw, folders));
      } catch {
        // plat 面不可用（host 未实现/桥断开）：chip 隐藏，不崩 UI。
        if (active) setSelection(null);
      }
    };
    void refresh();
    if (pollMs <= 0) return () => {
      active = false;
    };
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [plat, folders, pollMs]);

  const handleAttach = useCallback(() => {
    if (!selection) return;
    const { text } = buildSelectionPrefill({
      workspacePath,
      currentText: readCurrentDraftText?.() ?? "",
      state: selection,
    });
    useZCodeSessionStore.getState().requestComposerTextInsert(workspacePath, text);
  }, [selection, workspacePath, readCurrentDraftText]);

  if (!selection) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 px-2 enabled:cursor-pointer"
      title={`注入选区：${selection.relativePath}`}
      data-testid="selection-chip"
      onClick={handleAttach}
    >
      附带选中代码（{selectionChipLabel(selection)}）
    </Button>
  );
}
