# zcode-vscode 模块契约（CONTRACT.md）

## 模块定位

`zcode-vscode` 是 ZCodium 的 VS Code 扩展：**深度绑定内部模块的 VS Code 宿主**
（v0.2.0 起，纯协议消费方定位已废除）。

- 协议契约唯一所有者回归 `@zcode/shared`（`zcode-protocol-v4` schema，本模块零协议定义）；
- 传输 / Agent 服务复用 `@zcode/services`；
- Webview 连接复用 `@zcode/client`；
- 对话 UI 复用 `@zcode/ui`（cherry-pick 装配面）。

依赖声明与 `architecture-policy.yaml`（zcode-vscode 条目）及 `src/module.ts` 三方一致：
`requires: [shared, services, client, ui, rpc]`（`rpc` 供桥 rpc/flow 帧直通
`@zcode/rpc` 栈：`src/host/hostBridgeProtocol.ts`、`src/host/hostRuntime.ts`、
`src/webview-react/bridge/webviewMessagePort.ts`）；`publicEntrypoints` 仅 `src/extension.ts`。

## 对外契约（publicEntrypoints）

| 入口 | 用途 |
|---|---|
| `src/extension.ts` | VS Code 扩展激活/停用入口（activate/deactivate 薄壳，唯一 policy 登记入口） |
| `src/contract.ts` | 模块 API 汇总出口（内核类、桥 wire、错误码；模块外部/复用方只允许从这里 import） |
| `src/contract-ui.ts` | 平台 UI 类出口（StatusBar/DiffViewer/Diagnostics，依赖运行时 vscode API） |

> 历史入口 `src/zcodeProtocol/types.ts` 已随 P1 删除（契约唯一所有者回归 `@zcode/shared`），
> 目录 `src/zcodeProtocol/`、`src/protocol/`、`src/session/` 不再存在，禁止重新引入。

## contract.ts 门面 re-export 清单（contract.test.ts 断言面）

运行时导出（值，34 项，按 `src/contract.ts` 分组顺序）：

- 通信桥（host 侧）：`HostRuntime`、`HostBridgeProtocol`、`PlatformRpcHandler`、
  `PLATFORM_METHOD_WHITELIST`、`HostSettingsBridge`、`normalizeSettingsSnapshot`、
  `normalizeToolRules`、`normalizeAdditionalDirectories`、`parseBridgeModelSelection`
- 服务装配：`createPluginServices`、`createExposurePolicy`、`DEFAULT_EXPOSED_CHANNELS`、
  `builtinProviderConfigPath`
- 薄编排：`RuntimeController`
- Webview 侧：`WebviewMessagePortLike`、`sendClientContext`、`WEBVIEW_CLIENT_CONTEXT`、
  `PlatformRpcClient`、`HostFrameBus`、`VscodePlatformService`、`createConversationTransport`
- 桥 wire：`bytesToBase64`、`base64ToBytes`、`parseBridgeEnvelope`、`rpcFrame`
- 内核（无 vscode 依赖）：`ApprovalService`、`isDangerousCommand`、`allowlistKey`、
  `ExtensionStore`、`CliLocator`
- 错误码：`EXTENSION_ERROR_CODES`、`ExtensionProtocolError`、`EXTENSION_ERROR_MESSAGES`、
  `JSON_RPC_ERROR_CODES`

类型导出：`WebviewSender`、`PlatformMethodHandler`、`HostSettingsSnapshot`、
`PluginServiceAssembly`、`PluginServiceAssemblyOptions`、`BridgeEnvelope`、`HostFrame`、
`HostFrameKind`、`ApprovalChoice`、`ApprovalRequest`、`ApprovalUpdate`、`SessionIdStore`、
`CliInfo`、`ZcodiumUiState`。

门面本身零 `vscode` 运行时依赖（UI 类走 `contract-ui.ts`），可被 headless vitest 加载。

## 依赖方向（单向，forbidCycles / forbidDeepImports）

```
extension.ts(ui/chatPanel 薄壳) → container(装配) → host(hostRuntime/serviceAssembly/桥) → @zcode/*
webview-react(React 装配) → 桥 shim → 同一 wire 协议 → host
```

- 内核层（`approvals/`、`store.ts`、`bridge/wire.ts`、`cli/`、`errors.ts`、`config*`）
  不依赖 `vscode`，可被 vitest 直接测试（见 `contract.test.ts`）。
