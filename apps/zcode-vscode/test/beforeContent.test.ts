/**
 * beforeContent 反向应用单测（spec: docs/spec/vscode-pending-changes.md §10）。
 *
 * 手搓 hunk 必须遵守 jsdiff structuredPatch 的真实编码（round-trip 测试为准）：
 * - 行前缀 ' '/'-'/'+'，"" 为空内容上下文行；
 * - "\ No newline at end of file" 标记回填前一行、不计行数；
 * - 「无尾换行」用标记表达，缺标记 = 该行有行尾换行。
 * 真实 jsdiff 形态的正确性主证在 beforeContentRoundTrip.test.ts。
 */

import { describe, expect, it } from "vitest";
import {
  parsePatchHunks,
  reverseApplyPatches,
} from "../src/host/pendingChanges/beforeContent";
import type { ChangeHunk } from "../src/host/pendingChanges/types";

function hunk(
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
  lines: string[],
): ChangeHunk {
  return { oldStart, oldLines, newStart, newLines, lines };
}

const NO_NL = "\\ No newline at end of file";

describe("reverseApplyPatches", () => {
  it("纯新增行：从 after 重构出不含新增行的 before（两侧有尾换行）", () => {
    const before = "a\nb\nc\n";
    const after = "a\nb\nNEW1\nNEW2\nc\n";
    const patches = [hunk(2, 2, 2, 4, [" b", "+NEW1", "+NEW2", " c"])];
    expect(reverseApplyPatches(after, patches)).toBe(before);
  });

  it("纯删除行：before 包含被删除的行（两侧有尾换行）", () => {
    const before = "a\nOLD1\nOLD2\nb\n";
    const after = "a\nb\n";
    const patches = [hunk(1, 4, 1, 2, [" a", "-OLD1", "-OLD2", " b"])];
    expect(reverseApplyPatches(after, patches)).toBe(before);
  });

  it("替换行：before 保留旧内容（两侧有尾换行）", () => {
    const before = "TIMEOUT = 5\nMAX = 100\n";
    const after = "TIMEOUT = 8\nMAX = 200\n";
    const patches = [
      hunk(1, 2, 1, 2, ["-TIMEOUT = 5", "-MAX = 100", "+TIMEOUT = 8", "+MAX = 200"]),
    ];
    expect(reverseApplyPatches(after, patches)).toBe(before);
  });

  it("多 hunk + hunk 间未改动区", () => {
    const before = "1\nOLD-A\n2\nKEEP\n3\nOLD-B\n4\n";
    const after = "1\nNEW-A\n2\nKEEP\n3\nNEW-B\n4\n";
    const patches = [
      hunk(2, 1, 2, 1, ["-OLD-A", "+NEW-A"]),
      hunk(6, 1, 6, 1, ["-OLD-B", "+NEW-B"]),
    ];
    expect(reverseApplyPatches(after, patches)).toBe(before);
  });

  it("当前内容与 patch 的 after 不一致（外部修改）→ fail-closed 返回 null", () => {
    const drifted = "a\n被外部改过的行\nc\n";
    const patches = [hunk(2, 1, 2, 1, ["-OLD", "+NEW"])];
    expect(reverseApplyPatches(drifted, patches)).toBeNull();
  });

  it("hunk 行数与 oldLines/newLines 不符 → 返回 null", () => {
    const after = "a\nb\n";
    const patches = [hunk(1, 2, 1, 2, ["+a", "+b"])];
    expect(reverseApplyPatches(after, patches)).toBeNull();
  });

  it("空 patches → 返回 null（无重构依据）", () => {
    expect(reverseApplyPatches("anything", [])).toBeNull();
  });

  it("空内容上下文行（空串形态）按上下文处理", () => {
    const before = "x\n\ny\n";
    const after = "x\n\ny2\n";
    const patches = [hunk(2, 2, 2, 2, ["", "-y", "+y2"])];
    expect(reverseApplyPatches(after, patches)).toBe(before);
  });

  it("删除到空文件：旧侧无缺尾标记 ⟹ before 补尾换行", () => {
    const before = "only line\n";
    const after = "";
    const patches = [hunk(1, 1, 1, 0, ["-only line"])];
    expect(reverseApplyPatches(after, patches)).toBe(before);
  });

  it("删除到空文件：旧侧带缺尾标记 ⟹ before 不补尾换行", () => {
    const before = "only line";
    const after = "";
    const patches = [hunk(1, 1, 1, 0, ["-only line", NO_NL])];
    expect(reverseApplyPatches(after, patches)).toBe(before);
  });

  it("标记跟在 + 行后：只修饰新侧，旧侧换行不受影响", () => {
    const before = "x\ny\n";
    const after = "x\ny";
    const patches = [hunk(1, 2, 1, 2, [" x", "-y", "+y", NO_NL])];
    expect(reverseApplyPatches(after, patches)).toBe(before);
  });

  it("两侧都无尾换行（双标记）：before 无尾换行", () => {
    const before = "x\ny";
    const after = "x\nz";
    const patches = [hunk(1, 2, 1, 2, [" x", "-y", NO_NL, "+z", NO_NL])];
    expect(reverseApplyPatches(after, patches)).toBe(before);
  });

  it("context 行缺尾换行：旧侧继承标记", () => {
    const before = "a\ny";
    const after = "b\ny";
    const patches = [hunk(1, 2, 1, 2, ["-a", "+b", " y", NO_NL])];
    expect(reverseApplyPatches(after, patches)).toBe(before);
  });

  it("尾部未覆盖区存在 ⟹ before 尾换行继承 after", () => {
    const before = "OLD\ntail\n";
    const after = "NEW\ntail\n";
    const patches = [hunk(1, 1, 1, 1, ["-OLD", "+NEW"])];
    expect(reverseApplyPatches(after, patches)).toBe(before);
    // after 无尾换行的对照形态。
    const afterNoNl = "NEW\ntail";
    expect(reverseApplyPatches(afterNoNl, patches)).toBe("OLD\ntail");
  });

  it("纯追加到文件尾（context 收尾，真实 jsdiff 形态）→ before 补尾换行", () => {
    const before = "a\n";
    const after = "a\nb\n";
    // 真实 jsdiff 输出：追加到 EOF 时旧侧带 context 行（见 round-trip 实测）。
    const patches = [hunk(1, 1, 1, 2, [" a", "+b"])];
    expect(reverseApplyPatches(after, patches)).toBe(before);
  });

  it("空文件新增内容（before 为空串）", () => {
    const after = "brand new content\n";
    const patches = [hunk(1, 0, 1, 1, ["+brand new content"])];
    expect(reverseApplyPatches(after, patches)).toBe("");
  });
});

describe("parsePatchHunks（安全审查 S4：RPC 面宽松解析，畸形整体拒绝）", () => {
  it("合法 hunk 数组解析为 ChangeHunk[]", () => {
    expect(
      parsePatchHunks([
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [" a", "+b"] },
      ]),
    ).toEqual([
      { oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [" a", "+b"] },
    ]);
    expect(parsePatchHunks([])).toEqual([]);
  });

  it("非数组 / 脏条目 / 缺字段 / 非有限数字 / lines 非字符串数组 → null", () => {
    expect(parsePatchHunks("x")).toBeNull();
    expect(parsePatchHunks([null])).toBeNull();
    expect(parsePatchHunks([{ oldStart: 1 }])).toBeNull();
    expect(
      parsePatchHunks([
        { oldStart: Number.NaN, oldLines: 0, newStart: 1, newLines: 0, lines: [] },
      ]),
    ).toBeNull();
    expect(
      parsePatchHunks([
        { oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: [1] },
      ]),
    ).toBeNull();
  });
});
