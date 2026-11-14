/**
 * modelhubFetchModels 平台方法的 host 接线（adapters 层）。
 *
 * 拉取语义不在本层：`@zcode/services/node` 的 `fetchModelhubModels` 是唯一实现，
 * 桌面 main IPC 与 Host/Server RPC 服务共用同一份（spec: modelhub-fetch-models）。
 * 这里只做 webview 入参收口（plat-req 对端是 webview，payload 不可信）后透传；
 * apiKey 只在本次请求内使用，不落日志。无 vscode 依赖，可入 vitest 直测。
 */

import type {
  ModelhubFetchModelsRequest,
  ModelhubFetchModelsResult,
} from "@zcode/shared";
import { fetchModelhubModels } from "@zcode/services/node";

/** PlatformMethodHandler 形态：(args) => unknown | Promise<unknown>（platformRpcHandler）。 */
export function createModelhubFetchModelsMethod(deps?: {
  fetchModels?: (payload: ModelhubFetchModelsRequest) => Promise<ModelhubFetchModelsResult>;
}): (args: unknown[]) => Promise<unknown> {
  const fetchModels = deps?.fetchModels ?? fetchModelhubModels;
  return async (args) => {
    const payload = args[0] as Partial<ModelhubFetchModelsRequest> | undefined;
    if (!payload || typeof payload !== "object") {
      throw new Error("modelhubFetchModels: payload 必须为对象");
    }
    if (typeof payload.baseUrl !== "string" || payload.baseUrl.trim().length === 0) {
      throw new Error("modelhubFetchModels: baseUrl 必须为非空字符串");
    }
    return fetchModels({
      baseUrl: payload.baseUrl,
      ...(typeof payload.apiKey === "string" && payload.apiKey.length > 0
        ? { apiKey: payload.apiKey }
        : {}),
      ...(payload.headers && typeof payload.headers === "object" ? { headers: payload.headers } : {}),
      ...(typeof payload.dialect === "string" && payload.dialect.length > 0
        ? { dialect: payload.dialect }
        : {}),
    });
  };
}
