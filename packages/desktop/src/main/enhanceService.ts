// 提示词增强服务（zcode-patcher --enhance-btn 原生版）。
// main 进程读取用户级渠道配置（~/.zcode/v2/config.json + setting.json + credentials.json），
// 按可用性评分挑选渠道/模型，直接调用渠道 API 改写 composer 草稿。
// 与补丁载荷 ENH_MAIN_HANDLERS 行为一致：模板文案、渠道评分、重试与降级语义均对齐。
import {
  asString,
  channelModels,
  loadConfigBundle,
  resolveSelectedProviderId,
  scoreChannels,
  type JsonObject,
} from "./enhanceConfig.js";
import type { EnhanceListModelsResult, EnhancePromptDraftResult } from "@zcode/shared";
import { logger } from "./logger.js";
import { WB_TEMPLATES, sanitizeEnhancedPrompt } from "./enhanceTemplates.js";

/**
 * 严格提取 BEGIN/END RESPONSE 标记之间的增强正文。
 * 模型不守格式（例如把改写指令回显、把草稿拼在末尾）时返回 null，调用方将该
 * 模型判为失败并 failover——绝不把指令回显垃圾写进 composer 草稿。
 */
/** 指令回显特征：正常增强结果是任务提示词本身，绝不会包含这些元描述。 */
const ENHANCE_ECHO_PATTERN =
  /(原始文本[:：]|改写要求[:：]|增强要求[:：]|请将增强后的|原始\s*Prompt[:：]|BEGIN RESPONSE|END RESPONSE)/i;

