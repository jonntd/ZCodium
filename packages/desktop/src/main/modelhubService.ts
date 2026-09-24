// 模型拉取服务（zcode-patcher --modelhub 原生版）。
// 来源：zcode-modelhub-patch (MIT) 的载荷逻辑，本仓库以 main 进程服务重新实现。
// renderer 直接 fetch 自定义端点会被 CORS 拦截，因此 /models 拉取与视觉探测
// 都在 main 进程执行（Node fetch，无 CORS）；apiKey 只在本请求内使用，不落日志。
import { logger } from "./logger.js";

/** 兼容 anthropic / gemini / openai-compatible 三种渠道方言的 /models 端点。 */
function candidateModelListUrls(baseUrl: string, dialect: string): string[] {
  if (dialect === "anthropic") {
    return [`${baseUrl}/v1/models`, `${baseUrl}/models`];
  }
  if (dialect === "gemini") {
    return [`${baseUrl}/v1beta/models`, `${baseUrl}/models`];
  }
  const urls = [`${baseUrl}/models`];
  if (!/\/v\d+[a-z]*$/i.test(baseUrl)) urls.push(`${baseUrl}/v1/models`);
  return urls;
}

/** 与官方「平均缓存命中率」无关；此处按模型名猜测视觉能力（探测器不可用时的兜底）。 */
const VISION_ID_PATTERN =
  /(vision|vl-|gpt-4o|gpt-4\.1|gpt-5|claude|gemini|qwen.*vl|glm-4v|glm-5|internvl|llava|pixtral|o4-|omni|doubao.*vision|step-1v|deepseek-vision)/i;

function buildHeaders(
  baseUrl: string,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  dialect: string,
): Record<string, string> {
  void baseUrl;
  const hs: Record<string, string> = { "Content-Type": "application/json" };
  Object.assign(hs, headers && typeof headers === "object" ? headers : {});
  if (apiKey) {
    hs.Authorization = `Bearer ${apiKey}`;
    if (dialect === "anthropic") hs["x-api-key"] = apiKey;
    if (dialect === "gemini") {
      hs["x-goog-api-key"] = apiKey;
      delete hs.Authorization;
    }
  }
  return hs;
}

export async function modelhubFetchModels(payload: {
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  dialect?: string;
}): Promise<{ ok: boolean; models?: { id: string; visionGuess: boolean }[]; error?: string }> {
  try {
    const baseUrl = String(payload.baseUrl ?? "")
      .trim()
      .replace(/\/+$/, "");
    if (!baseUrl) return { ok: false, error: "baseUrl is empty" };
    const dialect = String(payload.dialect ?? "openai-compatible");
    const headers = buildHeaders(baseUrl, payload.apiKey, payload.headers, dialect);
    let lastError: string | null = null;
    for (const url of candidateModelListUrls(baseUrl, dialect)) {
      let response: Response;
      try {
        response = await fetch(url, { headers });
      } catch (error) {
        const cause = (error as { cause?: { code?: string } })?.cause?.code;
        lastError = String(cause || (error as Error)?.message || error);
        continue;
      }
      if (response.status === 404) {
        lastError = `404 at ${url}`;
        continue;
      }
      const text = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${text.slice(0, 300)}`;
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        lastError = `response is not JSON (HTML page?) at ${url}`;
        continue;
      }
      const raw = Array.isArray(json)
        ? json
        : ((json as { data?: unknown[] })?.data ?? (json as { models?: unknown[] })?.models ?? []);
      const ids = (raw as unknown[])
        .map((item) =>
          typeof item === "string"
            ? item
            : String((item as { id?: string })?.id ?? (item as { name?: string })?.name ?? ""),
        )
        .filter(Boolean);
      const naturalOrder = (a: string, b: string) =>
        a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
      return {
        ok: true,
        models: [...new Set(ids)].sort(naturalOrder).map((id) => ({
          id,
          visionGuess: VISION_ID_PATTERN.test(id),
        })),
      };
    }
    return { ok: false, error: lastError ?? "404: no /models endpoint found" };
  } catch (error) {
    logger.warn("modelhubFetchModels failed", error);
    return { ok: false, error: String((error as Error)?.message || error) };
  }
}

/** 1x1 透明 PNG：视觉探测的最小有效图片载荷。 */
const PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export async function modelhubProbeVision(payload: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
  dialect?: string;
}): Promise<{ ok: boolean; vision?: boolean; detail?: string; error?: string; status?: number }> {
  try {
    const baseUrl = String(payload.baseUrl ?? "")
      .trim()
      .replace(/\/+$/, "");
    const dialect = String(payload.dialect ?? "openai-compatible");
    const headers = buildHeaders(baseUrl, payload.apiKey, payload.headers, dialect);
    if (dialect === "gemini") {
      return { ok: true, vision: false, detail: "gemini probe unsupported" };
    }
    const imageData = PROBE_PNG_BASE64;
    const body =
      dialect === "anthropic"
        ? JSON.stringify({
            model: payload.model,
            max_tokens: 16,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "What color is this image? One word." },
                  {
                    type: "image",
                    source: { type: "base64", media_type: "image/png", data: imageData },
                  },
                ],
              },
            ],
          })
        : JSON.stringify({
            model: payload.model,
            max_tokens: 16,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "What color is this image? One word." },
                  { type: "image_url", image_url: { url: `data:image/png;base64,${imageData}` } },
                ],
              },
            ],
          });
    const urls =
      dialect === "anthropic"
        ? [`${baseUrl}/v1/messages`, `${baseUrl}/messages`]
        : [`${baseUrl}/chat/completions`].concat(
            /\/v\d+[a-z]*$/i.test(baseUrl) ? [] : [`${baseUrl}/v1/chat/completions`],
          );
    for (const url of urls) {
      let response: Response;
      try {
        response = await fetch(url, { method: "POST", headers, body });
      } catch (error) {
        const cause = (error as { cause?: { code?: string } })?.cause?.code;
        return { ok: false, error: String(cause || (error as Error)?.message || error) };
      }
      if (response.status === 404) continue;
      const text = await response.text();
      if (response.ok) return { ok: true, vision: true, detail: text.slice(0, 120) };
      if (response.status === 400 || response.status === 422) {
        const lower = text.toLowerCase();
        if (
          /image|visual|multimodal|multi-modal|content.*type|unsupported/.test(lower) &&
          !/rate|quota|billing|token limit|context length|maximum/.test(lower)
        ) {
          return { ok: true, vision: false, detail: "rejected image input" };
        }
      }
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
      };
    }
    return { ok: false, error: "404" };
  } catch (error) {
    logger.warn("modelhubProbeVision failed", error);
    return { ok: false, error: String((error as Error)?.message || error) };
  }
}
