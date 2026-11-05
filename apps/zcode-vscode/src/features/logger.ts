/**
 * 编辑器功能模块日志（M1 移植自 zcodium-vscode logger）。
 *
 * 独立 OutputChannel；容器装配时可用 setSink 把条目镜像到主诊断通道
 * （src/ui/diagnostics.ts），保持单一排障入口。
 */

import * as vscode from "vscode";

type Level = "debug" | "info" | "warn" | "error";

let channel: vscode.OutputChannel | null = null;
let sink: ((line: string) => void) | null = null;

function ensureChannel(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("ZCodium Editor Features");
  }
  return channel;
}

function write(level: Level, scope: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] [${scope}] ${message}`;
  try {
    ensureChannel().appendLine(line);
  } catch {
    // OutputChannel 不可用（测试环境）时静默。
  }
  sink?.(line);
}

export const log = {
  debug: (scope: string, message: string) => write("debug", scope, message),
  info: (scope: string, message: string) => write("info", scope, message),
  warn: (scope: string, message: string) => write("warn", scope, message),
  error: (scope: string, message: string) => write("error", scope, message),
};

/** 容器装配时注入主诊断通道镜像。 */
export function setLogSink(next: (line: string) => void): void {
  sink = next;
}

export function showLogs(): void {
  ensureChannel().show(true);
}
