# PRD §11/§12 核对报告：FR-05 模型接入与供应商管理、FR-06 权限与审批

- 核对日期：2026-11-07
- PRD 来源：`/Users/jonntd/Downloads/vscode-all-in-one-prd.md`（§11 行 520-563，§12 行 564-624，全文已通读）
- 核对方式：只读代码核对，全部结论给出 `file:line` 证据；未运行任何测试/构建（本任务为静态核对，未执行 PRD §11.7/§12.7 验收场景）。
- 范围说明：zcode-vscode 扩展的 Webview 复用共享 `Root`（`@zcode/ui`），因此 FR-05/FR-06 的实际 UI 机制主要落在 `packages/ui`，审批与权限决策落在 CLI `apps/zcode-cli/packages/core`。扩展自有面板与共享组件同时核对。

## 结论总表

| # | 条目 | 结论 |
|---|------|------|
| 1 | 模型选择器位置/并排/显示/分组/可搜索 | 部分实现（无搜索；扩展自有面板未挂载）【复核:确认】 |
| 2 | 切换作用域（会话下一轮 + 可设全局默认） | 部分实现（会话级 ✓，无"改全局默认"入口）【复核:确认，补充未接线回写半成品】 |
| 3 | 中途换模型按新上限重校验上下文 | 部分实现（auto-compact 按当前模型上限重评估，无显式超限提示形态）【复核:确认，补充：存在未接线的 contextWindowGuard 死文案】 |
| 4 | 供应商管理 UI（增删改/默认/连通性/SecretStorage/拉取模型） | 部分实现（缺"设为默认"；API Key 非 SecretStorage）【复核:确认】 |
| 5 | 内置类型 Anthropic/OpenAI/Google/OpenAI 兼容/Ollama + BYOK 说明 | 部分实现（无 Google/Ollama 原生类型；BYOK 说明仅套餐文案）【复核:确认，补充 legacy gemini 遗留读取格式】 |
| 6 | Auto Models / Sticky Models | 未实现（PRD 标 P1）【复核:确认】 |
| 7 | 用量显示（会话用量+费用、本月累计、按会话/模型明细、与 /usage 一致） | 部分实现（无费用、无月累计、无按模型明细、无 /usage 命令）【复核:修正→按模型明细与近似月度口径实存在于设置页使用情况分区；无费用、无 /usage 命令仍成立】 |
| 8 | 失败与降级（分类显示/重试 2 次/不故障转移） | 部分实现（分类在 CLI 侧齐全；重试默认 10 次而非 2 次；UI 分类文案未见；无故障转移 ✓）【复核:修正→UI 有套餐业务错误分类文案+恢复动作+详情弹窗展开；个人供应商原生 401/403 分类引导仍缺】 |
| 9 | 三层审批 L1/L2/L3 | 未实现为三层模型（实际是 6 模式语义 + alwaysAsk + 规则）【复核:修正→"无 L3 显式开关"不成立：审批窗「完全访问」开关完整闭环（切 yolo+receipt）；L2 分类代审确无】 |
| 10 | 模式与默认层级对应（Agent/Debug=L1、Auto=L2） | 机制不同（build/edit/plan/yolo/guarded/auto 六模式，auto 未实现）【复核:确认】 |
| 11 | 按工具 8 类授权开关 | 未实现（实际是 riskLevel × sideEffectScope 能力轴）【复核:确认】 |
| 12 | 细粒度规则 Tool+glob → allow/ask/deny | 部分实现（规则面齐全；yolo 模式压过 deny；无图形化同源编辑）【复核:确认】 |
| 13 | 审批交互（消息流内/Diff 入口/命令全文/风险标注/deny 说明来源/无超时） | 部分实现（弹窗非消息流内联；无 Diff 预览入口；无风险标注；其余 ✓）【复核:确认】 |
| 14 | 终端命令白名单（两张列表 + 拦截不弹审批） | 部分实现（工具级 allow/deny 两列表存在；无命令模式白名单设置页；deny 不弹审批 ✓）【复核:确认】 |

---

## FR-05 模型接入与供应商管理

### 1. 模型选择器（§11.2）— 部分实现

**PRD 要求**：输入框底部与模式选择器并排；显示供应商与模型名；点击弹出可搜索列表，按供应商分组。

**实际机制**：

- 位置与并排 ✓：输入区在上、工具条在下的 stacked 布局（`packages/ui/src/prompt-editor/ChatPromptEditor.tsx:69-70` 注释「stacked：输入区在上、工具栏在下」）；工具条由 `ConversationComposer` 的 `submitControlNode` 挂载（`packages/ui/src/v4/ConversationComposer.tsx:2315-2352`，注释「左侧 model/thought/usage 簇 + 右侧 stop 或 send」），`V4ComposerToolbar` 内模型菜单 `ModelConfigSelect`（`packages/ui/src/v4/composer/V4ComposerToolbar.tsx:1119-1158`）与模式下拉 `V4ComposerModeSwitch`（`V4ComposerModeControls.tsx:47-56`）并排。
- 显示供应商与模型名 ✓：`formatProviderModelLabel` 输出 `providerName/modelName`；内置 family（zai/bigmodel 套餐）只显示模型名避免重复（`packages/ui/src/v4/composer/modelTriggerDisplay.ts:39-50`）。
- 按供应商分组 ✓：`ModelConfigSelect` 有 `group.label` 分组标题 + family 连接方式子菜单（`packages/ui/src/ModelConfigSelect.tsx:386-404, 414-470`）；分组由 `V4ComposerToolbar.tsx:860` 的 `modelSelectGroups` 构建。
- 可搜索 ✗：`ModelConfigSelect.tsx` 与 `V4ComposerToolbar.tsx` 中 grep `search|过滤|filter` 无命中——模型菜单无搜索框。
- 扩展自有面板：`apps/zcode-vscode/src/webview-react/header/modelSelect.tsx:101-153` 有模型/思考档位/模式并排面板，label 显示 `providerName · modelId`（:209），但它是**扁平列表、无分组无搜索**（`buildModelOptions` :202-214），且**当前未挂载**：`App.tsx`/`index.tsx` 未引用 `PluginHeader`（`layout.tsx:59` 的 `PluginHeader` 与 `modelSelect` 槽位无 importer），live UI 走共享 `Root`（`App.tsx:199-209`）。`modelSelect.tsx` 仅有单测引用（`test/switchCommands.test.ts:30`）。

**差异**：位置/并排/显示/分组满足；「可搜索」未实现；扩展自有 modelSelect 面板与 layout 槽位是遗留组件，未接入当前装配。

**[复核:确认]**（独立换词验证）：`ModelConfigSelect.tsx`、`V4ComposerToolbar.tsx`、`header/modelSelect.tsx` 用 `搜索|searchable|combobox|searchInput|filterInput|\bsearch\b` 全量 grep 仅命中 `v4/composer/toolbarShortcuts.ts:196` 的无关快捷键注释；`ModelConfigSelect.tsx` 内唯一文本交互是 :440 子菜单按钮 `onKeyDown` 与 :571 关闭后聚焦聊天输入框，均非搜索框。挂载状态独立复核：`grep -rn "PluginHeader" apps/zcode-vscode/src/` 仅命中 `layout.tsx:46,59,67` 定义处，无任何 importer；`header/modelSelect.tsx` 唯一引用方是 `test/switchCommands.test.ts:30`。另确认扩展无其他可搜索模型切换入口（`showQuickPick` 命中均为会话/文件夹选择）。

### 2. 切换作用域（§11.2）— 部分实现

