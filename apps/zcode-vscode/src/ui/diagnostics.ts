/**
 * Diagnostics — OutputChannel 诊断（P0-2）：stderr 尾部、帧错误、状态机变更、
 * 协议生命周期事件都落到 "ZCodium Agent" 输出通道。
 */

import type { OutputChannel } from "vscode";
import { window } from "vscode";

export class Diagnostics {
  private readonly channel: OutputChannel;

  constructor() {
    this.channel = window.createOutputChannel("ZCodium Agent");
  }

  show(): void {
    this.channel.show(true);
  }

  log(message: string): void {
    this.channel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  logStderrLine(line: string): void {
    this.channel.appendLine(`[stderr] ${line}`);
  }

  logFatal(reason: string): void {
    this.channel.appendLine(`[fatal] ${reason}`);
  }

  logStateChange(from: string, to: string, event: string): void {
    this.channel.appendLine(`[state] ${from} → ${to}（${event}）`);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
