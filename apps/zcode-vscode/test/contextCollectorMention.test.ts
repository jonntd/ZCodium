import { describe, expect, it, vi } from "vitest";

// fileMentionRef 本身不触 vscode API；模块顶层的 import 需要桩。
vi.mock("vscode", () => ({}));
import { fileMentionRef } from "../src/features/contextCollector";

describe("fileMentionRef 选区行号（spec: composer-insert-delivery）", () => {
  it("带 range 时 data 携带起止行，label/markdown 保持调用方给定的展示文案", () => {
    const mention = fileMentionRef(
      "/tmp/gode-ui-test/droptest.txt",
      "droptest.txt",
      "droptest.txt 500-666",
      "file",
      ":500-666",
      { startLine: 500, endLine: 666 },
    );
    expect(mention.id).toBe("file:/tmp/gode-ui-test/droptest.txt:500-666");
    expect(mention.label).toBe("droptest.txt 500-666");
    expect(mention.value).toBe("droptest.txt");
    expect(mention.markdown).toBe("[droptest.txt 500-666](./droptest.txt)");
    expect(mention.data).toEqual({
      kind: "file",
      path: "/tmp/gode-ui-test/droptest.txt",
      relativePath: "droptest.txt",
      startLine: 500,
      endLine: 666,
    });
  });

  it("不带 range 时 data 无行号字段（文件级引用，光标/整文件）", () => {
    const mention = fileMentionRef("/w/a.md", "a.md", "a.md");
    expect(mention.data).toEqual({
      kind: "file",
      path: "/w/a.md",
      relativePath: "a.md",
    });
    expect(mention.id).toBe("file:/w/a.md");
  });
});
