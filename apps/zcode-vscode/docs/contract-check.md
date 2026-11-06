# zcode-vscode 契约核对单（contract-check）

> 本文是 T01/T14 的成文验收件（§8.1）：把「桥 wire schema」「`@zcode/shared` 版本锁定关系」
> 「v4 协议命令面消费清单」三件事从口口相传变成文档。对应代码事实：
> `src/bridge/wire.ts`（帧族 + base64 编解码）、`src/host/hostBridgeProtocol.ts`（host 侧）、
> `src/webview-react/bridge/webviewMessagePort.ts`（webview 侧）、
> `packages/shared/src/zcode-protocol-v4/command.ts`（v4 命令 schema 唯一事实）。
> 改动上述任一文件时必须同步更新本文，并由 `src/contract.test.ts` 的 re-export 断言守护。

## 1. 桥 wire schema（架构 §2.2 唯一自定义 wire）

### 1.1 传输底座

- 物理通道只有一条：`vscode.Webview.postMessage`（JSON 序列化、单向队列）。
- host 侧：`ChatPanel.onDidReceiveMessage → HostBridgeProtocol.handleRaw`；
  host → webview：`HostBridgeProtocol.send(VSBuffer)`。
- webview 侧：`WebviewMessagePortLike` 把 postMessage 伪装成 `@zcode/rpc` 的
  `MessagePortLike`；`HostFrameBus`/`PlatformRpcClient` 消费各自帧型。

### 1.2 帧族（`BridgeEnvelope`，按 `t` 判别）

| `t` | 方向 | 载荷 | 用途 | 消费方 |
|---|---|---|---|---|
| `rpc` | 双向 | `{ t:"rpc", b64:string }` | `@zcode/rpc` VSBuffer 二进制帧（base64） | host：`VSBuffer.wrap(base64ToBytes(b64))` 进 IPCServer/ChannelServer；webview：还原 `Uint8Array` 进 MessagePortProtocol |
| `flow` | webview→host | `{ t:"flow", state:"saturated"\|"drained" }` | MessagePortProtocol 背压透传（R1） | host 侧仅记录（host→webview 不产生背压） |
| `plat-req` | webview→host | `{ t:"plat-req", id:number, method:string, args:unknown[] }` | 平台小 RPC 请求 | `PlatformRpcHandler`（`PLATFORM_METHOD_WHITELIST` 白名单外拒绝） |
| `plat-res` | host→webview | `{ t:"plat-res", id:number, ok:bool, value?/error? }` | 平台 RPC 应答 | `PlatformRpcClient`（pending 表按 id 配对） |
| `plat-evt` | host→webview | `{ t:"plat-evt", event:string, payload:unknown }` | 平台事件分发（含 `__invalid-frame` 诊断） | `PlatformRpcClient` 事件面 |
| `host` | host→webview | `{ t:"host", kind:"theme"\|"locale"\|"workspace"\|"visibility", payload:unknown }` | 主题/locale/workspace/可见性推送 | `HostFrameBus` |

### 1.3 VSBuffer ↔ base64 帧（hostBridgeProtocol 往返）

```
host → webview：VSBuffer.buffer(Uint8Array 视图) --bytesToBase64--> {t:"rpc",b64} --postMessage--> webview
webview → host：{t:"rpc",b64} --base64ToBytes--> Uint8Array --VSBuffer.wrap--> @zcode/rpc ChannelServer/ChannelClient
```

- `bytesToBase64`/`base64ToBytes`（`src/bridge/wire.ts`）双端可用：node 走 `Buffer`
  快路径，浏览器（webview 无 Buffer）走 `btoa/atob` 分块路径——同一帧两端编解码一致，
  `contract.test.ts` 有 roundtrip 断言。
- `HostBridgeProtocol.send` 按 Uint8Array 视图（byteOffset/byteLength）精确编码，不整段拷贝。
- 所有入站消息先经 `parseBridgeEnvelope` 最小 schema 校验：非记录/未知 `t`/字段形状
  不符一律返回 `null` 丢弃，并以 `plat-evt __invalid-frame` 记录载荷——webview 侧任意
  注入非桥帧不会进入 `@zcode/rpc` 栈（该栈对非 `Uint8Array` 天然丢弃，`t` 分流隔离充分）。
- base64 有 +33% 体积开销（§8 R1）；大载荷依赖 v4 协议自身分页（rowsRange 一窗历史、
  attachment ≤512KiB 分块、workflowRunArtifactRead 分块）与 `flow` 背压透传。

## 2. `@zcode/shared` 版本锁定关系

1. **依赖声明**：`package.json` `"@zcode/shared": "workspace:*"`（同 `@zcode/services`
   /`@zcode/client`/`@zcode/ui`）。`workspace:*` 没有版本号语义：monorepo 内单例，
   pnpm-lock.yaml 只锁「指向 `packages/shared` 的 workspace 链接」，不存在 semver 漂移空间。
