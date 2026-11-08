# FR-10/11/12 + MCP/配置/存储/安全 核对报告（深度调查，含 file:line 证据）

## 总览

| PRD 项 | 结论 |
|---|---|
| FR-10-1 Agent Manager | 未实现 |
| FR-10-2 Worktree 隔离 | 未实现 |
| FR-10-3 子代理 | 大部分实现（缺 Plan 内置类型） |
| FR-10-4 后台 Agent 条 | 部分实现（有面板，无 PRD 全套动作/状态） |
| FR-10-5 Swarm Board | 未实现 |
| FR-11-6 会话终端 | 未实现（扩展侧） |
| FR-11-7 终端内联聊天 | 未实现 |
| FR-11-8 输出截断+看全文 | 大部分实现 |
| FR-11-9 浏览器工具 | 部分实现（能力存在但非 PRD 口径） |
| FR-12-10/11/12/13 | 部分实现（一句话指令机制，无独立流水线） |
| MCP 第22章 | 部分实现 |
| 配置/存储 第19/20章 | 部分实现 |
| 安全 第23章 | 部分实现（遥测无开关面、无敏感扫描、无 SecretStorage） |

## FR-10 多 Agent 并行与 Agent Manager

**1. Agent Manager — 未实现。**
- 全扩展 30 个 contributed commands 中无任何 agent-manager 类命令（`apps/zcode-vscode/package.json`）；`grep -rni "agentmanager"` 在 `apps/zcode-vscode/src` 与 `packages/ui/src` 均无命中。
- keybindings 仅两条：`gode.quickEdit`（ctrl+alt+k）、`gode.addToContext`（ctrl+alt+a），无 Cmd/Ctrl+Shift+M。
- viewsContainers 仅一个 activitybar 视图 `gode.chat`（对话 webview），无左栏会话+Worktree 双列表、无聊天/Diff/终端三页签容器、无会话卡片。

**2. Worktree 隔离 — 未实现。**
- 扩展与 UI 源码中 `worktree` 唯一命中是 `packages/ui/src/App.tsx:473-487`、`packages/ui/src/v4/SessionPane.tsx:336-337` 的 `gitWorktreeChangeSummary/gitWorktreeReviewSourceId`——这是「对另一 worktree 的 diff 做审查」的展示，不是新建并行会话可选 worktree。
- 无 setup script、无 Shift+点击置顶、无 Ctrl+Alt+1~9、无同提示派发 4 个 worktree。CLI 侧 `worktree` 只出现在 bash 只读策略（如 `apps/zcode-cli/packages/core/src/tool/handlers/guarded/git.ts:73-127` 对 `git worktree` 子命令的风险分级），非产品功能。

**3. 子代理 — 大部分实现。**
- Agent 工具：`apps/zcode-cli/packages/core/src/tool/handlers/agent.ts`（336 行，输出含 `completed` / `async_launched` 两态，`async_launched` 即后台子代理）。
- 内置类型：`Explore`（`apps/zcode-cli/packages/core/src/subagent/explore.ts:10` `EXPLORE_AGENT_TYPE = "Explore"`，只读 prompt + `explore-tools.ts:4-35` 工具白名单刻意不含 Write/Edit/ApplyPatch）与 `general-purpose`（`general-purpose.ts:5`，`profile.ts:17` `DEFAULT_SUBAGENT_TYPE`）。**没有内置 `Plan` 子代理类型**（grep 无命中；Plan 是主会话的 enter/exit plan mode 工具）。
- 子代理面板：`apps/zcode-vscode/src/webview-react/subagents/SubagentsPanel.tsx`（运行中来自 projection.snapshot.subagents，已结束走 `listSessionSubagents` 游标查询；命令 `gode.showSubagents` 注册于 `src/commands/hostCommands.ts:133`）。
- 只读查看器：`packages/ui/src/v4/SubagentDrilldown.tsx`（文件头注释明示「只读：不下发 onFork/onRetry/onEdit」；仅取最近 20 条 assistantText 行——是轻量输出预览，「完整记录」只能看最近窗口）。
- 不绕过主会话权限：`apps/zcode-cli/packages/core/src/subagent/interaction-origin.ts`（审批请求带 `kind:"subagent"` + parentSessionId/parentToolCallId 回传主会话）；`tool-policy.ts` 强制剔除 plan 工具；runner 继承父 disallowedTools（`runner.ts:252,500`）。

