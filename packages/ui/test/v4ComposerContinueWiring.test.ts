// @vitest-environment jsdom
// 继续按钮（patcher-parity spec §4）接线回归。门禁与回滚决策在
// composerContinueAction 纯函数里已有单测；本文件锁的是组件 wiring——
// 2026-10-25 bugfix：此前 handleContinue 无门禁先填后发，submit() 静默拒绝时
// 已填入的合成「继续」滞留输入框，连点即叠加，放行后整串还会被当作一条消息发出。
import { createElement, useEffect, type ComponentProps, type ReactNode } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditor } from "lexical";
import type { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ConversationComposer, type ConversationComposerProps } from "@/v4/ConversationComposer.js";
import { composerScopeKey, resolveComposerScope } from "@/v4/composer/composerDraftStore.js";
import { useComposerAttachmentUploadStore } from "@/store/composerAttachmentUploadStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

type EditorProps = ComponentProps<typeof ChatPromptEditor>;
const h = vi.hoisted(() => ({ editor: null as EditorProps | null, text: "", mounts: 0 }));
vi.mock("@/prompt-editor/ChatPromptEditor.js", () => ({
  ChatPromptEditor: (props: EditorProps) => {
    h.editor = props;
    useEffect(() => {
      h.mounts += 1;
    }, []);
    const api: LexicalChatInputHandle = {
      clear: () => {
        h.text = "";
      },
      focus: () => {},
      getEditorState: () => createEditor().getEditorState(),
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
    // leadingActions 承载继续按钮本体；不渲染则按钮不进 DOM。
    return createElement(
      "div",
      null,
      createElement("div", { "data-testid": "editor" }),
      props.leadingActions ?? null,
    );
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
    intl: {
      formatMessage: ({ id }: { id: string }) =>
        id === "chat.composer.continue.text" ? "继续" : id,
    },
  }),
}));
vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@/v4/composer/V4ComposerToolbar.js", () => ({
  V4ComposerModeSwitch: () => null,
  V4ComposerModelControls: () => null,
}));
vi.mock("@/v4/composer/V4ComposerCuaEntry.js", () => ({ V4ComposerCuaEntry: () => null }));
vi.mock("@/components/ui/dialog.js", () => {
  const Passthrough = ({ children }: { children?: ReactNode }) => children;
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
  serializeComposerPromptContexts: (text: string) => `${text}\n\nCONTEXT`,
  countComposerPromptContexts: () => 1,
}));