- `@zcode/*` 只经包入口 import（`forbidDeepImports`）；版本经 `workspace:*` 锁定
  （与 `@zcode/shared` 的锁定关系与桥 wire schema 见 `docs/contract-check.md`）。
- 会话/审批/时间线状态由 `@zcode/ui` 承接；VS Code 原生面（diff/通知）经
  `PlatformRpcHandler` 白名单方法落地。
- VS Code 命令面（`contributes.commands` 共 **31 条**，均 category `ZCodium`）。注册按
  来源分三处，与 package.json 逐一相等（2026-11-06 脚本化比对核实；曾漂移为 14 并宣称
  与 registerCommands 一字不差——M1 编辑器命令与 fullui 落地后未同步，已修正）：
  - `container.registerCommands` → `registerHostCommands`（`commands/hostCommands.ts`，
    14 条）：`openChat` / `onboarding` / `newSession` / `restartAgent` / `showLogs` /
    `checkBundleSize` / `switchWorkspace` / `sendDiagnostics` / `openMcpSettings` /
    `openInstructions` / `openSessionParams` / `importClaudeSessions` / `showSubagents` /
    `openUsage`；
  - `registerEditorCommands`（`features/editorCommands.ts`，16 条，M1 编辑器功能）：
    `quickEdit` / `sendTerminalSelection` / `generateCommitMessage` / `reviewChanges` /
    `pickSession` / `codeAction` / `addRangeToChat` / `fixDiagnostics` / `explainSelection` /
    `fixSelection` / `refactorSelection` / `writeTests` / `addToContext` / `showEditorLogs` /
    `addFileToContext` / `stop`；
  - `container` 装配直接注册 1 条：`openFullUi`（完整界面，fullui/M2）。

## 关键语义（实测自契约，勿凭记忆改动）

1. webview ↔ host 桥帧族与 `VSBuffer ↔ base64` 编解码见 `src/bridge/wire.ts` 与
   `docs/contract-check.md`；`rpc`/`flow` 帧直通 `@zcode/rpc` 栈，
   `plat-*`/`host` 帧由 `HostRuntime` 分流。
2. v4 协议命令（`createSession`/`sendText`/`resolveInteraction`/`switchModelConfig`/
   `switchCollaborationMode`/`compact`/`deleteSession`）**不经 `vscode.commands`**，
   由 webview 经 `@zcode/client` 消费 `@zcode/shared` schema 后走桥 rpc 帧下发
   （消费清单见 `docs/contract-check.md`）；它们不出现在 `contributes.commands`。
3. 会话参数（`zcodium.*` 设置）经 `HostSettingsBridge` 归一为 create/resume 参数；
   resume 必须携带 allowlist/denylist（P1-3.2）。
4. Agent 传输与进程生命周期由 `@zcode/services` 进程管理承担；
   `RuntimeController` 只做 folder→服务生命周期与 resume 编排。
5. 聊天卡片「审查 / 打开」（`src/host/pendingChanges/diffOpener.ts` +
   `beforeContent.ts`）：webview 经 `openCodeViewerInEditor` 平台能力委托宿主，
   「打开」→ `vscode.open`，「审查」→ `ChangesDiffOpener.openPendingDiff` 用
   `zcode-before` 虚拟文档重构改动前内容并 `vscode.diff` 原生双栏呈现。
   「文件改动历史」TreeView 及 `gode.changes.*` 命令族已按产品决策整体移除，
   不再装配会话订阅 / 状态栏角标 / 编辑器标题栏按钮；`ChangesTracker`、
   `ChangesService` 仅作为历史模块保留，不参与 activate 装配。

## 禁止事项

- 禁止绕过 `src/contract.ts` 门面 deep-import `@zcode/*` 内部路径
  （`architecture-policy.yaml` `forbidDeepImports` 拦截）。
- 禁止在本模块内定义或复制协议形状（唯一所有者：`@zcode/shared` 的
  `zcode-protocol-v4` schema）；禁止重新引入 `src/zcodeProtocol/` 目录。
- 禁止让内核层（approvals/store/bridge wire/cli/errors）感知 VS Code API 或 UI。
- 禁止把 v4 协议命令登记进 `contributes.commands`（它们不经 `vscode.commands`）。
