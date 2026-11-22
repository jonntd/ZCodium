// @vitest-environment jsdom
// composer-insert pill 持久化保真 wiring 回归（spec: composer-insert-delivery
// 「pill 持久化保真」2026-11-22 修订）。
//
// 事故：右键加入的 mention pill 数秒内降级成 canonical markdown 纯文本
// （`[README.md 14-17](./README.md) bbbbbb`）。链路：插入 pill → 编辑器 onChange →
// 旧实现 updateComposerContent({text}) 只写正文（updateComposerContent 会无条件抹掉
// editorStateJson/mention，且经 persistDraft 同步落盘）→ draftFocusVersion 翻动改变
// updateComposerContent 身份 → 草稿恢复 effect 重放 → 纯文本草稿经 setText 复原 →
// pill 永久降级（webview localStorage 草稿记录为同步 wipe 写实证）。
//
// 本测试锁死 wiring 口径：编辑器 onChange 进入草稿 store 时**同一拍携带
// editorStateJson 快照**，且快照内包含真实的 prompt-mention 节点（真实 Lexical
// 序列化，非 mock 字符串）。
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditor, $getRoot, $createParagraphNode } from "lexical";
import type { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ConversationComposer, type ConversationComposerProps } from "@/v4/ConversationComposer.js";
import { composerScopeKey, resolveComposerScope } from "@/v4/composer/composerDraftStore.js";
import { useComposerAttachmentUploadStore } from "@/store/composerAttachmentUploadStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  prependEditorMentionIfMissing,
} from "@/LexicalChatInput.js";
import {
  PromptMentionNode,
} from "@/mentions/nodes/PromptMentionNode.js";

// ui 测试环境不提供 localStorage（composerDraftStore 持久化会读写），与
// v4ComposerContinueWiring.test.ts 同口径用 Map 桩。
const localStorageState = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageState.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localStorageState.set(key, value);
    },
    removeItem: (key: string) => {
      localStorageState.delete(key);
    },
    clear: () => {
      localStorageState.clear();
    },
  },
});

type EditorProps = ComponentProps<typeof ChatPromptEditor>;
const h = vi.hoisted(() => ({
  editor: null as EditorProps | null,
  text: "",
  editorState: null as import("lexical").EditorState | null,
}));
vi.mock("@/prompt-editor/ChatPromptEditor.js", () => ({
  ChatPromptEditor: (props: EditorProps) => {
    h.editor = props;
    const api: LexicalChatInputHandle = {
      clear: () => {
        h.text = "";
      },
      focus: () => {},
      getEditorState: () => h.editorState!,
      getMarkdown: () => h.text,
      getText: () => h.text,
      appendText: (text) => {
        h.text += text;
      },
      appendFileMention: () => {},
      prependMentionIfMissing: () => false,
      setMention: () => {},
      insertMention: () => {},
      setText: (text) => {
        h.text = text;
      },
      setTextWithPluginMentions: (text) => {
        h.text = text;
      },
      setEditorStateJson: () => {},
      setSkillMention: () => {},
      setSlashCommandMention: () => {},
    };
    if (props.inputApiRef) props.inputApiRef.current = api;
    return createElement("div", { "data-testid": "editor" });
  },
}));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({ canSelectFilePath: true }),
  useOptionalPlatform: () => null,
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => ({ promptAttachmentTransferService: {} }),
  useOptionalServices: () => null,
}));
vi.mock("@/hooks/useSettingService.js", () => ({ useSettings: () => ({ settings: null }) }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "zh-CN",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/v4/composer/V4ComposerToolbar.js", () => ({
  V4ComposerModeSwitch: () => null,
  V4ComposerModelControls: () => null,
}));
vi.mock("@/v4/composer/V4ComposerCuaEntry.js", () => ({ V4ComposerCuaEntry: () => null }));
vi.mock("@/components/ui/dialog.js", () => {
  const Passthrough = ({ children }: { children: unknown }) => children;
  return {
    Dialog: () => null,
    DialogClose: Passthrough,
    DialogContent: Passthrough,
    DialogDescription: Passthrough,
    DialogFooter: Passthrough,
    DialogHeader: Passthrough,
    DialogTitle: Passthrough,
  };
});
vi.mock("@/v4/composer/composerPromptContexts.js", () => ({
  serializeComposerPromptContexts: (text: string) => text,
  countComposerPromptContexts: () => 0,
}));