const scope = resolveComposerScope("p");
const draft = { text: "", mode: "build" as const, updatedAt: 0 };
function props(patch: Partial<ConversationComposerProps> = {}): ConversationComposerProps {
  return {
    snapshot: null,
    sessionId: null,
    draftMode: true,
    workspacePath: "/same",
    composerDraft: draft,
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
const frames = new Map<number, FrameRequestCallback>();
let frameSequence = 0;
function flushFrames() {
  act(() => {
    const current = [...frames.values()];
    frames.clear();
    current.forEach((callback) => callback(0));
  });
}
/** 冲掉 submit() 链路上的微任务（附件预传 → onSendText → 回滚/清空）。 */
async function flushMicrotasks(times = 8) {
  await act(async () => {
    for (let i = 0; i < times; i += 1) {
      await Promise.resolve();
    }
  });
}
function continueButton(view: ReturnType<typeof render>) {
  const button = view.getByTestId("v4-composer-continue-button");
  expect(button).not.toBeNull();
  return button as HTMLButtonElement;
}
/** Cmd/Ctrl+Shift+J 走 composer 容器的 capture 处理器，不受按钮 disabled 语义影响。 */
function fireContinueShortcut(view: ReturnType<typeof render>) {
  fireEvent.keyDown(view.getByTestId("editor"), {
    key: "j",
    ctrlKey: true,
    shiftKey: true,
  });
}
beforeEach(() => {
  localStorage.clear();
  h.text = "";
  h.mounts = 0;
  h.editor = null;
  frames.clear();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++frameSequence;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  useZCodeSessionStore.setState({ workspaces: {} });
  useComposerAttachmentUploadStore.setState({ scopes: {} });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useComposerAttachmentUploadStore.setState({ scopes: {} });
});

describe("ZUP 继续按钮 wiring（patcher-parity spec §4）", () => {
  it("空草稿点击：填入本地化文案并立即发送，成功后清空输入框", async () => {
    const send = vi.fn<ConversationComposerProps["onSendText"]>(async () => "sent");
    const view = render(createElement(ConversationComposer, props({ onSendText: send })));
    flushFrames();
    fireEvent.click(continueButton(view));
    await flushMicrotasks();
    expect(send).toHaveBeenCalledWith(
      "继续\n\nCONTEXT",
      expect.objectContaining({ submittedDraftText: "继续" }),
    );
    expect(h.text).toBe("");
  });

  it("已有草稿：空格拼接后一并发送，不丢原文", async () => {
    const send = vi.fn<ConversationComposerProps["onSendText"]>(async () => "sent");
    const view = render(createElement(ConversationComposer, props({ onSendText: send })));
    flushFrames();
    await act(async () => {
      h.text = "改一下登录页";
      h.editor!.onChange?.("改一下登录页");
    });
    fireEvent.click(continueButton(view));
    await flushMicrotasks();
    expect(send).toHaveBeenCalledWith(
      "改一下登录页 继续\n\nCONTEXT",
      expect.objectContaining({ submittedDraftText: "改一下登录页 继续" }),
    );
    expect(h.text).toBe("");
  });

  it("上次发送在途（pending）：门禁拒绝，不填入——连点叠加 bug 的直接回归", async () => {
    let release!: () => void;
    const send = vi.fn<ConversationComposerProps["onSendText"]>(
      () =>
        new Promise<"sent">((resolve) => {
          release = () => resolve("sent");
        }),
    );
    const view = render(createElement(ConversationComposer, props({ onSendText: send })));
    flushFrames();
    await act(async () => {
      h.text = "第一问";
      h.editor!.onChange?.("第一问");
      h.editor!.onSubmit?.("第一问");
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(send).toHaveBeenCalledTimes(1);
    // pending 态下按钮可用门禁同步翻灰（= 发送键 canSend 去掉「有草稿」项）。
    expect(continueButton(view).disabled).toBe(true);
    fireContinueShortcut(view);
    await flushMicrotasks(2);
    expect(h.text).toBe("第一问");
    expect(send).toHaveBeenCalledTimes(1);
    await act(async () => release());
  });

  it("submissionReady 未就绪：快捷键路径同样不填入（门禁与按钮同一准入）", async () => {
    const send = vi.fn<ConversationComposerProps["onSendText"]>(async () => "sent");
    const view = render(
      createElement(ConversationComposer, props({ onSendText: send, submissionReady: false })),
    );
    flushFrames();
    expect(continueButton(view).disabled).toBe(true);
    fireContinueShortcut(view);
    await flushMicrotasks(2);
    expect(h.text).toBe("");
    expect(send).not.toHaveBeenCalled();
  });

  it("发送被 guard 拒绝（blocked）：回滚合成的「继续」，恢复点击前草稿", async () => {
    const send = vi.fn<ConversationComposerProps["onSendText"]>(async () => "blocked");
    const view = render(createElement(ConversationComposer, props({ onSendText: send })));
    flushFrames();
    await act(async () => {
      h.text = "改一下登录页";
      h.editor!.onChange?.("改一下登录页");
    });
    fireEvent.click(continueButton(view));
    await flushMicrotasks();
    expect(send).toHaveBeenCalledWith(
      "改一下登录页 继续\n\nCONTEXT",
      expect.objectContaining({ submittedDraftText: "改一下登录页 继续" }),
    );
    expect(h.text).toBe("改一下登录页");
  });
});
