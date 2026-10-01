// modelhub 模型拉取的 Node 侧实现测试（契约见 docs/spec/modelhub-fetch-models.md）。
//
// 这里钉住三件容易错的事：
//   1. 候选 URL 顺序（不同方言的 /models 位置不同）
//   2. 鉴权头按方言切换（openai-compatible/anthropic 用 Authorization(+x-api-key)，gemini 用 x-goog-api-key）
//   3. 失败语义：逐个候选回退，全部失败时返回**最后一个**原因，而不是笼统的 "failed"
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildModelhubHeaders,
  candidateModelListUrls,
  fetchModelhubModels,
} from "../src/model-provider/modelhubFetchModels.js";

interface FetchCall {
  url: string;
  headers: Record<string, string>;
}

/** 用固定响应替换全局 fetch；返回调用记录与还原函数。 */
function stubFetch(handler: (url: string) => Response): {
  calls: FetchCall[];
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(url);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("候选 URL 按方言给出正确顺序", () => {
  assert.deepEqual(candidateModelListUrls("https://api.example.com", "openai-compatible"), [
    "https://api.example.com/models",
    "https://api.example.com/v1/models",
  ]);
  // 已经带 /v1 时不再追加 /v1/models
  assert.deepEqual(candidateModelListUrls("https://api.example.com/v1", "openai-compatible"), [
    "https://api.example.com/v1/models",
  ]);
  assert.deepEqual(candidateModelListUrls("https://api.anthropic.com", "anthropic"), [
    "https://api.anthropic.com/v1/models",
    "https://api.anthropic.com/models",
  ]);
  assert.deepEqual(candidateModelListUrls("https://generativelanguage.example.com", "gemini"), [
    "https://generativelanguage.example.com/v1beta/models",
    "https://generativelanguage.example.com/models",
  ]);
});

test("鉴权头按方言切换，自定义头可覆盖", () => {
  const openai = buildModelhubHeaders("https://x", "sk-1", undefined, "openai-compatible");
  assert.equal(openai.Authorization, "Bearer sk-1");

  const anthropic = buildModelhubHeaders("https://x", "sk-2", undefined, "anthropic");
  assert.equal(anthropic.Authorization, "Bearer sk-2");
  assert.equal(anthropic["x-api-key"], "sk-2");

  const gemini = buildModelhubHeaders("https://x", "g-1", undefined, "gemini");
  assert.equal(gemini["x-goog-api-key"], "g-1");
  assert.equal(gemini.Authorization, undefined);

  const custom = buildModelhubHeaders("https://x", undefined, { "X-Org": "team" }, "openai-compatible");
  assert.equal(custom["X-Org"], "team");
  assert.equal(custom.Authorization, undefined);
});

test("拉取成功：去重、自然排序、按模型名给出视觉猜测", async () => {
  const stub = stubFetch(
    () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "my-model-10" }, { id: "my-model-2" }, { id: "gpt-4o" }] }), {
        status: 200,
      }),
  );
  try {
    const result = await fetchModelhubModels({ baseUrl: "https://api.example.com" });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.models?.map((m) => m.id),
      ["gpt-4o", "my-model-2", "my-model-10"],
      "去重 + 自然排序（my-model-2 在 my-model-10 前）",
    );
    assert.equal(result.models?.[0]?.visionGuess, true);
    assert.equal(result.models?.find((m) => m.id === "my-model-2")?.visionGuess, false);
    assert.equal(stub.calls.length, 1, "第一个候选命中后不再尝试其它 URL");
  } finally {
    stub.restore();
  }
});

test("首个候选 404 时回退到下一个候选（/models → /v1/models）", async () => {
  const stub = stubFetch((url) =>
    url.endsWith("/v1/models")
      ? new Response(JSON.stringify(["claude-sonnet"]), { status: 200 })
      : new Response("not found", { status: 404 }),
  );
  try {
    const result = await fetchModelhubModels({ baseUrl: "https://api.example.com" });
    assert.equal(result.ok, true);
    assert.deepEqual(result.models, [{ id: "claude-sonnet", visionGuess: true }]);
    assert.deepEqual(stub.calls.map((c) => c.url), [
      "https://api.example.com/models",
      "https://api.example.com/v1/models",
    ]);
  } finally {
    stub.restore();
  }
});

test("全部候选失败时返回最后一个原因（不是笼统 failed）", async () => {
  const stub = stubFetch(() => new Response("boom", { status: 500 }));
  try {
    const result = await fetchModelhubModels({ baseUrl: "https://api.example.com/v1" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /HTTP 500/);
  } finally {
    stub.restore();
  }
});

test("非 JSON 响应（HTML 门户页）被识别并继续回退", async () => {
  const stub = stubFetch(() => new Response("<!doctype html><title>portal</title>", { status: 200 }));
  try {
    const result = await fetchModelhubModels({ baseUrl: "https://api.example.com" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /not JSON/);
    assert.equal(stub.calls.length, 2, "两个候选都试过");
  } finally {
    stub.restore();
  }
});

test("空 baseUrl 直接失败，不发请求", async () => {
  const stub = stubFetch(() => new Response("{}", { status: 200 }));
  try {
    const result = await fetchModelhubModels({ baseUrl: "   " });
    assert.deepEqual(result, { ok: false, error: "baseUrl is empty" });
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});