**实际机制**：

- 「默认只影响当前会话下一轮」✓：模型切换是会话级 CAS 命令 `switchModelConfig`（`apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/handlers/model-config.ts:69-96`），落到 `session-facade.setModel`（`apps/zcode-cli/packages/bootstrap/src/app/session-facade.ts:644-697`）：写入 `CliDefaultSelection`（`cli-default-selection.ts:1-6` 注释「CLI 配置命令的会话默认值」）或 `runtime.setSessionModelSelection`，并落 session 级 entry（`persistSessionModelSelection`，`session-facade.ts:842-862`，注释「模型与思考档位是 session-local 原子选型」）。下一轮生效：`prepareInput` 把该选型写进下一 turn 的 `intent.modelSelection`（`input-facade.ts:217, 255, 279, 381`）。
- 「可在设置中改为全局默认」✗：无「把当前选择提升为全局默认」的 UI。全局默认仅有：(a) VS Code settings `gode.model`（`apps/zcode-vscode/src/configSettings.ts:29-31` + `hostSettingsBridge.ts:129-133`，仅作用于会话创建参数，package.json:325-330 注明「侧栏对话区草稿会话的模型在会话头部切换，不读取本设置」）；(b) CLI 默认模型。共享 UI 中 grep `作用域/modelScope/globalDefault` 无模型切换作用域开关。

**差异**：会话内切换语义满足（且即时生效于下一轮、落盘可恢复）；缺「改为全局默认」的切换入口。

**[复核:确认]**（附补充发现）：「无改全局默认入口」对 live 行为成立。换词复核发现两处**已写好但未接线**的回写半成品，报告漏列：(a) `apps/zcode-vscode/src/host/hostSettingsBridge.ts:284-317` 的 `wrapAgentServiceForModelWriteback`——拦截 `switchModelConfig` 帧并回写 VS Code 设置（`modelConfigToSettingValue` :247-249，注释「设置项与下拉双向同步」），但 `grep -rn "wrapAgentServiceForModelWriteback|modelConfigToSettingValue" apps/zcode-vscode/ --include="*.ts"` 仅命中定义文件自身，`container.ts` 无装配点；(b) 共享 store 的模型切换 stage 联合含 `"persistingWorkspace"`（`packages/ui/src/store/zcodeSessionStoreTypes.ts:131`）与 i18n「正在写入工作区默认模型...」（`zh-CN.ts:5241`），但全仓无 set 点（`grep -rn "persistingWorkspace"` 排除 locales 仅类型声明一处）。即「提升为全局默认」的管道两端（UI stage 文案 + 扩展回写包装）都存在，缺的是中间装配。

### 3. 中途换模型重新校验上下文（§11.2）— 部分实现

**实际机制**：没有「切换时立刻按新模型重算上下文」的显式步骤；校验发生在**下一次模型请求**时：

- 每次请求读取当前模型 `model.properties.contextWindow` 并构建上下文用量快照（`apps/zcode-cli/packages/core/src/runtime/methods/model.ts:126-139`）；
- auto-compact 策略按当前模型的 contextWindow / threshold 判定并自动压缩（`apps/zcode-cli/packages/core/src/compact/policy.ts:13-26`，`DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT = 100`）；
- UI 侧 `ComposerContextMeter` 按当前模型显示上下文占比与明细（`packages/ui/src/v4/composer/ComposerContextMeter.tsx:28`，注释「本组件被挂载即渲染读数」）。

**差异**：新模型上限会驱动自动 compact（超出即压缩），但 PRD 所说「走 FR-03 的超限提示」的**用户可见超限提示**形态未找到独立实现——实际兜底是自动压缩而非提示。

**[复核:确认]**（附关键补充）：复核者亲读 `compact/policy.ts:90-155` 确认 auto-compact 全按当前模型 contextWindow 计算（`getEffectiveContextWindowSize` :67-73 扣除 output 预留）。换词重搜发现与 PRD「切换时重校验+提示」**精确对应的死文案**：`packages/ui/src/i18n/locales/zh-CN.ts:5250-5258` 的 `chat.modelSwitch.contextWindowGuard.*` 文案族——「需要压缩上下文后再切换模型」「当前会话已使用 {used} tokens，已超过目标模型 {modelName} 预留最大输出后的可用上下文 {target} tokens…压缩完成且上下文用量小于目标模型可用上下文后，会继续切换模型」「压缩完成后…模型切换已取消」（`fa.ts:4536-4542` 同有）。但 `grep -rn "contextWindowGuard"` 全仓排除 locales 零命中，`git log -S` 显示来自初始开源提交后从未接线；CLI 侧 `switchModelConfig` 处理器与 `session-facade.setModel` 亦无上下文守卫（`model-config.ts:74` 注释自认「运行中也允许切换」）。结论：切换时按新上限重校验的**用户可见提示**确实未实现，但存在完整的规划文案残留；`ModelContextExceeded` 分类（`compact-active.ts:480`）仅驱动内部 compact 重试，不透出 UI 文案。

### 4. 供应商管理 UI（§11.3）— 部分实现

**实际机制**（共享设置页 `packages/ui/src/settings/ModelProviderSection.tsx`，经 `settingsNavigation.ts:10,74` 的 `modelProvider` 分区进入；composer「管理模型」入口 `V4ComposerToolbar.tsx:815-819` 打开设置页并定位）：

- 新增 ✓：`handleCreateProvider` + `ProviderTemplatePicker`（`ModelProviderSection.tsx:990-1001, 1072-1096`，i18n「添加供应商」zh-CN.ts:3234）。
- 删除 ✓：`confirmAndDeleteModelProvider`（`model-provider-section/modelProviderActions.ts:6-48`，带确认弹窗）。
- 编辑 ✓：`InlineEditableProviderCard`——名称、Base URL（:204, 794）、API 格式选择（`ProviderApiFormatSelect.tsx:11-15`）、API Key（`model-provider-section/ApiKeyInput.tsx`）。
- 连通性测试 ✓：`onTestModel` → `testModelConnectivity`（`packages/ui/src/hooks/useModelProviders.ts:182-210`）→ `providerSettingsService.testModelConnectivity` → 正式 Model 执行链（`packages/services/src/model-provider/providerSettingsConnectivity.ts:25-46`，注释「Provider 鉴权、headers、reasoning 映射和流消费全部由正式 Model 执行链负责」）。
- 设为默认 ✗：modelProvider 分区无「设为默认供应商/模型」操作。`settings.source.setDefault` 属于 source-server 设备卡（`source-server-settings/SourceServerDeviceCard.tsx:131`），不是模型供应商。默认模型由 `gode.model` settings / CLI 默认决定。
- API Key 存 SecretStorage ✗（替代机制）：扩展侧 grep `SecretStorage` 0 命中（`apps/zcode-vscode/src` 全量）。API Key 随 provider 个人配置落 `provider_config.json`（`packages/provider-node/src/runtime-paths.ts:5` `PERSONAL_PROVIDER_CONFIG_FILE_NAME`），以 `atomicWritePrivateTextFile` 写入并 0o600 加权（`packages/shared/src/node/privateFilePersistence.ts:100`）；桌面另有 `credentialService` 加密 JSON（`packages/services/src/credential/credentialService.ts:19-28`，注释自述「后续可切换到 Electron safeStorage（钥匙串）」）。**不是 VS Code SecretStorage**。
- 模型列表自动拉取 ✓：`modelhubFetchModels.ts`（`packages/services/src/model-provider/modelhubFetchModels.ts:14-36`）Node 侧拉取 `/models`，兼容 anthropic/gemini/openai-compatible 三方言；也可手动填（`InlineEditableProviderCard`）。

