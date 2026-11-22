/**
 * composer-insert mention pill 节点保真回归（2026-11-22 用户反馈：pill 显示成
 * canonical markdown 纯文本 `[README.md 14-17](./README.md)`）。
 *
 * 用**真实 Lexical 编辑器**（jsdom headless）驱动 LexicalChatInput 的真实插入/
 * 序列化路径，锁死三段保真：
 * 1. prepend-if-missing 插入 → 编辑器内是 PromptMentionNode 节点（非 TextNode）；
 * 2. 节点存在时 getEditorMarkdown 输出 canonical markdown（发送/草稿文本面）；
 * 3. editorState.toJSON() → parseEditorState 往返（重载草稿恢复路径）→ 节点不降级。
 *
 * 若 1/3 失败，即「pill 显示成纯文本」的根因在编辑器层；全部通过则退化发生在
 * 投递链（请求丢失 mentions/mention 走 setText 兜底）——两段证据面分开归因。
 */
import { describe, expect, it } from "vitest";
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
} from "lexical";
import {
  $isPromptMentionNode,
  PromptMentionNode,
} from "@/mentions/nodes/PromptMentionNode.js";
import {
  getEditorMarkdown,
  prependEditorMentionIfMissing,
} from "@/LexicalChatInput.js";

const HOST_FILE_MENTION = {
  id: "file:/w/README.md",
  category: "files" as const,
  label: "README.md 14-17",
  value: "README.md",
  markdown: "[README.md 14-17](./README.md)",
  data: {
    kind: "file" as const,
    path: "/w/README.md",
    relativePath: "README.md",
    startLine: 14,
    endLine: 17,
  },
};

function makeEditor(): LexicalEditor {
  const editor = createEditor({
    namespace: "composer-insert-repro",
    theme: {},
    nodes: [PromptMentionNode],
    onError: (error: Error) => {
      throw error;
    },
  });
  editor.update(() => {
    $getRoot().append($createParagraphNode());
  });
  return editor;
}

function mentionNodes(editor: LexicalEditor): PromptMentionNode[] {
  const found: PromptMentionNode[] = [];
  editor.getEditorState().read(() => {
    for (const node of $getRoot().getAllTextNodes()) {
      if ($isPromptMentionNode(node)) found.push(node);
    }
  });
  return found;
}

/** 全部节点读取都收进 read 上下文（Lexical 状态读取同步契约）。 */
function inspectEditor(
  editor: LexicalEditor,
  inspect: (nodes: PromptMentionNode[], markdown: string) => void,
): void {
  editor.getEditorState().read(() => {
    const nodes: PromptMentionNode[] = [];
    for (const node of $getRoot().getAllTextNodes()) {
      if ($isPromptMentionNode(node)) nodes.push(node);
    }
    inspect(nodes, getEditorMarkdown(editor.getEditorState()));
  });
}

describe("composer-insert mention pill 节点保真（真实 Lexical）", () => {
  it("prepend-if-missing：插入的是 PromptMentionNode 节点，非 canonical 文本", () => {
    const editor = makeEditor();
    const inserted = prependEditorMentionIfMissing(editor, HOST_FILE_MENTION);
    expect(inserted).toBe(true);

    inspectEditor(editor, (nodes) => {
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.getMention().id).toBe("file:/w/README.md");
      // 编辑器正文（DOM 文本面）= 展示文字，不是 canonical markdown
      expect(nodes[0]!.getTextContent()).not.toBe(HOST_FILE_MENTION.markdown);
    });
  });

  it("getEditorMarkdown：节点存在时输出 canonical markdown（草稿/发送文本面）", () => {
    const editor = makeEditor();
    prependEditorMentionIfMissing(editor, HOST_FILE_MENTION);
    expect(getEditorMarkdown(editor.getEditorState())).toBe(
      "[README.md 14-17](./README.md) ",
    );
  });

  it("已有草稿正文时 prepend：节点前置 + 正文保留（与事故截图同构）", () => {
    const editor = makeEditor();
    editor.update(() => {
      const paragraph = $getRoot().getFirstChild() as ReturnType<
        typeof $getRoot.getFirstChild
      > & { append: (node: ReturnType<typeof $createTextNode>) => void };
      paragraph.append($createTextNode("bbbbbb"));
    });
    expect(prependEditorMentionIfMissing(editor, HOST_FILE_MENTION)).toBe(true);
    expect(mentionNodes(editor)).toHaveLength(1);
    expect(getEditorMarkdown(editor.getEditorState())).toBe(
      "[README.md 14-17](./README.md) bbbbbb",
    );
  });

  it("editorState JSON 往返（重载草稿恢复路径）：节点不降级为文本", () => {
    const editor = makeEditor();
    prependEditorMentionIfMissing(editor, HOST_FILE_MENTION);
    const json = JSON.stringify(editor.getEditorState().toJSON());

    const restored = makeEditor();
    const state = restored.parseEditorState(json);
    restored.setEditorState(state);

    inspectEditor(restored, (nodes, markdown) => {
      expect(nodes).toHaveLength(1);
      expect(nodes[0]!.getMention().id).toBe("file:/w/README.md");
      expect(nodes[0]!.getTextContent()).not.toBe(HOST_FILE_MENTION.markdown);
      expect(markdown).toBe("[README.md 14-17](./README.md) ");
    });
  });

  it("同 id 二次 prepend 判重命中（不新增第二个 pill）", () => {
    const editor = makeEditor();
    expect(prependEditorMentionIfMissing(editor, HOST_FILE_MENTION)).toBe(true);
    expect(prependEditorMentionIfMissing(editor, HOST_FILE_MENTION)).toBe(false);
    inspectEditor(editor, (nodes) => {
      expect(nodes).toHaveLength(1);
    });
  });
});
