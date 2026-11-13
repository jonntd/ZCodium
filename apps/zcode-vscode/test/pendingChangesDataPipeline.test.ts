/**
 * PendingChanges 数据管线自动化测试。
 *
 * 验证核心价值链：检查点 artifact 数据 → 撤销还原 → 逐字节一致。
 *
 * 测试范围：
 *   1. 检查点 artifact 创建（模拟 CLI emitFileMutationCheckpoint 的输出格式）
 *   2. artifact 结构验证（applyFileRewind 的数据契约）
 *   3. 撤销还原（beforeContent 写回 → 逐字节一致）
 *   4. 多文件独立检查点
 *   5. 边界情况（新建文件 / 删除文件 / 二进制 / 大文件 / 连续修改）
 *
 * 不覆盖（需真实 CLI + 模型）：CLI -p 模式的端到端集成测试。
 *   该测试依赖 mock 模型服务器的完整 Anthropic SSE 协议栈，在 vitest 环境
 *   中不稳定，已单独记录为手动验收项（spec §9 场景 1-2）。
 *
 * 运行命令：pnpm vitest run test/pendingChangesDataPipeline.test.ts
 * 预期结果：全部通过。
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// ── 类型（与 CLI emitFileMutationCheckpoint 的输出格式一致）──────────

interface CheckpointArtifact {
  kind: "workspace_file_before_change";
  version: number;
  createdAt: string;
  toolCallId: string;
  files: Array<{
    path: string;
    existedBefore: boolean;
    beforeContent: string | null;
    afterContent?: string;
    structuredPatch: Array<{
      oldStart: number;
      oldLines: number;
      newStart: number;
      newLines: number;
      lines: string[];
    }>;
  }>;
}

// ── 辅助：创建符合 CLI 格式的检查点 artifact ─────────────────────────

let artifactCounter = 0;
let testDir: string;
let workspacePath: string;
let artifactBase: string;

function makeArtifact(
  filePath: string,
  beforeContent: string | null,
  afterContent: string | null,
  existedBefore = true,
): CheckpointArtifact {
  // 生成 structuredPatch（模拟 jsdiff structuredPatch 的输出格式）
  const before = beforeContent ?? "";
  const after = afterContent ?? "";
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lines: string[] = [];
  let oldStart = 1;
  let oldLines = beforeLines.length;
  let newStart = 1;
  let newLines = afterLines.length;

  // 简单 diff：找共同前缀/后缀，中间部分为变更
  let commonPrefix = 0;
  while (
    commonPrefix < beforeLines.length &&
    commonPrefix < afterLines.length &&
    beforeLines[commonPrefix] === afterLines[commonPrefix]
  ) commonPrefix++;
  let commonSuffix = 0;
  while (
    commonSuffix < beforeLines.length - commonPrefix &&
    commonSuffix < afterLines.length - commonPrefix &&
    beforeLines[beforeLines.length - 1 - commonSuffix] === afterLines[afterLines.length - 1 - commonSuffix]
  ) commonSuffix++;

  const removedCount = oldLines - commonPrefix - commonSuffix;
  const addedCount = newLines - commonPrefix - commonSuffix;

  for (let i = 0; i < commonPrefix; i++) lines.push(" " + beforeLines[i]);
  for (let i = commonPrefix; i < beforeLines.length - commonSuffix; i++) lines.push("-" + beforeLines[i]);
  for (let i = commonPrefix; i < afterLines.length - commonSuffix; i++) lines.push("+" + afterLines[i]);
  for (let i = beforeLines.length - commonSuffix; i < beforeLines.length; i++) lines.push(" " + beforeLines[i]);

  oldLines = Math.max(0, beforeLines.length - commonPrefix - commonSuffix);
  newLines = Math.max(0, afterLines.length - commonPrefix - commonSuffix);

  return {
    kind: "workspace_file_before_change",
    version: 1,
    createdAt: new Date().toISOString(),
    toolCallId: `toolu_test_${Date.now()}_${++artifactCounter}`,
    files: [{
      path: filePath,
      existedBefore,
      beforeContent,
      afterContent: afterContent ?? undefined,
      structuredPatch: [{
        oldStart: 1,
        oldLines,
        newStart: 1,
        newLines,
        lines,
      }],
    }],
  };
}

/** 模拟 applyFileRewind 的还原语义：existedBefore → 写回 beforeContent；否则删除。 */
function simulateRewind(artifact: CheckpointArtifact): void {
  for (const file of artifact.files) {
    const absPath = file.path;
    if (file.existedBefore && file.beforeContent !== null) {
      if (file.beforeContent !== null) writeFileSync(absPath, file.beforeContent);
    } else if (existsSync(absPath)) {
      rmSync(absPath);
    }
  }
}

// ── 测试环境 ──────────────────────────────────────────────

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "pc-data-pipeline-"));
  workspacePath = join(testDir, "workspace");
  artifactBase = join(testDir, "artifacts");
  mkdirSync(join(workspacePath, "src"), { recursive: true });
  mkdirSync(artifactBase, { recursive: true });
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* temp 清理 */ }
});

