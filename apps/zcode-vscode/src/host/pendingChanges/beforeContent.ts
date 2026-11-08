/**
 * 改动前内容重构（spec: docs/spec/vscode-pending-changes.md §5）。
 *
 * v4/conversation/fileChanges 只返回 patches（first-before → final-after 的
 * DiffHunk[]），不含 beforeContent 全文。待审窗口内「当前磁盘内容 == after」，
 * 因此把 patch **反向应用**到当前内容即可零协议改动地重构 diff 左栏。
 * 失败（外部修改导致上下文对不上等）返回 null，调用方降级为只读打开当前文件。
 *
 * 行级语义（jsdiff structuredPatch 实测，round-trip 测试为准）：
 * - 行以 ' '/'-'/'+' 前缀区分上下文/旧侧/新侧；"" 为空内容上下文行；
 * - "\ No newline at end of file"（'\' 前缀）是元数据标记，回填其**前一行**：
 *   该行在对应文件侧缺行尾换行；标记不计入 oldLines/newLines，且按位置归属
 *   （跟在 '-'/context 后影响旧侧，跟在 '+' 后只影响新侧）；
 * - 内容行与「尾换行」分开建模：`"a\n"` 的 split 尾部 "" 是换行标记不是内容行；
 *   before 的尾换行 = 尾部未覆盖区继承 after，hunk 覆盖到内容 EOF 时由旧侧末行
 *   的缺尾标记决定（缺标记本身就是「有换行」的编码）。
 */

import type { ChangeHunk } from "./types";

type HunkLineKind = "context" | "old" | "new" | "meta";

function classifyHunkLine(line: string): { kind: HunkLineKind; text: string } {
  if (line === "") return { kind: "context", text: "" };
  const marker = line[0];
  if (marker === "+") return { kind: "new", text: line.slice(1) };
  if (marker === "-") return { kind: "old", text: line.slice(1) };
  if (marker === "\\") return { kind: "meta", text: line.slice(1) };
  // ' ' 上下文；个别 diff 产器对空上下文行发空串（上面已截获），其余一律按上下文剥一字符。
  return { kind: "context", text: marker === " " ? line.slice(1) : line };
}

interface CollectedLine {
  readonly kind: "context" | "old" | "new";
  readonly text: string;
  noNewline: boolean;
}

/** after 全文 → 内容行 + 尾换行标志（split 的尾部 "" 是换行标记不是内容行）。 */
function splitContent(content: string): { lines: string[]; endsWithNewline: boolean } {
  if (content === "") return { lines: [], endsWithNewline: false };
  const lines = content.split("\n");
  if (content.endsWith("\n")) {
    lines.pop();
    return { lines, endsWithNewline: true };
  }
  return { lines, endsWithNewline: false };
}

/**
 * 把 patches 反向应用到 after 全文，重构 before 全文。
 *
 * 算法：hunks 升序（jsdiff structuredPatch 保证）。对每个 hunk：
 * 1. 复制 current 中上一 hunk 终点到本 hunk newStart-1 的未改动区；
 * 2. 校验 current 的覆盖区与 hunk 的「context+new」逐行一致（不一致说明当前文件
 *    不是该 patch 的 after，fail-closed 返回 null，绝不猜测）；
 * 3. 用「context+old」替换该区，得到 before 的对应片段。
 */
export function reverseApplyPatches(
  afterContent: string,
  patches: readonly ChangeHunk[],
): string | null {
  if (patches.length === 0) return null;
  const after = splitContent(afterContent);
  const beforeLines: string[] = [];
  let cursor = 0; // after 内容行中已消费的行数（0-based 下一段起点）
  let tailCopied = 0; // 尾部未覆盖区行数（>0 ⟹ before 尾换行继承 after）
  let lastOldMissingNewline = false; // 最后一个 hunk 旧侧末行是否带缺尾标记
  let lastHunkHadOldLines = false;

  for (const hunk of patches) {
    if (hunk.newStart < 1 || hunk.newStart - 1 < cursor) return null;
    // 未改动区（newStart 为 1-based）。
    for (let i = cursor; i < hunk.newStart - 1; i += 1) {
      beforeLines.push(after.lines[i] ?? "");
    }
    const newSpanStart = hunk.newStart - 1;

    // 校验 + 收集：current 的覆盖区必须等于 context+new 序列；标记回填前一行。
    const collected: CollectedLine[] = [];
    for (const raw of hunk.lines) {
      const { kind, text } = classifyHunkLine(raw);
      if (kind === "meta") {
        if (collected.length > 0) collected[collected.length - 1]!.noNewline = true;
        continue;
      }
      collected.push({ kind, text, noNewline: false });
    }
    const expectedNew = collected
      .filter((line) => line.kind !== "old")
      .map((line) => line.text);
    const restoredOld = collected.filter((line) => line.kind !== "new");
    if (expectedNew.length !== hunk.newLines || restoredOld.length !== hunk.oldLines) {
      return null;
    }
    for (let i = 0; i < expectedNew.length; i += 1) {
      if (after.lines[newSpanStart + i] !== expectedNew[i]) return null;
    }
    beforeLines.push(...restoredOld.map((line) => line.text));
    cursor = newSpanStart + expectedNew.length;
    const lastOldParticipating = restoredOld[restoredOld.length - 1];
    lastOldMissingNewline = lastOldParticipating?.noNewline ?? false;
    lastHunkHadOldLines = restoredOld.length > 0;
  }
  for (let i = cursor; i < after.lines.length; i += 1) {
    beforeLines.push(after.lines[i] ?? "");
    tailCopied += 1;
  }
  if (beforeLines.length === 0) return "";
  // 尾换行收口：尾部未覆盖区存在 ⟹ 末行与 after 相同（继承）；hunk 覆盖到内容
  // EOF ⟹ 由旧侧末行的缺尾标记决定。
  const beforeEndsWithNewline =
    tailCopied > 0 ? after.endsWithNewline : lastHunkHadOldLines && !lastOldMissingNewline;
  return beforeLines.join("\n") + (beforeEndsWithNewline ? "\n" : "");
}
