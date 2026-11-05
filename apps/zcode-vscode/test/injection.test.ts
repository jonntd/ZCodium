/**
 * T09 webview 半：@file/@selection 注入格式与降级口径（P1-4/P1-5）。
 *
 * - 注入格式定稿（architecture-p1.md T09）：@file = ui mention markdown
 *   `[name](./relativePath)`；@selection = 纯文本标记 `[file.rs L12-L40]` + 围栏代码块；
 * - 诊断两档：host diagnostics 帧的可读化（仅错误/全部的文案面）；
 * - 降级口径（PRD P1-4.3）：只做 @file/@selection，不做 @symbol、不做代码库索引——
 *   数据源只经 file 频道（IFileService.searchWorkspaceFiles），无符号索引查询面。
 *
 * 纯层测试：injection.ts / mentionSource.ts / selectionChip.tsx 纯函数，无 React 渲染。
 */

import { describe, expect, it } from "vitest";
import type { WorkspaceFileEntry } from "@zcode/shared";
import {
  appendInjection,
  buildDiagnosticsInjection,
  buildFileMentionInjection,
  buildSelectionInjection,
  diagnosticsFrameIsEmpty,
} from "../src/webview-react/composer/injection";
import {
  buildMentionInsertRequest,
  searchWorkspaceFileMentions,
  toFileMentionItem,
} from "../src/webview-react/composer/mentionSource";
import {
  buildSelectionInjectionText,
  buildSelectionPrefill,
  projectSelectionChip,
  selectionChipLabel,
  toWorkspaceRelativePath,
} from "../src/webview-react/composer/selectionChip";

// ── @file 注入格式 ──

describe("buildFileMentionInjection（@file 注入定稿格式）", () => {
  it("相对路径 → `[label](./relativePath)`（与 ui mentionMarkdown 同口径）", () => {
    expect(buildFileMentionInjection("src/index.ts", "index.ts")).toBe(
      "[index.ts](./src/index.ts)",
    );
  });

  it("目录以 `/` 结尾", () => {
    expect(buildFileMentionInjection("src/", "src")).toBe("[src](./src/)");
    expect(buildFileMentionInjection("src\\", "src")).toBe("[src](./src/)");
  });

  it("绝对路径不补 ./（跨 root 引用口径）", () => {
    expect(buildFileMentionInjection("/repo/other/a.rs", "a.rs")).toBe("[a.rs](/repo/other/a.rs)");
  });

  it("label 中的 [] 转义、destination 中的 > 转义", () => {
    expect(buildFileMentionInjection("a>b.ts", "we[ird]")).toBe("[we\\[ird\\]](./a\\>b.ts)");
  });

  it("空路径返回空串（不产生悬空 mention）", () => {
    expect(buildFileMentionInjection("  ", "x")).toBe("");
  });
});

// ── @selection 注入格式 ──

describe("buildSelectionInjection（@selection 注入定稿格式）", () => {
  it("多行选区 → `[file.rs L12-L40]` + 围栏代码块（行号 1-based）", () => {
    const injection = buildSelectionInjection({
      relativePath: "src/file.rs",
      startLine: 11, // 0-based → L12
      endLine: 39, // 0-based → L40
      text: "fn main() {}\nfn other() {}",
    });
    expect(injection).toBe(
      "[src/file.rs L12-L40]\n```\nfn main() {}\nfn other() {}\n```",
    );
  });

  it("单行选区退化为单点标记 `L12`", () => {
    const injection = buildSelectionInjection({
      relativePath: "a.ts",
      startLine: 11,
      endLine: 11,
      text: "const x = 1;",
    });
    expect(injection).toBe("[a.ts L12]\n```\nconst x = 1;\n```");
  });

  it("空选区文本 → 仅标记（无围栏）", () => {
    expect(
      buildSelectionInjection({ relativePath: "a.ts", startLine: 0, endLine: 0, text: "" }),
    ).toBe("[a.ts L1]");
  });
});

describe("appendInjection（注入拼接）", () => {
  it("空草稿直接以注入块开头", () => {
    expect(appendInjection("", "[a.ts L1]")).toBe("[a.ts L1]");
  });

  it("非空草稿补空格；块级注入自带换行时不补", () => {
    expect(appendInjection("看看这个", "[a.ts L1]")).toBe("看看这个 [a.ts L1]");
    expect(appendInjection("看看这个", "\n[a.ts L1]\n```\ncode\n```")).toBe(
      "看看这个\n[a.ts L1]\n```\ncode\n```",
    );
  });
});

// ── 诊断两档（host 帧可读化） ──

