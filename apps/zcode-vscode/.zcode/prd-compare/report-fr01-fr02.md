# PRD 核对报告：FR-01 入口与布局 / FR-02 聊天输入框与消息流

- 日期：2026-11-07
- PRD：`/Users/jonntd/Downloads/vscode-all-in-one-prd.md`（第 7、8 章全文 + 第 24 章命令/快捷键总表；只读核对，未改动任何代码）
- 代码基线：monorepo `/Users/jonntd/ZCodium`，分支 `feat/vscode-editor-native`；扩展壳 `apps/zcode-vscode`（package.json 当前工作树为 `gode` 版本，注意与最近提交「扩展改名 zcodium.code」存在未同步的本地改动，见 git diff：`apps/zcode-vscode/package.json 108 insertions(+), 113 deletions(-)`）
- 结论分级：✅ 已实现 / 🟡 部分实现（行为与 PRD 有偏差）/ ❌ 未实现（含搜索证据）
- 实现位置标注：扩展原生 = `apps/zcode-vscode/src/**`；共享组件 = `packages/ui/**`；CLI 运行时 = `apps/zcode-cli/**`

---

## FR-01 入口与布局（PRD 第 7 章）

### 1) Activity Bar 图标 + 运行中任务数字角标 — 🟡 部分实现

> [复核:确认] 独立换词重搜（`setBadge|TreeDataProvider|registerTreeData|runningTask|taskCount` 于 `apps/zcode-vscode/src` + package.json）均零命中；`contributes.viewsContainers` 仅 activitybar 一个容器、`views` 仅 `gode.chat` 一个视图（python 解析 package.json 实测）。唯一角标是状态栏审批 `⚠ n`（statusBar.ts:66-67），与原报告一致。

- 图标 ✅：`apps/zcode-vscode/package.json:29-35` `contributes.viewsContainers.activitybar` 注册容器 `gode`，图标 `media/gode.svg`；侧栏视图 `gode.chat`（package.json:37-45）。
- 数字角标 ❌：全扩展源码搜索 `badge|Badge` 仅命中 `src/ui/statusBar.ts:66-67`（状态栏文本 `⚠ n`，是待审批计数，不是 Activity Bar 运行中任务角标）。无 TreeView badge、无任何 Activity Bar 徽记代码（VS Code 稳定 API 也不提供对容器图标的数字角标，需要自行用 TreeView 或状态栏承担）。
- 结论：图标有、运行中任务数字角标无。

### 2) 编辑器标题栏图标入口 — ❌ 未实现

> [复核:确认] 独立验证：python 枚举 `contributes.menus` 共 8 类（view/title、editor/context、gode.editorContext、commandPalette、scm/title、terminal/context、explorer/context、editor/title/context），无 `editor/title`；`grep createWebviewPanel|viewType` 于 `src e2e test` 零命中，`editor/title` 全仓仅命中本报告自身与 package.json:296（context 变体）。结论维持。

- `package.json` 菜单贡献只有 `editor/title/context`（标签页右键，`gode.addFileToContext`，package.json:296-301）与 `editor/context` 子菜单（package.json:231-237）。
- 没有 `editor/title` 图标按钮贡献（无「编辑器右上角打开会话」入口）；也无「仅有文件打开时」的 when 条件。
- 全仓搜索 `createWebviewPanel|New Tab|New Window` 在 `apps/zcode-vscode/src` 零命中。

### 3) 状态栏状态区 — 🟡 部分实现（枚举不一致）

> [复核:确认] 独立读 statusBar.ts 全文：六态枚举（:11-17）、`crashed` 红色 `editorError.foreground`（:32）、`command = gode.openChat`（:45）、审批角标拼接（:66-68）逐行属实；`grep workStatus|thinking|awaitingInput|查看详情` 于 `src` 仅 oneShotText.ts 一处无关 thinking 注释，扩展 host 层确无细粒度工作状态投影、无「查看详情」专用动作。

实现位置：扩展原生 `src/ui/statusBar.ts`。

- 实际状态枚举（statusBar.ts:11-17）：`inactive | starting | ready | busy | crashed | restarting` 六态；与 PRD 七态「空闲/思考中/读文件/写代码/等输入/运行命令/出错」不对齐——无「思考中/读文件/写代码/等输入/运行命令」这类细粒度（这些细分信息 webview 侧有工作状态胶囊「工作中 {时长}」等，见 ConversationTurnGroup.tsx:665-683，但不投影到 VS Code 状态栏）。
- 出错红色 ✅：`crashed` 用 `ThemeColor("editorError.foreground")`（statusBar.ts:29-33）。
- 可点击「查看详情」🟡：状态栏项 `command = gode.openChat`（statusBar.ts:45），点击打开对话面板；无错误详情专用动作。
- 附加：待审批角标 `⚠ n`（statusBar.ts:66，数据源 `reportPendingApprovals` platform 方法，container.ts:739-747）。

### 4) 命令面板命令齐全度 — 🟡 部分实现

