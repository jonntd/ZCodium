/**
 * Diagnostics — OutputChannel 诊断（P0-2）：stderr 尾部、帧错误、状态机变更、
 * 协议生命周期事件都落到 "ZCodium Agent" 输出通道。
 *
 * closeout-3（架构 §7.10）：每条 appendLine 同步镜像到内存环形缓冲
 * （src/ui/diagnosticsBuffer.ts，零 vscode 依赖可直测），供 exportLogs 聚合
 * 真实诊断面；镜像容量 500 行、activation 起有效，不替代 OutputChannel 全史。
 */

import type { OutputChannel } from "vscode";
import { window } from "vscode";
import {
  BoundedLineBuffer,
  DIAGNOSTICS_BUFFER_CAPACITY,
} from "./diagnosticsBuffer";

export class Diagnostics {
  private readonly channel: OutputChannel;
  private readonly buffer = new BoundedLineBuffer(DIAGNOSTICS_BUFFER_CAPACITY);

  constructor() {
    this.channel = window.createOutputChannel("ZCodium Agent");
  }

  show(): void {
    this.channel.show(true);
  }

  /** 输出通道与内存镜像的单点写入（所有 log* 方法的唯一通道，防双写路径漂移）。 */
  private appendLine(line: string): void {
    this.channel.appendLine(line);
    this.buffer.push(line);
  }

  log(message: string): void {
    this.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  logStderrLine(line: string): void {
    this.appendLine(`[stderr] ${line}`);
  }

  logFatal(reason: string): void {
    this.appendLine(`[fatal] ${reason}`);
  }

  logStateChange(from: string, to: string, event: string): void {
    this.appendLine(`[state] ${from} → ${to}（${event}）`);
  }

  /** exportLogs 聚合面：内存镜像最近行（FIFO 顺序；非 OutputChannel 全史）。 */
  snapshotLines(): string[] {
    return this.buffer.snapshot();
  }

  dispose(): void {
    this.channel.dispose();
  }
}