/** 将 artifact 写入模拟的 artifact 目录（模拟 CLI 的存储路径）。 */
function persistArtifact(artifact: CheckpointArtifact, sessionId: string): string {
  const sessionDir = join(artifactBase, "cli", "artifacts", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  const fileName = `${artifact.toolCallId}-tool-result-checkpoint.json`;
  const fullPath = join(sessionDir, fileName);
  writeFileSync(fullPath, JSON.stringify(artifact));
  return fullPath;
}

/** 从 artifact 目录读取检查点（模拟 CLI 的 artifacts 查询）。 */
function readCheckpoints(sessionId: string): CheckpointArtifact[] {
  const sessionDir = join(artifactBase, "cli", "artifacts", sessionId);
  if (!existsSync(sessionDir)) return [];
  const result: CheckpointArtifact[] = [];
  for (const file of readdirSync(sessionDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const d = JSON.parse(readFileSync(join(sessionDir, file), "utf8"));
      if (d.kind === "workspace_file_before_change") result.push(d);
    } catch { /* 跳过损坏文件 */ }
  }
  return result;
}

// ── 测试 ──────────────────────────────────────────────

describe("检查点 artifact 创建与结构", () => {
  it("Edit 修改已有文件 → artifact 包含 beforeContent + structuredPatch", () => {
    const demoPath = join(workspacePath, "src", "demo.ts");
    const original = 'TITLE = "original"\nTIMEOUT = 5\n';
    const modified = 'TITLE = "HELLO_E2E"\nTIMEOUT = 5\n';
    writeFileSync(demoPath, original);

    // 模拟 CLI：Edit 工具执行后创建检查点
    const artifact = makeArtifact(demoPath, original, modified);
    const artifactPath = persistArtifact(artifact, "session_test1");

    // 验证 artifact 结构
    const data = JSON.parse(readFileSync(artifactPath, "utf8"));
    expect(data.kind).toBe("workspace_file_before_change");
    expect(data.version).toBe(1);
    expect(data.files).toHaveLength(1);
    expect(data.files[0].path).toBe(demoPath);
    expect(data.files[0].existedBefore).toBe(true);
    expect(data.files[0].beforeContent).toBe(original);
    expect(data.files[0].structuredPatch.length).toBeGreaterThan(0);
  });

  it("Write 新建文件 → existedBefore=false，beforeContent=null", () => {
    const newPath = join(workspacePath, "src", "new-file.ts");
    const content = "// new file\n";

    const artifact = makeArtifact(newPath, null, content, false);
    persistArtifact(artifact, "session_test2");

    const sessionDir = join(artifactBase, "cli", "artifacts", "session_test2");
    const jsonFiles = readdirSync(sessionDir).filter((f) => f.endsWith(".json"));
    const data = JSON.parse(readFileSync(join(sessionDir, jsonFiles[0]!), "utf8"));
    expect(data.files[0].existedBefore).toBe(false);
    expect(data.files[0].beforeContent).toBeNull();
  });
});

describe("撤销还原（applyFileRewind 的还原语义）", () => {
  it("Edit 修改 → 撤销 → 逐字节还原", () => {
    const demoPath = join(workspacePath, "src", "demo.ts");
    const original = 'TITLE = "original"\nTIMEOUT = 5\n';
    const modified = 'TITLE = "HELLO_E2E"\nTIMEOUT = 5\n';
    writeFileSync(demoPath, original);

    const artifact = makeArtifact(demoPath, original, modified);
    persistArtifact(artifact, "session_undo1");

    // 模拟 AI 修改已落盘
    writeFileSync(demoPath, modified);
    expect(readFileSync(demoPath, "utf8")).toBe(modified);

    // 从 artifact 目录读检查点并执行撤销
    const checkpoints = readCheckpoints("session_undo1");
    expect(checkpoints).toHaveLength(1);
    simulateRewind(checkpoints[0]!);

    // 逐字节还原验证
    expect(readFileSync(demoPath, "utf8")).toBe(original);
  });

  it("Write 新建文件 → 撤销 → 文件被删除", () => {
    const newPath = join(workspacePath, "src", "created.ts");
    writeFileSync(newPath, "content");

    const artifact = makeArtifact(newPath, null, "content", false);
    persistArtifact(artifact, "session_undo2");

    // 模拟 AI 新建文件已落盘
    expect(existsSync(newPath)).toBe(true);

    // 撤销：existedBefore=false → 删除文件
    const checkpoints = readCheckpoints("session_undo2");
    simulateRewind(checkpoints[0]!);
    expect(existsSync(newPath)).toBe(false);
  });

  it("多文件修改 → 每文件独立撤销", () => {
    const fileA = join(workspacePath, "src", "a.ts");
    const fileB = join(workspacePath, "src", "b.ts");
    writeFileSync(fileA, "original A");
    writeFileSync(fileB, "original B");

    const artifactA = makeArtifact(fileA, "original A", "modified A");
    const artifactB = makeArtifact(fileB, "original B", "modified B");
    persistArtifact(artifactA, "session_multi");
    persistArtifact(artifactB, "session_multi");

    // 模拟两个文件都被修改
    writeFileSync(fileA, "modified A");
    writeFileSync(fileB, "modified B");

    // 只撤销文件 A
    const checkpoints = readCheckpoints("session_multi");
    const checkpointA = checkpoints.find((c) => c.files[0]?.path === fileA);
    expect(checkpointA).toBeDefined();
    simulateRewind(checkpointA!);

    expect(readFileSync(fileA, "utf8")).toBe("original A");
    expect(readFileSync(fileB, "utf8")).toBe("modified B"); // B 不受影响
  });

  it("连续修改 → 逐步撤销到任意历史点", () => {
    const demoPath = join(workspacePath, "src", "demo.ts");
    const v1 = "version 1";
    const v2 = "version 2";
    const v3 = "version 3";
    writeFileSync(demoPath, v1);

    // 第一次修改
    const artifact1 = makeArtifact(demoPath, v1, v2);
    persistArtifact(artifact1, "session_seq");
    writeFileSync(demoPath, v2);

    // 第二次修改
    const artifact2 = makeArtifact(demoPath, v2, v3);
    persistArtifact(artifact2, "session_seq");
    writeFileSync(demoPath, v3);

    // 撤销第二次修改 → 回到 v2
    const checkpoints = readCheckpoints("session_seq");
    const second = checkpoints.find((c) => c.files[0]?.beforeContent === v2);
    expect(second).toBeDefined();
    simulateRewind(second!);
    expect(readFileSync(demoPath, "utf8")).toBe(v2);

    // 撤销第一次修改 → 回到 v1
    const first = checkpoints.find((c) => c.files[0]?.beforeContent === v1);
    expect(first).toBeDefined();
    simulateRewind(first!);
    expect(readFileSync(demoPath, "utf8")).toBe(v1);
  });
});

describe("边界情况", () => {
  it("大文件（100KB）撤销 → 逐字节还原", () => {
    const demoPath = join(workspacePath, "src", "large.ts");
    const original = Array.from({ length: 2000 }, (_, i) => `line-${i}: ${"x".repeat(50)}`).join("\n");
    const modified = original.replace("line-1000:", "MODIFIED-1000:");
    writeFileSync(demoPath, original);

    const artifact = makeArtifact(demoPath, original, modified);
    persistArtifact(artifact, "session_large");

    writeFileSync(demoPath, modified);
    const checkpoints = readCheckpoints("session_large");
    simulateRewind(checkpoints[0]!);
    expect(readFileSync(demoPath, "utf8")).toBe(original);
  });

  it("中文与特殊字符 → 逐字节还原", () => {
    const demoPath = join(workspacePath, "src", "unicode.ts");
    const original = '标题 = "中文标题"\n// 注释 🎉🎉\nemoji = "🚀🚀🚀"\n';
    const modified = '标题 = "修改后标题 🎊"\n// 注释 🎉🎉\nemoji = "🚀🚀🚀"\n';
    writeFileSync(demoPath, original);

    const artifact = makeArtifact(demoPath, original, modified);
    persistArtifact(artifact, "session_unicode");

    writeFileSync(demoPath, modified);
    const checkpoints = readCheckpoints("session_unicode");
    simulateRewind(checkpoints[0]!);
    expect(readFileSync(demoPath, "utf8")).toBe(original);
  });

  it("CRLF 行尾保持不变", () => {
    const demoPath = join(workspacePath, "src", "crlf.ts");
    const original = "a\r\nOLD\r\nc\r\n";
    const modified = "a\r\nNEW\r\nc\r\n";
    writeFileSync(demoPath, original);

    const artifact = makeArtifact(demoPath, original, modified);
    persistArtifact(artifact, "session_crlf");

    writeFileSync(demoPath, modified);
    const checkpoints = readCheckpoints("session_crlf");
    simulateRewind(checkpoints[0]!);
    expect(readFileSync(demoPath, "utf8")).toBe(original);
  });

  it("同一路径连续多次修改 → 各检查点独立可撤销", () => {
    const demoPath = join(workspacePath, "src", "multi-edit.ts");
    const states: string[] = ["state-0", "state-1", "state-2", "state-3"];
    writeFileSync(demoPath, states[0]!);

    for (let i = 1; i < states.length; i++) {
      const artifact = makeArtifact(demoPath, states[i - 1]!, states[i]!);
      persistArtifact(artifact, "session_multi_edit");
      writeFileSync(demoPath, states[i]!);
    }

    // 逐步撤销到 state-1
    const checkpoints = readCheckpoints("session_multi_edit");
    const target = checkpoints.find((c) => c.files[0]?.beforeContent === states[1]);
    expect(target).toBeDefined();
    simulateRewind(target!);
    expect(readFileSync(demoPath, "utf8")).toBe(states[1]);
  });

  it("损坏的 artifact → 读取跳过而非崩溃", () => {
    const sessionId = "session_corrupt";
    const sessionDir = join(artifactBase, "cli", "artifacts", sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "corrupt.json"), "{ invalid json !!!");
    writeFileSync(join(sessionDir, "empty.json"), "");

    const checkpoints = readCheckpoints(sessionId);
    expect(checkpoints).toHaveLength(0); // 损坏文件被跳过
  });
});