> [复核:修正→部分修正] ① 命令总数：python 实测 `contributes.commands` 为 **30 条**（报告写 31），小误差不影响结论。② 「缺失 8 条」中 **「Insert @-Mention」并非完全缺失**：`gode.addToContext`（title「加入对话上下文」，keybinding `ctrl+alt+a` when `editorHasSelection`，editorCommands.ts:109-141）push `composer-insert` 帧（含当前文件/选区 `mention.markdown` + `mentions` 数组）并 `executeCommand("gode.openChat")`，与 PRD「Insert @-Mention：插入当前文件与选区的引用」「Alt+K 插入 @ 引用」语义等价——缺的是命令名与 Alt+K 键位，不是能力。其余 7 条（Open in New Tab / New Window / Sidebar、Open Agent Manager、Focus Input、Reopen Closed Session、Set Background）经语义关键词过滤逐一核对确无对应命令。③ 陈旧 view id：view/title 五条 when 全为 `view == code.chat`，`CHAT_VIEW_ID = "gode.chat"`（chatPanel.ts:15），属实。

PRD 24.1 命令总表（PRD 行 1128-1144）要求 12 条，扩展 `contributes.commands` 共 31 条（package.json:46-201）：

- 已覆盖（语义对应）：`gode.newSession`（New Conversation）、`gode.openMcpSettings`（Manage MCP Servers）、`gode.writeTests`（Generate Tests）、`gode.reviewChanges`（Review Code）、`gode.openChat`（打开对话，但 PRD 的 Focus Input 语义是聚焦输入框）。
- PRD 24.1 缺失 8 条：`Open in New Tab`、`Open in New Window`、`Open in Sidebar`、`Open Agent Manager`、`Focus Input`（聚焦输入框）、`Reopen Closed Session`、`Insert @-Mention`、`Set Background`——全部未在 `contributes.commands` 声明。
- 额外存在 PRD 未列的扩展自有命令：onboarding / showLogs / checkBundleSize / switchWorkspace / sendDiagnostics / openInstructions / openSessionParams / importClaudeSessions / showSubagents / openUsage / quickEdit / sendTerminalSelection / generateCommitMessage / pickSession / codeAction / addRangeToChat / fixDiagnostics / explainSelection / fixSelection / refactorSelection / addToContext / showEditorLogs / stop / addFileToContext 等。
- 顺带发现的缺陷：`menus.view/title` 的 when 全部写 `view == code.chat`（package.json:207-228），而实际视图 id 是 `gode.chat`（`src/ui/chatPanel.ts:15`），陈旧 id 引用导致新建会话/历史会话/停止等 view/title 菜单项不会显示。

### 5) 快捷键 Ctrl+Alt+I 打开并聚焦聊天输入框 — ❌ 未实现

> [复核:确认] 独立验证：python 枚举 `contributes.keybindings` 全量仅 2 条（`ctrl+alt+k` quickEdit、`ctrl+alt+a` addToContext），无 ctrl+alt+i；`gode.openChat` 注册体仅 `deps.chatPanel.reveal()`（hostCommands.ts:98）→ `view.show(true)`（chatPanel.ts:52-54）；webview 侧 `requestComposerFocus`（ConversationComposer.tsx:1073）仅组件内部使用，无宿主→webview 的聚焦帧（index.tsx/App.tsx 无 focus 帧消费）。链路断裂属实。

- `package.json:385-398` keybindings 仅两条：`ctrl+alt+k`（quickEdit）、`ctrl+alt+a`（addToContext）；无 `ctrl+alt+i`。
- `gode.openChat` 的 `reveal()` 只 `view.show(true)`（chatPanel.ts:52-54），且未注册任何 keybinding；webview 内部有 `requestComposerFocus`（packages/ui/src/v4/ConversationComposer.tsx:1073）但没有跨过扩展命令面的「聚焦输入框」链路。

### 6) 面板可停靠三形态 + 同会话互通 + 位置记忆 + Open in New Tab/New Window — ❌ 未实现（仅侧栏单一形态）

> [复核:确认] 独立验证：chatPanel.ts:4 注释明言「插件原生形态（唯一形态）」；`grep workspaceState|globalState` 于 `src` 仅 store.ts（按 folder 键存会话 ID，store.ts:19-41）与 container.ts deviceId（:489-492），无任何布局/形态持久化；`registerWebviewViewProvider` 仅侧栏一处（extension.ts:31），attachWebview 单 id（hostRuntime.ts:120）。三形态、位置记忆、多实例互通均未实现，结论维持。

- 视图只注册在 activitybar 容器（package.json:29-44）；没有 Open in New Tab / Open in New Window / Open in Sidebar 命令（见条目 4）。
- `ChatPanel` 是单实例单视图：`this.view: WebviewView | null`（chatPanel.ts:19），`resolveWebviewView` 直接整体重绑（chatPanel.ts:28-48）；hostRuntime 的连接表按固定 id `gode.chat` 注册（`src/host/hostRuntime.ts:120-148` attachWebview），没有多 webview 实例并存 / 同会话数据互通的方案。
- 位置记忆：无扩展侧实现（无 workspaceState/memento 读写）；仅依赖 VS Code 原生视图布局持久化，且 PRD 的「拖到右侧栏/编辑器标签页」显式命令与记忆语义均未落地。