2. **构建期内联**：`esbuild.mjs` 把 `@zcode/shared`（连同 `zod`）打进
   `dist/extension.js`（host bundle）与 `dist/webview/main.js`（webview bundle）；
   `.vscodeignore` 排除 `node_modules/**` → vsix 内零 node_modules（§7.2 硬指标）。
   **运行时协议 = 构建时刻的 shared 源码**，无热替换面。
3. **schema 唯一所有者**：v4 命令/事件 schema 只存在于
   `packages/shared/src/zcode-protocol-v4/`（`command.ts` 等）；本模块禁止定义或复制
   协议形状（`src/CONTRACT.md` 禁止事项）。桌面端与插件端消费同一份 schema 文件，
   同 commit 生效——不存在「桌面 v4 与插件 v4 版本不一致」的可能面。
4. **升级路径**：升级 = 在 monorepo 内改 `packages/shared` 并重新构建本扩展
   （`pnpm --filter zcode-vscode build`）。`workspace:*` 自动跟随，无需改本包版本号。
5. **`@zcode/rpc`**（wire 编解码底座，workspace 内部包 1.0.0）经
   `@zcode/client`/`@zcode/services` 依赖进入两份 bundle，锁定关系同上。
6. **兼容口径**：桥 wire（§1 帧族）与 v4 协议 schema 解耦。改 wire 必须同时改
   `wire.ts` + `hostBridgeProtocol.ts` + `webviewMessagePort.ts` + 本文；改协议 schema
   只动 `packages/shared`，本文 §3 消费清单随之核对。

## 3. v4 协议命令面消费清单

v4 命令**不经 `vscode.commands`**（不登记 `contributes.commands`，见 `src/CONTRACT.md`）。
链路：webview（`@zcode/ui` 装配面）→ `createConversationTransport`
（`createAgentConversationTransport(IZCodeAgentService)`）→ 桥 `rpc` 帧 →
`zcode-agent` 频道（`DEFAULT_EXPOSED_CHANNELS` 白名单）→ host `@zcode/services` 进程管理
→ `zcodium` CLI app-server。ACK 形状 = `commandAckSchema`
（`status: accepted|rejected|stale|duplicate|noop|failed` + `result`）。

schema 唯一事实：`packages/shared/src/zcode-protocol-v4/command.ts`（行号为当前快照，
以文件为准）。

| 命令 | schema 位置 | 载荷要点 | 消费场景 |
|---|---|---|---|
| `createSession` | `command.ts:54` | `sessionId?`/`workspaceId`/`additionalDirectories?`(≤256)/`firstInput?`/`config?`/`mcpServers?`/`offPeakToolEnabled?`/`dynamicWorkflow*?`；MCP 必须随 create 一次性下发 | 新会话创建（ACK `type:"createSession"` 返回 `sessionId`） |
| `sendText` | `command.ts:95` | `text`/`attachments?`/`requestedDelivery?`(startNow/queue/guide)/`modelSelection?`/`mode?`/`planEnabled?`/`modelExecution?` 等；与 `editUserQuery`/`sendQueuedNow` 共用执行材料不变量（`command.ts:36`） | 用户文本输入主路径 |
| `resolveInteraction` | `command.ts:227` | `interactionId` + `answer{ optionId?, freeText?, action?(accept/decline/cancel), content? }`；先到先得，迟到 noop（`proto.alreadyResolved`） | 审批/交互卡回执 |
| `switchModelConfig` | `command.ts:259` | `{ provider, model, thought }` | 模型/思考档切换；**pane 内切换即回写设置**（FR-A03 双向同步）：host 在 `sendConversationCommandV4` 命令路径观测本帧，经 `HostSettingsBridge.modelConfigToSettingValue` 持久化 `zcodium.model` = `provider/model`（thought **不入设置**——该设置形状被 `parseModelSelection` 锁定为恰好一个 `/`，拼入 thought 会破坏 create 的 modelId；会话档位由 CLI 会话实体自持、resume 沿用原会话，P1-6.3）；回写失败不使命令失败（切换本体已受理，仅诊断）；**不登记 contributes.commands** |
| `switchCollaborationMode` | `command.ts:266` | `{ mode: build\|edit\|plan\|yolo\|guarded }`（auto 非用户可切，不进命令面） | 协作模式切换；**不登记 contributes.commands** |
| `compact` | `command.ts:167` | `{}`；输入型维护命令：idle 立即执行，busy/held 进 FIFO，不走 CAS（`sourceCommandId` 幂等） | 上下文压缩；**不登记 contributes.commands** |
| `deleteSession` | `command.ts:296` | `{}`；与 `renameSession` 同属无会话目标命令族（`command.ts:304`） | 会话删除 |

## 4. 维护约定

- 改 `src/bridge/wire.ts` 帧族 / 编解码 → 同步本文 §1 + `contract.test.ts` roundtrip 断言。
- `@zcode/shared` 增删 v4 命令 → 同步本文 §3 清单。
- `src/contract.ts` 门面 re-export 增删 → 同步 `src/CONTRACT.md` 清单 + `contract.test.ts`
  排序断言（`Object.keys(contract)` 与文档清单一致）。
