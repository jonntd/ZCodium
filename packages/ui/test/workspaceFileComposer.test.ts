import { describe, expect, it, vi } from "vitest";
import type { MutableRefObject } from "react";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { appendExplorerFileDropMentionsToComposer } from "@/lib/workspaceFileComposer.js";

function makeInputApiRef(appended: Array<Record<string, unknown>> = []) {
  const handle = {
    appendFileMention: vi.fn(
      (
        name: string,
        value: string,
        markdown: string,
        data?: Record<string, unknown>,
      ) => {
        appended.push({ name, value, markdown, data });
      },
    ),
    focus: vi.fn(),
  } as unknown as LexicalChatInputHandle;
  const ref = {
    current: handle,
  } as MutableRefObject<LexicalChatInputHandle | null>;
  return { ref, appended };
}

describe("appendExplorerFileDropMentionsToComposer（spec: composer-explorer-file-drop v2）", () => {
  it("N 个文件循环追加 N 个 pill，文本面按序拼接且 onTextChange 逐次生效", () => {
    const { ref, appended } = makeInputApiRef();
    const onTextChange = vi.fn();

    const finalText = appendExplorerFileDropMentionsToComposer({
      inputApiRef: ref,
      currentMarkdown: "",
      resolvedPaths: [
        "/tmp/gode-ui-test/README.md",
        "/tmp/gode-ui-test/droptest.txt",
      ],
      workspacePath: "/tmp/gode-ui-test",
      onTextChange,
    });

    expect(appended).toHaveLength(2);
    // 同 workspace → relativePath；跨目录时 helper 落到绝对路径。
    expect(appended[0]).toMatchObject({
      name: "README.md",
      value: "README.md",
      markdown: "[README.md](./README.md)",
    });
    expect(appended[1]).toMatchObject({
      name: "droptest.txt",
      value: "droptest.txt",
      markdown: "[droptest.txt](./droptest.txt)",
    });
    expect(finalText).toBe(
      "[README.md](./README.md) [droptest.txt](./droptest.txt) ",
    );
    expect(onTextChange).toHaveBeenNthCalledWith(
      1,
      "[README.md](./README.md) ",
    );
    expect(onTextChange).toHaveBeenNthCalledWith(
      2,
      "[README.md](./README.md) [droptest.txt](./droptest.txt) ",
    );
    expect(ref.current?.focus).toHaveBeenCalled();
  });

  it("workspace 外的文件用绝对路径作为 mention 目标", () => {
    const { ref, appended } = makeInputApiRef();
    appendExplorerFileDropMentionsToComposer({
      inputApiRef: ref,
      currentMarkdown: "",
      resolvedPaths: ["/Users/someone/else/notes.md"],
      workspacePath: "/tmp/gode-ui-test",
      onTextChange: vi.fn(),
    });
    expect(appended[0]).toMatchObject({
      name: "notes.md",
      value: "/Users/someone/else/notes.md",
      markdown: "[notes.md](/Users/someone/else/notes.md)",
    });
  });
});
