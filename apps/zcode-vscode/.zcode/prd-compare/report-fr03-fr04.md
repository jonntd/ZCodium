# FR-03 上下文系统 / FR-04 模式系统 核对报告（深度调查，含 file:line 证据）

> 总体结论：该仓库是 fork 自有品牌（命令 `gode.*`、指令文件 `GODE.md`、全局目录 `~/.zcodium`）。FR-03/FR-04 的 PRD 设想（6 档模式枚举、上下文条、索引、#引用）与现状差异很大：现状是一套 Claude Code 风格的「协作模式 + mention pill + 弹窗审批」体系。FR-04 的 6 档枚举整体不存在；FR-03 有相当多「PRD 降级口径」的明确注释（源码自认未做）。

## FR-03 上下文系统

### 1. 隐式上下文 — 部分实现（能力在，发送链路断线）
- 收集器齐备：`apps/zcode-vscode/src/features/contextCollector.ts:37-123`（`contextFromSelection`/`contextFromActiveFile`/`contextFromDiagnostics`，诊断 chip label 即「诊断 N 条」）。
- 但组装链 `buildPrompt`（同文件 :361-420，含 `<context>` 块、autoContext、includeActiveFile/includeDiagnostics）在扩展内**无任何调用点**（全仓 grep 仅定义处）——自动上下文实际不生效。`gode.autoContext` 设置存在（package.json contributes、`features/featureConfig.ts:58`），`buildAutoContext` 同样无消费者。
- 实际生效路径是显式命令：`features/editorCommands.ts:236-255`（`gode.addToContext`：选区或活动文件 + 诊断两枚 mention 预填）；诊断另有 `gode.sendDiagnostics` → host 帧 → `webview-react/index.tsx:200-222` `buildDiagnosticsInjection`（`composer/injection.ts:78-90`，两档过滤）。
- 「一行摘要上下文条（可点开明细）」不存在；诊断/终端/git diff 以注入文本或 mention pill 呈现。ui 侧 `packages/ui/src/v4/composer/ComposerContextMeter.tsx` 是会话上下文窗口占用环，不是输入芯片摘要。

### 2. 显式上下文条常驻输入框上方 — 部分实现
- ui 侧有 chip 行：`packages/ui/src/v4/ConversationComposer.tsx:2261-2294`（CodeComment/WebElement/PptxElement/ConversationSelectionReference 四类 chip），共用外壳 `v4/composer/ContextAttachmentPill.tsx`（hover 详情浮层 + 叉号移除）——满足「悬停、点击、移除」交互，但 chip 类型只有这四种特化场景，不是通用上下文条。
- 「默认含整个工作区 + 当前文件」：无此默认。
- 文件类 mention pill（`packages/ui/src/mentions/nodes/PromptMentionNode.ts`）是 Lexical token（`@name` 展示 :38-43），**无 hover 预览/叉号**，只能退格删除。
- 扩展自有 `apps/zcode-vscode/src/webview-react/composer/selectionChip.tsx`（选区 chip，:115-170）与 `mentionSource.ts` 已写好但**未在任何页面挂载**（grep 无 import 方）。

### 3. 可添加类型 — 部分实现
- 文件/文件夹：`gode.addFileToContext`（`editorCommands.ts:281-300` → `editorContextFiles.ts:60-64` `contextFromUri`）。
- 选区：`contextFromSelection`（含行范围 pill）。
- 图片：附件系统支持粘贴截图/拖拽（`packages/ui/src/v4/composer/attachmentUpload.ts:1-9` dataBase64/localPath 分派），随 v4 sendText attachments 发送。
- 另有 git diff（`features/git.ts:113-119`）、终端选区（`features/terminal.ts:30-34`）。
- 缺失：外部文档、网页抓取结果（CLI 有 WebFetch 工具但无上下文条类型）；「其他仓库 Workspace Context」仅以设置项存在（`gode.context.additionalDirectories`，`config.ts:35` → `runtimeController.ts:102,118` 传给 CLI additionalDirectories），不是上下文芯片。

### 4. 芯片 Token 估算 / 80% 警告 / 发送校验裁剪 — 未实现
- 无任何芯片级 token 估算；无 80% 变色；无发送时校验/裁剪提示。`packages/ui/src/v4/composer/turnStats.ts:16` 的 `estimateTokens` 只用于轮次统计；`ComposerContextMeter.tsx` 展示的是会话 contextWindow 占用（`usage.contextWindow`），无 80% 阈值告警逻辑。

### 5. `@` 引用 — 部分实现
- @file 模糊搜索：`packages/ui/src/mentions/MentionPlugin.tsx`（`@` 触发）+ `mentions/mentionSearch.ts`（fuzzy 打分、CJK 子串特判）+ `mentions/providers/fileMentionProvider.ts`；数据面 `IFileService.searchWorkspaceFiles`（`packages/services/src/file/fileService.ts:589`）。
- 行范围：支持以选区生成 `@name 12-40` pill（`pendingContext.ts:34-42` startLine/endLine、`PromptMentionNode.ts:38-43`），但**无 `@文件#起止行` 语法解析**。
- @terminal / @workspace（全库检索）：无。扩展侧 `apps/zcode-vscode/src/webview-react/composer/mentionSource.ts:8-10` 明注：「@symbol、代码库索引：明确不做（PRD P1-4.3 降级口径）」；`composer/injection.ts:10` 同。

