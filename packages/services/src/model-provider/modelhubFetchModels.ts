/**
 * 自定义渠道的模型列表拉取（zcode-patcher `--modelhub` 原生版）。
 *
 * 为什么放在 Node 侧服务层：浏览器直连渠道端点会被 CORS 拦（绝大多数渠道不返回
 * `Access-Control-Allow-*`），请求必须由 Node 侧发出。放在这里可以让
 * **桌面 main 的 IPC**（`packages/desktop/src/main/modelhubService.ts`）与
 * **Host/Server 的 RPC 服务**（`IProviderSettingsService.fetchModels`）共用同一份实现 ——
 * Web 端因此也能有「拉取模型」入口（经 Host 转发，见 docs/spec/modelhub-fetch-models.md）。
 *
 * `apiKey` 只在本次请求内使用：不写日志、不落盘。
 */
import type { ModelhubFetchModelsRequest, ModelhubFetchModelsResult } from "@zcode/shared";

/** 兼容 anthropic / gemini / openai-compatible 三种渠道方言的 `/models` 端点（按顺序尝试）。 */
export function candidateModelListUrls(baseUrl: string, dialect: string): string[] {
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

/** 按渠道方言拼请求头；视觉探测（probeVision）复用同一份，避免两种实现漂移。 */
export function buildModelhubHeaders(
  baseUrl: string,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
  dialect: string,
): Record<string, string> {
  void baseUrl;
  const merged: Record<string, string> = { "Content-Type": "application/json" };
  Object.assign(merged, headers && typeof headers === "object" ? headers : {});
  if (apiKey) {
    merged.Authorization = `Bearer ${apiKey}`;
    if (dialect === "anthropic") merged["x-api-key"] = apiKey;
    if (dialect === "gemini") {
      merged["x-goog-api-key"] = apiKey;
      delete merged.Authorization;
    }
  }
  return merged;
}

function normalizeBaseUrl(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .replace(/\/+$/, "");
}

/**
 * 拉取渠道的模型列表。逐个候选 URL 尝试，命中第一个可用响应即返回；
 * 全部失败时返回**最后一个**原因（便于设置页直接展示，如 404 / 非 JSON / 网络错误）。
 */
export async function fetchModelhubModels(
  payload: ModelhubFetchModelsRequest,
): Promise<ModelhubFetchModelsResult> {
  try {
    const baseUrl = normalizeBaseUrl(payload.baseUrl);
    if (!baseUrl) return { ok: false, error: "baseUrl is empty" };
    const dialect = String(payload.dialect ?? "openai-compatible");
    const headers = buildModelhubHeaders(baseUrl, payload.apiKey, payload.headers, dialect);
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
    return { ok: false, error: String((error as Error)?.message || error) };
  }
}
