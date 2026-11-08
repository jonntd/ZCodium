import { describe, expect, it, vi } from "vitest";
import {
  applyExternalTextInsertRequestToComposer,
  restorePersistedComposerDraftIntoInput,
} from "@/v4/ConversationComposer.js";


describe("v4 queue edit extraction", () => {
  it("Workspace 插件页重挂载时从共享草稿恢复结构化 mention", () => {
    const mention = {
      id: "plugin:document-skills@official",
      category: "plugins" as const,
      label: "文档技能",
      value: "document-skills@official",
      markdown: "[@文档技能](plugin://document-skills@official)",
      data: { pluginId: "document-skills@official" },
    };
    const inputApi = {
      getMarkdown: vi.fn(() => "unused"),
      setEditorStateJson: vi.fn(),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const text = `${mention.markdown} 整理文档`;

    expect(
      restorePersistedComposerDraftIntoInput({
        draft: { text, mention, updatedAt: 1 },
        inputApi,
      }),
    ).toBe(text);
    expect(inputApi.setMention).toHaveBeenCalledWith(mention, " 整理文档");
    expect(inputApi.setText).not.toHaveBeenCalled();
  });

  it("插件 Skills 与独立 Skills 的 New 入口从共享草稿恢复 skill node", () => {
    const mention = {
      id: "skill:skill-creator",
      category: "skills" as const,
      label: "skill-creator",
      value: "skill-creator",
      markdown: "[$skill-creator](./.agents/skills/skill-creator/SKILL.md)",
      data: {
        path: ".agents/skills/skill-creator/SKILL.md",
        scope: "workspace" as const,
      },
    };
    const inputApi = {
      getMarkdown: vi.fn(() => "unused"),
      setEditorStateJson: vi.fn(),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const text = `${mention.markdown} `;

    expect(
      restorePersistedComposerDraftIntoInput({
        draft: { text, mention },
        inputApi,
      }),
    ).toBe(text);
    expect(inputApi.setMention).toHaveBeenCalledWith(mention, " ");
    expect(inputApi.setText).not.toHaveBeenCalled();
  });

  it("新建技能把 canonical 前缀恢复为结构化 Skill mention 并保留尾空格", () => {
    const mention = {
      id: "skill:skill-creator",
      category: "skills" as const,
      label: "skill-creator",
      value: "skill-creator",
      markdown: "[$skill-creator](./.agents/skills/skill-creator/SKILL.md)",
      data: {
        path: ".agents/skills/skill-creator/SKILL.md",
        scope: "workspace" as const,
      },
    };
    const inputApi = {
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();
    const requestFocus = vi.fn();
    const scheduleDraftPersist = vi.fn();
    const text = `${mention.markdown} `;

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: { requestId: 6, text, mention },
        requestFocus,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(6);
    expect(inputApi.setMention).toHaveBeenCalledWith(mention, " ");
    expect(inputApi.setText).not.toHaveBeenCalled();
    expect(updateText).toHaveBeenCalledWith(text);
  });

  it("商店试用把 canonical 前缀恢复为结构化 Plugin mention", () => {
    const mention = {
      id: "plugin:demo@mkt",
      category: "plugins" as const,
      label: "Demo",
      value: "demo@mkt",
      markdown: "[@Demo](plugin://demo@mkt)",
      data: {
        pluginId: "demo@mkt",
        icon: "https://cdn.example.com/demo.png",
      },
    };
    const inputApi = {
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();
    const requestFocus = vi.fn();
    const scheduleDraftPersist = vi.fn();
    const text = `${mention.markdown} Diagnose this workspace`;

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: { requestId: 7, text, mention },
        requestFocus,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(7);
    expect(inputApi.setMention).toHaveBeenCalledWith(
      mention,
      " Diagnose this workspace",
    );
    expect(inputApi.setText).not.toHaveBeenCalled();
    expect(updateText).toHaveBeenCalledWith(text);
    expect(scheduleDraftPersist).toHaveBeenCalledTimes(1);
    expect(requestFocus).toHaveBeenCalledTimes(1);
  });

  it("插件安装完成后把唯一 chip 前置到编辑器当前正文而不回放旧 prompt", () => {
    const mention = {
      id: "plugin:document-skills@zcode-plugins-official",
      category: "plugins" as const,
      label: "文档技能",
      value: "document-skills@zcode-plugins-official",
      markdown: "[@文档技能](plugin://document-skills@zcode-plugins-official)",
      data: { pluginId: "document-skills@zcode-plugins-official" },
    };
    const inputApi = {
      getMarkdown: vi.fn(() => `${mention.markdown} 用户安装期间编辑后的正文`),
      prependMentionIfMissing: vi.fn(() => true),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();
    const requestFocus = vi.fn();
    const scheduleDraftPersist = vi.fn();

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: {
          requestId: 8,
          text: mention.markdown,
          mention,
          mode: "prepend-if-missing",
        },
        requestFocus,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(8);
    expect(inputApi.prependMentionIfMissing).toHaveBeenCalledWith(mention);
    expect(updateText).toHaveBeenCalledWith(
      `${mention.markdown} 用户安装期间编辑后的正文`,
    );
    expect(inputApi.setMention).not.toHaveBeenCalled();
    expect(inputApi.setText).not.toHaveBeenCalled();
  });

  it("当前草稿已有同一 Plugin canonical 文本时不重复插入 chip", () => {
    const mention = {
      id: "plugin:demo@mkt",
      category: "plugins" as const,
      label: "Demo",
      value: "demo@mkt",
      markdown: "[@Demo](plugin://demo@mkt)",
      data: { pluginId: "demo@mkt" },
    };
    const inputApi = {
      // label 是 display-only；即使语言切换导致 label 不同，同一 stable ID 也不能重复插入。
      getMarkdown: vi.fn(() => "[@旧名称](plugin://demo@mkt) 当前正文"),
      prependMentionIfMissing: vi.fn(() => false),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: {
          requestId: 9,
          text: mention.markdown,
          mention,
          mode: "prepend-if-missing",
        },
        requestFocus: vi.fn(),
        scheduleDraftPersist: vi.fn(),
        updateText,
      }),
    ).toBe(9);
    expect(inputApi.prependMentionIfMissing).toHaveBeenCalledWith(mention);
    expect(inputApi.setMention).not.toHaveBeenCalled();
    expect(updateText).not.toHaveBeenCalled();
  });

  it("批量 mentions 单帧按逆序前置，最终顺序与传入一致且只 updateText 一次", () => {
    const mentionA = {
      id: "file:/w/a.ts",
      category: "files" as const,
      label: "a.ts",
      value: "a.ts",
      markdown: "[a.ts](./a.ts)",
    };
    const mentionB = {
      id: "file:/w/b.ts",
      category: "files" as const,
      label: "b.ts",
      value: "b.ts",
      markdown: "[b.ts](./b.ts)",
    };
    const inputApi = {
      getMarkdown: vi.fn(() => "[b.ts](./b.ts) [a.ts](./a.ts) "),
      prependMentionIfMissing: vi.fn(() => true),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();
    const requestFocus = vi.fn();
    const scheduleDraftPersist = vi.fn();

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: {
          requestId: 10,
          text: "[a.ts](./a.ts) [b.ts](./b.ts) ",
          mentions: [mentionA, mentionB],
          mode: "prepend-if-missing",
        },
        requestFocus,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(10);
    // prepend 每次插到最前：按逆序应用（先 b 后 a）后编辑器顺序与传入一致。
    expect(inputApi.prependMentionIfMissing).toHaveBeenNthCalledWith(
      1,
      mentionB,
    );
    expect(inputApi.prependMentionIfMissing).toHaveBeenNthCalledWith(
      2,
      mentionA,
    );
    expect(updateText).toHaveBeenCalledTimes(1);
    expect(updateText).toHaveBeenCalledWith("[b.ts](./b.ts) [a.ts](./a.ts) ");
    expect(requestFocus).toHaveBeenCalledTimes(1);
    expect(scheduleDraftPersist).toHaveBeenCalledTimes(1);
    expect(inputApi.setMention).not.toHaveBeenCalled();
    expect(inputApi.setText).not.toHaveBeenCalled();
  });

  it("批量 mentions 全部判重命中时不再 updateText，仅交回焦点作反馈", () => {
    const mention = {
      id: "file:/w/a.ts:1-2",
      category: "files" as const,
      label: "a.ts 1-2",
      value: "a.ts",
      markdown: "[a.ts 1-2](./a.ts)",
    };
    const inputApi = {
      getMarkdown: vi.fn(() => "[a.ts 1-2](./a.ts) "),
      prependMentionIfMissing: vi.fn(() => false),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();
    const requestFocus = vi.fn();
    const scheduleDraftPersist = vi.fn();

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: {
          requestId: 11,
          text: "[a.ts 1-2](./a.ts) ",
          mentions: [mention],
          mode: "prepend-if-missing",
        },
        requestFocus,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(11);
    expect(updateText).not.toHaveBeenCalled();
    expect(scheduleDraftPersist).not.toHaveBeenCalled();
    expect(requestFocus).toHaveBeenCalledTimes(1);
  });

  it("单数 mention 在批量字段缺省时保持既有 prepend 行为", () => {
    const mention = {
      id: "file:/w/a.ts",
      category: "files" as const,
      label: "a.ts",
      value: "a.ts",
      markdown: "[a.ts](./a.ts)",
    };
    const inputApi = {
      getMarkdown: vi.fn(() => "[a.ts](./a.ts) "),
      prependMentionIfMissing: vi.fn(() => true),
      setMention: vi.fn(),
      setText: vi.fn(),
    };
    const updateText = vi.fn();
    const requestFocus = vi.fn();
    const scheduleDraftPersist = vi.fn();

    expect(
      applyExternalTextInsertRequestToComposer({
        appliedRequestId: null,
        inputApi,
        request: {
          requestId: 12,
          text: "[a.ts](./a.ts) ",
          mention,
          mode: "prepend-if-missing",
        },
        requestFocus,
        scheduleDraftPersist,
        updateText,
      }),
    ).toBe(12);
    expect(inputApi.prependMentionIfMissing).toHaveBeenCalledTimes(1);
    expect(updateText).toHaveBeenCalledWith("[a.ts](./a.ts) ");
  });
});