**差异**：管理面五项操作有四项；「设为默认」缺失；密钥落 0o600 本地 JSON 而非 SecretStorage。

**[复核:确认]**：换词复核「设为默认」：`isDefault|preferredProvider|defaultProvider|markAsDefault` 命中的 `preferredProviderId`（`useCodingPlanEntitlements.ts:89-92`、`Detail.tsx:369-375`）是套餐权益查询参数而非用户操作；`LoginApiKeyForm.tsx:103-107` 的 `markApiKeyLoginSuccess(defaultModelPreference)` 是登录成功的一次性 store 标记，均不构成管理面「设为默认」。SecretStorage：`grep -rn -i "SecretStorage|context\.secrets|safeStorage|keytar" apps/zcode-vscode/src/` 0 命中；`credentialService` 消费方仅 OAuth/JWT（`bigmodelStartPlanZcodeJwt.ts:15-17`、`codingPlanProviderAvailability.ts:240-245`），个人供应商 API Key 确走 `provider_config.json`（`runtime-paths.ts:5` 亲读）+ 0o600 原子写（`privateFilePersistence.ts:100` 亲读）。

### 5. 内置支持类型与 BYOK（§11.3）— 部分实现

**实际机制**：

- Provider API 类型枚举只有三种：`anthropic-messages | openai-chat-completions | openai-responses`（`packages/provider/src/config/provider-data-schema.ts:4-8`；UI 同源 `ProviderApiFormatSelect.tsx:11-15`）。
  - Anthropic ✓、OpenAI 兼容 ✓（两种 OpenAI 形态覆盖多数第三方/网关）。
  - Google ✗：provider API type 无 `gemini`；仅模型拉取辅助函数有 gemini 方言（`modelhubFetchModels.ts:16-27`），不能构成 Gemini 原生接入类型。
  - Ollama ✗：全仓 grep `ollama`（`apps/zcode-cli/packages`、`packages`）仅命中 bash 命令注册表（`core/src/tool/handlers/generated/bash-command-registry.ts`）与 previewPane 测试，无 Ollama 供应商适配。
- 内置连接模板仅 zai/bigmodel 两族（`packages/shared/src/model-provider-types.ts:2-5` `BUILTIN_PROVIDER_TEMPLATE_IDS`）+ 套餐入口（:7-14）。
- BYOK 说明：仅有 Start Plan 兼容性文案「支持 BYOK、BYOA；Base URL、API Format 和 API Key 由 ZCodium 自动维护，无需手动配置」（`packages/ui/src/i18n/locales/zh-CN.ts:3318`）。PRD 要求的「插件本体免费，费用由用户与供应商结算，不做二次计费」的通用 BYOK 界面声明未找到。

**[复核:确认]**（附一处精度补充）：枚举亲读 `provider-data-schema.ts:3-8` 确认仅三类型。Ollama：全仓（排除 node_modules/dist）`grep -rln -i ollama` 唯一实质命中是 1.8MB 单行的 `bash-command-registry.ts`（bash 命令元数据表含 `ollama` CLI 条目，与报告判断一致——非供应商适配）。Google/Gemini 补充：`legacyModelProviderSerialized.ts:26-36` 保留 `ModelProviderSupportedFormat = "anthropic" | "openai" | "responses" | "gemini"` 的**遗留数据兼容读取**（:26 注释「Gemini custom provider 已统一走 endpoints.openai + compat，仅保留旧数据兼容读取」），仍是 deprecated 迁移格式而非可新建的接入类型，不改变结论。BYOK 免费声明：`grep -E "插件.{0,6}免费|本体免费|不做二次计费|由用户.{0,8}结算"` 于 zh-CN 与扩展源码 0 命中。

### 6. Auto Models / Sticky Models（§11.4，P1）— 未实现

- 按任务类型自动选模型（审查用快模型、Agent 用强模型）的规则未找到：grep `taskType|fastModel|quickModel|reviewModel|modelRouting|routeModel` 无相关实现；模型策略设置页不存在。
- 按模式/自定义 Agent 固定模型的 Sticky 优先级同样无实现。
- 最接近的是 `highspeed` 加速轮（限时加速模型，`V4ComposerToolbar.tsx:44-45, 113, 1093-1103`）与 CLI 目录兜底（registry fallback），但二者都不是「按任务类型选模型」或「Sticky 优先级」。PRD 标 P1，如实记录为未实现。

**[复核:确认]**：换词 `stickyModel|autoModel|模型策略|modelStrategy|modelRouting|modelForTask|taskModelPolicy` 全仓（ui/cli/services/shared）仅命中 1 条测试注释（`bootstrap/tests/dynamic-workflow-run-service.test.ts:329`）。设置分区清单亲读 `settingsPageConfig.ts:53-185`：basics/agentCapabilities/general/appearance/modelProvider/systemPrompt/remoteDevices/memory/subagents/plugin/mcp/skill/commands/automations/hooks/browser/computerUse/shortcuts/workspaceFileSearch/usage/archives/officialServices——无模型策略页。精度补充：automations 定时任务可为每个任务固定模型与思考档位（`automationAgentConfigOptions.ts:130-170`），形式上接近「自定义 Agent 固定模型」，但它是用户逐任务手动绑定，无「按任务类型自动路由」亦无「优先级高于 Auto」的体系，不构成 Sticky Models。

### 7. 用量显示（§11.5）— 部分实现

**实际机制**（扩展自有面板 `apps/zcode-vscode/src/webview-react/usage/usagePanel.tsx` + `usageModel.ts`）：

- 会话累计 Token ✓：关闭态一行摘要（`usagePanel.tsx:56-78`），展开态输入/输出/缓存读写/上下文占比（:138-152），数据源 `snapshot.usage.cumulative` 随投影帧更新（`usageModel.ts:5-6`）。
- 权威总量 ✓：`getTaskTokenUsage`（v4/conversation/usage）（`usagePanel.tsx:96-102, 145-151`）。
- 每轮用量行 ✓：turn.completed 事件投影（`usagePanel.tsx:153-186`，`usageModel.ts` `projectTurnUsageRows`）。
- 挂载状态：设计为顶栏 usage 槽位（`layout.tsx:106`），但同条目 1——`PluginHeader` 当前无 importer，**live UI 未挂载该面板**；共享侧在 composer 有 `ComposerContextMeter`（上下文占比）与侧栏 `WorkspaceSidebarFooterUsageSummary`（套餐额度，`packages/ui/src/WorkspaceSidebarFooterUsageSummary.tsx:12-24`，面向 Coding Plan quota 而非 Token/费用）。
- 估算费用 ✗：`usageModel.ts` 无 cost/费用字段（grep `cost|费用|price` 无命中）。
- 本月累计 ✗：面板与数据面均无「本月」口径（grep `month|本月` 无命中）。
- 按会话/按模型明细 ✗：只有「每轮」明细，无按模型分组、无跨会话列表。
- 与 `/usage` 一致 ✗：全仓 grep `"/usage"` 斜杠命令（CLI core/tui、packages）无实现（仅 node_modules 类型库误命中）；用量面板是独立实现，不存在 `/usage` 口径可对齐。