describe("buildDiagnosticsInjection（诊断帧预填，P1-5）", () => {
  const frame = {
    tier: "all" as const,
    items: [
      {
        path: "/repo/src/a.ts",
        severity: 0,
        message: "xxx is not defined",
        source: "ts",
        startLine: 9,
        startCharacter: 0,
      },
      {
        path: "/repo/src/b.ts",
        severity: 1,
        message: "unused var",
        startLine: 2,
        startCharacter: 4,
      },
    ],
    errorCount: 1,
    generatedAt: 0,
  };

  it("全部档：标题带档位与计数，条目含 path:line/severity/message/source", () => {
    const text = buildDiagnosticsInjection(frame);
    expect(text).toContain("[diagnostics] 错误+警告（2 条，errors=1）");
    expect(text).toContain("/repo/src/a.ts:10 [Error] xxx is not defined (ts)");
    expect(text).toContain("/repo/src/b.ts:3 [Warning] unused var");
  });

  it("仅错误档文案", () => {
    const firstItem = frame.items[0];
    expect(firstItem).toBeDefined();
    const errorsOnly = { ...frame, tier: "errors" as const, items: firstItem ? [firstItem] : [] };
    expect(buildDiagnosticsInjection(errorsOnly)).toContain("仅错误（1 条，errors=1）");
  });

  it("空诊断 → 哨兵文案（UI 据此禁用发送，P1-5 无诊断禁用）", () => {
    const empty = { ...frame, items: [], errorCount: 0 };
    expect(buildDiagnosticsInjection(empty)).toBe("[diagnostics] 当前无错误+警告级诊断");
    expect(diagnosticsFrameIsEmpty(empty)).toBe(true);
  });
});

// ── @file 补全数据源（file 频道 + folders） ──

function fileEntry(partial: Partial<WorkspaceFileEntry> & { path: string; relativePath: string; name: string }): WorkspaceFileEntry {
  return { type: "file", ...partial } as WorkspaceFileEntry;
}

describe("mentionSource（@file 补全数据源，file 频道 + workspace folders）", () => {
  it("同根命中 → value=相对路径；跨根命中 → value=绝对路径（ui fileMentionProvider 口径）", () => {
    const sameRoot = toFileMentionItem(
      fileEntry({ path: "/repo/src/a.ts", relativePath: "src/a.ts", name: "a.ts" }),
      "/repo",
    );
    expect(sameRoot.value).toBe("src/a.ts");
    expect(sameRoot.markdown).toBe("[a.ts](./src/a.ts)");
    expect(sameRoot.category).toBe("files");

    const otherRoot = toFileMentionItem(
      fileEntry({ path: "/lib/b.ts", relativePath: "b.ts", name: "b.ts" }),
      "/repo",
    );
    expect(otherRoot.value).toBe("/lib/b.ts");
  });

  it("多根查询去重 + 失败 root 不拖垮整体", async () => {
    const calls: string[] = [];
    const fileService = {
      async searchWorkspaceFiles(params: { rootPath: string; query: string; limit?: number }) {
        calls.push(params.rootPath);
        if (params.rootPath === "/bad") throw new Error("denied");
        return params.rootPath === "/repo"
          ? [fileEntry({ path: "/repo/a.ts", relativePath: "a.ts", name: "a.ts" })]
          : [fileEntry({ path: "/repo/a.ts", relativePath: "a.ts", name: "a.ts" })];
      },
    };
    const result = await searchWorkspaceFileMentions({
      fileService,
      workspacePath: "/repo",
      folders: ["/repo", "/bad"],
      query: "a",
    });
    expect(calls).toEqual(["/repo", "/bad"]);
    expect(result.items).toHaveLength(1); // 跨根同 path 去重
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("denied");
  });

  it("插入请求 = mention markdown + 空格（requestComposerTextInsert 入参形状）", () => {
    const item = toFileMentionItem(
      fileEntry({ path: "/repo/a.ts", relativePath: "a.ts", name: "a.ts" }),
      "/repo",
    );
    const request = buildMentionInsertRequest(item);
    expect(request.text).toBe("[a.ts](./a.ts) ");
    expect(request.mention).toMatchObject({ category: "files", value: "a.ts" });
  });
});

// ── 选区 chip（活动编辑器选区，getActiveEditorSelection plat 面） ──

describe("selectionChip（活动编辑器选区投影）", () => {
  it("无编辑器/空选区 → null（chip 隐藏）", () => {
    expect(projectSelectionChip(null, [])).toBeNull();
    expect(
      projectSelectionChip(
        { path: "/repo/a.ts", startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 5, isEmpty: true, text: "" },
        ["/repo"],
      ),
    ).toBeNull();
  });

  it("多根相对路径：命中 folder 前缀裁掉，未命中保留", () => {
    expect(toWorkspaceRelativePath("/repo/src/a.ts", ["/repo", "/lib"])).toBe("src/a.ts");
    expect(toWorkspaceRelativePath("/other/a.ts", ["/repo"])).toBe("/other/a.ts");
    expect(toWorkspaceRelativePath("/repo/src/a.ts", ["C:\\repo"])).toBe("/repo/src/a.ts");
  });

  it("chip 文案与注入块", () => {
    const state = projectSelectionChip(
      {
        path: "/repo/src/file.rs",
        startLine: 11,
        startCharacter: 0,
        endLine: 39,
        endCharacter: 1,
        isEmpty: false,
        text: "fn main() {}",
      },
      ["/repo"],
    );
    expect(state).not.toBeNull();
    expect(selectionChipLabel(state!)).toBe("file.rs L12-L40");
    expect(buildSelectionInjectionText(state!)).toBe("[src/file.rs L12-L40]\n```\nfn main() {}\n```");
    const prefill = buildSelectionPrefill({ workspacePath: "/repo", currentText: "", state: state! });
    expect(prefill.workspacePath).toBe("/repo");
    expect(prefill.text.startsWith("[src/file.rs L12-L40]")).toBe(true);
  });
});
