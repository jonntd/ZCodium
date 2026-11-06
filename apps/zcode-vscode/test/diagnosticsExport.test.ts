/**
 * exportLogs 聚合面（架构 architecture.md §7.10「exportLogs 聚合口径」）：
 *
 * 背景：exportLogs 曾只写一行占位文本（「见 ZCodium 输出通道」）即 success:true，
 * 用户拿到的「日志」有误导性。这里锁定两个纯层单元：
 * - BoundedLineBuffer：输出通道内存镜像（FIFO 环形，容量淘汰）；
 * - buildDiagnosticsExportContent：聚合导出内容（含空边界——如实标注
 *   「（无记录）」，不虚构、不回落占位文本）。
 *
 * （server 日志尾部源随 server 形态退役移除。）
 * Diagnostics 自身依赖 vscode 运行时，镜像接线由其薄层承担，纯层单测覆盖聚合语义。
 */

import { describe, expect, it } from "vitest";
import {
  BoundedLineBuffer,
  DIAGNOSTICS_BUFFER_CAPACITY,
  buildDiagnosticsExportContent,
} from "../src/ui/diagnosticsBuffer";

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

describe("buildDiagnosticsExportContent：聚合导出（含空边界）", () => {
  it("有记录 → 按序聚合，标注来源与容量", () => {
    const content = buildDiagnosticsExportContent({
      diagnosticsLines: ["[ts1] [state] ready", "[ts2] [stderr] tail"],
      exportedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(content).toContain("ZCodium 诊断导出（2026-01-01T00:00:00.000Z）");
    expect(content).toContain("[ts1] [state] ready");
    expect(content).toContain("[ts2] [stderr] tail");
    expect(content).not.toContain("（无记录）");
    // 不再是占位文本。
    expect(content).not.toContain("见 ZCodium 输出通道（ZCodium: 显示日志）");
  });

  it("镜像为空（边界）→ 如实标注「（无记录）」，不虚构内容", () => {
    const content = buildDiagnosticsExportContent({
      diagnosticsLines: [],
      exportedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(content.match(/（无记录）/g)?.length).toBe(1);
  });

  it("镜像容量进标题", () => {
    const content = buildDiagnosticsExportContent({
      diagnosticsLines: ["[ts1] only-line"],
      exportedAt: "2026-01-01T00:00:00.000Z",
      diagnosticsCapacity: 500,
    });
    expect(content).toContain("[ts1] only-line");
    expect(content).toContain("最近 ≤500 行");
  });

  it("镜像段标题标明「完整历史见 OutputChannel」（镜像非全史，防误导）", () => {
    const content = buildDiagnosticsExportContent({
      diagnosticsLines: ["x"],
      exportedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(content).toContain("完整历史见 OutputChannel");
  });
});