**[复核:修正→部分负面不成立，总评仍为「部分实现」但缺项清单需改]**：
- 「按会话/按模型明细 ✗」**不成立**——共享设置页「使用情况」分区（`packages/ui/src/settings/settingsPageConfig.ts:172` id:"usage"；扩展经共享 `Root` 挂载，`apps/zcode-vscode/src/webview-react/App.tsx:19`）有跨会话按模型统计：`AppUsageModelUsagePieChart` + `AppUsageDailyModelTrendChart`（`settings/usage-stats/AppUsagePanel.tsx:96-113`），数据 schema 含每模型 `totalTokens/inputTokens/outputTokens/requestCount/share` 与 `favoriteModel`（`packages/shared/src/usage-stats.ts:181-185, 232-238`），来源 agent-db 会话历史（:261 `source: "agent-db"`）。报告只核对了扩展自有 usagePanel，漏看该层。
- 「本月累计 ✗」**部分修正**——无自然「月」口径，但有 30 天滚动区间 `APP_USAGE_RANGES = ["all","7d","30d"]`（`usage-stats.ts:178`）与套餐周期额度展示（`CodingPlanUsagePanel.tsx` quota limits + `entitlementMonthlyMcpUsage` :391-393）；PRD 允许「供应商提供时显示真实值」，套餐额度链路部分满足。
- 「无费用估算 ✗」确认：`usage-stats/` 组件与 schema `grep cost|费用|price` 0 命中；`usageModel.ts` 字段仅 input/output/cache/请求计数（亲读 :19-22, 47-50）。
- 「无 /usage 命令 ✗」确认：CLI 斜杠命令注册表亲读 `apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts:53-237`（compact/expert/effort/dwf/fork/help/init/workflow/login/logout/locale/resume/new/rewind/mode/mcp/plugins/model/goal/skill），无 usage；协议层 `bootstrap/src/zcode-protocol/slash-commands.ts` 同无。
- 侧栏 usage 槽位未挂载（PluginHeader 无 importer）复核成立（同条目 1）。

### 8. 失败与降级（§11.6）— 部分实现

**实际机制**（CLI adapter 层分类齐全）：

- 错误分类 ✓（CLI 侧）：`apps/zcode-cli/packages/adapters/src/model/failure-classifier.ts`
  - 鉴权失败：401/403 → `ProviderNotConfigured`，message「Provider authentication failed.」，不可重试（:204-212）；
  - 限流：429 → `ModelRateLimited`，可重试 + `retryAfterMs`（:183-193）；529 → ProviderOverloaded（:194-202）；
  - 网络失败：`isNetworkFailure`/timeout 分支（:128-179）；
  - 上下文超限：400/422 且 `isContextExceededFailure` → `ModelContextExceeded`（:214-227）；
  - 「模型不存在」类：`provider.notInRegistry`（`bootstrap/src/zcode-protocol-v4/commands/handlers/model-config.ts:36-44`，切到不存在的 provider 返回结构化失败）。
- UI 分类显示未逐项确认：i18n 中未见「鉴权失败→引导改 Key」「网络失败」等按类别的用户文案（zh-CN.ts grep `鉴权|限流|网络失败` 仅命中 workflow throttle「限流」:6135）。错误在对话区以错误行/详情展示（如 `ToolCallBlocks` 各 renderer），是否完全「不甩原始堆栈、详情可展开」未逐一验证——如实标注为未确认。
- 自动重试：**次数与 PRD 不符**。默认 `maxAttempts = DEFAULT_MAX_RETRIES(10) + 1 = 11`，baseDelay 2s、指数退避 backoffFactor 2、maxDelay 60s、jitter（`apps/zcode-cli/packages/adapters/src/model/retry-policy.ts:8-27`）；限流尊重 provider `retry-after`（上限 5 分钟，`runner-retry.ts:7-9, 29-38`）。PRD 说「网络类瞬时失败重试 2 次」——实际默认 10 次（env 可调 `ZCODE_MODEL_RETRY_MAX_RETRIES`），指数退避+抖动存在。
- 不做跨供应商自动故障转移 ✓：无 failover 实现（grep `failover|故障转移` 仅命中 `packages/services/src/prompt-assist/promptEnhanceGenerator.ts:112` 的注释，说明旧旁路曾有跨渠道 failover、现行同模型重试）。失败后由用户手动切换模型，会话上下文保留（switchModelConfig 不清会话）。

**[复核:修正→「UI 分类文案未见」需改写]**：
- 重试参数亲读 `retry-policy.ts` 确认：`DEFAULT_MAX_RETRIES = 10`（:13）→ `maxAttempts = 11`（:28 注释「includes the first request」），base 2s/×2/60s/jitter（:14-16,26），env `ZCODE_MODEL_RETRY_MAX_RETRIES` 可调（:18）——「10 次 ≠ PRD 的 2 次」成立。
- 但「i18n 中未见按类别的用户文案」**不成立**：`packages/ui/src/lib/providerBusinessError.ts:16-103` 存在完整的业务错误码→文案+恢复动作映射——1006 登录失效→「重新登录」（鉴权引导）、1005 额度用尽→「刷新额度/升级」、3006 模型不可用→「切换模型」、3002/429 限流→「稍后重试」、2007 上游不可用、3102 闲时超时；文案亲读 `zh-CN.ts:6304-6307`（动作按钮）与 :6544-6556（分类文案）。错误横幅 `ChatErrorBanner.tsx:260-285` 提供详情 Dialog 展开（「chat.error.expandDetails」）+ 复制 TraceID——「详情可展开查看」满足。
- 精度限定：该分类覆盖 zcode-plan/Coding Plan 业务码域；个人供应商原生 HTTP 401/403（`Provider authentication failed.`，failure-classifier :204-212）仍无本地化分类引导文案，PRD「填错 Key 时出现鉴权引导」对自带 Key 场景确实缺口。
- UI 错误码透传链复核：`snapshot.meta.lastError` 含 code/detail/attribution（`packages/ui/test/zcodeSessionProjection.test.ts:1175-1196` 断言），UI 端 `zcodeUiError.ts` 归一并保留根因。
- 无故障转移 ✓ 独立确认。

---

## FR-06 权限与审批

### 9. 三层审批模型（§12.2）— 未实现为三层模型

**PRD 要求**：L1 逐步确认 / L2 分类模型代审（轻量分类模型先审）/ L3 全自动（显式开启、状态常驻可见、关面板或新建会话回默认）。

**实际机制**（`apps/zcode-cli/packages/core/src/permission/service.ts`，`checkPermission` :99-273）：

- 无分类模型代审：grep `classifier|fullAuto` 无 L2 实现；唯一的 `autoApproveHighRisk` 是静态布尔配置且默认 false（:731, 738），不是模型代审。
- 无 L3 显式开关：无「会话内全部放行」的用户开关；无界面常驻状态显示。`yolo`/`guarded` 模式接近 L3 语义（「Yolo mode bypasses permission prompts」，:160-164），但它是模式选择而非带二次确认的全自动开关。
- 实际决策轴是：**模式 × 工具自报能力 × 规则集**：
  1. Plan 模式转换判定（:140-146）；
  2. `requiresUserInteraction` 工具必问（:149-160）；
  3. guarded 模式下工具 `userApprovalRule`（危险命令）user-once 询问（:147-155）；
  4. `alwaysAsk` 工具（如批量删除）压过一切放行分支但压不过硬阻断（`checkAlwaysAsk` :370-416）；
  5. yolo/guarded 直通（:160-164）；
  6. `auto` 模式保留未实现，一律 deny「Auto mode is reserved but not implemented yet」（:166-175）；
  7. disallowedTools deny（:177-181）→ 项目 deny → 项目 ask → …… → 项目 allow → allowedTools allow（:190-264）→ build/edit 模式风险语义（:266-272, 542-569）。