**4. 后台 Agent 条 — 部分实现。**
- `packages/ui/src/v4/ConversationBackgroundWorks.tsx`（面板，`projection.backgroundWorks`）+ `v4/composer/ConversationBackgroundWorkTrigger.tsx`（聊天区的 badge 触发，计数 bash/workflow/subagent 三类）。
- 状态枚举是 `running/resultPending/failed/cancelled`（`packages/shared/src/zcode-protocol-v4/snapshot.ts:367-385`），**不是** PRD 的 Running/Done/Cancelled/Error/Needs input（resultPending 语义最近似 Done+待续）。
- 动作只有单项「取消」（`cancelBackgroundWork`，`command.ts:272`）；**无 Stop all / Dismiss / Clear finished / Continue in background**。

**5. Swarm Board — 未实现。** `swarm` 在扩展与 UI 源码零命中。

## FR-11 终端与浏览器工具

**6. 会话终端 — 未实现（扩展侧）。**
- `grep "createTerminal|onDidWriteTerminalData|pty."` 在 `apps/zcode-vscode/src` 零命中：扩展从不创建/托管集成终端，Agent 的命令在 CLI 运行时自己的执行器跑，输出经 bash 工具行回流（`packages/ui/src/ToolCallBlocks/renderers/execute.tsx` + `ExecuteOutput.tsx`），**不是**「每会话一个集成终端」。
- 终端相关贡献仅 `gode.sendTerminalSelection`（`src/features/terminal.ts`：借剪贴板取终端选区→拼 XML `<terminal-output>`→预填 composer）+ `package.json` 的 `terminal/context` 菜单（第 284-287 行）。
- `!` 前缀：composer 无 bash escape 解析（`packages/ui/src/v4/ConversationComposer.tsx:2164` 的 `"!"` 是附件上传失败角标），无共用终端与白名单。

**7. 终端内联聊天 — 未实现。** `terminalLastCommand|#terminal|inlineChat|ctrl+i` 零命中。

**8. 截断+看全文 — 大部分实现（CLI 层）。**
- `apps/zcode-cli/packages/core/src/tool/handlers/bash.ts:81-82`：inline 30KB 截断；`:488` `persistOutput: run_in_background ? "always" : "on_truncate"`（上限 5GB），超长输出落盘并回「Output too large… Full output saved to: … Preview (first 2KB)」。
- UI：`packages/ui/src/lib/nodeReplToolDisplay.ts:45` 解析 persisted-output 标签；`app-shell/BackgroundBashOutputSidePane.tsx:79` 有「Full output file」（i18n `bashOutput.fullFile`，`i18n/locales/en-US.ts:360`）打开全文；对话内 `ExecuteOutput.tsx` 是 5 行吸底滚动视口（非「看全文」按钮）。全文以**运行时持久化文件**而非「会话附件」承载。

**9. 浏览器工具（P1）— 部分实现（形态不同）。**
- 能力在 `apps/zcode-cli/packages/browser-use-plugin/`（skills：control-browser、web-gui-tester）+ `packages/core/src/browser-client/`（Browser facade/Playwright API/Tab 对象模型，`facade.ts`）+ `packages/node-repl-host/`（browser-bridge）。
- 不是 PRD 的离散 `browser_open/click/type/screenshot` 工具，而是 JS REPL 里 `browser.tabs.new()/goto()/playwright.domSnapshot()` 风格。
- localhost 限制：`core/src/browser-client/selection.ts:37-47` `isLocalTarget` 存在，但语义是 **tab 复用/浏览器选择**的本地目标判定，未见「公网走审批」的强制门；`grep allowlist|deny|permission` 在 browser-client 与 browser-bridge 均无命中。
- 页面诊断（控制台报错/网络失败）：`contracts/src/interfaces/browser-control.port.ts` 无 console/network-failure 采集（只有 waitUntil/errorCode/录制状态）。
- 集成浏览器标签：backend 类型 `iab`（in-app browser）由 **desktop host** 广告（`browser-use-plugin/docs/overview.md`）；VS Code 扩展 `grep iab|browser.*tab` 零命中——扩展侧无集成浏览器标签，浏览器会话面板（截图+步骤回放）未找到。