### 7) Cmd/Ctrl+Esc 编辑器与聊天间切换焦点 — ❌ 未实现

> [复核:确认] 独立验证：keybindings 全量 2 条（见条目 5）无 Esc 绑定；`grep Escape` 于 `src` 仅 quickEdit.ts:56 的 QuickInput 提示文案（「Esc 取消」），无任何编辑器↔聊天焦点切换逻辑。结论维持。

- keybindings 无该键（package.json:385-398）；扩展源码无 Escape 焦点切换逻辑。
- 现有 Esc 语义均为面板内行为：停止生成（`packages/ui/src/v4/composer/escapeStop.ts:8-34`、发送按钮 tooltip `shortcut="Esc"` ConversationComposer.tsx:2358）、关闭斜杠/mention 面板（`packages/ui/src/mentions/MentionPlugin.tsx:678-690`）。

### 8) 未配置模型时引导态（输入框禁用但历史可看）— 🟡 部分实现

> [复核:确认] 独立读 useDraftModelReadinessGate.ts：`enabled = sessionId === null && isZCodeAgentProvider(displayProvider)`（:52）、`ensureReadyForSend` missing 时返回 false 拒发（:133-157）、`agentStartupAllowed` 拦启动（:175-182）属实；composer textarea `disabled={disabled || mode === "reject"}`（ConversationComposer.tsx:2589）不受模型门禁置 true，仅 submitDisabled 拦截；`model_config_missing` 门（chatPrepareError.ts:9、ChatErrorBanner.tsx:58）属实。welcomePage.ts 为 CLI 未找到引导（:3,:20,:24）与 onboarding.ts 为 Claude 导入引导（:38-46）均独立核实。

- 共享层有无模型门禁：`packages/ui/src/v4/composer/useDraftModelReadinessGate.ts:29-33`（registry 无任何 provider/model → `missing`）、`:133-157`（首发 admission `ensureReadyForSend` 返回 false 拒发）、`:175-182`（`agentStartupAllowed=false` 阻止启动 Agent）。
- 引导横幅 ✅：错误 code `model_config_missing` → `ChatErrorBanner` 渲染「设置模型」跳转按钮（`packages/ui/src/ChatErrorBanner.tsx:164,244-255`，文案源 `src/lib/chatPrepareError.ts:15-22`），对应 PRD「提示去配置供应商（跳转 FR-05）」。
- 「输入框禁用」🟡：门禁只拒绝发送与启动，composer 的 `disabled` 不因无模型置 true（ConversationComposer.tsx:2589 仅 `disabled || mode === "reject"`）；「历史可看」✅ 成立——gate 仅对草稿态（`sessionId === null`，useDraftModelReadinessGate.ts:52）生效。
- 任务提示指向的两个文件与该条目不对应：`src/ui/welcomePage.ts` 是 **CLI 未找到**引导（`presentCliMissing` welcomePage.ts:221-226 + 3 步上手卡 :38-62）；`src/webview-react/import/onboarding.ts` 是 **Claude 会话导入**引导（:38-84 引导文案与门控）。两者均非「未配置模型」引导。

### 9) Webview 被回收后重开恢复会话与滚动位置 — 🟡 部分实现

> [复核:确认] 独立验证：`webviewOptions: { retainContextWhenHidden: true }`（extension.ts:31-33）与 data-session-id bootstrap（chatPanel.ts:66-89）属实；滚动记忆为模块级 `new Map`（chatSessionScrollMemory.ts:13，200 条 LRU :29-38），换词重搜确认无任何持久化层——无 `vscode.setState/getState`、无 localStorage/persist（ConversationTimeline.tsx、SessionPane.tsx 中 scrollMemory 消费亦无），webview 销毁重建即清零，PRD「跨回收恢复滚动位置附近」不成立，结论维持。

- 会话恢复 ✅：`extension.ts:31-33` 注册时 `webviewOptions: { retainContextWhenHidden: true }`（隐藏不销毁）；webview 重建时经 bootstrap `data-session-id` 注入 per-folder 最近会话（chatPanel.ts:66-89；解析链 `runtimeController.activeSession(folder) ?? workspaceSessions.get(folderKey(folder))`，container.ts:318-327），恢复失败有 session-switch null 纠正帧（container.ts:269-277），恢复编排 `runtimeController.restoreWorkspaceSessions()`（container.ts:397）。
- 滚动位置 🟡：滚动记忆 `packages/ui/src/lib/chatSessionScrollMemory.ts:13` 是模块内存 `Map`（200 条上限 :29），同一 webview 生命周期内的会话/面板切换可恢复（ConversationTimeline.tsx:1208、1421、224-244 容差恢复），但 webview 被销毁重建后该 Map 清零——PRD「恢复到回收前的滚动位置附近」跨回收不成立。

---

## FR-02 聊天输入框与消息流（PRD 第 8 章）

### 10) 多行自适应高度、Enter 发送/Shift+Enter 换行、发送键可配置 — ✅ 已实现