- 会话级「批准并记住」：`grantSessionPermission`（:92-95）+ broker 应答的 `suggestedPermissionUpdates`（`contracts/src/interfaces/permission.port.ts:28-30`），会话实例随会话消亡（:83-86 注释）。

**差异**：三层模型不存在；实际是「模式语义 + 工具能力自报 + allow/ask/deny 规则」的连续决策，无分类模型、无全自动开关、无常驻 L3 状态。

**[复核:修正→「无 L3 显式开关」不成立；L2 半边确认]**：
- L2 分类模型代审确无：`grep -ri "classifier|triage|代审"` 于 `core/src/permission/`、`core/src/runtime/` 0 命中；`autoApproveHighRisk` 静态布尔默认 false（`service.ts:731,738` 亲读）。
- 但「无『会话内全部放行』的用户开关」**不成立**——审批窗的「完全访问 / Full access」是完整闭环的显式 L3 等价开关：
  1. 请求合成：`product-projection.ts:3475-3487`——`fullAccessSupported === true` 且非 user-once/无 origin/无 optionsPolicy 的每个权限请求都附加 `fullAccessOption`；
  2. `fullAccessSupported` 由 `session-mode-port.ts:7` 给出（`supportsPermissionFullAccess = sessionStore 有 commitPermissionFullAccess`，桌面 v4 路径基本恒真；`core/src/tool/executor/events.ts:174-177`）；
  3. UI 注入：`packages/ui/src/v4/pendingInteractionAdapter.ts:63-64` 把 fullAccessOption 并入审批选项；`PermissionDialog.tsx:189-193` 归一显示「完全访问 / 授予 Agent 完全访问权限，不再确认。」（`zh-CN.ts:6362-6363` 亲读）；
  4. 应答路由：`interaction-registry.ts:181-200` `resolveFullAccess` → `interaction-broker.ts:156-169` `fullAccess` 回调 → `grantPermissionFullAccess`；
  5. 生效语义：`core/src/runtime/permission-full-access.ts:54` —— 会话执行态**切换为 yolo 模式**并提交 `PERMISSION_FULL_ACCESS_ENTRY` receipt（「完全访问只改当前任务」:17），新建会话回 build 默认（`configSettings.ts:29`）；yolo 状态经 composer 模式选择器常驻可见（`V4ComposerModeControls.tsx:123` 对 yolo 有 warning 高亮）。
- 语义差异保留：L3 要求「状态常驻可见」为独立指示器，此处经模式指示器间接可见；开关出现在审批窗内而非设置页常驻开关。三层**命名模型**（L1/L2/L3 全模块引用）不存在，报告标题层面的结论可保留，但内文两个具体否定（无会话级全部放行开关、无任何显式全自动开关）需按上述修正。

### 10. 模式与默认审批强度（§12.2）— 机制不同

**PRD 要求**：Agent 与 Debug 默认 L1，Auto 默认 L2。

**实际机制**（`core/src/permission/service.ts`；扩展默认模式 `build`，`apps/zcode-vscode/src/configSettings.ts:38`）：

| 模式 | 默认审批强度（代码路径） |
|------|------|
| build（默认） | 只读工具 allow（:546-552）；critical/high risk ask（:554-562）；session-state 低风险 allow（:564-574）；有副作用/破坏性/needsApproval ask（:576-586）；其余低风险 allow（:588-594） |
| edit | workspace 文件编辑类工具 allow，其余按 build（`checkEditMode` :557-567） |
| plan | 只读非破坏 allow；非破坏 MCP allow；其余 **deny**（`checkPlanMode` :490-514） |
| guarded | 直通，但危险命令（userApprovalRule）user-once ask（:147-155），alwaysAsk 仍问 |
| yolo | 直通（:160-164），alwaysAsk/批量删除仍问 |
| auto | 保留未实现，一律 deny（:166-175） |

**差异**：PRD 的 Agent/Debug/Auto 三模式映射不存在；实际六模式（build/edit/plan/guarded/yolo/auto）里没有名为 Agent/Debug 的模式，auto 未实现。build 默认强度接近 L1 但低风险（只读、session 状态）自动放行，不是纯逐步确认。

**[复核:确认]**：默认模式亲读 `apps/zcode-vscode/src/configSettings.ts:29`（`mode: "build"`）；可切换集合亲读 `model-config.ts:67`（`SWITCHABLE_MODES = {build, edit, plan, yolo, guarded}`，auto 不在其中）；`auto` 一律 deny 亲读 `service.ts:159-166`（「Auto mode is reserved but not implemented yet」）。UI 侧模式集亲读 `V4ComposerModeControls.tsx:63-82,123-124,150-151`（build/edit/plan 开关/yolo/guarded，yolo 带 warning 高亮）。注意：报告所引 `service.ts` 行号有整体漂移（如「yolo/guarded 直通 :160-164」实际在 :155-157、「auto deny :166-175」实际在 :159-166），系工作区代码演进所致，机制结论不受影响。

### 11. 按工具 8 类授权开关（§12.3）— 未实现

**PRD 要求**：读项目内/读项目外/改项目内/改项目外/跑安全命令/跑全部命令/用浏览器/用 MCP 八类开关，默认只开读项目内；改项目外与跑全部命令首次二次确认。

**实际机制**：

- 无八类开关 UI（共享与扩展设置页 grep 无对应分区）；「改项目外」「跑全部命令」的 L3 首次二次确认亦无。
- 实际分类轴是工具能力自报（`PermissionToolCapability`，`permission/service.ts:39-53`）：
  - `riskLevel: low/medium/high/critical`；
  - `sideEffectScope: none/session/workspace/git/network/system/userInteraction`（`contracts/src/model/index.ts:476-483`）；
  - `readOnly/destructive/needsApproval/alwaysAsk`；
  - `permissionCapabilityGroup` 目前仅 `official_cua`（计算机使用，`contracts/src/interfaces/permission.port.ts:12-14`）——这是唯一接近「按类授权」的组（CUA 有专属项目级授权选项「always allow computer use in this project」，`PermissionDialog.tsx:209-212`）。
- 「项目内/项目外」维度通过 `additionalDirectories` 附加目录约束（`apps/zcode-vscode/src/host/hostSettingsBridge.ts:23, 130`，上限 256）控制可访问范围，而非按类开关。
- Bash 细分：只读命令（`isRuntimeReadOnlyBashCommand`，`core/src/tool/handlers/bash.ts:129-143`）自动放行；批量删除自报 alwaysAsk（:144-160 + `bash-delete-protection.ts`）；guarded 危险命令表（`bash-command-permission-policy.ts:15-28` `HIGH_RISK_ROOT_COMMANDS`）。
- 默认行为近似「读安全→自动放行，写/副作用→ask」，等效覆盖了 PRD 的核心意图，但不是 8 个独立开关。

**[复核:确认]**：`PermissionCapabilityGroup` 全集亲读 `contracts/src/interfaces/permission.port.ts:12-14`——仅 `official_cua` 一组，唯一使用点 `core/src/mcp/index.ts:49,184`（官方 CUA MCP 工具），对应审批窗「always allow computer use in this project」（`PermissionDialog.tsx:195`）。设置面无按类开关：`grep -i "自动批准|autoApprove|自动放行|授权开关"` 于 `packages/ui/src/settings/` 0 命中；扩展权限设置仅 `gode.permissions.allowlist/denylist`（`package.json:329,337` 亲读）。