### 6. `#` 引用 — 未实现（PRD 口径）
- `packages/ui/src/mentions/MentionPlugin.tsx:169-174`：`#` 触发的是 **sessions** 提及、`$` 是 skills，`@` 才是文件。#file/#folder/#codebase/#selection/#terminalSelection/#terminalLastCommand/#fetch 均不存在。近似替代是命令：`gode.sendTerminalSelection`（terminal.ts）、`gode.addToContext`。

### 7. 编辑器聚焦 Alt+K — 部分（键位与行为都不同）
- `package.json` keybindings：`ctrl+alt+k`（mac `cmd+alt+k`）→ `gode.quickEdit`（改写选中代码，不是插入 @ 引用）；`ctrl/cmd+alt+a` → `gode.addToContext`（功能接近「带文件/选区进对话」但非 Option+K）。

### 8. 索引状态 — 未实现
- 全仓库无 codebase 索引/四种状态/重试按钮/进度重放；`sessionsIndexBridge.ts`、`session/workspaceSessions.ts` 是会话索引（session list），与代码索引无关。
- `.aiignore`：无（grep 全仓无命中）。文件搜索用的是 `.zcodeignore`（`packages/services/src/file/fileService.ts:206,275`），且只作用于文件树/搜索。
- 大文件：`editorContextFiles.ts:6,17-23` 超过 **256KB** 只给路径 chip「（过大，仅路径）」，是截断策略，不是「>200KB 只带符号大纲」（无符号大纲能力，`mentionSource.ts:10` 自认协议/运行时无符号索引）。

### 9. 项目规则文件 — 部分实现
- AGENTS.md 自动加载（CLI 运行时）：`apps/zcode-cli/packages/adapters/src/context/index.ts:24`（`DEFAULT_PRIORITY_FILES = ["AGENTS.md"]`）、:204-227（自 cwd 逐级向上查找）、:229-243（全局 `~/.zcodium/AGENTS.md`）；bootstrap 默认启用（`bootstrap/src/app/runtime-config.ts:63,143-145`）；注入系统提示 `# agentsMd`（`core/src/context/sections/request-user-context.ts:44-76`），缺失时给「自行探测构建命令」兜底（:50-55）。
- CLAUDE.md：仅扩展设置页「一次性导入」（`apps/zcode-vscode/src/container.ts:835-862`，每 folder 读 `GODE.md`/`CLAUDE.md`，**GODE.md 优先、命中即止**）→ 写入 customSystemPrompt 设置；非运行时自动合并。`.clinerules`：无任何支持。
- 冲突提示/优先级说明：无。
- 设置页可查看编辑：`apps/zcode-vscode/src/webview-react/settings/WorkspaceInstructionsPanel.tsx` 编辑的是**设置里的 customSystemPrompt/customSystemSegments**（非 AGENTS.md 文件），且注释明示「改动随下次会话生效」——不满足「对新消息立即生效」。

## FR-04 模式系统

### 10. 6 档模式 — 未实现（枚举不符）
- 实际枚举：`apps/zcode-cli/packages/contracts/src/interfaces/session.port.ts:32` `CollaborationMode = "plan" | "build" | "edit" | "yolo" | "guarded" | "auto"`。
- UI 目录（4+1）：`packages/shared/src/zcode-agent-model-state.ts:19-45`——build「Ask before changes」/ guarded「Autonomous mode（Ask when there's risk）」/ plan「Plan mode」/ yolo「Full access」+ 隐藏遗留 edit。
- `auto` 在权限服务被显式拒绝："Auto mode is reserved but not implemented yet"（`apps/zcode-cli/packages/core/src/permission/service.ts:157-163`，及 :367-371）。
- 权限映射（现实体系）：build 只读直通 + criticalRisk ask（service.ts:494-505 `checkBuildMode`）；plan 只读 + 方案审批（:452-488 `checkPlanMode`，含 plan 分支优先于 Guarded 注释 :136-137）；guarded 风险才弹审批（:138-147）；yolo 直通（:155-157）。**ask/debug/quickAsk 不存在**（quickAsk 全仓 0 命中）。

### 11. 切换入口唯一 + 默认模式可配置 — 部分实现
- 入口不唯一：composer 工具条模式选择器（`packages/ui/src/v4/composer/V4ComposerModeControls.tsx`，plan 为独立勾选、三种权限单选）之外，会话头部 `apps/zcode-vscode/src/webview-react/header/modelSelect.tsx:31` 也提供 `switchCollaborationMode`（值域 build/edit/plan/yolo/guarded，CAS 即时生效）；CLI 模型还能经 `EnterPlanMode` 工具自行切模式（`core/tool/handlers/plan-mode.ts:130`）。
- 默认模式：`gode.mode` 设置存在（package.json，default "build"）但其 markdownDescription 自述「侧栏对话区草稿会话走 v4 createSession（模式在会话头部切换），**不读取本设置**」；新任务草稿默认硬编码 "build"（`packages/ui/src/v4/composer/newTaskDraft.ts:26`）。默认模式实际不可配置。