- 自适应高度：`packages/ui/src/LexicalChatInput.tsx:1575` `min-h-10 max-h-40 overflow-y-auto`（内容增高至 10rem 后内部滚动）。
- Enter/Shift+Enter：LexicalChatInput.tsx:542-687 键盘行为插件（Enter 发送、Shift+Enter 及未启用反转投递的 Ctrl/Meta+Enter 换行 :660-663）。
- 发送键可配置：`packages/ui/src/shortcuts/composerShortcuts.ts:28-53`——`composerSend` 可改绑为任意键（如 Ctrl+Enter/F9），改绑后裸 Enter 回退换行（:51-53）；LexicalChatInput.tsx:565-646 消费生效绑定表。

### 11) 占位文案显示当前模式名与发送快捷键 — ❌ 未实现

> [复核:确认] 独立读 chatPlaceholder.ts 全文（按 hasHistoryMessages/isTaskProcessing/compactNewTask 三态静态选 key）+ zh-CN.ts:4980-4983 与 en-US.ts:5316-5320 词条原文：均为纯静态文案，`grep placeholder.*(mode|Enter|shortcut)` 全库仅命中无关组件（PermissionDialog/设置表单等）。模式名与快捷键插值确不存在，结论维持。

- 占位文案是静态 i18n 文案，按会话状态三选一（`packages/ui/src/lib/chatPlaceholder.ts:20-25`）：`zh-CN.ts:4980-4983`「向 ZCodium 提问，使用 @ 添加上下文，使用 / 选择命令或能力」/「向 ZCodium 提问…」/「提出后续修改要求」/「继续输入以排队后续修改」——既无当前模式名（Agent/Plan…）插值，也无发送快捷键（PRD 示例「在 Agent 模式下提问，Enter 发送」）。
- 发送快捷键只出现在发送按钮 tooltip（ConversationComposer.tsx:1889-1902 `resolvedSendTooltipShortcut`），不在 placeholder。

### 12) 粘贴图片转附件、拖文件转附件、附件芯片可预览可删除 — ✅ 已实现

- 粘贴：`packages/ui/src/v4/composer/useComposerAttachments.ts:848-869`（clipboardData.files → `addAttachmentFiles`；电子表格文本优先的分流 :854-855）。
- 拖入：useComposerAttachments.ts:937-953（dragover 反馈与 `hasLocalResourceDropSignal`）、:974-994 `handleDropComposer`（dataTransfer.files → 附件；资源管理器文件拖入另走 `resolveFileDropPaths` platform 方法，container.ts:708）。
- 芯片删除：ConversationComposer.tsx:2051-2053 `onRemove → attachmentsApi.removeAttachment`。
- 芯片预览：ConversationComposer.tsx:2058-2079 图片/视频进 gallery（`composerMediaPreviewItems` :1930-1945 + `ImagePreviewDialog` :83/:2661）、PDF 走 PdfViewer；普通文件显示类型图标。

### 13) 发送中按钮变下拉（Add to Queue / Steer with Message / Stop and Send）+ 队列上限 10 — ❌ 未实现（语义用其他形态承担，无下拉、无上限）

> [复核:确认] 独立验证：① `showStopControl` 分支渲染 SquareIcon 停止按钮（ConversationComposer.tsx:2357-2374），`grep DropdownMenu` 于 composer 零命中，生成中确无下拉；② 换词追踪 `chat.followup.addToQueue` 消费点——仅 followupModeSettings.ts:88 作为修饰键（⌘/Ctrl+Enter）tooltip 标题，非菜单项，佐证「排队/转向语义以设置默认+修饰键取反承担」的表述；③ 队列上限 10：换词 `queue.*limit|MAX_QUEUE|maxQueued|队列.{0,6}上限` 于 ui/shared/cli 三层零命中，精读 steering.ts（仅 `MAX_TURN_STEER_INPUT_BYTES` 字节限 :83/:239，queueLength 只做位置上报 :127/:168/:262）与 PROTOCOL_V4_LIMITS（core.ts:64-110 无条数项）属实。

