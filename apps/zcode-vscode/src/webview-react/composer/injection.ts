/**
 * composer/injection.ts — @file/@selection/诊断 → composer 预填文本的注入格式（T09 webview 半）。
 *
 * PRD 定稿口径（architecture-p1.md T09）：
 * - @file：ui mention 的标准转译格式 `[name](./relativePath)`（与 @zcode/ui
 *   mentions/mentionMarkdown.buildFileMentionMarkdown 一字不差，本地实现避免为纯函数
 *   拉进 ui 组件链）；
 * - @selection：纯文本标记 `[file.rs L12-L40]` + 围栏代码块（行号 1-based）；
 * - 诊断两档：host diagnostics 帧已按档过滤，本模块只做可读格式化（P1-5）。
 * - @symbol / 代码库索引：明确不做（PRD 降级口径，协议/运行时无符号索引能力）。
 *
 * 纯函数模块：无 React、无 vscode 依赖，vitest 直测（test/injection.test.ts）。
 */

import type { DiagnosticsHostFramePayload } from "../../host/hostFrameKinds";

/** ui mention 标准 markdown：`[label](./relativePath)`（目录以 `/` 结尾）。 */
export function buildFileMentionInjection(relativePath: string, label: string): string {
  const trimmed = relativePath.trim();
  if (!trimmed) return "";
  const isDirectory = /[\\/]$/.test(trimmed);
  const normalized = isDirectory ? `${trimmed.replace(/[\\/]+$/, "")}/` : trimmed;
  const destination = normalized.startsWith("/") || /^\w+:/.test(normalized)
    ? normalized
    : `./${normalized}`;
  const escapedLabel = label.replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]");
  return `[${escapedLabel}](${destination.replaceAll(">", "\\>")})`;
}

/** 选区注入入参（selectionChip 投影后的形状）。 */
export interface SelectionInjectionInput {
  /** 展示用相对路径（多根 folder 前缀保留，P1-4）。 */
  relativePath: string;
  /** 0-based 起始行（VS Code selection 口径）。 */
  startLine: number;
  /** 0-based 结束行。 */
  endLine: number;
  /** 选区文本（空选区为空串）。 */
  text: string;
}

/**
 * 选区注入块：`[file.rs L12-L40]` + ``` 围栏（architecture-p1.md T09 定稿格式）。
 * 行号 1-based；空选区退化为单点标记 `L12`；选区语言无法从 webview 取得，围栏不定语言。
 */
export function buildSelectionInjection(input: SelectionInjectionInput): string {
  const relativePath = input.relativePath.trim() || "untitled";
  const from = input.startLine + 1;
  const marker =
    input.startLine === input.endLine ? `L${from}` : `L${from}-L${input.endLine + 1}`;
  const header = `[${relativePath} ${marker}]`;
  if (!input.text.trim()) return header;
  return `${header}\n\`\`\`\n${input.text.replace(/\s+$/, "")}\n\`\`\``;
}

/**
 * 追加注入到既有 composer 文本：文本非空且不以空白结尾时补一个空格，块级注入
 * （选区/诊断含换行）前保证换行分隔。
 */
export function appendInjection(currentText: string, injection: string): string {
  if (!injection) return currentText;
  if (!currentText.trim()) return injection;
  const needsSpace = !/\s$/.test(currentText) && !injection.startsWith("\n");
  return `${currentText}${needsSpace ? " " : ""}${injection}`;
}

/** 单条诊断的可读行：`path:line+1 [severity] message (source)`。 */
function formatDiagnosticItem(item: DiagnosticsHostFramePayload["items"][number]): string {
  const severity = ["Error", "Warning", "Info", "Hint"][item.severity] ?? `severity:${item.severity}`;
  const source = item.source ? ` (${item.source})` : "";
  return `${item.path}:${item.startLine + 1} [${severity}] ${item.message}${source}`;
}

/**
 * 诊断帧 → composer 预填块（P1-5：文件/行/消息/severity；两档由 host 过滤，
 * payload.tier 透传到标题文案供用户确认范围）。
 */
export function buildDiagnosticsInjection(payload: DiagnosticsHostFramePayload): string {
  const tierLabel = payload.tier === "errors" ? "仅错误" : "错误+警告";
  if (payload.items.length === 0) {
    return `[diagnostics] 当前无${tierLabel}级诊断`;
  }
  const lines = payload.items.map(formatDiagnosticItem);
  return `[diagnostics] ${tierLabel}（${payload.items.length} 条，errors=${payload.errorCount}）\n${lines.join("\n")}`;
}

/** 无诊断时的哨兵：UI 据此禁用发送入口（P1-5 两档按钮禁用）。 */
export function diagnosticsFrameIsEmpty(payload: DiagnosticsHostFramePayload): boolean {
  return payload.items.length === 0;
}
