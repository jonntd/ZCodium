/**
 * fullui server 日志尾部读取（架构 architecture.md §7.10「exportLogs 聚合口径」，closeout-3）。
 *
 * 零 vscode 依赖（仅 node:fs），headless vitest 直测；container exportLogs 薄接线调用。
 * serverHost 的 teeServerLog 无轮转地 append，文件可能持续增长——读取必须按字节上界
 * 有界（默认尾部 ≤256KB），禁止整文件读入。
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** 日志尾部读取字节上界。 */
export const SERVER_LOG_TAIL_MAX_BYTES = 256 * 1024;

/**
 * 读日志文件尾部行（有界；截断边界的不完整首行丢弃）。
 * 文件不存在 / 为空 / 读取失败一律返回 []（导出面按「无记录」呈现，不抛错）。
 */
export function readServerLogTail(
  logPath: string,
  maxBytes: number = SERVER_LOG_TAIL_MAX_BYTES,
): string[] {
  if (maxBytes < 1)
    throw new Error(`readServerLogTail maxBytes 必须 ≥ 1，收到 ${maxBytes}`);
  let fd: number;
  try {
    fd = openSync(logPath, "r");
  } catch {
    return [];
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return [];
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, size - length);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const rawLines = text.split("\n");
    // 从中间起读时首行大概率被截断：丢弃（宁少一行，不出半行乱码）。
    if (size - length > 0) rawLines.shift();
    // 去掉尾部空行（文件以 \n 结尾产生的空串）；行内容原样保留（含时间戳前缀）。
    while (
      rawLines.length > 0 &&
      rawLines[rawLines.length - 1]?.trim() === ""
    ) {
      rawLines.pop();
    }
    return rawLines;
  } catch {
    return [];
  } finally {
    try {
      closeSync(fd);
    } catch {
      // 关闭失败不影响返回值。
    }
  }
}
