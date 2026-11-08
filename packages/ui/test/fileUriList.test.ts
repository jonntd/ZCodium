import { describe, expect, it } from "vitest";
import {
  FILE_URI_LIST_MIME,
  VSCODE_TREE_DRAG_MIME_PREFIX,
  hasExplorerResourceDragSignal,
  hasLocalResourceDropSignal,
  parseFileUriList,
} from "@/lib/workspaceFileDrag.js";

describe("parseFileUriList", () => {
  it("解析多行 uri-list，CRLF 与空白分隔的 title 不进入结果", () => {
    expect(
      parseFileUriList(
        "file:///workspace/a.md\r\nfile:///workspace/b.md some title\n",
      ),
    ).toEqual(["file:///workspace/a.md", "file:///workspace/b.md"]);
  });

  it("跳过空行、注释行与非 file scheme（http/https 链接拖拽不入附件）", () => {
    expect(
      parseFileUriList(
        "# comment\n\nhttps://example.com/page\ndata:text/plain,hi\nfile:///a.md",
      ),
    ).toEqual(["file:///a.md"]);
  });

  it("scheme 大小写不敏感，结果按原序去重", () => {
    expect(
      parseFileUriList(
        "FILE:///a.md\nfile:///a.md\nfile:///b.md\nfile:///a.md",
      ),
    ).toEqual(["FILE:///a.md", "file:///b.md"]);
  });

  it("保留百分号编码原样（解码语义由 host Uri.parse 承担）", () => {
    expect(parseFileUriList("file:///tmp/a%20b.md")).toEqual([
      "file:///tmp/a%20b.md",
    ]);
  });

  it("空输入返回空数组", () => {
    expect(parseFileUriList(null)).toEqual([]);
    expect(parseFileUriList(undefined)).toEqual([]);
    expect(parseFileUriList("")).toEqual([]);
  });
});

describe("hasLocalResourceDropSignal / hasExplorerResourceDragSignal", () => {
  const explorerTypes = [
    FILE_URI_LIST_MIME,
    `${VSCODE_TREE_DRAG_MIME_PREFIX}workbench.edit.files`,
  ];
  // Antigravity 实测（探针 2026-11-06）：树拖拽只有 application/vnd.code.uri-list。
  const antigravityTypes = [
    "text/plain",
    FILE_URI_LIST_MIME,
    "resourceurls",
    "codefiles",
    "codeeditors",
    "application/vnd.code.uri-list",
  ];

  it("资源管理器拖拽（uri-list + vnd.code.tree）命中 attachment 信号", () => {
    expect(hasLocalResourceDropSignal(explorerTypes)).toBe(true);
    expect(hasExplorerResourceDragSignal(explorerTypes)).toBe(true);
  });

  it("Antigravity 树拖拽（application/vnd.code.uri-list，无 tree 前缀）命中", () => {
    expect(hasLocalResourceDropSignal(antigravityTypes)).toBe(true);
    expect(hasExplorerResourceDragSignal(antigravityTypes)).toBe(true);
    expect(hasExplorerResourceDragSignal([FILE_URI_LIST_MIME, "application/vnd.code.uri-list"])).toBe(true);
  });

  it("纯链接拖拽（仅 uri-list）不命中，保持默认文本插入", () => {
    expect(hasLocalResourceDropSignal([FILE_URI_LIST_MIME])).toBe(false);
    expect(hasExplorerResourceDragSignal([FILE_URI_LIST_MIME])).toBe(false);
  });

  it("仅 vnd.code.tree 而 URI 列表缺失时不命中（opaque 内容不可读）", () => {
    expect(
      hasLocalResourceDropSignal([`${VSCODE_TREE_DRAG_MIME_PREFIX}x`]),
    ).toBe(false);
  });

  it("OS 文件（Files 类型 / file items）与 workspace MIME 命中", () => {
    expect(hasLocalResourceDropSignal(["text/plain", "Files"])).toBe(true);
    expect(hasLocalResourceDropSignal(["text/plain"], true)).toBe(true);
    expect(
      hasLocalResourceDropSignal(["application/x-zcode-workspace-file"]),
    ).toBe(true);
  });

  it("纯文本拖拽不命中", () => {
    expect(hasLocalResourceDropSignal(["text/plain", "text/html"])).toBe(false);
  });
});
