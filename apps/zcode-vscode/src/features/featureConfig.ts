/**
 * 编辑器功能模块的设置读面（M1 移植；设置项与 zcodium-vscode 同名，口径一致）。
 *
 * - `gode.model`：`providerId/modelId[$reasoningLevel]`，一次性文本生成（Quick Edit /
 *   生成提交信息）的模型选择；未配置时由调用方给出可读错误；
 * - `gode.autoContext`：FR-B22 自动上下文档位（off / openEditors / openEditorsAndRecentEdits）。
 */

import * as vscode from "vscode";

export interface ModelSelectionInput {
  providerId: string;
  modelId: string;
  options?: { reasoningLevel?: string };
}

/** FR-B22 自动上下文档位（shape 权威在 contextCollector；此处 re-export 供设置读取）。 */
export type AutoContextMode = "off" | "openEditors" | "openEditorsAndRecentEdits";

/**
 * `providerId/modelId[$reasoningLevel]` → modelSelection 形状。
 * `$` 之后是推理档位（仓库既有展示格式，部分模型档位必填）。没有 `/` 时返回 undefined：
 * modelSelection 是 strict schema，猜一个 providerId 只会让协议侧报参数错误。
 */
export function parseModelSelection(value: string): ModelSelectionInput | undefined {
  const trimmed = value.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) return undefined;

  const providerId = trimmed.slice(0, separator);
  const rest = trimmed.slice(separator + 1);
  const levelSeparator = rest.lastIndexOf("$");
  if (levelSeparator <= 0) return { providerId, modelId: rest };

  return {
    providerId,
    modelId: rest.slice(0, levelSeparator),
    options: { reasoningLevel: rest.slice(levelSeparator + 1) },
  };
}

export function readModelSelection(): ModelSelectionInput | undefined {
  const configured = vscode.workspace
    .getConfiguration("gode")
    .get<string>("model");
  return configured ? parseModelSelection(configured) : undefined;
}

const AUTO_CONTEXT_MODES: readonly AutoContextMode[] = [
  "off",
  "openEditors",
  "openEditorsAndRecentEdits",
];

export function readAutoContextMode(): AutoContextMode {
  const value = vscode.workspace
    .getConfiguration("gode")
    .get<string>("autoContext", "off");
  return AUTO_CONTEXT_MODES.includes(value as AutoContextMode)
    ? (value as AutoContextMode)
    : "off";
}

export function primaryWorkspacePath(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}