## FR-12 测试生成、代码审查与辅助命令

**10. 入口 — 部分实现。**
- 无 `/test /review /explain /improve /docstring /fix` 内置斜杠命令：`packages/ui/src/v4/slashCommands.ts` 只内置解析 plan/compact/goal/side/btw，其余走 CLI 自定义命令目录；仓库内无 test.md/review.md/docstring.md 命令文件。
- 编辑器右键：`package.json` `editor/context` 子菜单 `gode.editorContext` = explainSelection/fixSelection/refactorSelection/writeTests/addToContext；SCM 标题栏有 generateCommitMessage/reviewChanges；explorer/editor/title 有 addFileToContext。PRD 字面「Generate Tests/Review Code/Explain Code/Improve Code/Git Diff Review」大体对得上（Improve→重构、Git Diff Review→reviewChanges）。
- 快捷键：**无 Alt+Shift+T / Alt+Shift+C**（仅 quickEdit/addToContext 两条绑定）。
- 侧栏顶部快捷区：`apps/zcode-vscode/src/webview-react/layout.tsx:19-45` 七个面板槽位（folder 切换、会话列表、modelSelect、usage、mcpSettings、instructions、sessionParams、subagents）——有模型/用量入口，**无测试生成/代码审查快捷按钮**。

**11-13. /test、/review、/explain、/improve、/docstring、/fix 机制 — 部分实现，且无独立流水线。**
- 实际机制（两路）：
  - **一句话指令 → composer 预填**：`src/features/editorCommands.ts:54-62` 的 `INSTRUCTIONS`（explain/fix/refactor/tests 四条中文指令），`runOnSelection()`（336-365 行）把「选中代码 mention + 指令」经 host 帧 `composer-insert` 预填输入框并 `gode.openChat`（`createCodeActionEntry`，75-140 行）；真正执行交给 CLI 会话按用户当前模式跑，`fix/tests/refactor`（expectEdits）仅弹一条「写操作会先征求确认」的状态栏提示，无逐条用例接受/修改/拒绝 UI、无 Jest/Vitest/pytest 框架识别代码（只是 prompt 里让模型「先确认仓库现有测试框架与命名约定」）、无行为路径覆盖清单、无 review 分类（Bug/破坏性/安全/性能）与一键应用。
  - **无会话一次性生成**：`src/features/oneShotText.ts` 经 `zcodeAgentService.generateWorkspaceText`（协议方法 `workspace/generateText`）纯文本生成，用于 quickEdit 与 generateCommitMessage。
- `gode.writeTests`/`explainSelection`/`fixSelection`/`refactorSelection` 注册于 `editorCommands.ts:220-234`；`gode.fixDiagnostics` 走 `src/features/codeActions.ts:108-137`（诊断+附近代码一起发指令）；`gode.reviewChanges` 走 `src/features/git.ts:96-127`（取 repo.diff，24KB 截断，拼 `<git-diff>` 上下文发对话，要求「像 code review 一样指出缺陷/触发条件/直接修改」——只有 Local Review 口径，无选区/文件范围选择、无指定分支 Diff、无结构化检查分类）；`gode.generateCommitMessage` 走 `git.ts:43-93`（one-shot，Conventional Commits，写入 SCM inputBox）。

## MCP 集成（第 22 章）

