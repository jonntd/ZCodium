import assert from "node:assert/strict";
import test from "node:test";
import {
  PromptEnhanceGenerationError,
  PromptEnhanceGenerator,
} from "../src/prompt-assist/promptEnhanceGenerator.js";
import {
  ENHANCE_ECHO_PATTERN,
  WB_TEMPLATES,
  extractMarkedResponse,
  sanitizeEnhancedPrompt,
} from "../src/prompt-assist/promptEnhanceTemplates.js";

function buildGenerator(overrides?: {
  currentModel?: { providerId: string; modelId: string } | null;
  responseText?: string;
  /** 每次模型调用按顺序取用的返回文本;耗尽后重复最后一项。 */
  responseSequence?: string[];
  generateError?: Error;
}) {
  const calls: Array<{
    querySource: string;
    messages: Array<{ role: string; content: string }>;
    selection: { providerId: string; modelId: string };
  }> = [];
  const sequence = overrides?.responseSequence ?? [];
  let attempt = 0;
  const generator = new PromptEnhanceGenerator({
    currentModelProvider: {
      async readCurrentModel() {
        return overrides?.currentModel === undefined
          ? { providerId: "custom-channel", modelId: "test-model" }
          : overrides.currentModel;
      },
    },
    textGenerator: {
      async generateText(params) {
        calls.push({
          querySource: params.querySource,
          messages: params.messages,
          selection: params.selection,
        });
        if (overrides?.generateError) throw overrides.generateError;
        const response = sequence.length
          ? sequence[Math.min(attempt, sequence.length - 1)]!
          : (overrides?.responseText ?? "");
        attempt += 1;
        return { text: response };
      },
    },
  });
  return { generator, calls };
}

test("超短输入本地直判透传原文,不调用模型(阈值 6 码点)", async () => {
  const { generator, calls } = buildGenerator();
  assert.deepEqual(await generator.generate({ workspacePath: "/tmp/ws", text: " a " }), {
    text: "a",
    unchanged: true,
  });
  assert.deepEqual(await generator.generate({ workspacePath: "/tmp/ws", text: "test" }), {
    text: "test",
    unchanged: true,
  });
  assert.equal(calls.length, 0);
});

test("未读取到会话模型时报 model-unavailable", async () => {
  const { generator } = buildGenerator({ currentModel: null });
  await assert.rejects(
    generator.generate({ workspacePath: "/tmp/ws", text: "帮我写个脚本" }),
    (error: unknown) => {
      assert.ok(error instanceof PromptEnhanceGenerationError);
      assert.equal(error.reason, "model-unavailable");
      return true;
    },
  );
});

test("正常路径:组装模板消息、携带 prompt_enhance querySource、返回清洗后正文", async () => {
  const { generator, calls } = buildGenerator({
    responseText:
      "### BEGIN RESPONSE ###\n写一个批量重命名文件的脚本,包含错误处理。\n### END RESPONSE ###",
  });
  const result = await generator.generate({
    workspacePath: "/tmp/ws",
    workspaceIdentity: "ws-identity",
    text: "写个重命名脚本",
  });
  assert.equal(result.unchanged, undefined);
  assert.equal(result.text, "写一个批量重命名文件的脚本,包含错误处理。");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.querySource, "prompt_enhance");
  assert.deepEqual(
    calls[0]!.messages.map((message) => message.role),
    ["system", "user"],
  );
  assert.ok(calls[0]!.messages[0]!.content === WB_TEMPLATES.WB_SYS_WORKBUDDY);
  assert.ok(calls[0]!.messages[1]!.content.includes("写个重命名脚本"));
  assert.equal(calls[0]!.selection.providerId, "custom-channel");
});

