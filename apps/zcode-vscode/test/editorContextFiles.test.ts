/**
 * editorContextFiles（gode.addFileToContext 的上下文核心）单测。
 *
 * 覆盖三类落面：
 * 1. 文件 ≤400 行：fenced 语言标注 + mention/chip 形状；
 * 2. 截断口径：>400 行截断、>256KB 仅路径（"宁可少给，不要打满"）；
 * 3. 目录：只给结构不给内容，mention kind=directory，>200 条截断。
 *
 * vscode.workspace.fs 全部 mock（与 contextCollectorMention.test.ts 同一模式）。
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const { fsMock, asRelativePath } = vi.hoisted(() => ({
  fsMock: {
    stat: vi.fn(),
    readFile: vi.fn(),
    readDirectory: vi.fn(),
  },
  asRelativePath: vi.fn((uri: { fsPath: string }) =>
    uri.fsPath.replace("/w/", ""),
  ),
}));

vi.mock("vscode", () => ({
  workspace: { fs: fsMock, asRelativePath },
  FileType: { File: 1, Directory: 2 },
  Uri: { file: (p: string) => ({ fsPath: p, toString: () => `file://${p}` }) },
}));

import {
  contextFromUri,
  readFileContext,
  readDirectoryContext,
} from "../src/features/editorContextFiles";

const FILE_URI = { fsPath: "/w/src/client.ts", toString: () => "file:///w/src/client.ts" };
const DIR_URI = { fsPath: "/w/src", toString: () => "file:///w/src" };

describe("readFileContext：文件上下文", () => {
  beforeEach(() => {
    fsMock.stat.mockReset();
    fsMock.readFile.mockReset();
  });

  it("≤400 行：fenced 标注语言（.ts → typescript），mention/chip 用相对路径", async () => {
    fsMock.stat.mockResolvedValue({ size: 100, type: 1 });
    fsMock.readFile.mockResolvedValue(new TextEncoder().encode("const a = 1;\nconst b = 2;"));

    const item = await readFileContext(FILE_URI as never);

    expect(item?.chip).toEqual({
      id: "file-file:///w/src/client.ts",
      label: "src/client.ts",
    });
    expect(item?.mention?.data).toMatchObject({
      kind: "file",
      path: "/w/src/client.ts",
      relativePath: "src/client.ts",
    });
    expect(item?.text).toContain('<file path="src/client.ts">');
    expect(item?.text).toContain("```typescript");
    expect(item?.text).toContain("const a = 1;");
  });

  it(">400 行：截断到 400 行并追加截断标记", async () => {
    fsMock.stat.mockResolvedValue({ size: 10, type: 1 });
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    fsMock.readFile.mockResolvedValue(new TextEncoder().encode(lines.join("\n")));

    const item = await readFileContext(FILE_URI as never);

    expect(item?.text).toContain("line 399");
    expect(item?.text).not.toContain("line 400");
    expect(item?.text).toContain("…（文件过长，已截断）");
  });

  it(">256KB：不读内容，仅路径引用（过大，仅路径）", async () => {
    fsMock.stat.mockResolvedValue({ size: 256 * 1024 + 1, type: 1 });

    const item = await readFileContext(FILE_URI as never);

    expect(fsMock.readFile).not.toHaveBeenCalled();
    expect(item?.chip.label).toBe("src/client.ts（过大，仅路径）");
    expect(item?.text).toBe('<file path="src/client.ts" note="文件过大，未附带内容" />');
  });

  it("未知扩展回落 text 语言标注", async () => {
    fsMock.stat.mockResolvedValue({ size: 1, type: 1 });
    fsMock.readFile.mockResolvedValue(new TextEncoder().encode("data"));
    const weird = { fsPath: "/w/blob.xyz", toString: () => "file:///w/blob.xyz" };

    const item = await readFileContext(weird as never);

    expect(item?.text).toContain("```text");
  });
});

describe("readDirectoryContext：目录只给结构", () => {
  beforeEach(() => {
    fsMock.stat.mockReset();
    fsMock.readDirectory.mockReset();
  });

  it("结构行 dir/file 前缀 + 排序；mention kind=directory、value 带斜杠", async () => {
    fsMock.stat.mockResolvedValue({ size: 0, type: 2 });
    fsMock.readDirectory.mockResolvedValue([
      ["utils", 2],
      ["client.ts", 1],
      ["README.md", 1],
    ]);

    const item = await readDirectoryContext(DIR_URI as never);

    expect(item?.chip.label).toBe("src/");
    expect(item?.mention?.data).toMatchObject({
      kind: "directory",
      relativePath: "src",
      // value 由 fileMentionRef 构造：目录带尾部斜杠
      path: "/w/src",
    });
    expect(item?.mention?.value).toBe("src/");
    expect(item?.text).toContain('<directory path="src">');
    // .sort() 在映射后的字符串上按字典序：'d' < 'f' → dir utils 排在 file 行之前
    const body = item?.text ?? "";
    expect(body.indexOf("dir utils")).toBeLessThan(body.indexOf("file client.ts"));
    expect(body.indexOf("file README.md")).toBeLessThan(body.indexOf("file client.ts"));
  });

  it(">200 条目：截断并追加标记", async () => {
    fsMock.stat.mockResolvedValue({ size: 0, type: 2 });
    fsMock.readDirectory.mockResolvedValue(
      Array.from({ length: 201 }, (_, i) => [`f${i}.ts`, 1] as [string, number]),
    );

    const item = await readDirectoryContext(DIR_URI as never);

    expect(item?.text).toContain("f199.ts");
    expect(item?.text).not.toContain("f200.ts");
    expect(item?.text).toContain("…（条目过多，已截断）");
  });
});

describe("contextFromUri：按 stat.type 分流", () => {
  beforeEach(() => {
    fsMock.stat.mockReset();
    fsMock.readFile.mockReset();
    fsMock.readDirectory.mockReset();
  });

  it("Directory → 目录结构；File → 文件内容", async () => {
    // contextFromUri 与 readFileContext 各 stat 一次：按 uri 分流返回类型
    fsMock.stat.mockImplementation(async (uri: { fsPath: string }) =>
      uri.fsPath === "/w/src" ? { size: 0, type: 2 } : { size: 1, type: 1 },
    );
    fsMock.readDirectory.mockResolvedValue([["a.ts", 1]]);
    fsMock.readFile.mockResolvedValue(new TextEncoder().encode("ok"));

    const dirItem = await contextFromUri(DIR_URI as never);
    expect(dirItem?.text).toContain("<directory");

    const fileItem = await contextFromUri(FILE_URI as never);
    expect(fileItem?.text).toContain("<file");
    expect(fileItem?.text).toContain("ok");
  });
});
