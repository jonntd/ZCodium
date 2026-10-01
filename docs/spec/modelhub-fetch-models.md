# Spec: 拉取自定义渠道的模型列表（modelhub fetch）

本 spec 定义「设置 → 模型设置 → 拉取模型」这条能力**由谁执行、怎么到达 Web 端**，
以及 UI 如何判断入口可用。它只覆盖 `/models` 拉取；视觉探测（`probeVision`）不在范围内（见 §6）。

## 1. 问题

`zcode-patcher --modelhub` 的 `/models` 拉取必须在 **Node 侧**执行：绝大多数渠道端点
不返回 `Access-Control-Allow-*`，浏览器直连会被 CORS 拦。

原先的实现只存在于桌面 main（`packages/desktop/src/main/modelhubService.ts`，经
`IPlatformService.modelhubFetchModels` → preload → IPC 到达渲染进程），因此：

- 桌面 App：能拉取 ✅
- Web 客户端（`packages/web`）：`createWebPlatform` 故意不实现该能力 → UI 的
  `platform.modelhubFetchModels != null` 探测失败 → **「拉取模型」入口不渲染**。

这就是「web 模型设置里没有拉取模型的按钮」的根因。它**不是**漏了一行，而是当时没有
Web 侧可达的 Node 执行路径 —— 而 Web 客户端本来就有一条到 Host 的 RPC 通道。

## 2. 规则

| 项 | 定义 |
| --- | --- |
| **唯一实现** | `packages/services/src/model-provider/modelhubFetchModels.ts`（Node 侧，`fetch` 直连渠道） |
| 桌面传输 | `IPlatformService.modelhubFetchModels` → preload → main IPC → `fetchModelhubModels`（既有链路，契约不变） |
| Web 传输 | `IProviderSettingsService.fetchModels`（Host/Server 的 Node 侧服务，RPC）→ 同一份实现 |
| UI 可用性判定 | `platform.modelhubFetchModels != null`；Web 平台**只在 Host 暴露 `fetchModels` 时**才提供该能力（不支持时保持 `undefined`，按钮隐藏） |
| 无需版本协商 | 旧 Host 没有 `fetchModels` → Web 端按钮自然隐藏，不出现「可点但必失败」 |

三方方言（`anthropic` / `gemini` / `openai-compatible`）的候选 URL 与鉴权头规则：

| 方言 | 候选 URL（按序尝试） | 鉴权头 |
| --- | --- | --- |
| `openai-compatible`（缺省） | `${base}/models`，若 base 未以 `/vN` 结尾再试 `${base}/v1/models` | `Authorization: Bearer <key>` |
| `anthropic` | `${base}/v1/models`，`${base}/models` | `Authorization` + `x-api-key` |
| `gemini` | `${base}/v1beta/models`，`${base}/models` | `x-goog-api-key`（不带 `Authorization`） |

## 3. 事件顺序（Web 端拉取）

```text
设置页「模型设置」卡片（ProviderCardSections）
  └─ 入口可见性 = platform.modelhubFetchModels != null && 渠道有 baseUrl
      └─ 点击 → platform.modelhubFetchModels({ baseUrl, apiKey, headers, dialect })
          └─ web 平台转发 → services.providerSettingsService.fetchModels(...)   ← RPC 到 Host
              └─ Host（Node）fetchModelhubModels() → 逐个候选 URL 请求 /models
                  └─ { ok: true, models: [{ id, visionGuess }] } 或 { ok: false, error }
                      └─ UI：勾选后走既有 onAddModel 通路落库；失败显示 toast
```

`apiKey` 只在本次请求内使用：不写日志、不落盘（两侧实现都遵守）。

## 4. 失败语义

- 单个候选：404 → 换下一个；非 2xx → 记 `HTTP <status>: <body 前 300 字>` 后换下一个；
  非 JSON（门户页/HTML）→ 记 `not JSON (HTML page?)` 后换下一个；网络异常 → 记 `cause.code | message`。
- 全部候选失败：返回 `{ ok: false, error: <最后一个原因> }`（**不抛异常**，UI 直接展示）。
- `baseUrl` 为空：不发任何请求，直接 `{ ok: false, error: "baseUrl is empty" }`。

## 5. 验收

| 场景 | 期望 | 测试 |
| --- | --- | --- |
| 候选 URL 顺序 | 按方言给出正确顺序；base 已带 `/vN` 时不重复追加 | `packages/services/test/modelhubFetchModels.test.ts` #1 |
| 鉴权头 | openai/anthropic/gemini 各自的头；自定义头可覆盖 | #2 |
| 成功响应 | 去重 + 自然排序 + `visionGuess`；命中首个候选后不再继续请求 | #3 |
| 首个候选 404 | 回退到 `${base}/v1/models` 并成功 | #4 |
| 全部失败 | 返回最后一个原因（含 `HTTP 500`） | #5 |
| 非 JSON | 识别并继续回退 | #6 |
| 空 baseUrl | 不发请求，直接报错 | #7 |
| Web 端入口 | Host 支持时「拉取模型」按钮出现且可用；旧 Host 上保持隐藏 | 浏览器 E2E（本机 relay + 桌面 Host） |

运行：`pnpm --filter @zcode/services test`

## 6. 未做

- **视觉探测（`modelhubProbeVision`）**：同样受 CORS 限制，且 Host 侧暂无对应服务，
  Web 端保持 `undefined`（按钮不渲染），避免「可点但必失败」。要做的话按本 spec 的同一模式加
  `IProviderSettingsService.probeVision`。
- **不新增协议/通道**：复用既有 `IProviderSettingsService` 通道，只新增一个可选的
  `fetchModels` 方法；跨包调用遵循各包公开入口（`@zcode/services` 类型、`@zcode/services/node` 实现）。
