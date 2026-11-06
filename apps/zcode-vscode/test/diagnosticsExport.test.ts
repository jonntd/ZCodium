/**
 * exportLogs 聚合面（架构 architecture.md §7.10「exportLogs 聚合口径」，closeout-3）：
 *
 * 背景：exportLogs 曾只写一行占位文本（「见 ZCodium 输出通道」）即 success:true，
 * 用户拿到的「日志」有误导性。这里锁定三个纯层单元：
 * - BoundedLineBuffer：输出通道内存镜像（FIFO 环形，容量淘汰）；
 * - buildDiagnosticsExportContent：两真实源聚合成导出内容（含两者皆空边界——
 *   如实标注「（无记录）」，不虚构、不回落占位文本）；
 * - readServerLogTail：fullui server 日志有界尾部读取（截断首行丢弃、缺文件返回空）。
 *
 * Diagnostics/ServerHost 自身依赖 vscode 运行时，镜像与读取的接线由这两处薄层承担，
 * 纯层单测覆盖聚合语义。
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BoundedLineBuffer,
  DIAGNOSTICS_BUFFER_CAPACITY,
  buildDiagnosticsExportContent,
} from "../src/ui/diagnosticsBuffer";
import {
  SERVER_LOG_TAIL_MAX_BYTES,
  readServerLogTail,
} from "../src/fullui/serverLogTail";

const tempDirs: string[] = [];

function tempLog(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "zcode-diag-export-"));
  tempDirs.push(dir);
  const file = join(dir, name);
  if (content.length > 0) writeFileSync(file, content, "utf8");
  return file;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("BoundedLineBuffer：输出通道内存镜像（FIFO 环形）", () => {
  it("保持写入顺序；未超容量时不淘汰", () => {
    const buffer = new BoundedLineBuffer(3);
    buffer.push("[t1] a");
    buffer.push("[t2] b");
    expect(buffer.snapshot()).toEqual(["[t1] a", "[t2] b"]);
    expect(buffer.size).toBe(2);
  });

  it(`超容量丢最旧行（默认容量 ${DIAGNOSTICS_BUFFER_CAPACITY}）`, () => {
    const buffer = new BoundedLineBuffer(2);
    buffer.push("old-1");
    buffer.push("old-2");
    buffer.push("new-3");
    expect(buffer.snapshot()).toEqual(["old-2", "new-3"]);
    // 默认容量常量面（spec 口径 500 行）。
    expect(DIAGNOSTICS_BUFFER_CAPACITY).toBe(500);
  });

  it("snapshot 是拷贝：外部变更不影响缓冲", () => {
    const buffer = new BoundedLineBuffer(2);
    buffer.push("keep");
    buffer.snapshot().length = 0;
    expect(buffer.size).toBe(1);
  });

  it("容量 <1 拒绝构造（防静默零容量）", () => {
    expect(() => new BoundedLineBuffer(0)).toThrow();
  });
});

describe("buildDiagnosticsExportContent：两真实源聚合（含空边界）", () => {
  it("两来源都有 → 各段按序聚合，标注来源与容量", () => {
    const content = buildDiagnosticsExportContent({
      diagnosticsLines: ["[ts1] [state] ready", "[ts2] [stderr] tail"],
      serverLogLines: ["[ts3] spawn: entry-http.js port=1"],
      serverLogPath: "/gs/logs/fullui-server.log",
      exportedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(content).toContain("ZCodium 诊断导出（2026-01-01T00:00:00.000Z）");
    expect(content).toContain("[ts1] [state] ready");
    expect(content).toContain("[ts2] [stderr] tail");
    expect(content).toContain("/gs/logs/fullui-server.log");
    expect(content).toContain("[ts3] spawn: entry-http.js port=1");
    expect(content).not.toContain("（无记录）");
    // 不再是占位文本（closeout-3 前的行为）。
    expect(content).not.toContain("见 ZCodium 输出通道（ZCodium: 显示日志）");
  });

  it("两者皆空（边界）→ 两段如实标注「（无记录）」，不虚构内容", () => {
    const content = buildDiagnosticsExportContent({
      diagnosticsLines: [],
      serverLogLines: [],
      serverLogPath: null,
      exportedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(content).toContain("未产生 server 日志文件");
    expect(content.match(/（无记录）/g)?.length).toBe(2);
  });

  it("仅镜像有记录 → server 段标注无记录；镜像容量进标题", () => {
    const content = buildDiagnosticsExportContent({
      diagnosticsLines: ["[ts1] only-line"],
      exportedAt: "2026-01-01T00:00:00.000Z",
      diagnosticsCapacity: 500,
    });
    expect(content).toContain("[ts1] only-line");
    expect(content).toContain("最近 ≤500 行");
    expect(content).toContain("（无记录）");
  });

  it("镜像段标题标明「完整历史见 OutputChannel」（镜像非全史，防误导）", () => {
    const content = buildDiagnosticsExportContent({
      diagnosticsLines: ["x"],
      exportedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(content).toContain("完整历史见 OutputChannel");
  });
});

describe("readServerLogTail：fullui server 日志有界尾部读取", () => {
  it("小文件整读（保留每行，去掉结尾换行产生的空串）", () => {
    const file = tempLog("fullui-server.log", "[t1] spawn\n[t2] line\n");
    expect(readServerLogTail(file)).toEqual(["[t1] spawn", "[t2] line"]);
  });

  it(`超界只读尾部 ${SERVER_LOG_TAIL_MAX_BYTES} 字节内，截断的不完整首行丢弃`, () => {
    const head = "x".repeat(300) + "\n"; // 被截断的半行
    const line = "y".repeat(50) + "\n";
    const content = head + line.repeat(10);
    const file = tempLog("big.log", content);
    const tail = readServerLogTail(file, 256);
    expect(tail.length).toBeGreaterThanOrEqual(1);
    expect(tail.length).toBeLessThan(11);
    // 首条返回的是完整行（不是被截断的 "xxx...xx" 半行）。
    expect(tail[0]?.startsWith("yyyyy")).toBe(true);
    expect(tail.every((l) => l.length <= 50)).toBe(true);
  });

  it("文件不存在 / 空文件 → []（导出面按「无记录」呈现，不抛错）", () => {
    expect(
      readServerLogTail(join(tmpdir(), "zcode-missing-fullui-server.log")),
    ).toEqual([]);
    expect(readServerLogTail(tempLog("empty.log", ""))).toEqual([]);
  });

  it("仅换行的文件 → []", () => {
    expect(readServerLogTail(tempLog("only-newline.log", "\n\n"))).toEqual([]);
  });
});
