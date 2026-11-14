/**
 * modelhubFetchModels host 方法收口单测（spec: modelhub-fetch-models §2 VS Code 传输）。
 *
 * 拉取语义由 `@zcode/services/node` 唯一实现承担（另有包内 UT），这里只锁两层契约：
 * - 入参收口：webview payload 不可信，缺 payload / 空 baseUrl 直接参数错误（fail-closed）；
 * - 透传：收口后的 payload 逐字下发唯一实现，结果原样带回（apiKey 只透传不落日志）。
 */

import { describe, expect, it, vi } from "vitest";
import { createModelhubFetchModelsMethod } from "../src/host/modelhubPlatformMethod";

function makeMethod() {
  const fetchModels = vi
    .fn()
    .mockResolvedValue({ ok: true, models: [{ id: "glm-5", visionGuess: true }] });
  return { method: createModelhubFetchModelsMethod({ fetchModels }), fetchModels };
}

describe("modelhubFetchModels host 方法（plat-req 落地面）", () => {
  it("payload 收口后逐字透传唯一实现，结果原样带回", async () => {
    const { method, fetchModels } = makeMethod();
    const payload = {
      baseUrl: "https://api.example.com/v1/",
      apiKey: "sk-test",
      headers: { "x-custom": "1" },
      dialect: "anthropic",
    };
    await expect(method([payload])).resolves.toEqual({
      ok: true,
      models: [{ id: "glm-5", visionGuess: true }],
    });
    expect(fetchModels).toHaveBeenCalledOnce();
    expect(fetchModels).toHaveBeenCalledWith(payload);
  });

  it("可选字段缺省时不携带（apiKey/headers/dialect 只在提供时下发）", async () => {
    const { method, fetchModels } = makeMethod();
    await method([{ baseUrl: "https://api.example.com" }]);
    expect(fetchModels).toHaveBeenCalledWith({ baseUrl: "https://api.example.com" });
  });

  it("缺 payload / 空 baseUrl：参数错误，不触达唯一实现（fail-closed）", async () => {
    const { method, fetchModels } = makeMethod();
    await expect(method([])).rejects.toThrow("payload 必须为对象");
    await expect(method([undefined])).rejects.toThrow("payload 必须为对象");
    await expect(method([{ baseUrl: "   " }])).rejects.toThrow(
      "baseUrl 必须为非空字符串",
    );
    expect(fetchModels).not.toHaveBeenCalled();
  });

  it("唯一实现返回失败结果时原样带回（不抛错，UI 直接展示 error）", async () => {
    const fetchModels = vi
      .fn()
      .mockResolvedValue({ ok: false, error: "HTTP 401: unauthorized" });
    const method = createModelhubFetchModelsMethod({ fetchModels });
    await expect(method([{ baseUrl: "https://api.example.com" }])).resolves.toEqual({
      ok: false,
      error: "HTTP 401: unauthorized",
    });
  });
});