function extractMarkedResponse(raw: string): string | null {
  const text = String(raw || "");
  const begin = text.search(/###\s*BEGIN RESPONSE\s*###/i);
  if (begin < 0) return null;
  const from = text.indexOf("\n", begin);
  const rest = text.slice(from >= 0 ? from + 1 : begin);
  const end = rest.search(/###\s*END RESPONSE\s*###/i);
  const body = (end >= 0 ? rest.slice(0, end) : rest).trim();
  return body || null;
}

// ── IPC: zcode:enhance-list-models ──

export async function enhanceListModels(): Promise<EnhanceListModelsResult> {
  try {
    const { cfg, st, credRaw, manualCfg } = loadConfigBundle();
    const providers = (cfg.provider ?? {}) as Record<string, JsonObject | null>;
    const selectedId = resolveSelectedProviderId(cfg, st);
    // oauth access_token 的键名是明文（只有值加密），按键名判断无需解密。
    const oauthAccessKeys = new Set(
      Object.keys(credRaw).filter(
        (key) => key.startsWith("oauth:") && key.endsWith(":access_token"),
      ),
    );
    const channels = Object.keys(providers)
      .filter(
        (id) =>
          providers[id] && providers[id]!.enabled !== false && !String(id).startsWith("builtin:"),
      )
      .map((id) => {
        const provider = providers[id]!;
        const options = (provider.options ?? {}) as JsonObject;
        let score = 0;
        if (String(options.apiKey ?? "").trim()) score += 2;
        if (String(options.baseURL ?? "").trim()) score += 1;
        if (!String(id).startsWith("builtin:")) score += 1;
        if (id === selectedId) score += 10;
        // hasKey 按渠道判定（bugfix：曾存在任一 oauth token 就给全部渠道打 true，
        // 徽标失真）：渠道自有 apiKey，或该渠道自己的 oauth:<id>:access_token 在场。
        // enhancePromptDraft 里的 oauthTokens[0] 跨渠道兜底只是尝试性 fallback
        // （token 跨供应商基本无效），徽标不为其背书。
        const hasKey =
          Boolean(String(options.apiKey ?? asString(provider.apiKey)).trim()) ||
          oauthAccessKeys.has(`oauth:${id}:access_token`);
        return {
          id,
          name: String(provider.name ?? "").trim() || id,
          kind: String(provider.kind ?? ""),
          score,
          selected: id === selectedId,
          hasKey,
          models: channelModels(provider),
        };
      })
      .sort((a, b) => b.score - a.score);
    const manualBase = asString(manualCfg.baseURL).trim();
    const manualKey = asString(manualCfg.apiKey).trim();
    const manualModel = asString(manualCfg.model).trim();
    const manual =
      manualBase && manualKey && manualModel
        ? { model: manualModel, kind: asString(manualCfg.kind).trim() || "anthropic" }
        : null;
    return { ok: true, selected: selectedId ?? "", channels, manual };
  } catch (error) {
    logger.warn("enhanceListModels failed", error);
    return {
      ok: false,
      selected: "",
      channels: [],
      error: `list: ${String((error as Error)?.message || error)}`,
    };
  }
}

// ── 提示词增强模板（与补丁载荷逐字一致，禁止随意改写影响增强质量） ──

// ── IPC: zcode:enhance-run ──

export async function enhancePromptDraft(payload: {
  text: string;
  channel?: string;
  model?: string;
}): Promise<EnhancePromptDraftResult> {
  try {
    const text = String(payload?.text ?? "").trim();
    if (!text) return { ok: false, error: "empty draft" };
    // 本地直判：超短输入无改写价值，直接透传原文（unchanged），省一次模型调用。
    if ([...text].length < 2) {
      return { ok: true, text, unchanged: true };
    }
    // 单链路：incipit 提示词（专业 Prompt 工程师），思考始终显式关闭。
    const sys = WB_TEMPLATES.WB_SYS_WORKBUDDY;
    const userInput = WB_TEMPLATES.WB_USER_WORKBUDDY.replace("{input}", () => text);
    const maxTok = 4096;

    const { cfg, st, credRaw, manualCfg } = loadConfigBundle();
    const { oauthTokens, active, scored } = scoreChannels(cfg, st, credRaw);
    if (
      manualCfg &&
      String(manualCfg.baseURL ?? "").trim() &&
      String(manualCfg.apiKey ?? "").trim()
    ) {
      const manualModel = String(manualCfg.model ?? "").trim();
      if (manualModel) {
        scored.unshift({
          id: "manual",
          provider: { kind: String(manualCfg.kind ?? "anthropic"), models: { [manualModel]: {} } },
          options: {
            baseURL: manualCfg.baseURL,
            apiKey: manualCfg.apiKey,
            headers: manualCfg.headers,
          },
          score: 0,
        });
      }
    }
    const wantChannel = String(payload?.channel ?? "").trim();
    const wantModel = String(payload?.model ?? "").trim();
    if (wantModel && !(wantChannel && String(wantChannel).startsWith("builtin:"))) {
      const providers = (cfg.provider ?? {}) as Record<string, JsonObject | null>;
      // 渠道 id 命中优先；composer 传来的可能是显示名而非 id，此时按模型 id 在
      // 启用渠道中兜底定位（当前模型是最可靠的增强目标）。
      const direct = wantChannel ? providers[wantChannel] : undefined;
      const directModels = (direct?.models ?? {}) as Record<string, unknown>;
      const found =
        direct && direct.enabled !== false && directModels[wantModel] !== undefined
          ? direct
          : Object.values(providers).find(
              (provider) =>
                provider &&
                provider.enabled !== false &&
                ((provider.models ?? {}) as Record<string, unknown>)[wantModel] !== undefined,
            );
      if (found) {
        const foundModels = (found.models ?? {}) as Record<string, unknown>;
        if (foundModels[wantModel]) {
          const foundId =
            Object.keys(providers).find((id) => providers[id] === found) ?? wantChannel;
          scored.unshift({
            id: foundId,
            provider: found,
            options: (found.options ?? {}) as JsonObject,
            score: Number.MAX_SAFE_INTEGER,
            forcedModel: wantModel,
          });
        }
      }
    }

    const errors: string[] = [];
    for (const { id, provider, options, forcedModel } of scored) {
      const base = String(options.baseURL ?? provider.baseURL ?? "").replace(/\/+$/, "");
      if (!base) continue;
      let key = String(options.apiKey ?? provider.apiKey ?? "").trim();
      if (!key) {
        const chosen =
          oauthTokens.find(([k]) => active && k.startsWith(`oauth:${active}:`)) ||
          oauthTokens.find(([k]) => k.startsWith(`oauth:${id}:`)) ||
          oauthTokens[0];
        if (chosen && String(chosen[1]).length > 8) key = String(chosen[1]);
      }
      if (!key) continue;
      const kind = String(provider.kind ?? "anthropic").toLowerCase();
      const models = forcedModel
        ? [forcedModel]
        : channelModels(provider)
            .slice(0, 3)
            .map((entry) => entry.id);
      if (!models.length) continue;
      const extraHeaders =
        options.headers && typeof options.headers === "object"
          ? (options.headers as Record<string, string>)
          : {};
      const endpoint = (suffix: string) =>
        /\/v\d+$/.test(base) ? base + suffix : `${base}/v1${suffix}`;
      for (const model of models) {
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (kind.includes("anthropic")) {
            headers["x-api-key"] = key;
            headers.Authorization = `Bearer ${key}`;
            headers["anthropic-version"] = "2023-06-01";
          } else {
            headers.Authorization = `Bearer ${key}`;
          }
          for (const headerKey of Object.keys(extraHeaders))
            headers[headerKey] = extraHeaders[headerKey]!;
          let url: string;
          let requestBody: string;
          let parse: (json: JsonObject) => string;
          if (kind.includes("anthropic")) {
            url = endpoint("/messages");
            requestBody = JSON.stringify({
              model,
              max_tokens: maxTok,
              // 常规链路轻量化：显式关思考。思考默认开启的渠道会拖慢响应，
              // 且可能吃掉 max_tokens 预算导致正文截断（parse 出空 → 整渠道误判失败）。
              // 创意模式是深度发展链路，保持服务端默认。
              thinking: { type: "disabled" },
              system: sys,
              messages: [{ role: "user", content: userInput }],
            });
            parse = (json) => {
              const content = (json.content ?? []) as { text?: string }[];
              const out = content
                .map((chunk) => chunk?.text ?? "")
                .join("")
                .trim();
              if (!out) throw new Error("empty response");
              return out;
            };
          } else {
            url = endpoint("/chat/completions");
            requestBody = JSON.stringify({
              model,
              max_tokens: maxTok,
              messages: [
                { role: "system", content: sys },
                { role: "user", content: userInput },
              ],
            });
            parse = (json) => {
              const choices = (json.choices ?? []) as {
                message?: { content?: string };
              }[];
              const out = String(choices[0]?.message?.content ?? "").trim();
              if (!out) throw new Error("empty response");
              return out;
            };
          }
          let response: Response | null = null;
          let body = "";
          for (let attempt = 0; attempt < 2; attempt++) {
            if (response && response.status === 429) {
              await new Promise((resolve) => setTimeout(resolve, 1600));
            }
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), 45000);
            try {
              response = await fetch(url, {
                method: "POST",
                headers,
                body: requestBody,
                signal: controller.signal,
              });
            } finally {
              clearTimeout(timer);
            }
            body = await response.text();
            if (response.status !== 429 || attempt === 1) break;
          }
          if (!response || !response.ok) {
            errors.push(`${id}/${model} HTTP${response?.status} ${body.slice(0, 70)}`);
            if (response && (response.status === 401 || response.status === 403)) break;
            if (response && response.status === 400 && /captcha|verify|sign/i.test(body)) break;
            continue;
          }
          let json: JsonObject;
          try {
            json = JSON.parse(body) as JsonObject;
          } catch {
            errors.push(`${id} non-JSON`);
            continue;
          }
          const parsed = parse(json);
          // 优先取标记间正文；模型未按格式输出（指令回显等）判为该模型失败，
          // failover 到下一模型，绝不把回显垃圾写进草稿。
          const marked = extractMarkedResponse(parsed) ?? extractMarkedResponse(body);
          if (marked === null) {
            errors.push(`${id}/${model} response missing BEGIN/END markers`);
            continue;
          }
          if (ENHANCE_ECHO_PATTERN.test(marked)) {
            // 模型把改写指令/格式说明回显进了标记内——同样判失败并 failover。
            errors.push(`${id}/${model} instruction echo detected`);
            continue;
          }
          // sanitize 清洗残余围栏/脚手架/emoji，清空则回退原文。
          return { ok: true, text: sanitizeEnhancedPrompt(marked, text), model, channel: id };
        } catch (error) {
          errors.push(`${id}/${model} ${(error as Error)?.message || error}`);
        }
      }
    }
    return {
      ok: false,
      error: `所有渠道均失败 — ${errors.length ? errors.join("；") : "没有可用渠道"}`,
    };
  } catch (error) {
    logger.warn("enhancePromptDraft failed", error);
    return { ok: false, error: String((error as Error)?.message || error) };
  }
}
