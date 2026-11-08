/**
 * beforeContent round-trip 单测（spec: docs/spec/vscode-pending-changes.md §10）。
 *
 * 用 CLI 同款 `diff` 库的 structuredPatch（参数对齐 cold-file-change-summaries.ts
 * createFinalPatch：默认 context、timeout 5s）生成真实形态的 hunk，再验证
 * reverseApplyPatches(after) === before。这是 diff 左栏重构在真实数据形态下的
 * 正确性主证，hunk 均为 jsdiff 实际输出（非手搓）。
 */

import { describe, expect, it } from "vitest";
import { structuredPatch } from "diff";
import { reverseApplyPatches } from "../src/host/pendingChanges/beforeContent";

/** 与生产 createFinalPatch 同参：默认 context、timeout 5s。 */
function productionPatch(before: string, after: string) {
  return structuredPatch("f", "f", before, after, undefined, undefined, {
    timeout: 5_000,
  })?.hunks ?? [];
}

function roundTrip(before: string, after: string): string | null {
  return reverseApplyPatches(after, productionPatch(before, after));
}

describe("reverseApplyPatches × jsdiff structuredPatch round-trip", () => {
  it("多 hunk 替换（函数签名/常量/新增 import 混合）", () => {
    const before = [
      "import os",
      "",
      "TEST_URL = 'http://www.baidu.com'",
      "TIMEOUT = 5",
      "MAX_WORKERS = 100",
      "",
      "def check(proxy):",
      "    return proxy",
    ].join("\n");
    const after = [
      "import os",
      "import threading",
      "",
      "TEST_URL = 'https://www.google.com/generate_204'",
      "TIMEOUT = 8",
      "MAX_WORKERS = 200",
      "",
      "def check(proxy, stats, lock):",
      "    return proxy",
    ].join("\n");
    expect(roundTrip(before, after)).toBe(before);
  });

  it("纯新增段（带尾换行）", () => {
    const before = "a\nb\nc\n";
    const after = "a\nb\nNEW1\nNEW2\nc\n";
    expect(roundTrip(before, after)).toBe(before);
  });

  it("整文件删除（after 为空串）", () => {
    const before = "only line\n";
    const after = "";
    expect(roundTrip(before, after)).toBe(before);
  });

  it("空文件新增内容（before 为空串）", () => {
    const before = "";
    const after = "brand new content\n";
    expect(roundTrip(before, after)).toBe(before);
  });

  it("CRLF 行尾保持不变", () => {
    const before = "a\r\nOLD\r\nc\r\n";
    const after = "a\r\nNEW\r\nc\r\n";
    expect(roundTrip(before, after)).toBe(before);
  });

  it("中文与 emoji 内容", () => {
    const before = "const 标题 = '旧标题';\n// 注释 🎉\nexport {};\n";
    const after = "const 标题 = '新标题 🚀';\n// 注释 🎉\nexport {};\n";
    expect(roundTrip(before, after)).toBe(before);
  });

  it("无尾换行 → 有尾换行", () => {
    const before = "x\ny";
    const after = "x\ny\n";
    expect(roundTrip(before, after)).toBe(before);
  });

  it("大文件（600 行）中间改动", () => {
    const lines = (marker: string) =>
      Array.from({ length: 600 }, (_, i) => (i === 300 ? marker : `line-${i}`)).join("\n");
    const before = lines("OLD-300");
    const after = lines("NEW-300");
    expect(roundTrip(before, after)).toBe(before);
  });

  it("多处相邻小改动（<context 间隔合并为单 hunk）", () => {
    const before = Array.from({ length: 20 }, (_, i) => `v${i}`).join("\n");
    const after = Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? `n${i}` : `v${i}`)).join("\n");
    expect(roundTrip(before, after)).toBe(before);
  });

  it("外部修改后的 after（对不上）→ fail-closed 返回 null", () => {
    const before = "a\nOLD\nc\n";
    const after = "a\nNEW\nc\n";
    const drifted = "a\n被外部改掉\nc\n";
    expect(reverseApplyPatches(drifted, productionPatch(before, after))).toBeNull();
  });
});