const scope = resolveComposerScope(null);
function props(patch: Partial<ConversationComposerProps> = {}): ConversationComposerProps {
  return {
    snapshot: null,
    sessionId: null,
    draftMode: true,
    workspacePath: "/w/claude-code",
    composerDraft: { text: "", mode: "build" as const, updatedAt: 0 },
    rootDraftScopeKey: composerScopeKey(scope),
    updateComposerContent: vi.fn(),
    replaceComposerDraft: vi.fn(),
    createSubmissionFromComposer: () => ({
      mode: "build",
      planEnabled: false,
      modelSelection: { providerId: "p", modelId: "m", options: { reasoningLevel: "high" } },
    }),
    onSendText: vi.fn<ConversationComposerProps["onSendText"]>(async () => "sent"),
    onStop: vi.fn(),
    onSelectModel: vi.fn(),
    onSelectThought: vi.fn(),
    onSwitchMode: vi.fn(),
    attachmentPut: vi.fn(),
    autoFocusEnabled: false,
    ...patch,
  };
}

/** 构造带真实 PromptMentionNode 的编辑器状态（模拟 prepend 之后的编辑器）。 */
function editorStateWithFileMention(): import("lexical").EditorState {
  const editor = createEditor({
    namespace: "composer-insert-snapshot-test",
    theme: {},
    nodes: [PromptMentionNode],
    onError: (error: Error) => {
      throw error;
    },
  });
  editor.update(() => {
    $getRoot().append($createParagraphNode());
  });
  editor.update(() => {
    prependEditorMentionIfMissing(editor, {
      id: "file:/w/README.md",
      category: "files",
      label: "README.md 14-17",
      value: "README.md",
      markdown: "[README.md 14-17](./README.md)",
      data: { kind: "file", path: "/w/README.md", relativePath: "README.md", startLine: 14, endLine: 17 },
    });
  });
  return editor.getEditorState();
}

beforeEach(() => {
  localStorage.clear();
  h.text = "";
  h.editor = null;
  h.editorState = null;
  useZCodeSessionStore.setState({ workspaces: {} });
  useComposerAttachmentUploadStore.setState({ scopes: {} });
});
afterEach(() => {
  cleanup();
  h.editorState = null;
  useComposerAttachmentUploadStore.setState({ scopes: {} });
});

describe("编辑器 onChange → 草稿快照同一拍落库（pill 持久化保真）", () => {
  it("onChange 携带 editorStateJson 快照，内含真实 prompt-mention 节点（本 bug 修复点）", () => {
    const updateComposerContent = vi.fn<ConversationComposerProps["updateComposerContent"]>();
    render(createElement(ConversationComposer, props({ updateComposerContent })));
    h.editorState = editorStateWithFileMention();
    h.text = "[README.md 14-17](./README.md) bbbbbb";

    act(() => {
      h.editor!.onChange?.("[README.md 14-17](./README.md) bbbbbb");
    });

    expect(updateComposerContent).toHaveBeenCalled();
    const payload = updateComposerContent.mock.calls.at(-1)![0];
    expect(payload.text).toBe("[README.md 14-17](./README.md) bbbbbb");
    expect(typeof payload.editorStateJson).toBe("string");
    const parsed = JSON.parse(payload.editorStateJson!) as {
      root: { children: Array<{ children: Array<{ type: string; mentionId?: string }> }> };
    };
    const nodes = parsed.root.children.flatMap((p) => p.children);
    expect(nodes.some((n) => n.type === "prompt-mention" && n.mentionId === "file:/w/README.md")).toBe(true);
  });

  it("onChange 快照的 JSON 经 parseEditorState 往返后节点仍在（恢复重放不降级）", () => {
    const updateComposerContent = vi.fn<ConversationComposerProps["updateComposerContent"]>();
    render(createElement(ConversationComposer, props({ updateComposerContent })));
    h.editorState = editorStateWithFileMention();
    h.text = "[README.md 14-17](./README.md) bbbbbb";
    act(() => {
      h.editor!.onChange?.("[README.md 14-17](./README.md) bbbbbb");
    });

    const payload = updateComposerContent.mock.calls.at(-1)![0];
    const restored = createEditor({
      namespace: "composer-insert-snapshot-restore",
      theme: {},
      nodes: [PromptMentionNode],
      onError: (error: Error) => {
        throw error;
      },
    });
    restored.setEditorState(restored.parseEditorState(payload.editorStateJson!));
    restored.getEditorState().read(() => {
      const mentionNodes = $getRoot()
        .getAllTextNodes()
        .filter((node) => node.getType() === "prompt-mention");
      expect(mentionNodes).toHaveLength(1);
    });
  });
});
