// @vitest-environment jsdom

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UserInputRow } from "@zcode/shared/zcode-protocol-v4";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import type { ConversationRowRenderContext } from "@/v4/conversationRowContext.js";

// docs/spec/patcher-parity.md §4：继续按钮发出的纯继续消息在对话流中整行隐藏。
// 模型侧照常收到该文本（按钮语义不变），只是这条 user 行不再渲染气泡与动作行。

const context: ConversationRowRenderContext = {
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
  sessionId: "session-1",
  theme: "system",
  workspacePath: "/workspace",
};

function userInputRow(overrides: Partial<UserInputRow> = {}): UserInputRow {
  return {
    rowId: 7,
    entityId: "message-user-7",
    turnId: "turn-1",
    createdAt: 1_700_000_000_000,
    createdAtSeq: 1,
    kind: "userInput",
    origin: "realUser",
    text: "继续",
    ...overrides,
  };
}

function html(row: UserInputRow, locale: "en-US" | "zh-CN" = "zh-CN"): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: locale },
      createElement(TooltipProvider, null, createElement(ConversationRowView, { context, row })),
    ),
  );
}

describe("ConversationRowView 纯继续行隐藏", () => {
  it("zh/en 两个 token 都整行隐藏（含气泡与动作行）", () => {
    for (const [text, locale] of [
      ["继续", "zh-CN"],
      ["Continue", "en-US"],
    ] as const) {
      const out = html(userInputRow({ text }), locale);
      // 不只看气泡：复制/编辑/时间动作行也必须一起消失，否则会留下空壳。
      expect(out).not.toContain("data-v4-user-input-bubble");
      expect(out.trim()).toBe("");
    }
  });

  it("历史行按 token 值判定，不随当前 UI 语言切换漏判", () => {
    // zh 会话切到 en 界面：历史里的「继续」仍是 zh token，必须照样隐藏。
    expect(html(userInputRow({ text: "继续" }), "en-US").trim()).toBe("");
    expect(html(userInputRow({ text: "Continue" }), "zh-CN").trim()).toBe("");
  });

  it("带草稿正文拼接的继续消息照常展示", () => {
    const out = html(userInputRow({ text: "改一下登录页 继续" }));
    expect(out).toContain("data-v4-user-input-bubble");
    expect(out).toContain("改一下登录页 继续");
  });

  it("带附件的继续消息照常展示", () => {
    const out = html(
      userInputRow({
        attachments: [
          {
            ref: "att-1",
            fileName: "a.txt",
            mime: "text/plain",
            bytes: 3,
          },
        ],
      }),
    );
    expect(out).toContain("data-v4-user-input-bubble");
    expect(out).toContain("继续");
  });

  it("带引擎尾注的继续消息照常展示", () => {
    const out = html(userInputRow({ text: "继续\n\n---\nengine text", epilogueStart: 2 }));
    expect(out).toContain("data-v4-user-input-bubble");
  });

  it("普通用户消息不受影响", () => {
    const out = html(userInputRow({ text: "帮我看看这个 bug" }));
    expect(out).toContain("data-v4-user-input-bubble");
    expect(out).toContain("帮我看看这个 bug");
  });
});