**14. — 部分实现。**
- CRUD/启停状态：`apps/zcode-vscode/src/webview-react/settings/McpSettingsPanel.tsx`（servers 增删改、`updateMcpServers` 写回 `gode.mcp.servers`、mcp/list 状态 `listMcpServerStatuses`、allowlist/denylist 权限规则、会话内允许写回 `appendSessionAllowlist`、「改动后需重建会话生效」提示）；状态模型 `mcpServersModel.ts`（stdio: name/command/args/env；http/sse: name/type/url/headers，`:54-70`；`summarizeStatuses` 产出 `● N connected / M failed`，`:134-146`；`statusLabel` failed 显示失败+error，`:127-128`——状态行 `McpSettingsPanel.tsx:276-281` 是纯文本，**未见标红样式**；日志有 `gode.showLogs`）。
- 配置环境变量：schema 是明文 `env: Record<string,string>`（`packages/shared/src/mcp.ts:35`、扩展侧 `env: [] as unknown[]` `mcpServersModel.ts:62`）。**密钥 SecretStorage：零命中**（`grep SecretStorage|context.secrets` 全扩展无）。
- 三处入口同源：实际两处半——命令面板 `gode.openMcpSettings`（`hostCommands.ts:127-130`，直接跳 `gode.mcp.servers` 设置）+ 聊天 header 面板槽（layout `mcpSettings` 槽）；**`/` 菜单无 Customize 分组**（`packages/ui/src/slashCommandPanelSections.tsx` 只有 commands/skills/subagents 三节）；设置页里另有 `packages/ui/src/settings/McpSettingsSection.tsx`（桌面端 SettingsPage 的 mcp 节）。
- 工具来源标注：`packages/ui/src/ToolCallBlocks/renderers/mcp.tsx:26-118,138` 从 `mcp__server__tool` 命名解析出 serverName 展示（有来源标注）；「工具分组显示」未见专门分组视图。
- **128 上限：无**（grep `128|maxTools|toolLimit` 在 core/mcp、runtime 均无）。

**15. 内置浏览器自动化注册为 MCP 服务器 — 部分实现。** `packages/node-repl-host/src/server.ts:4-5` 用 `@modelcontextprotocol/server` + `serveStdio` 构成 node_repl MCP 服务器，`browser-bridge.ts` 注入 `agent.browsers` 浏览器自动化面（`tool-contract.ts:24-27` 限域文案提及 Browser Use 为合法入口）——即浏览器自动化可经该 MCP 服务器暴露，但不是「注册 browser_* 工具集」的独立服务器。

## 配置系统（第 20 章）与存储（第 19 章）

**16. 配置分层 — 部分实现。**
- CLI 侧权威分层：`apps/zcode-cli/packages/adapters/src/config/config-factory.ts:113-119` 明确优先级 System defaults → User(`~/.zcodium/cli/config.json`) → Project（root→cwd 发现多份项目配置，`loadProjectConfigs`）→ Env → CLI overrides；合并器 `config-merger.ts`（ConfigScope 优先级、深合并 permission/mcp/hooks 等）。项目配置 schema 含 `permission.{mode,allowedTools,disallowedTools,autoApproveHighRisk,allowMediumRiskInAuto}`、`features.{mcp,subagent,...}`（`adapters/src/config/schema.ts:13-19,30-37`）——**无 defaultMode/approvals/terminal 白名单项目字段**。
- 扩展侧：`gode.*` 8 项设置（package.json：cliPath/mode/model/permissions.allowlist|denylist/mcp.servers/context.additionalDirectories/autoContext）经 `src/host/hostSettingsBridge.ts` 归一化进 create/resume 参数（resume 恒带 allowlist/denylist，`:6-7` 关键语义）。
- **界面标明来源层：未实现**（无 source-label UI）；「会话内临时设置」层未见。13 标签设置页：`packages/ui/src/lib/settingsNavigation.ts:4,67-92` 的节是 general/appearance/systemPrompt/migration/browser/modelProvider/remoteDevices/officialServices/memory/plugin/mcp/skill/usage/archives/subagents/commands/hooks/workspaceFileSearch/computerUse/automations/shortcuts——与 PRD 13 标签（Providers/Behaviour/AutoApprove/…/About）**名目不一致**（且这是共享 UI 的桌面口径；扩展内配置面是独立面板而非 SettingsPage）。
- 图形表单↔配置文件双向同步：扩展面板经 `plat.updateMcpServers/updatePermissionRules/updateAdditionalDirectories` 与 `settingService.get/update` 读写 `gode.*`/AppSettings（`SessionParamsPanel.tsx`、`workspacePreferences.ts` 头注释）——settings.json 是唯一真相源，算单向写回+回读。