### 12. 细粒度规则（§12.4）— 部分实现

**实际机制**：

- 规则形状 ✓：`PermissionRuleset { allow/deny/ask: { toolName, ruleContent }[] }`（`contracts/src/interfaces/permission.port.ts:24-32`），`ruleContent` 支持 `prefix:*` 前缀、`*` 通配、精确匹配（`permission/service.ts:330-343`；bash 专用求值 `core/src/tool/handlers/bash-command-rule-evaluator.ts:16-45`，allow 要求全子命令匹配、deny/ask 任一匹配）。
- 扩展设置面：`gode.permissions.allowlist` / `gode.permissions.denylist`（`apps/zcode-vscode/package.json:329-344`，`Tool` 与 `Tool(args)` 形式）→ `HostSettingsBridge` 归一（`hostSettingsBridge.ts:26-33`）→ 随 create/resume 携带（:129-146）→ CLI 侧 `allowedTools`/`disallowedTools`（`bootstrap/src/app/app-config-options.ts:17-18`）→ `rule.allowedTools` allow / `rule.disallowedTools` deny（`permission/service.ts:177-181, 253-263`）。**只有 allow/deny 两态，无 ask**。
- 项目/会话规则存储：sqlite `local_settings`（namespace=permission，scope=project，`adapters/src/storage/session-store/repositories/local-settings.ts:7-43`）+ 会话级 ruleset（`core/src/tool/executor/permission-rules-persistence.ts:19-27`）。**非 PRD 所说「随项目配置文件、两处同源」**；也无设置页图形化编辑（无对应设置分区）。
- 优先级：build/edit/plan 分支下检查顺序为 disallowedTools deny（:177 前提）→ 项目 deny（:177-181）→ 项目 ask（:186-192）→ …… → 项目 allow（:217-222）→ allowedTools allow（:253-263）→ 模式语义（:266-272），即 **deny > ask > allow > 分类开关/模式默认** 成立 ✓。
  - **例外**：`yolo`/`guarded` 的模式放行在项目规则之前（:160-164 先于 :177/:190），yolo 下项目 deny 不拦截（代码注释自认：「尤其 yolo 目前先于 disallowedTools 放行这一点」:366）；alwaysAsk 路径内 deny 先于会话 allow（:392-404），阻断优先。PRD 的「deny 大于一切」在 yolo/guarded 模式不成立。
- 「批准并记住」写面：allowAlways 选项携带 `permissionUpdates: addRules(allow)`（`PermissionDialog.tsx:100-117` 读取 bash 前缀 scope；CLI `applyGrantedPermissionUpdates` 落 project/session ruleset）。

**[复核:确认]**：存储亲读 `local-settings.ts:10-45`——项目规则落 sqlite `local_settings`（key="ruleset", namespace="permission", scope="project"）+ 旧 `permission` 表回退，非项目配置文件；PRD「设置页图形化编辑/两处同源」不存在：`grep -i "permission.*rules|ruleset"` 于 settings 目录 0 命中，规则查看/撤销 UI 亦无（`grep -i "revoke|撤销|deleteRule"` 于 packages/ui 仅命中无关组件）。扩展侧两态确认：`package.json:329-344` 仅 allowlist/denylist，无 asklist。**yolo 压过 deny 亲验成立**：`service.ts:155-157` yolo/guarded 直通分支先于 :168 `disallowedTools` deny 与 :177-184 项目 deny（:151-153 alwaysAsk 与 :138-148 guarded 危险命令 ask 先于直通——报告「alwaysAsk 压过 yolo」同样亲验成立）。

### 13. 审批交互（§12.5）— 部分实现

**实际机制**（`packages/ui/src/PermissionDialog.tsx` + `v4/V4InteractionDialogs.tsx`）：

- **审批请求出现位置 ✗**：PRD 说「出现在消息流内」，实际是**模态弹窗**——`V4InteractionDialogs` 把 pendingInteraction 接到 `PermissionDialog`（`v4/V4InteractionDialogs.tsx:327-359`），挂载于 `SessionPane.tsx:5113` 覆盖层，非消息流内联块。
- 内容 ✓：工具名 + 按工具分类的预览块（edit/execute/mcp/search/workflow/skill/fallback，`PermissionDialog.tsx:277-336`，注释「避免把 raw JSON 摊开」「只展示用户关心的 URL/query 摘要」）；request reason 过滤非用户可见文案后展示（:239-252）；文件路径/命令全文预览。
- 批准/拒绝/批准并记住 ✓：允许（allowOnce）/始终允许（allowAlways）/拒绝（rejectOnce）/始终拒绝（rejectAlways）（i18n `zh-CN.ts:6357-6370`；描述 :6472-6479「后续相同命令不再询问/也会直接拒绝」）；另有 full access、项目级、会话级、CUA 项目级选项（:207-226）；deny 可附 freeText 反馈（:130, 561）。「批准并记住」写入分类/细粒度规则（见条目 12）。
- **Diff 预览入口 ✗**：edit 审批块复用聊天区同一套文件摘要解析（`rawFileSummaries`，:503-514，注释「复用聊天区同一套 edit 解析」），但 `onOpenCodeViewer: undefined`（:410）、`viewerLabelId: "codeViewer.viewCode"`（:391）——审批弹窗内**没有**打开 Diff/代码查看器的入口；Diff 预览由消息流的 FR-07 面板承担，审批时刻看不到。
- 终端命令全文 ✓：`ExecuteCommand` 渲染整段命令 `<pre>`，溢出限高但提供展开/滚动入口（`ToolCallBlocks/renderers/ExecuteCommand.tsx:27-40`，注释「原命令区域只有限高和截断，没有阅读完整内容的入口」——已修复为可展开）；preview 链路 `normalizeBlockText` 不截断（`shared/src/permission-request-preview.ts:47-49`）。
- **风险标注 ✗**：审批块与执行块均无「含管道/重定向/删除/网络访问」类风险标签（`ExecuteCommand.tsx` 与 `PermissionDialog.tsx` grep `risk|危险|删除|管道` 无风险文案命中）；审批按钮描述按 command/file/generic 作用域区分（zh-CN.ts:6472-6479），不按风险类型标注。风险信息仅体现在 CLI 决策（riskLevel/userApprovalRule），未透出为 UI 标注。
- deny 说明规则来源 部分 ✓：deny 携带 `ruleId`（`rule.project.deny`「denied by project permission rules」:177-181、`rule.disallowedTools`「explicitly disallowed」:159-167）——来源分类可说明，但不回显命中的具体规则内容。
- 审批无超时 ✓：`ManualPermissionBroker.requestPermission` 仅在显式传 `timeoutMs` 时起定时器（`core/src/permission/broker.ts:120-135`）；`permissionTimeoutMs` 是可选配置（`core/src/runtime/types.ts:145`），bootstrap/cli 装配未设置（grep `permissionTimeoutMs` 在 bootstrap/cli 无赋值）→ 默认一直等用户，只受用户 abort（停会话）取消。注意区分：`ElicitationDialog` 的 autoResolution 倒计时（`ElicitationDialog.tsx:31-38`）只作用于 AskUserQuestion 类 userInput 交互（`V4InteractionDialogs.tsx:391-405`），不作用于工具审批。

