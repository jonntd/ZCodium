/**
 * 诊断导出纯层（架构 architecture.md §7.10「exportLogs 聚合口径」）。
 *
 * 零 vscode 依赖：环形缓冲与导出内容组装可被 headless vitest 直测；
 * vscode 侧（Diagnostics）与 container exportLogs 只做薄接线。
 *
 * 背景：exportLogs 曾只写一行占位文本（「见 ZCodium 输出通道」）即 success:true，
 * 用户拿到的「日志」有误导性；本模块提供输出通道内存镜像的真实聚合面。
 * （server 日志源随 server 形态退役一并移除。）
 */

/** 输出通道内存镜像容量：FIFO 环形，超限丢最旧（activation 起有效，不替代 OutputChannel 全史）。 */
export const DIAGNOSTICS_BUFFER_CAPACITY = 500;

/** 有界行缓冲（FIFO 环形语义：push 超容量时丢最旧行）。 */
export class BoundedLineBuffer {
  private lines: string[] = [];

  constructor(private readonly capacity: number = DIAGNOSTICS_BUFFER_CAPACITY) {
    if (capacity < 1)
      throw new Error(`BoundedLineBuffer capacity 必须 ≥ 1，收到 ${capacity}`);
  }

  push(line: string): void {
    this.lines.push(line);
    while (this.lines.length > this.capacity) {
      this.lines.shift();
    }
  }

  /** 当前镜像行（FIFO 顺序拷贝；调用方可安全变更）。 */
  snapshot(): string[] {
    return [...this.lines];
  }

  get size(): number {
    return this.lines.length;
  }
}

export interface DiagnosticsExportInput {
  /** 输出通道内存镜像行（Diagnostics.snapshotLines() 产物）。 */
  readonly diagnosticsLines: readonly string[];
  /** 导出时间戳（ISO 8601；缺省取当前时间）。 */
  readonly exportedAt?: string;
  /** 镜像容量（标题标注「最近 ≤N 行」用；缺省 DIAGNOSTICS_BUFFER_CAPACITY）。 */
  readonly diagnosticsCapacity?: number;
}

const NO_RECORD = "（无记录）";

function renderSection(
  title: string,
  lines: readonly string[] | undefined,
): string {
  const body = lines && lines.length > 0 ? lines.join("\n") : NO_RECORD;
  return `== ${title} ==\n${body}`;
}

/**
 * 聚合导出内容（纯函数）：输出通道内存镜像。
 * 来源为空时如实标注「（无记录）」——不虚构内容，不回落占位文本。
 */
export function buildDiagnosticsExportContent(
  input: DiagnosticsExportInput,
): string {
  const exportedAt = input.exportedAt ?? new Date().toISOString();
  const capacity = input.diagnosticsCapacity ?? DIAGNOSTICS_BUFFER_CAPACITY;
  return [
    `ZCodium 诊断导出（${exportedAt}）`,
    "由「ZCodium: 显示日志」命令聚合生成；诊断面不写凭据与真实用户数据。",
    renderSection(
      `ZCodium 输出通道镜像（最近 ≤${capacity} 行，自激活起；完整历史见 OutputChannel「Gode Agent」）`,
      input.diagnosticsLines,
    ),
    "",
  ].join("\n");
}