### 12. 只读模式工具「不可见」 — 未实现
- plan 模式下非只读工具走权限 **deny**（"mode.plan.nonReadOnly"，`permission/service.ts:482-488`），是报错/拒绝而非从工具列表隐藏；`getTools` 无按模式过滤（`core/src/runtime/methods/config.ts:169-183`，仅按 model/tool-search 过滤）。

### 13. 模式切换只影响下一轮 — 部分实现（两路行为不一致）
- 满足的一半：composer 模式选择器「只编辑草稿，不向 Runtime 发切换命令」（`V4ComposerModeControls.tsx:44`），提交瞬间冻结执行配置（`v4/composer/composerSubmissionConfig.ts:22`「在点击提交的瞬间…冻结成本次 Submission 的执行配置」）。
- 不满足的一半：会话头部 `switchCollaborationMode` 即时生效，且协议层明确「旧协议路径无 active turn guard（运行中也允许切换）」（`bootstrap/src/zcode-protocol-v4/commands/handlers/model-config.ts:74`），权限门实时读 `getMode()` → 进行中的一轮会被中途换模式。

### 14. Plan 模式 — 部分实现
- 已实现：EnterPlanMode/ExitPlanMode 工具（`core/tool/handlers/plan-mode.ts:107-190`）、只读策略（`permission/plan-mode-policy.ts` + `service.ts:452-488`）、方案审批弹窗：`bootstrap/src/zcode-protocol/interaction-broker.ts:433-457`——approve=确认并执行、freeText=计划反馈（`plan_approval_feedback` deny 回传模型，可反复修改重出方案）。
- 未实现/相反：方案不在编辑器标签页打开 Markdown（无此链路）；无「分步分段批注」（只有单一 freeText）；**批准后方案自动落盘** `.zcode/plans/plan-<sessionId>.md`（`core/src/runtime/helpers/plan-file-continuity.ts:22-28` + `plan-mode.ts:218-232` `writeApprovedPlanFile`）——与 PRD「保存在会话内不自动落盘」直接相反；无聊天摘要专门面。

### 15. Debug 模式（P1）— 未实现
- 无 debug 模式、无复现→定位→假设→改动→测试循环、无 5 次上限、无每轮分段消息流（grep debug mode / test loop 无命中）。

### 16. 自定义 Agent（P1）— 未实现（PRD 形态）
- 无 Markdown+YAML frontmatter 的 Agent 定义（`.agents/` 只用于 **skills**：`adapters/src/skills/roots.ts:108-119` 支持 `.zcode/skills` + `.agents/skills`，`skills/index.ts:178-199` 解析 SKILL.md frontmatter 的 name/description）——skills 走 `$` 提及/斜杠命令，不出现在模式选择器。
- subagent 体系是内置两类 general-purpose/explore（`core/src/subagent/profile.ts:29-35,85`）+ 内置模型覆盖（:52-63）；扩展 `gode.showSubagents` 面板是运行状态只读目录（`webview-react/subagents/subagentsModel.ts`）。
- 模式选择器无「自定义」分组（`V4ComposerModeControls.tsx` 仅模式目录 + plan 勾选）。

## 关键文件索引
- 扩展上下文：`apps/zcode-vscode/src/features/{contextCollector,pendingContext,editorContextFiles,editorCommands,featureConfig}.ts`
- 扩展 composer 半成品（未挂载）：`apps/zcode-vscode/src/webview-react/composer/{mentionSource.ts,selectionChip.tsx,injection.ts}`
- 模式：`apps/zcode-cli/packages/contracts/src/interfaces/session.port.ts:32`、`packages/shared/src/zcode-agent-model-state.ts:19-45`、`apps/zcode-cli/packages/core/src/permission/service.ts`、`packages/ui/src/v4/composer/V4ComposerModeControls.tsx`、`apps/zcode-vscode/src/webview-react/header/modelSelect.tsx`
- Plan：`apps/zcode-cli/packages/core/src/tool/handlers/plan-mode.ts`、`plan-mode-prompts.ts`、`core/src/runtime/helpers/plan-file-continuity.ts`、`packages/ui/src/ElicitationDialog.tsx:196-199`、`bootstrap/src/zcode-protocol/interaction-broker.ts:433-457`
- 规则文件：`apps/zcode-cli/packages/adapters/src/context/index.ts`、`apps/zcode-vscode/src/container.ts:835-862`、`apps/zcode-vscode/src/webview-react/settings/WorkspaceInstructionsPanel.tsx`
- 降级自认注释：`apps/zcode-vscode/src/webview-react/composer/mentionSource.ts:8-10`、`injection.ts:10`