**17. 存储 — 部分实现。**
- 会话索引：`apps/zcode-vscode/src/store.ts:2-41`（globalState 按 workspace 键存当前会话 ID；`container.ts:489-492` 存 deviceId）；每会话数据文件由 CLI session store 承担（`adapters/src/storage/session-store.ts`）。
- schemaVersion 迁移：`adapters/src/storage/session-store/migration-runner.ts:106-110` 迁移前备份到 `<dataRoot>/backup`，checksum mismatch 报 `SqliteSessionMigrationError(kind:"checksum_mismatch")` 且失败回滚（`rollback` 分支）——符合「迁移失败备份不丢弃」精神。
- **检查点影子仓库：未实现**。CLI 有 workspace 文件 rewind（`core/src/runtime/types.ts:632-648` `WorkspaceFileRewindAction`、`core/test/fileRewindPaths.test.ts`），但 `grep checkpoint|影子|shadow` 在 adapters/context 无命中（`git-snapshot.ts` 只是 env 信息的 git 状态快照）。
- 用量按月分桶：**未实现**。扩展用量面板是会话累计+每轮行（`apps/zcode-vscode/src/webview-react/usage/usagePanel.tsx`、`usageModel.ts`）；月度口径只出现在 CodingPlan 配额（`packages/ui/src/CodingPlanUsageRemainingPanel.tsx:263` monthlyToolLimit，服务端下发），非本地按月分桶存储。

**18. 安全（第 23 章）— 部分实现。**
- 遥测默认关闭：源码里**没有产品遥测开关**；`packages/shared/src/runtimeEnv.ts:104-125` 注释「审计版不再捕获遥测配置；仍剔除旧环境变量」，遥测 env 键（ZCODE_MODEL_TELEMETRY_ENABLED 等）被从子进程环境剔除；`core/src/telemetry/runtime-telemetry.ts:222` 默认 `NOOP_AGENT_EXECUTION_TELEMETRY`（内部执行指标端口，无外发默认实现）。UI 无 telemetry 开关（grep 零命中）。「默认关闭」以「不存在遥测」的方式成立，但无用户可见开关面。
- 发送前敏感信息扫描：**未实现**（grep sensitive/证件/身份证/credential-scan 无产品化实现）。
- 气隙离线可用：CLI 本身本地运行、模型可配置自定义 provider（`gode.model`/providerId），间接支持本地模型，但无显式 air-gapped 模式/UI（仅 remote runtime 有 "offline" 连接模式，`packages/ui/src/RemoteConnectionFields.tsx:86-100`）。

## 补充说明（机制口径）
- 扩展是薄壳：聊天 UI 复用 `packages/ui` 的 V4 面板（经 host 帧 `composer-insert`/`session-switch`/`workspace` 通信，`src/features/editorCommands.ts:1-12` 头注释）；Agent 能力统一走 `@zcode/services` 的 WS accessor（full 模式不 spawn 第二个 agent 进程，`editorCommands.ts:44-51`）。
- 因此 PRD 里凡是「CLI 运行时已有」的能力（bash 截断持久化、子代理、后台工作、MCP 状态查询）在扩展里都可见；而 PRD 里「扩展宿主层」的功能（Agent Manager 窗口、Worktree 并行会话、集成终端、内联聊天、浏览器标签页、SecretStorage、月度用量桶、敏感扫描）在 `apps/zcode-vscode` 与共享 UI 中均无对应实现。