- 发送中按钮 ✅ 会切换，但 ❌ 不是下拉：`showStopControl ? <Stop 图标按钮> : <发送按钮>`（ConversationComposer.tsx:2357-2393），无 DropdownMenu，无 PRD 三动作项。
- 排队/转向语义存在但形态不同：协议层 `inputRouting.mode = startNow|enqueue|guide|reject|choice`（`packages/shared/src/zcode-protocol-v4/snapshot.ts:171`）；产品层 followupMode `guide|queue`（`packages/ui/src/v4/composer/followupModeSettings.ts:4-16`）+ Ctrl/Cmd+Enter 反向投递（ConversationComposer.tsx:1698-1714 `resolveOppositeFollowupDelivery`）——即「设置决定 busy 输入默认走排队还是引导，修饰键取反」；held 队列确认框提供 `clearQueueAndSend/keepQueueAndSend`（ConversationComposer.tsx:1716-1732、shared snapshot.ts:169-171）。CLI 侧 steer 语义在 `apps/zcode-cli/packages/core/src/runtime/types.ts:551-556`（`delivery: steer_active_turn`、`queueDelivery: guide|queue`，附件或不可 steer 时回退 queue）。
- 队列面板 ✅（可拖拽排序/编辑撤回/删除/立即发送）：`packages/ui/src/v4/ConversationQueuePanel.tsx:382-405` dnd-kit 拖拽 + `resolveV4QueueReorderAnchor`（:57-88）；编辑撤回到发起端 composer（:39-40，权威删除成功后才恢复草稿）；删除/立即发送（:243-289）。渲染位置在 composer 之上（SessionPane.tsx:5094-5108）。
- 队列上限 10 ❌：未找到任何队列条数上限。已搜：CLI 准入 `enqueueDeferredInput`（apps/zcode-cli/packages/core/src/runtime/methods/steering.ts:222 起，仅 empty_input/input_too_large 校验）、v4 输入准入 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/input-admission.ts`（无条数门）、协议限额表 `packages/shared/src/zcode-protocol-v4/core.ts:64-110`（PROTOCOL_V4_LIMITS 无队列条数项）、UI 全库 `queueFull|maxQueue|队列上限` 零命中。也无「超出提示先处理队列」文案。

### 14) Stop 保留已产出文本并标注「已停止」— ✅ 已实现

- Stop：`onStop`（ConversationComposer.tsx:1734-1736）；停止后队列保留（zh-CN.ts:6259「仅停止当前这一轮生成，队列中的后续消息会保留」）。
- 「已停止」标注：本轮 workStatus `state === "interrupted"` 时渲染 i18n `chat.history.stopped` =「已停止」（`packages/ui/src/v4/ConversationTurnGroup.tsx:674-678`；文案 `packages/ui/src/i18n/locales/zh-CN.ts:5047`）；正文行保留 interrupted 态文本（ConversationRowView.tsx:1949）。

### 15) Continue 续跑 — 🟡 部分实现（语义偏差）

> [复核:确认] 独立读 composerContinueAction.ts 与 ConversationComposer.tsx:1753-1800、2461-2476：`buildComposerContinueText` 空格拼接后走同一 `submit()` 通路、失败回滚（:1794-1798）、按钮常驻仅 `disabled={!continueCanSend}`（:2472）属实——不是「原模型原模式恢复被打断的 turn」，显隐条件「输入框为空时才出现」未实现。i18n `chat.composer.continue.text = "继续"`（zh-CN.ts:6337）亦核实。

- 继续按钮存在：ConversationComposer.tsx:2461-2476（`v4-composer-continue-button`）+ 决策逻辑 `packages/ui/src/v4/composer/composerContinueAction.ts`。
- 偏差：实现是「把合成的『继续』文案按空格追加到草稿，走与发送完全相同的 submit 通路」（composerContinueAction.ts:5-12；ConversationComposer.tsx:1764-1794），不是 PRD 的「用原模型、原模式续跑被打断的那一轮」的原 turn 恢复；门禁/失败回滚完备（composerContinueAction.ts:35-63），但「输入框为空时才出现」的显隐条件未实现（按钮常驻，仅按 pending/门禁 disable）。

### 16) 斜杠命令菜单与内置命令 — 🟡 部分实现

> [复核:确认] 独立验证：① 循环 grep 8 个 PRD 命令名（usage/docstring/improve/explain/review/fix/clear/test）于 `apps/zcode-cli/packages/*/src` + `packages/shared/src` 全零命中；② slash-command-surface.ts:8-13 `APP_PROTOCOL_VISIBLE_BUILTIN_SLASH_COMMAND_NAMES = ["goal","workflow","compact","init"]` 原文核实；③ `packages/shared/src/zcode-slash-command-help.ts` name 逐项 = help/login/logout/compact/init/expert/effort/dwf/fork/locale/mcp/plugins/mode/model/new/resume/rewind/skill/goal/workflow（20 条），无 8 命令；④ `/clear` 仅 CLI 终端侧 `rawName === "new" || rawName === "clear"` 别名（slash-commands.ts:160）；⑤ UI 策略注释「命令目录必须完整来自 CLI workspace slash catalog」（ConversationComposer.tsx:2621-2623）属实。

- 菜单与交互 ✅：分组面板 `packages/ui/src/slashCommandPanelSections.tsx:20-91`（commands / skills($ 前缀) / subagents 三组）；模糊搜索 `packages/ui/src/lib/slashCommands.ts:5-36`（`scoreFuzzyMatch`：前缀/子串/子序列加权）+ `filterSlashCommands`（:54-97）；方向键/Enter/Tab 选择、Esc 关闭（`packages/ui/src/mentions/MentionPlugin.tsx:620-700`，KEY_ARROW_DOWN/UP/ENTER/TAB/ESCAPE）。
- 内置命令 ❌ 大半缺失：聊天面板内置目录只有 `goal / workflow / compact / init`（`apps/zcode-cli/packages/bootstrap/src/slash-command-surface.ts:8-13`）；CLI 全量帮助表为 `help / login / logout / compact / init / expert / effort / dwf / fork / locale / mcp / plugins / mode / model / new / resume / rewind / skill / goal / workflow`（`packages/shared/src/zcode-slash-command-help.ts:9-` 按 `name:` 逐项列举）。PRD 要求的 `/clear /usage /test /review /explain /improve /docstring /fix`：`/clear` 仅存在于 CLI 终端侧作为 `/new` 别名（`apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts:160`），不在聊天面板目录；其余 7 个均无。UI 侧明确「命令目录必须完整来自 CLI workspace slash catalog；不再追加任何内建命令或别名」（ConversationComposer.tsx:2621-2626）。测试/审查类能力以编辑器命令形态存在（`gode.writeTests`/`gode.reviewChanges`，src/features/editorCommands.ts:175/:232），非斜杠命令。

### 17) `!` 前缀直接执行终端命令不经模型 — ❌ 未实现

> [复核:确认] 换词重搜：`startsWith("!")|charAt(0) === "!"|exclam|shellEscape|execPrefix|commandPrefix|runInTerminal` 于 packages/ui/src、apps/zcode-vscode/src、apps/zcode-cli/packages/{bootstrap,cli,core}/src 仅命中 `!!` 布尔转换与无关的「Command prefix」权限 i18n；CLI command-center 入口判定 `if (!input.startsWith("/")) return null`（slash-commands.ts:41），无 bang 分支；「退出码回显」类消息类型仅存在 workflow 脚本状态（zh-CN.ts:6085）与浏览器崩溃详情（:1238），非 `!` 命令回显。结论维持。

- 全仓搜索 `startsWith("!")`、`bang`、`shellPrefix`、`bashMode`：`packages/ui/src`、`apps/zcode-cli/packages/{bootstrap,cli,core}/src` 零命中（唯一 `!` 是附件上传失败图标，ConversationComposer.tsx:2164）。无「直接执行终端命令、输出与退出码回显消息流、不计模型用量」的消息类型或命令路径。

### 18) 图片附件上限 5 张提示、语音输入 — 🟡 部分（上限口径不同）+ ❌（语音）

> [复核:确认+补充证据] ① 上限：`MAX_CHAT_ATTACHMENTS = 8`（chatAttachments.ts:37）实测；`addPreparedAttachments` 以 `MAX_CHAT_ATTACHMENTS - current.length` 计剩余槽、溢出 revoke + toast（useComposerAttachments.ts:715-731），按全部附件计数属实；`grep maxImage|image.*limit|图片上限` 零命中，无图片单独口径。② 语音：换词 `microphone|MediaRecorder|getUserMedia|whisper|asr|录音` 重搜——补充一处原报告漏看的文件：`packages/ui/src/components/ai-elements/mic-selector.tsx`（麦克风设备枚举/选择器，:43-129 getUserMedia audioinput），但全库无消费方（死组件）且无 MediaRecorder/转写链路、zh-CN 无「语音」词条，不构成语音输入能力，❌ 结论维持。

- 附件上限提示 ✅ 但口径不同：`MAX_CHAT_ATTACHMENTS = 8`（`packages/ui/src/lib/chatAttachments.ts:37`），按**全部附件**计数（含图片/视频/PDF/文本），超出部分丢弃并 toast（`useComposerAttachments.ts:702-715` `chat.attachments.maxFiles`，:717-731 截断逻辑）——不是 PRD 的「单条消息图片上限 5 张」。
- 回形针选取 ✅：附件菜单 + 隐藏 file input（ConversationComposer.tsx:1907-1915、2540-2547）。
- 语音输入 ❌：`packages/ui/src` 与 `apps/zcode-vscode/src` 全库搜索 `voice|语音|speech|dictation|transcri` 无实现（i18n 也无相关词条）。

### 19) 对话内图表渲染与生成图片内嵌 + Save — ✅ 已实现（图表按 Mermaid 口径）

- 对话内图表 ✅：Markdown 代码块中的 mermaid 由 `packages/ui/src/components/ai-elements/mermaid-block.tsx`（@streamdown/mermaid，:3,:36）渲染，支持放大/缩放预览（`code-block.tsx` 引用；i18n `codeBlock.mermaid.*` zh-CN.ts:1722-1733）。
- 生成图片内嵌 ✅：`packages/ui/src/components/ai-elements/message.tsx:1530` `MarkdownImage`（AI 元素 Image 组件）。
- Save ✅：预览对话框下载走 `platform.saveFile`（`image-preview-dialog.tsx:329-370`）；扩展侧落地为 VS Code 保存对话框 + 写盘（`apps/zcode-vscode/src/container.ts:647-682` saveFile，支持 dataB64/sourceUrl 双通道）。
- 备注：PRD「结构化图表数据」若指通用图表组件（`components/ui/chart.tsx` 存在），未见用于对话流；对话内图表以 Mermaid 为准。

### 20) Enhance Prompt 改写按钮 — ✅ 已实现

- `packages/ui/src/v4/composer/ComposerEnhanceButton.tsx:46-91`：`promptAssistService.enhancePromptDraft` → 结果回填草稿（:71 `replaceRef.current(result.text)`），不自动发送，由用户审阅；失败 toast 保留原文不清空（:79-87）；空草稿提示（:52-54）；短输入判 `unchanged` 不强行改写（:64-67）；Ctrl+/ 快捷键经 enhanceRunRef 注册（:93-98，ConversationComposer.tsx:1805-1809）。按钮位于 composer 左下控制簇（ConversationComposer.tsx:2453-2460）。

### 21) 消息流（Transcript）规格 — 🟡 大部分实现（代码块动作与重新生成缺失）

> [复核:确认] 独立验证：① 代码块「插入到光标」「应用为改动」：换词 `insert.*cursor|applyCode|应用到编辑器|editAtCursor` + zh-CN 全部 `codeBlock.*` 词条（:1722-1733 仅 mermaid/换行/复制）零命中，缺失属实；② 重新生成：`onRetry` 自 ConversationTurnGroup.tsx:872/1053/1264/1626 一路传透至 ConversationRowView（:251/:1496/:1664/:1755/:2303），但最终组件 `ConversationAssistantTextActions` JSX 仅渲染 Copy/赞/踩/分叉/HookDetails/时间/tok/s（:1583-1644 精读），无 retry 入口，「声明但未渲染」属实；③ 平滑追加：`typewriter|smooth|animate.*stream` 于 v4 仅命中滚动行为（ConversationTimeline.tsx:1213 贴底 instant、Navigator:196 smooth 滚动）与无关的 HighSpeedDiffusionCanvas smoothstep，无文本动画层；④ 默认折叠 `toolLayoutOpenState.get(...) ?? false`（ToolLayout.tsx:109）、following 滚动语义（timelineScrollAnchor.ts:4-9/:60-71）、hover 容器 `group/assistant-turn`（ConversationTurnGroup.tsx:1597）均逐行核实。

- 按角色区分样式 ✅：用户气泡 `ConversationUserInputBubble.tsx`、助手轮 `ConversationTurnGroup.tsx`、工具行 `ConversationAgentToolCallRow.tsx`/`ToolCallBlocks`、系统提示类行（ConversationRowView.tsx:1920 注释列举 system/retryNotice/checkpointRestored 分支）。
- 工具调用默认折叠 ✅：`packages/ui/src/ToolCallBlocks/ToolLayout.tsx:115-117` `useState(() => toolLayoutOpenState.get(...) ?? false)` 默认收起，摘要一行 + Collapsible 展开；edit/read 一次性 autoOpen（:157-166）、子代理完成自动收起（:168-177）。
- 代码块动作 🟡：复制 ✅（`components/ai-elements/code-block.tsx:448-502` `CodeBlockCopyButton`，`codeBlock.copyCode`=「复制代码」zh-CN.ts:1724）；「插入到光标」「应用为改动」❌——全仓无对应 i18n 文案与动作（zh-CN.ts:1722-1733 仅复制/换行/Mermaid 词条；搜索 `插入到光标|insertAtCursor|应用为改动|applyAsEdit` 零命中）。
- 流式平滑追加 🟡：流式行级增量经 v4 rows 投影渐进渲染（`unit.assistantTextRows` 等，ConversationTurnGroup.tsx:1382-1386），贴底跟随 instant（ConversationTimeline.tsx:1213）；但无独立的「平滑动画」文本层（搜索 smooth/typewriter/streamBuffer 无命中）。
- 上滚暂停自动滚动 ✅：`packages/ui/src/v4/timelineScrollAnchor.ts:4-8` following 语义（用户上滚离底 → following=false，流式增量不得拉回阅读位置；只有真实用户滚动输入能改变），:60-71 reconcile、:176-177 回到底部按钮；ConversationTimeline.tsx:886/929-932/1313/1393 消费（following 时 stickToBottom，否则 hold）。
- 助手消息悬停操作 🟡：hover 容器 `group/assistant-turn`（ConversationTurnGroup.tsx:1593-1597）；动作栏 `ConversationAssistantTextActions`（`packages/ui/src/v4/ConversationRowView.tsx:1466-1644`）= 复制（:1565-1569）+ 赞/踩反馈（:1600-1608）+ **分叉 fork**（:1611-1621，`forkAssistant`，`chat.message.fork`=「分叉」zh-CN.ts:4999）+ 时间。与 PRD 的对照：复制 ✅；「倒带」→ 实现为 fork 分叉（另有意文件级 rewind `ConversationFileRewindDialog.tsx` 与 CLI `/rewind` 命令，不在悬停动作栏）；「重新生成」❌——`onRetry` prop 被声明并传入（ConversationRowView.tsx:250-251、ConversationTurnGroup.tsx:1709 `canRetryLatestAssistant`），但组件体内从未渲染重试入口（ConversationRowView.tsx:250-251 注释明确「协议兼容：上层仍可提供 retryTurn capability，但产品 UI 不渲染普通重试入口」）；「仅最后一条」门控存在（`latestAssistantTextRow.actions.canRetry/canFork`，ConversationTurnGroup.tsx:1495-1496 附近计算 + :871-872 `item.latest &&` 传递）。

---

## 验收标准对照（PRD 7.5 / 8.8）

本次为静态代码核对，未在 VS Code 真机执行验收场景（无运行环境跑 `pnpm dev:desktop`/扩展宿主）；7.5 与 8.8 的行为级验收（五入口逐验、拖动重启、三动作逐验、`!` 回显、上滚不被拽回等）未执行，以上逐条结论均为源码证据推断，未做运行时验证。

## 主要搜索范围记录（用于「未实现」结论的可复核性）

- 角标：`grep -rn "badge|Badge" apps/zcode-vscode/src` → 仅 statusBar.ts。
- 编辑器标题/多面板：`grep -rn "createWebviewPanel|New Tab|New Window" apps/zcode-vscode/{src,package.json}` → 零命中。
- 快捷键：`package.json keybindings` 全量 + `grep -rn "Ctrl+Alt+I|Escape|keybinding" src/extension.ts src/module.ts src/commands/`。
- 队列上限 10：`grep -rn "MAX_QUEUE|queueLimit|队列上限|queueFull|maxQueueItems" packages/{shared,ui}/src apps/zcode-cli`（排除 dist/node_modules）+ 精读 `core/src/runtime/methods/steering.ts`、`bootstrap/src/zcode-protocol-v4/commands/input-admission.ts`、`shared/src/zcode-protocol-v4/core.ts`（PROTOCOL_V4_LIMITS）。
- `!` 前缀：`grep -rn "startsWith(\"!\")|bang|shellPrefix|bashMode" packages/ui/src apps/zcode-cli/packages/{bootstrap,cli,core}/src`。
- 语音：`grep -rni "voice|语音|speech|dictation|transcri" packages/ui/src apps/zcode-vscode/src`。
- 内置斜杠命令：`packages/shared/src/zcode-slash-command-help.ts` name 列举 + `bootstrap/src/slash-command-surface.ts` + `cli/src/command-center/slash-commands.ts`。
- 代码块插入/应用：`grep -rn "插入到|应用到|insertAtCursor|applyAsEdit|insertCode" packages/ui/src`（含 zh-CN 全量 codeBlock 词条）。

---

## 复核纪要（独立复核员，2026-11-07）

复核方法：对全部 16 条「未实现/部分实现/与 PRD 不符」结论，用复核员自己的关键词与文件范围独立重搜与精读（未照抄调查员搜索词），覆盖扩展壳（apps/zcode-vscode/src + package.json）、共享 UI（packages/ui/src）、CLI 运行时（apps/zcode-cli/packages/{bootstrap,cli,core}）与协议（packages/shared/src）四层；PRD 以第 7/8/24 章原文为准。

### 汇总

- 确认 14 条：#1 角标、#2 编辑器标题栏入口、#3 状态栏枚举、#5 Ctrl+Alt+I、#6 三形态、#7 Cmd+Esc、#8 无模型引导态、#9 回收恢复滚动、#11 占位文案、#13 下拉与队列上限、#15 Continue、#16 斜杠命令、#17 `!` 前缀、#21 代码块动作/重新生成/平滑追加。
- 修正 1 条：#4 命令齐全度（两处小修正，见下）。
- 补充证据但不改结论 1 条：#18 语音输入（原搜索漏看 mic-selector.tsx，核实为无消费方死组件，❌ 维持）。
- 存疑 0 条：所有负面结论均在复核员的独立搜索中复现，无跟风确认项。

### 修正明细

1. **#4 命令总数**：报告写「contributes.commands 共 31 条」，python 实测为 **30 条**（报告或含基线漂移；不影响缺失结论）。
2. **#4「Insert @-Mention」缺失定性**：`gode.addToContext`（「加入对话上下文」，ctrl+alt+a，editorCommands.ts:109-141）push `composer-insert` 帧（含 mention.markdown + mentions 数组）后打开聊天，是 PRD「Insert @-Mention / Alt+K 插入 @ 引用」的**语义等价物**。PRD 24.1 实际缺失为 **7 条**（Open in New Tab / New Window / Sidebar、Open Agent Manager、Focus Input、Reopen Closed Session、Set Background）+ 1 条「名称与键位不符」（Insert @-Mention ↔ addToContext，Alt+K 未绑定）。其余 7 条缺失经语义关键词过滤逐一核实成立。

### 复核中额外核实的正面锚点（抽样）

- `gode.openChat` → `chatPanel.reveal()` → `view.show(true)`，无 composer 聚焦帧（hostCommands.ts:98、chatPanel.ts:52-54）。
- 滚动记忆无持久化层：无 vscode.setState/getState、无 localStorage（chatSessionScrollMemory.ts 为模块内存 Map）。
- PROTOCOL_V4_LIMITS（packages/shared/src/zcode-protocol-v4/core.ts:64-110）与 CLI steering.ts 准入均无队列条数上限。
- onRetry prop 全链路传透但 ConversationAssistantTextActions JSX（ConversationRowView.tsx:1583-1644）无重试渲染。

### 复核未做事项

- 未做运行时/真机验收（同原报告声明：7.5 / 8.8 行为级验收未执行，全部结论为静态源码证据推断）。
- PRD 24.2 快捷键总表的逐条全量审计不在本次报告条目范围内，仅复核了报告点名的 Ctrl+Alt+I 与 Cmd+Esc。