test("输出缺少 BEGIN/END 标记时重试一次,仍失败判 invalid-output", async () => {
  const { generator, calls } = buildGenerator({
    responseText: "直接回答了用户的问题,没有标记。",
  });
  await assert.rejects(
    generator.generate({ workspacePath: "/tmp/ws", text: "帮我写个脚本" }),
    (error: unknown) => {
      assert.ok(error instanceof PromptEnhanceGenerationError);
      assert.equal(error.reason, "invalid-output");
      return true;
    },
  );
  // 恰好重试一次:初次 + 重试 = 2 次调用,不多不少。
  assert.equal(calls.length, 2);
});

test("invalid-output 重试后输出合规则成功", async () => {
  const { generator, calls } = buildGenerator({
    responseSequence: [
      "### BEGIN RESPONSE ###\n原始文本: 帮我写个脚本\n### END RESPONSE ###",
      "### BEGIN RESPONSE ###\n写一个批量重命名文件的脚本,包含错误处理。\n### END RESPONSE ###",
    ],
  });
  const result = await generator.generate({
    workspacePath: "/tmp/ws",
    text: "帮我写个脚本",
  });
  assert.equal(result.text, "写一个批量重命名文件的脚本,包含错误处理。");
  assert.equal(calls.length, 2);
});

test("标记内指令回显重试后仍回显判 invalid-output,不写草稿", async () => {
  const echoed =
    "### BEGIN RESPONSE ###\n原始文本: 帮我写个脚本\n改写要求: 请增强\n### END RESPONSE ###";
  assert.ok(ENHANCE_ECHO_PATTERN.test(echoed.slice(echoed.indexOf("BEGIN"), echoed.length)));
  const { generator, calls } = buildGenerator({ responseText: echoed });
  await assert.rejects(
    generator.generate({ workspacePath: "/tmp/ws", text: "帮我写个脚本" }),
    (error: unknown) => {
      assert.ok(error instanceof PromptEnhanceGenerationError);
      assert.equal(error.reason, "invalid-output");
      return true;
    },
  );
  assert.equal(calls.length, 2);
});

test("模型调用失败包装为 request-failed,不重试", async () => {
  const { generator, calls } = buildGenerator({
    generateError: new Error("upstream 502"),
  });
  await assert.rejects(
    generator.generate({ workspacePath: "/tmp/ws", text: "帮我写个脚本" }),
    (error: unknown) => {
      assert.ok(error instanceof PromptEnhanceGenerationError);
      assert.equal(error.reason, "request-failed");
      assert.equal(error.detail, "upstream 502");
      return true;
    },
  );
  // 请求级失败由统一执行面的 adapter 重试预算负责,生成器不叠加重试。
  assert.equal(calls.length, 1);
});

test("extractMarkedResponse 只取两标记之间正文", () => {
  assert.equal(
    extractMarkedResponse("前置说明\n### BEGIN RESPONSE ###\n正文A\n### END RESPONSE ###\n尾巴"),
    "正文A",
  );
  assert.equal(extractMarkedResponse("没有标记"), null);
  assert.equal(extractMarkedResponse("### BEGIN RESPONSE ###\n\n### END RESPONSE ###"), null);
});

test("sanitizeEnhancedPrompt 清洗分支:样板语、脚手架围栏、emoji、引号", () => {
  assert.equal(
    sanitizeEnhancedPrompt(
      "Here is an enhanced version of the original instruction that is more specific and clear:\n增强正文",
      "原文",
    ),
    "增强正文",
  );
  assert.equal(
    sanitizeEnhancedPrompt("```tool_call\ngarbage\n```\n增强正文2", "原文"),
    "增强正文2",
  );
  assert.equal(sanitizeEnhancedPrompt("🎉 增强正文3 ✨", "原文"), "增强正文3");
  assert.equal(sanitizeEnhancedPrompt('"增强正文4"', "原文"), "增强正文4");
});

test("sanitizeEnhancedPrompt 清洗后为空回退原文", () => {
  assert.equal(sanitizeEnhancedPrompt("🎉✨", "原始草稿"), "原始草稿");
  assert.equal(sanitizeEnhancedPrompt("", "原始草稿"), "原始草稿");
});