**[复核:确认]**：弹窗形态亲读 `V4InteractionDialogs.tsx:327-371`（permission → `PermissionDialog`）+ 挂载点 `SessionPane.tsx:5113`（overlay 层，非消息流内联块）——注意 v4 投影中审批请求带 `anchorRowId` 锚到工具行（`product-projection.ts:3466`），但 UI 呈现仍是弹窗。Diff 入口亲读 `PermissionDialog.tsx:388`（`inlinePreview: { type: "none" }`）、:397（`viewerSource: null`）、:410（`onOpenCodeViewer: undefined`）——审批时刻确无 Diff/代码查看器入口。风险标注：`grep -i "风险|riskLabel|dangerous|管道|重定向"` 于 `PermissionDialog.tsx`、`ToolCallBlocks/renderers/ExecuteCommand.tsx`、`shared/src/permission-request-preview.ts` 0 命中。无超时：`broker.ts:108-126` 亲读（仅显式 `options.timeoutMs` 起定时器）；`grep -rln permissionTimeoutMs apps/zcode-cli/packages/{bootstrap,cli}/src` 0 文件命中——默认无超时成立。

### 14. 终端命令白名单（§12.6）— 部分实现

**PRD 要求**：设置页维护允许与拦截两张**命令模式**列表；拦截命中直接拒绝执行并在消息流说明，不弹审批。

**实际机制**：

- 两张列表（工具级）✓：`gode.permissions.allowlist/denylist`（package.json:329-344）——但这是 VS Code settings 的 JSON 数组编辑，非插件内「设置页」专用 UI；规则形式是 `Tool` / `Tool(args)`，命令模式（glob）规则实际走项目 ruleset（条目 12）。
- 拦截命中直接拒绝不弹审批 ✓（有例外）：`disallowedTools` 与项目 deny 在 `checkPermission` 返回 deny、不发起 broker 审批（`permission/service.ts:177-181`；`requiresUserInteraction` 工具先行 deny :149-160）。**例外**：yolo/guarded 模式直通分支在 deny 检查之前（:160-164），yolo 下 denylist 不拦（代码注释自认）；guarded 下危险命令 userApprovalRule ask 在 disallowedTools 检查之前（:147-155），被 denylist 的危险命令在 guarded 下会先弹审批。
- CLI bash 只读策略 ✓（但定位不同）：`core/src/tool/handlers/bash-readonly-policy*` 一族 + 生成命令注册表（`bash-command-permission-policy.ts:9-13`，`analyzeBashCommand`/`isBashCommandPermissionSafe`）用于判定命令读写性，支撑 plan 模式拦截与只读放行；危险命令表 + guarded user-once（`bash.ts:113-127`）。这是内置语义策略，不是用户可维护的白名单列表。
- 「允许列表命中直接放行终端命令」：`allowedTools`（allowlist）在 build/edit 模式生效（:253-263，位于项目规则后、模式语义前）——allowlist 命中可放行；但允许列表是工具级（如 `Bash(npm test:*)` 形式由项目 ruleset 表达更完整），extension allowlist 条目说明只提 `Tool` 与 `Tool(args)`。

**差异**：没有独立的两张命令模式列表设置页；deny 不弹审批的语义存在但受模式优先级例外影响；bash 只读策略是内置判定而非用户配置面。

**[复核:确认]**：`grep -i "命令(白名单|模式)|commandWhitelist|commandAllowlist|terminalAllow|允许的命令"` 于 ui/extension/settings 仅命中 `zh-CN.ts:1053` 的 bots 域「允许的命令」（机器人功能，与终端工具无关）；两列表为 VS Code settings JSON 数组（`package.json:329-344`）经 `normalizeToolRules`（`hostSettingsBridge.ts:30-38,59-60` 亲读）原样透传。deny 不弹审批 + yolo/guarded 例外已亲验（`service.ts:155-157` 先于 :168/:177，同条目 12）。

---

## 与 PRD 的核心差距摘要

1. **FR-05**：模型切换/供应商管理的骨架完整（会话级 CAS、管理面 CRUD+连通性、Node 侧拉模型、错误分类与指数退避），但缺「可搜索模型菜单」「设为默认」「全局默认切换入口」「费用估算」「本月累计」「/usage 口径」「Google/Ollama 类型」「BYOK 免费声明」；密钥落 0o600 JSON 而非 SecretStorage；重试次数 10 ≠ PRD 的 2。
   **（复核修订**：「本月累计」不精确——设置页使用情况有 30d 滚动区间与套餐周期额度，缺的是自然月口径；「按模型明细」原表列为缺失是错的，设置页使用情况分区已有跨会话按模型统计与饼图/趋势图**）**
2. **FR-06**：实际机制是「六协作模式 × 工具能力自报（riskLevel/sideEffectScope/alwaysAsk）× allow/ask/deny 规则」，比 PRD 的「三层审批 + 8 类开关」更细也更强（alwaysAsk 压过 yolo），但 PRD 明确要求的 L2 分类模型代审、L3 显式开关与常驻状态、8 类授权开关 UI、审批内 Diff 预览入口、命令风险标注均无；yolo 模式压过 deny 规则是与「deny 最大」原则的真实冲突点。
   **（复核修订**：「L3 显式开关均无」不成立——审批窗「完全访问」开关完整闭环（合成→UI→路由→切 yolo+receipt，见条目 9 复核标注）；L2 分类代审、8 类开关 UI、Diff 入口、风险标注均无的判断经复核成立**）**
3. **挂载缺口**：扩展自有的 `layout.tsx`（modelSelect/usage 槽位）、`header/modelSelect.tsx`、`usage/usagePanel.tsx` 均有实现与单测，但当前 `App.tsx`/`index.tsx` 未装配 `PluginHeader`——live 界面使用共享 `Root`，这些面板处于未接入状态。
   **（复核确认**：另有两处未接线半成品同属此类——`wrapAgentServiceForModelWriteback`（模型切换回写 VS Code 设置）与 store stage `persistingWorkspace`，见条目 2 复核标注**）**

## 搜索范围与方法记录

- grep 关键词：`modelSelect|modelGroups|switchModelConfig|cliDefaultSelection`、`SecretStorage|apiKey|credential`、`ollama|gemini|google`、`BYOK`、`cost|费用|month|本月`、`"/usage"`、`retry|backoff|maxAttempts|rate.?limit|failover`、`classifier|fullAuto|autoApprove|yolo|guarded`、`allowlist|denylist|ruleset|denyPriority`、`userApprovalRule|alwaysAsk|permissionTimeoutMs`、`riskLevel|sideEffectScope`。
- 主要目录：`apps/zcode-vscode/src`（webview/host/config）、`packages/ui/src`（composer/settings/PermissionDialog/i18n）、`apps/zcode-cli/packages/core/src`（permission/tool）、`apps/zcode-cli/packages/{bootstrap,adapters,contracts}`、`packages/{provider,provider-node,services,shared}`。
- 未执行项：PRD §11.7/§12.7 的验收场景（运行时行为）未测试；`zcode-vscode` 扩展自身的 `pnpm typecheck`/`pnpm lint` 未运行（本任务为只读核对，未改代码）。

---

## 复核纪要（2026-11-07 独立复核）

复核人独立换词重搜与亲读，全部 14 条负面结论逐条验证：**确认 10 条、修正 3 条（#7/#8/#9）、无存疑**。修正不推翻各条「部分实现」的总评，但纠正了其中的具体否定事实；另为确认条目补充了 4 处调查员漏列的代码事实。

### 修正条目

