// 模型拉取 / 视觉探测（zcode-patcher --modelhub 原生版）。
// 来源：zcode-modelhub-patch (MIT) 的载荷逻辑，本仓库以 Node 侧实现重新实现。
//
// /models 拉取的**唯一实现**已下沉到 `@zcode/services/node`（`fetchModelhubModels`）：
// 桌面 main 的 IPC 与 Host/Server 的 RPC 服务（IProviderSettingsService.fetchModels）共用同一份，
// Web 端因此也能「拉取模型」（经 Host 转发；浏览器直连渠道会被 CORS 拦，见
// docs/spec/modelhub-fetch-models.md）。视觉探测仍留在 main：只有它需要，且同样只需 Node fetch。
import type { ModelhubFetchModelsRequest, ModelhubFetchModelsResult } from "@zcode/shared";
import { buildModelhubHeaders, fetchModelhubModels } from "@zcode/services/node";
import { logger } from "./logger.js";

/** 桌面 renderer 的 IPC 入口：转发到 Node 侧唯一实现，保持既有 IPC 契约不变。 */
export function modelhubFetchModels(
  payload: ModelhubFetchModelsRequest,
): Promise<ModelhubFetchModelsResult> {
  return fetchModelhubModels(payload);
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
    const headers = buildModelhubHeaders(baseUrl, payload.apiKey, payload.headers, dialect);
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
