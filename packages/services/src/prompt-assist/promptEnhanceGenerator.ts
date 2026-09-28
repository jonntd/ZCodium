import type {
  PromptEnhanceDraftRequest,
  PromptEnhanceDraftResult,
  ZCodeWorkspaceGenerateTextParams,
} from "@zcode/shared";
import type { ServiceLogger } from "#src/logger/serviceLogger.js";
import {
  ENHANCE_ECHO_PATTERN,
  WB_TEMPLATES,
  extractMarkedResponse,
  sanitizeEnhancedPrompt,
} from "./promptEnhanceTemplates.js";

/** 与 core runtime（workspace-generate-text.ts）的特判常量保持同一字面量。 */
export const PROMPT_ENHANCE_QUERY_SOURCE = "prompt_enhance";

/**
 * 去空白后不足该码点数视为无改写价值，本地直判透传原文，省一次模型调用。
 * 阈值 6（2026-09-28 修订，原契约 2）：实测 2~4 字符输入会让会话模型产出
 * "改写说明"类元描述甚至嵌套标记，回显检测必然拦截；此类输入没有改写价值。
 */
const MIN_ENHANCE_INPUT_CHARS = 6;

/** invalid-output（标记缺失/指令回显）最多自动重试次数：同模型再生成一次。 */
const INVALID_OUTPUT_MAX_RETRIES = 1;

interface PromptEnhanceCurrentModelProvider {
  readCurrentModel(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeWorkspaceGenerateTextParams["selection"] | null>;
}

interface PromptEnhanceTextGenerator {
  generateText(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    selection: ZCodeWorkspaceGenerateTextParams["selection"];
    messages: Array<{ role: "system" | "user"; content: string }>;
    querySource: string;
  }): Promise<{ text: string }>;
}

interface PromptEnhanceGeneratorOptions {
  currentModelProvider: PromptEnhanceCurrentModelProvider;
  textGenerator: PromptEnhanceTextGenerator;
  logger?: ServiceLogger;
}

/**
 * 严格提取 BEGIN/END 标记间正文并做指令回显检测。
 * 优先取标记间正文；模型未按格式输出（把改写指令回显、把草稿拼在末尾）时
 * 判为不合规，绝不把回显垃圾写进草稿。
 */
function validateMarkedResponse(
  raw: string,
): { ok: true; body: string } | { ok: false; reason: "missing-markers" | "echo"; preview: string } {
  const marked = extractMarkedResponse(raw);
  if (marked === null) {
    return { ok: false, reason: "missing-markers", preview: raw.slice(0, 120) };
  }
  if (ENHANCE_ECHO_PATTERN.test(marked)) {
    return { ok: false, reason: "echo", preview: marked.slice(0, 120) };
  }
  return { ok: true, body: marked };
}

export class PromptEnhanceGenerationError extends Error {
  constructor(
    message: string,
    readonly reason: "model-unavailable" | "request-failed" | "invalid-output",
    readonly detail?: string,
  ) {
    super(message);
    this.name = "PromptEnhanceGenerationError";
  }
}

/**
 * 提示词增强生成器：跟随会话模型（Host View preferredSelection）走统一执行链路。
 * 模板契约（docs/spec/prompt-enhance-unified.md §4）：模板与清洗逐字保留，
 * 标记提取失败或指令回显一律判 invalid-output，绝不把垃圾写进 composer 草稿。
 */
export class PromptEnhanceGenerator {
  constructor(private readonly options: PromptEnhanceGeneratorOptions) {}

  async generate(params: PromptEnhanceDraftRequest): Promise<PromptEnhanceDraftResult> {
    const text = String(params.text ?? "").trim();
    if ([...text].length < MIN_ENHANCE_INPUT_CHARS) {
      // 本地直判：超短输入无改写价值，直接透传原文（unchanged），省一次模型调用。
      return { text, unchanged: true };
    }

    const selection = await this.resolveCurrentModel(params);
    const messages = [
      { role: "system" as const, content: WB_TEMPLATES.WB_SYS_WORKBUDDY },
      {
        role: "user" as const,
        // replace 用函数形式，防草稿里的 `$&` 等替换模式注入模板。
        content: WB_TEMPLATES.WB_USER_WORKBUDDY.replace("{input}", () => text),
      },
    ];

    this.options.logger?.info(undefined, "开始生成提示词增强", {
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      providerId: selection.providerId,
      model: selection.modelId,
      inputChars: [...text].length,
    });

    // 标记提取/回显检测不合规时同模型重试一次：旧旁路靠跨渠道 failover 提供
    // 韧性，单模型链路对偶发坏输出只有重试这一条恢复路径（spec §4）。
    let rawMessage = await this.complete({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
      selection,
      messages,
    });
    for (let attempt = 0; ; attempt++) {
      const outcome = validateMarkedResponse(rawMessage);
      if (outcome.ok) {
        // sanitize 清洗残余围栏/脚手架/emoji；清空则回退原文（spec §4 契约）。
        return { text: sanitizeEnhancedPrompt(outcome.body, text) };
      }
      this.options.logger?.debug(undefined, "提示词增强输出不合规", {
        workspacePath: params.workspacePath,
        providerId: selection.providerId,
        model: selection.modelId,
        attempt,
        reason: outcome.reason,
        preview: outcome.preview,
      });
      if (attempt >= INVALID_OUTPUT_MAX_RETRIES) {
        throw new PromptEnhanceGenerationError(
          outcome.reason === "echo"
            ? "模型把改写指令回显进了增强结果。"
            : "模型没有按标记格式返回增强结果。",
          "invalid-output",
          outcome.preview,
        );
      }
      this.options.logger?.info(undefined, "提示词增强输出不合规，重试一次", {
        workspacePath: params.workspacePath,
        providerId: selection.providerId,
        model: selection.modelId,
        attempt,
        reason: outcome.reason,
      });
      rawMessage = await this.complete({
        workspacePath: params.workspacePath,
        workspaceIdentity: params.workspaceIdentity,
        selection,
        messages,
      });
    }
  }

  private async resolveCurrentModel(params: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<ZCodeWorkspaceGenerateTextParams["selection"]> {
    const currentModel = await this.options.currentModelProvider.readCurrentModel({
      workspacePath: params.workspacePath,
      workspaceIdentity: params.workspaceIdentity,
    });
    const modelId = currentModel?.modelId?.trim();
    const providerId = currentModel?.providerId?.trim();
    const options = currentModel?.options;
    if (!providerId || !modelId) {
      throw new PromptEnhanceGenerationError("未读取到当前模型。", "model-unavailable");
    }
    return {
      providerId,
      modelId,
      ...(options ? { options: { ...options } } : {}),
    };
  }

  private async complete(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    selection: ZCodeWorkspaceGenerateTextParams["selection"];
    messages: Array<{ role: "system" | "user"; content: string }>;
  }): Promise<string> {
    try {
      const result = await this.options.textGenerator.generateText({
        workspacePath: params.workspacePath,
        ...(params.workspaceIdentity ? { workspaceIdentity: params.workspaceIdentity } : {}),
        selection: params.selection,
        messages: params.messages,
        querySource: PROMPT_ENHANCE_QUERY_SOURCE,
      });
      if (typeof result.text !== "string" || !result.text.trim()) {
        throw new Error("模型响应缺少文本内容。");
      }
      return result.text.trim();
    } catch (error) {
      if (error instanceof PromptEnhanceGenerationError) {
        throw error;
      }
      throw new PromptEnhanceGenerationError(
        "模型请求失败。",
        "request-failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