- **#7 用量显示**：「按会话/按模型明细 ✗」不成立。共享设置页「使用情况」分区（`settingsPageConfig.ts:172`，扩展经共享 `Root` 挂载可达）有跨会话按模型统计：`AppUsageModelUsagePieChart`/`AppUsageDailyModelTrendChart`（`AppUsagePanel.tsx:96-113`）、每模型 `totalTokens/inputTokens/outputTokens/requestCount/share` 与 `favoriteModel` schema（`shared/src/usage-stats.ts:181-185,232-238`）、agent-db 会话历史聚合（:261）。「本月累计 ✗」部分修正：无自然月口径，但有 `APP_USAGE_RANGES=["all","7d","30d"]`（:178）30 天滚动区间与套餐周期额度展示。「无费用 ✗」「无 /usage 命令 ✗」复核确认（CLI 斜杠命令注册表 `slash-commands.ts:53-237` 亲读无 usage）。
- **#8 失败与降级**：「UI 分类文案未见」不成立。`packages/ui/src/lib/providerBusinessError.ts:16-103` 有完整业务错误码→分类文案+恢复动作映射（1006 登录失效→重新登录、1005 额度→刷新/升级、3006→切换模型、3002/429 限流→稍后重试、2007 上游不可用），文案亲读 `zh-CN.ts:6304-6307,6544-6556`；`ChatErrorBanner.tsx:260-285` 详情 Dialog 可展开+复制 TraceID（「详情可展开」满足）。精度限定：该分类覆盖套餐业务码域，个人供应商原生 401/403（"Provider authentication failed."）仍无本地化鉴权引导——此子项缺口确认。重试 10 次（`retry-policy.ts:13,28` 亲读）、无故障转移均确认。
- **#9 三层审批**：「无 L3 显式开关」不成立。审批窗「完全访问 / Full access」是完整闭环的会话级全自动开关：`product-projection.ts:3475-3487` 合成 fullAccessOption（条件亲读：非 user-once、无 origin/optionsPolicy、`fullAccessSupported`，后者由 `session-mode-port.ts:7` 给出）→ `pendingInteractionAdapter.ts:63-64` 注入选项 → `PermissionDialog` 显示「完全访问…不再确认。」（`zh-CN.ts:6362-6363`）→ `interaction-registry.ts:181-200` → `interaction-broker.ts:156-169` → `permission-full-access.ts:54` **会话模式切 yolo + PERMISSION_FULL_ACCESS_ENTRY receipt**；新建会话回 build 默认，yolo 状态经模式选择器常驻可见。与 PRD L3 的残余差距：开关出现在审批窗内而非设置页常驻开关，状态靠模式指示器间接可见。L2 分类代审确无（`autoApproveHighRisk` 静态布尔默认 false，`service.ts:731,738` 亲读；classifier/triage/代审 grep 0 命中）。报告标题「未实现为三层模型」仍成立（L1/L2/L3 命名体系与全模块引用不存在），但内文否定需按此修正。

### 确认条目（附复核补充证据）

- **#1**：无搜索输入（换词 `搜索|searchable|combobox|filterInput` 全量 grep 仅无关命中；`ModelConfigSelect.tsx:440,571` 亲读非搜索框）；`PluginHeader` 无 importer、`header/modelSelect.tsx` 仅测试引用亲验。
- **#2**：「无改全局默认入口」对 live 行为成立；**补充**：两处未接线半成品——`hostSettingsBridge.ts:284-317` `wrapAgentServiceForModelWriteback`（switchModelConfig 帧回写 VS Code 设置，无装配点）与 store stage `"persistingWorkspace"`（`zcodeSessionStoreTypes.ts:131` + `zh-CN.ts:5241`，无 set 点）。
- **#3**：auto-compact 按当前模型亲读确认（`compact/policy.ts:90-155`）；**补充**：`zh-CN.ts:5250-5258` 存在与 PRD「切换重校验提示」精确对应的 `chat.modelSwitch.contextWindowGuard.*` 死文案（全仓无代码引用，`git log -S` 来自初始提交），证明该守卫曾规划未接线；CLI `switchModelConfig` 无上下文守卫（`model-config.ts:74` 注释自认运行中可切换）。
- **#4**：「设为默认」缺失确认（`preferredProviderId` 是套餐权益查询参数；`markApiKeyLoginSuccess` 是登录一次性标记）；SecretStorage 0 命中确认；API Key 落 `provider_config.json` 0o600 亲读确认（`runtime-paths.ts:5`、`privateFilePersistence.ts:100`）。
- **#5**：三类型枚举亲读确认（`provider-data-schema.ts:3-8`）；Ollama 全仓唯一实质命中为 bash 命令元数据表（1.8MB 单行 registry，与原报告一致）；**补充**：`legacyModelProviderSerialized.ts:26-36` 有 deprecated gemini 遗留读取格式（迁移兼容，非可新建类型，不改结论）；BYOK 免费声明 0 命中确认。
- **#6**：换词 `stickyModel|autoModel|模型策略|modelRouting` 全仓仅 1 条测试注释；设置分区清单亲读无模型策略页；automations 可逐任务固定模型（`automationAgentConfigOptions.ts:130-170`）但非任务类型路由/Sticky 体系。
- **#10**：默认 build（`configSettings.ts:29`）、SWITCHABLE_MODES 亲读（`model-config.ts:67`）、auto deny 亲读（`service.ts:159-166`）确认；注意报告所引 service.ts 行号整体漂移约 5 行（代码演进），机制结论不受影响。
- **#11**：`PermissionCapabilityGroup` 仅 official_cua 亲读（`permission.port.ts:12-14`；唯一使用 `core/src/mcp/index.ts:49,184`）；无按类开关 UI 确认。
- **#12**：规则落 sqlite（`local-settings.ts:10-45` 亲读）、无 ask 态、无图形化编辑/撤销 UI、yolo 压过 deny 亲验（`service.ts:155-157` 先于 :168/:177）全部确认；「alwaysAsk 压过 yolo」同面亲验（:151-153 先于 :155-157）。
- **#13**：弹窗非内联（`V4InteractionDialogs.tsx:327-371` + `SessionPane.tsx:5113`）、无 Diff 入口（`PermissionDialog.tsx:388,397,410` 亲读）、无风险标注（三文件 grep 0 命中）、无默认超时（`broker.ts:108-126` 亲读 + `permissionTimeoutMs` 在 bootstrap/cli 0 文件命中）全部确认。补充：v4 投影中审批请求带 `anchorRowId` 锚定工具行，但 UI 呈现为 overlay 弹窗。
- **#14**：无命令模式白名单设置页确认（唯一 i18n 命中为 bots 域无关文案）；deny 不弹审批 + yolo/guarded 例外亲验确认。

### 复核方法说明

- 全部复核为本会话内执行的只读 grep/亲读，未运行测试或构建（与原报告一致，PRD §11.7/§12.7 运行时验收场景仍未执行）。
- 复核独立换用的关键词族：`搜索|searchable|combobox|filterInput`、`persistingWorkspace|wrapAgentServiceForModelWriteback`、`contextWindowGuard|targetModel`、`preferredProvider|isDefault|markAsDefault`、`stickyModel|autoModel|模型策略`、`dailyModelUsage|appUsage|APP_USAGE_RANGES`、`providerBusiness|copyTraceId|expandDetails`、`fullAccess|grantPermissionFullAccess|supportsPermissionFullAccess`、`PermissionCapabilityGroup|autoApprove`、`commandWhitelist|commandAllowlist`、`revoke|撤销`。
- 调查员漏看的主要层：共享设置页「使用情况」分区（#7）、`providerBusinessError.ts` + `ChatErrorBanner` 错误分类呈现（#8）、审批窗 fullAccess 开关全链路（#9）。三处均在 `packages/ui`，属原报告声明已覆盖的目录。
