# PRD 核对报告：FR-07 / FR-08 / FR-09（第 13、14、15 章）

- **核对日期**：2026-11-07
- **PRD**：`/Users/jonntd/Downloads/vscode-all-in-one-prd.md`（第 13 章 FR-07 L625-671、第 14 章 FR-08 L674-710、第 15 章 FR-09 L713-754，已全文通读）
- **代码基线**：monorepo `/Users/jonntd/ZCodium`，分支 `feat/vscode-editor-native`；`apps/zcode-vscode`（薄壳扩展）+ `packages/ui`（共享 UI，webview 挂载桌面壳 `Root`）+ `apps/zcode-cli`（CLI 运行时）
- **核对方式**：纯静态读码（本次为只读调查，未运行任何测试/构建；文中所有结论均给出 file:line 证据，"未找到"条目附搜索关键词与范围）

## 关键架构事实（影响全部条目的判读）

1. **扩展 webview = 共享桌面壳**。`apps/zcode-vscode/src/webview-react/App.tsx:171-189` 直接挂载 `@zcode/ui` 的 `Root`（12 层 Provider 栈、tab 系统、会话/模型/diff/Git 面板全部由 Root 内部装配，见 `App.tsx:2-15` 注释）。因此 FR-07/FR-09 的会话列表、文件卡片、撤销弹窗、聊天查找等实际由 `packages/ui` 提供，插件只做宿主桥接。
2. **`SessionListPanel` / `PluginHeader`（layout.tsx）是遗留未挂载件**：全仓引用只有测试 `test/sessionList.test.ts:27` 与其自身文件，当前 `App.tsx` 不渲染它们（`grep -rln "SessionListPanel|PluginHeader"` 在 src 下仅命中自身 + layout.tsx + sessionListModel 注释）。
3. **改动的权威数据**：CLI 每次文件变更工具成功后写 checkpoint artifact（单文件 before/after + structuredPatch），会话级 fileChanges 快照由此投影；不存在名为 ChangeSet 的聚合结构。

## 总览

| # | 条目 | 结论 |
|---|------|------|
| 1 | ChangeSet/Hunk 数据模型 | **未实现**（有等价的 per-file 快照 + structuredPatch，无轮级 ChangeSet、无逐 Hunk 状态机） |
| 2 | 三种审查视图共用改动集 | **部分实现**（文件卡片/审阅 Diff/审批预览同源；无 Working Set 展开区、无逐 Hunk 接受拒绝、无"先编辑新文本"） |
| 3 | 文件卡片（行数/点开 Diff/Undo） | **大部分实现**（+/- 行数✓、打开 diff✓〔webview 代码查看器而非原生 diff〕、逐文件 Undo✓、快照来源=checkpoint✓） |
| 4 | 动作展开与纠正 | **部分实现**（步骤展开✓、停止整轮✓、执行中纠正✓、跳过待执行动作✗） |
| 5 | 冲突处理（外部修改/二进制/行号重算） | **部分实现**（外部修改 hash 检测✓〔在撤销侧〕；二进制/Hunk 行号重算因逐 Hunk 机制不存在而不适用/未实现） |
| 6 | Ctrl+I 选区上方浮出输入框 | **未实现**（现有 `gode.quickEdit` 为 Cmd/Ctrl+Alt+K 的 InputBox+diff 标签页流程） |
| 7 | 纯提问浮层内回答 | **未实现** |
| 8 | 改动走审批与检查点口径一致 | **部分实现**（Agent 产生的改动走审批+检查点✓；QuickEdit 本地改写不经审批/检查点） |
| 9 | 「转到侧栏会话」 | **未实现** |
| 10 | Esc 关闭丢弃 / 模型不可用提示 / 单实例 | **部分实现**（取消不改盘✓；模型失败走全局 showErrorMessage 而非浮层内提示✗） |
| 11 | 会话列表（标题/时间/模型/用量、新建/重命名/删除确认/搜索） | **部分实现**（标题/时间/状态/变更摘要✓；模型/用量✗；重命名/删除确认/跨会话搜索✓） |
| 12 | 多标签会话 + 快捷键族 | **部分实现**（workspace 级标签✓、拖动排序未接线✗、Cmd+Alt+Left/Right✗〔实为 Cmd/Ctrl+Shift+[〕、Cmd/Ctrl+N✗、Ctrl+L✗、Cmd/Ctrl+Shift+T✗） |
| 13 | 会话自动标题（改后不覆盖） | **已实现**（CLI 首轮模型生成 sidecar；`cli_title_source='custom'` 防覆盖） |
| 14 | 历史视图（全文搜索含工具输出/过滤/批量删/元数据/排序/收藏防误删/导出 MD） | **部分实现**（搜索不含工具输出✗、无费用/Token 元数据✗、无按花费排序✗、收藏=置顶非删除特别确认△、导出 Markdown✗、批量删除仅限归档任务△） |
| 15 | 聊天内搜索 Cmd/Ctrl+F | **部分实现**（Cmd/Ctrl+F✓、Enter/Shift+Enter 跳转✓；大小写/全词/正则✗、Alt+Cmd+↑/↓✗、Alt+Cmd+PgUp/PgDn✗、语料不含工具输出/代码块✗） |
| 16 | 检查点 | **大部分实现**（每次工具调用后生成✓、等价快照含未纳入 Git 文件✓、逐文件/整轮恢复+确认✓、恢复三选一能力等价△、Compare 按钮△、Redo✗、保留 100 个✗） |
| 17 | 无障碍视图 Alt+F2 | **未实现** |

---

## FR-07 改动审查与 Diff（PRD 第 13 章）

### 1) ChangeSet/Hunk 数据模型 —— 未实现

**PRD 要求**（L631-634）：ChangeSet = 一轮全部文件改动，含会话 ID、轮次、文件列表、每文件 Hunk 列表、整体状态（待审/部分接受/已接受/已拒绝）；Hunk 为最小接受/拒绝单位。

**实况**：
- 全仓搜索 `ChangeSet|changeset|changeSet`（范围：`apps/zcode-vscode/src`、`packages/ui/src`、`packages/shared/src`）零命中；`Hunk|hunk` 命中仅为 **diff 文本解析显示**（`packages/ui/src/lib/patchDiffPreview.ts:36-176`，把 patch 的 `@@` 头解析出来渲染预览），不是可操作的数据模型。
- 实际数据结构：
  - checkpoint artifact（单文件）：`apps/zcode-cli/packages/core/src/runtime/helpers/rewind.ts:58-81` —— `{ kind: "workspace_file_before_change", files: [{ path, beforeContent, afterContent, structuredPatch, existedBefore }], toolCallId, toolName }`；
  - 轮级变更快照（展示用）：`@zcode/shared` 的 `ZCodePersistedFileChange`/`ZCodeTaskChangeSummary`（`packages/ui/src/MessageChangeSummaryPanel.tsx:2-6` 引用），`buildTurnChangeSummary` 按单轮重算（`MessageChangeSummaryPanel.tsx:67-71`）。
- **无** "待审/部分接受/已接受/已拒绝" 的整体状态字段，**无** 逐 Hunk 的 accept/reject 状态。最接近的"部分接受"语义是按文件勾选撤销（`packages/ui/src/v4/fileRewindSelection.ts:10-17`），粒度是文件不是 Hunk。

> [复核:确认]（2026-11-07）独立换词验证：`rg -i "changeset|change_set"` 于 `apps/zcode-vscode/src`、`packages/ui/src`、`packages/shared/src`、`packages/services/src`、`packages/rpc/src`、`packages/client/src`、`apps/zcode-cli/packages/{core,adapters,contracts}/src` 全部零命中（范围比原报告多覆盖 rpc/client/adapters 三层）；`rg -i "hunk"` 仅命中 chunk 噪音与 `helpers/rewind.ts:51` 的 `isRuntimeDiffHunk`（checkpoint patch 校验解析，非接受状态机）。checkpoint 单文件粒度实读确认：`tools.ts:214`、`tools.ts:231` 均为 `fileCount: 1`。结论维持"未实现"。

### 2) 三种审查视图共用同一份改动集 —— 部分实现

**PRD 要求**（L636-642）：并排 Diff（原生 diff、逐 Hunk 接受/拒绝、可先编辑新文本）、内联 Diff（Keep/Undo）、Working Set（输入框上方展开区，不依赖 Git）。

**实况**（三种"呈现面"存在，但形态都不等于 PRD 规格）：
- **审批中的 Diff（≈并排 Diff）**：`apps/zcode-vscode/src/ui/diffViewer.ts:69-86` —— `DiffViewer.open()` 用 `zcodium-proposed` 虚拟文档 + 原生编辑器打开；但（a）左侧开的是磁盘当前文件（`window.showTextDocument(fileUri)`），不是标准 `vscode.diff` 双栏（quickEdit 那条链路才是 `vscode.diff`）；（b）纯只读，**无逐 Hunk 接受/拒绝、无"先编辑新文本再接受"**；（c）该能力经平台方法 `showDiff` 暴露（`apps/zcode-vscode/src/container.ts:571-577`、`src/webview-react/platform/vscodePlatformService.ts:196-198`），但共享 UI 中 **没有任何调用方**（`grep -rn "\.showDiff("` 于 `packages/ui/src`、`apps/zcode-vscode/src` 仅命中定义与 container 实现）——审批 diff 实际在 webview 内由共享 UI 卡片渲染，此原生 diff 路径当前处于休眠。
- **内联 Diff（Keep/Undo）**：**未实现**。编辑器内没有 Keep/Undo 装饰控件；最接近的是工具行内的只读 diff 预览 `packages/ui/src/ToolCallBlocks/renderers/EditInlineDiffContent.tsx`（shiki 高亮渲染，无操作按钮）。
- **Working Set（输入框上方展开区）**：**未实现**。全仓搜索 `workingSet|working_set|工作区改动` 零命中；改动摘要面板出现在**消息流内**（回合末尾，`packages/ui/src/v4/ConversationTurnGroup.tsx:1680` 挂 `ConversationFileSummaryPanel`），不在输入框上方；"不依赖 Git"满足——数据来自 checkpoint artifact 与 fileChanges 快照，与 Git 无关。
- **共用数据**：✔ 三处（审批卡片、文件卡片、diff 查看器）同源（fileChanges 快照 + snapshot before/after），见 `packages/ui/src/messageChangeSummaryPreview.ts:9-61`（`patch` → patch 视图；`snapshot.beforeContent/afterContent` → multi-file-diff 视图）。

> [复核:确认]（2026-11-07）换词重搜 `working.?set|工作集|工作区改动|本轮改动`：唯一命中是 Windows 进程采样的内存字节数（`packages/services/src/process/processResourceSampler.ts:155-171`，无关）。`rg "showDiff"` 全仓仅定义链三处（`container.ts:571`、`platformRpcHandler.ts:38` 白名单、`vscodePlatformService.ts:197-198` 客户端），无任何调用方，佐证"原生 diff 路径休眠"。实读 `apps/zcode-vscode/src/ui/diffViewer.ts:69-86`：左侧为 `window.showTextDocument(fileUri)` 磁盘文件、提议内容为虚拟文档，非 `vscode.diff` 双栏、无 Hunk 操作；文件卡片点开走 webview 内 `openChangeSummaryDiffViewer`（`MessageChangeSummaryPanel.tsx:190`）确认非原生 diff。结论维持"部分实现"。

### 3) 文件卡片 —— 大部分实现

**PRD 要求**（L644-647）：每轮收成可折叠卡片组、显示增删行数、点文件名打开并排 Diff、卡片带 Undo 恢复改动前（快照来源 FR-09 检查点）。

**实况**：
- 折叠卡片组 + 每文件 `+N/-N` 行数：`packages/ui/src/MessageChangeSummaryPanel.tsx:101-163`（折叠容器、聚合 +/- 于 `:134-137`）、逐文件行数 `:226-233`；按单轮快照重算避免跨轮混入（`:67-71`）。
- 点文件名打开 diff：`:193-249`（`openDiffViewer` → `openChangeSummaryDiffViewer`）；**但打开的是 webview 内代码查看器的 diff 视图（`multi-file-diff`/`patch` source），不是 VS Code 原生 diff 编辑器**。
- 卡片 Undo：整轮撤销按钮 `MessageChangeSummaryPanel.tsx:140-162`（Undo2 图标，`fileState === "reverted"` 时禁用）；**逐文件 Undo** 在 `packages/ui/src/v4/ConversationFileSummaryPanel.tsx:381-389`（每行 Undo2 按钮 → `handlePreviewRewind(item.path)` → `ConversationFileRewindDialog`（`:432-441`，单文件预勾选）→ `applyFileRewind`）。
- 快照来源 = 检查点 ✔：撤销由 CLI 按各文件 checkpoint artifact 的 `beforeContent` 还原（`apps/zcode-cli/packages/core/src/runtime/methods/file-rewind.ts`，聚合 `FileCheckpointOperation.beforeContent`，`:41-53`）。

> [复核:确认]（2026-11-07）抽查正面与负面点：聚合 +/- 行数实读确认（`MessageChangeSummaryPanel.tsx:135-136` 整轮、`:227-231` 逐文件）；逐文件 Undo 实读确认（`ConversationFileSummaryPanel.tsx:161` `handlePreviewRewind`、`:380-384` 行内 Undo2 按钮、`:432` 挂 `ConversationFileRewindDialog`）。"点文件名打开的是 webview 内查看器而非 VS Code 原生 diff"这一与 PRD 不符点维持（见条目 2 复核）。

### 4) 动作展开与纠正 —— 部分实现

**PRD 要求**（L649-652）：每步可展开（文件 Diff / 终端命令与输出 / 外部集成结果）、可跳过某个待执行动作、停止整轮、执行中发纠正（Steer）。

**实况**：
- 每步可展开 ✔：`packages/ui/src/ToolCallBlocks.tsx` 分发渲染器；文件 Diff = `renderers/EditInlineDiffContent.tsx`；终端命令与输出 = `renderers/ExecuteCommand.tsx` + `ExecuteOutput.tsx`；外部集成（MCP 工具）走 `resolveRenderer.ts` 的通用渲染。
- 停止整轮 ✔：`gode.stop` 命令 → `zcodeTaskService.stopGeneration`（`apps/zcode-vscode/src/features/editorCommands.ts:265-283`）；共享 UI composer 运行中按钮同款（`packages/ui/src/v4/ConversationComposer.tsx:12` 注释）。
- 执行中发纠正 ✔：composer 的 `guide` 投递通道（`ConversationComposer.tsx:1360-1361` 注释：guide 是 CLI 已授权的 busy 输入路由，最终 steer 或回退 queue 由命令层裁决）；CLI 侧 `steerTurn`（`apps/zcode-cli/packages/core/src/runtime/methods/tool-result-settlement.ts:252-258` 一带、`packages/shared/src/zcode-protocol/index.ts:25-26` 记载 `session/steer` 旧词已并入命令面）。
- **跳过某个待执行动作 ✗**：未找到任何入口。搜索 `跳过|skipStep|skipAction` 于 `packages/ui/src`（PermissionDialog/ConversationTimeline/TodoPanel 等）仅命中无关逻辑；计划步骤面板 `TodoPanel.tsx` 只读展示 `ZCodePlanStep` 状态，无 skip 操作。

> [复核:确认]（2026-11-07）独立词 `skipStep|skipAction|跳过.{0,6}(动作|步骤|待执行)|待执行.{0,6}跳过` 于 5 层源码树零命中；`skip` 泛搜仅命中 composer 自动聚焦跳过（`ConversationComposer.tsx:1074`）、分享预检 skippableWarnings（`SessionPane.tsx:907-908`）、示例 prompt 文案（`featureSuggestedPrompts.ts:61`），均与"跳过待执行动作"无关。其余三项（展开/停止/纠正）正面证据由原报告给出且与本次抽查一致（`editorCommands.ts:265` `gode.stop`、`tool-result-settlement.ts:254` `steerTurn`、`conversationFindSearch` 式 Enter 映射无关）。结论维持"部分实现"。

### 5) 冲突处理 —— 部分实现（在撤销侧，不在 Hunk 应用侧）

**PRD 要求**（L659-663）：外部修改致 Hunk 对不上 → 标记冲突不强行应用；二进制文件只显示文件级接受/拒绝；接受部分 Hunk 后行号重算。

**实况**：
- **外部修改检测 ✔（撤销路径）**：`file-rewind.ts:473-481` —— 计划恢复前对每个文件取当前磁盘 hash，与 checkpoint `afterContent` 期望 hash 比对，不等则标记 `unsafe.reason = "external_modified"`（类型定义 `apps/zcode-cli/packages/core/src/runtime/types.ts:634-654`），整体拒绝应用（`:130` "File rewind was not applied because at least one file is unsafe."）；UI 在弹窗 unsafe 区呈现原因（`ConversationFileRewindDialog.tsx:41-52` 的 `external_modified` 文案、`:244-252` unsafe 列表）。**但** PRD 场景是"应用 Hunk 时 Hunk 对不上"——逐 Hunk 应用机制本身不存在（见条目 1），故该能力只覆盖"点 Undo/撤销时文件已被外部改过"。
- **二进制文件 ✗/不适用**：checkpoint 候选要求输出含文本 `filePath + structuredPatch + originalFile`（`helpers/rewind.ts:38-56`，`originalFile` 必须为 string 或 null）——二进制写入不进该快照面；无"二进制文件级接受/拒绝"专用 UI（审批粒度在工具调用级，FR-06 面）。
- **接受部分 Hunk 后行号重算 ✗/不适用**：无逐 Hunk 接受，无从重算。

> [复核:确认]（2026-11-07）实读 `file-rewind.ts:472-481`：计划恢复前 `hashContent(operation.afterContent)` 与当前磁盘 hash 比对，不等则 `markUnsafe({..., reason: "external_modified"})`——外部修改检测确在撤销侧；实读 `helpers/rewind.ts:38-58`：checkpoint 候选强制要求 `filePath` + `structuredPatch` 数组 + `originalFile`（string|null），二进制写入无 structuredPatch 即不产出快照，"二进制文件级接受/拒绝"专用 UI 亦无。结论维持"部分实现"。

---

## FR-08 内联聊天（PRD 第 14 章）

### 现有最接近实现：`gode.quickEdit` 的真实机制（ask 要求详细描述）

触发与绑定：`apps/zcode-vscode/package.json` keybindings —— `{"command":"gode.quickEdit","key":"ctrl+alt+k","mac":"cmd+alt+k","when":"editorHasSelection && editorTextFocus"}`（全扩展仅此一条编辑器快捷键 + `gode.addToContext`）。

交互形态（`apps/zcode-vscode/src/features/quickEdit.ts`）：
1. **必须有选区**（`:46-50`，无选区仅提示"请先选中要修改的代码"），**不支持无选区作用于当前行**；
2. `vscode.window.showInputBox`（`:54-59`）收指令 —— 这是**系统输入框**，不是"选区上方浮出的浮层 widget"，也不显示作用范围；
3. 走 `workspace/generateText` **一次性文本生成**（`src/features/oneShotText.ts:19-45`，进程内/WS accessor 直调，无工具调用、无会话回合、无审批、无检查点），prompt 让模型输出"替换后的完整代码"（`quickEdit.ts:64-78`）；
4. `vscode.diff` 打开**独立 diff 标签页**（左右均为 `gode-quick-edit` 虚拟文档，`:111-125`）预览 —— 是"编辑器 tab 里的 diff"，**不是原代码位置上的内联 Diff**，且右侧不可编辑（虚拟文档）；
5. 模态 `showInformationMessage("应用这次改写？", "应用"/"放弃")`（`:127-132`）→ 应用则 `WorkspaceEdit.replace(选区, 改写文本)`（`:145-159`），放弃则关闭 diff 编辑器、磁盘不变；
6. 生成失败走 `showErrorMessage` 全局提示（`:94-98`）；模型未配置时 `oneShotText.ts:26-29` 抛错同样落到这里。

即：**QuickEdit 是"选区改写器"，不是 PRD 的内联聊天** —— 无浮层、无提问回答、无作用范围显示、无会话、无转侧栏动作。

### 6) Ctrl+I 选区上方浮出输入框、显示作用范围 —— 未实现

- 全扩展与共享 UI 均无 `Ctrl+I` 绑定（搜索 `Ctrl+I|ctrl+i` 于 package.json 与 src：零命中；`packages/shared/src/shortcutCommands.ts` 快捷键命令表也无对应命令）。
- QuickEdit 绑定 Cmd/Ctrl+Alt+K 且用 InputBox（见上）。无"作用范围显示"（选区外不能生效，本身就无范围概念）。

> [复核:确认]（2026-11-07）独立验证：脚本解析 `apps/zcode-vscode/package.json` 的 `contributes.keybindings` 全量仅 2 条（`gode.quickEdit`=ctrl/cmd+alt+k、`gode.addToContext`=ctrl/cmd+alt+a），无 Ctrl+I；`rg -i "ctrl\+i|inline.?chat|zone.?widget|zonewidget"` 于扩展与 `packages/ui/src`、`packages/shared/src` 零命中；`shortcutCommands.ts` 全表亦无对应命令。实读 `quickEdit.ts:46-50`（无选区仅提示）、`:54-59`（showInputBox）。结论维持"未实现"。

### 7) 纯提问浮层内回答、改动以内联 Diff Keep/Undo —— 未实现

- QuickEdit 只产出替换代码，不回答问题（`quickEdit.ts:64-78` prompt 明确"只输出改写后的完整代码"）。
- 解释类命令（`gode.explainSelection` 等）把指令+选区 mention **推到侧栏 composer 并打开侧栏**（`apps/zcode-vscode/src/features/editorCommands.ts:74-140` `createCodeActionEntry` → `pushFrame("composer-insert")` + `gode.openChat`；`:220-234` 四个选区命令），回答出现在侧栏会话，不在浮层。
- Keep/Undo 内联 Diff：不存在（见 FR-07 条目 2）。

> [复核:确认]（2026-11-07）实读 `quickEdit.ts:64-78`：prompt 明文"只输出改写后的完整代码，不要任何解释"，无提问回答通道；无选区/浮层/Keep-Undo 控件。结论维持"未实现"。

### 8) 改动走审批与检查点口径一致 —— 部分实现（口径分裂，但 QuickEdit 定位为本地编辑）

- **Agent 会话产生的改动 ✔ 口径一致**：审批经 CLI 反向请求 `interaction/requestPermission` → 宿主应答（`apps/zcode-vscode/src/approvals/approvalService.ts:1-14` 文档注释；现行装配下审批 UI 在 webview 共享 UI 内，`container.ts:10-13` 注释）；检查点由 CLI 每次工具结果落定后生成（`tool-result-settlement.ts:185-194`）。
- **QuickEdit 改写 ✗ 不走审批/检查点**：进程内 `generateText` + 本地 `WorkspaceEdit`，全程无 `requestPermission`、无 checkpoint artifact（`quickEdit.ts` 全文）。它不"开后门改会话状态"，但也不满足"改动同样走 FR-06 审批与 FR-09 检查点"。

> [复核:确认]（2026-11-07）深挖 CLI 侧底层：实读 `apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts:111-280`——`generateWorkspaceText` 全程只发 `ModelRequest`/`ModelComplete` 事件并记 usage fact，无权限请求、无 checkpoint artifact 产出（checkpoint 仅由文件变更工具在 tool-result settlement 产出）；应用侧为本地 `WorkspaceEdit`（`quickEdit.ts:145-159`）。口径分裂结论成立，维持"部分实现"。

### 9) 「转到侧栏会话」 —— 未实现

- QuickEdit 流程无此动作；代码动作（explain/fix/refactor/tests）虽然天然落进侧栏会话，但那是"提交到侧栏"，不是"内联浮层把选区+提问+已产生改动带入新会话"。搜索 `转到侧栏|moveToSession|sendToSession` 于 `apps/zcode-vscode/src`、`packages/ui/src`：零命中。

> [复核:确认]（2026-11-07）换词重搜 `转到侧栏|moveToSession|sendToSession|sendToSidebar|带入.{0,4}会话` 于 `apps/zcode-vscode/src`、`packages/ui/src`、`packages/shared/src`、`packages/services/src`、`apps/zcode-cli/packages/core/src`：零命中。结论维持"未实现"。

### 10) Esc 关闭丢弃 / 模型不可用浮层内提示 / 同编辑器单实例 —— 部分实现

- **Esc/取消不改盘 ✔（形态不同）**：InputBox Esc = 取消，未生成（`quickEdit.ts:60`）；diff 预览后按 Esc 关掉提示框 = 放弃（`choice !== "应用"` → 关闭 diff 编辑器，`:133-136`），未应用前从未落盘。PRD 语义"未接受的内联 Diff 改动直接丢弃"等价成立，但没有"浮层"。
- **模型不可用 ✗**：失败用 `window.showErrorMessage`（`quickEdit.ts:97`）—— 全局错误通知，会打断编辑流，不满足"浮层内提示、不弹全局报错、不影响打字与编辑"。
- **单实例 ✔（平凡满足）**：命令式串行流程（InputBox→生成→diff→确认），无持久浮层，天然不存在双浮层。

> [复核:确认]（2026-11-07）实读 `quickEdit.ts:54-60`（InputBox Esc 即取消，无落盘）、`:127-138`（choice !== "应用" 仅关闭 diff 编辑器）、`:94-98`（失败走 `showErrorMessage` 全局通知，非浮层内提示）。三项子结论（Esc 等价成立/模型不可用提示不符/单实例平凡满足）均维持。

---

## FR-09 历史、检查点与会话管理（PRD 第 15 章）

### 11) 会话列表 —— 部分实现

**当前实际生效的会话列表**（webview = 共享桌面壳 Root → WorkspaceSidebar 任务列表，`packages/ui/src/app-shell/WorkspaceShellLayout.tsx:1933` 挂载）：
- 显示 ✔：标题（`TaskListItem.tsx:131` title 投影）、相对时间（`:369 formatTaskRelativeTime(task.updatedAt)`）、状态、每任务变更 `+added/-removed` 摘要（`:400-404`）。
- **模型 ✗ / 用量摘要 ✗**：列表项无 model/token/cost 展示（`TaskListItem.tsx` 全文无 model/usage 字段渲染；shared 类型有 `cost` 字段 `packages/shared/src/zcode-task-types-core.ts:934-935` 但无人消费）。用量只有独立面板（`apps/zcode-vscode/src/webview-react/usage/usagePanel.tsx`，且该面板属未挂载的 layout 槽位体系）。
- 新建 ✔：`NewTaskButtonGroup`/Header 新建入口 + `gode.newSession` 命令（package.json commands；无 keybinding）。
- 重命名 ✔：`TaskRenameDialog.tsx`（TaskList/WorkspacePinnedTasksSection/WorkspaceGroupedTasksSection 等多处消费）。
- 删除确认 ✔：`confirmDialog.taskDeleteTitle`（`packages/ui/src/i18n/locales/zh-CN.ts:802`）、归档任务另有 `confirmDialog.archivedTaskDeleteTitle`（`:804`）。
- 搜索 ✔：`TaskSearchDialog.tsx` 跨会话搜索（详见条目 14）。
- **遗留件说明**：`src/webview-react/sessions/SessionListPanel.tsx`（title/status/folder/updatedAt、删除二次确认 `:203`）+ `layout.tsx` PluginHeader 带"会话列表"按钮，**当前 App 不装配**（App.tsx 仅挂 Root），仅 `test/sessionList.test.ts` 引用；归 CLI 共享历史的另一入口是 `gode.pickSession` QuickPick（`apps/zcode-vscode/src/features/history.ts:22-56`，title/相对时间/mode）。

> [复核:确认]（2026-11-07）独立验证："模型/用量 ✗"——实读 `packages/ui/src/TaskListItem.tsx` 全文无 model/usage/cost/token 渲染（唯一相关引用是 `modelTrajectoryStore` 打开轨迹面板入口，非列表项元数据）；用量面板 `usagePanel.tsx` 仅由未挂载的 `layout.tsx` 槽位（PluginPanelSlot name="usage"）承载，且 `gode.openUsage`（`hostCommands.ts:137`）推的 `open-panel` 帧在现行 webview 无订阅方——`App.tsx` 仅订阅 `workspace`/`session-switch`/`capabilities` 三种帧，面板实际不可达，佐证"属未挂载槽位体系"。"遗留件不装配"亦确认：`rg "SessionListPanel"` 排除自身与 sessionListModel 后仅剩 `layout.tsx:6` 一条注释，无生产 import。结论维持"部分实现"。

### 12) 多标签会话与快捷键族 —— 部分实现

- **标签 ✔ 但语义不同**：共享 UI tab 系统是 **workspace 级标签**（`packages/ui/src/store/tabStore.ts:34-44` `WorkspaceTabState` 按 workspacePath/identity 建签），**不是"每会话一个标签"**；同 workspace 内多会话经侧栏任务列表切换（`activeTaskId`，`App.tsx:148-166` 订阅）。PRD"同一窗口开多个会话标签"以"多 workspace 标签 + 单 workspace 内任务切换"近似。
- **拖动排序 ✗**：`tabStore.ts:448-485` 有 `reorderTabs`/`reorderWorkspaceTabs` 纯实现，但**全仓无调用方**（`grep -rn "reorderTabs|reorderWorkspaceTabs"` 排除 store 自身后零命中）——拖拽未接线。
- **Cmd/Ctrl+Alt+Left/Right ✗**：上一个/下一个会话的实际默认键是 `CmdOrCtrl+Shift+[` / `CmdOrCtrl+Shift+]`（`packages/shared/src/shortcutCommands.ts:77-78`，处理在 `packages/ui/src/App.tsx:1058-1059`）；无方向键绑定。
- **Cmd/Ctrl+N ✗**：`newTask` 是 **menu 通道**（Electron 桌面菜单 accelerator，`shortcutCommands.ts:86`），renderer 的 `useAppKeyboard` 不分发（`App.tsx:1044-1062` 仅列 window 通道命令）；VS Code 扩展 `gode.newSession` 无 keybinding（package.json keybindings 仅 2 条）。
- **Ctrl+L ✗**：无此绑定。
- **Cmd/Ctrl+Shift+T 重开关闭会话 ✗**：`closeTab`（`tabStore.ts:345-412`）无关闭历史/恢复机制；`useTabPersistence.ts` 只做启动期标签恢复，无"最近关闭"栈。

> [复核:确认＋补充修正细节]（2026-11-07）拖动排序：`reorderTabs|reorderWorkspaceTabs` 全仓仅 `tabStore.ts:448/465` 定义与 `test/tabStore.test.ts:313/317` 测试调用，无生产接线，✗ 维持。快捷键族：脚本解析扩展 keybindings 仅 2 条（无 Cmd+N/Ctrl+L/Cmd+Shift+T）；`shortcutCommands.ts:77-78` 上/下会话实为 `CmdOrCtrl+Shift+[` / `CmdOrCtrl+Shift+]`、`:86` `newTask` 为 menu 通道；`ctrl\+l|cmd\+l` 与 `shift\+t` 全仓零命中（后者仅 Shift+Tab 无关逻辑）。**补充**：报告"无'最近关闭'栈"仅对**会话标签**成立——右侧 SidePane 标签（Diff/Terminal/Git/Browser）确有最近关闭恢复栈与可视化入口（`useAppPanels.ts:1621` `handleReopenClosedSidePaneTab` + `allRecentClosedSidePaneTabs`、`SidePaneTabOverview.tsx:246`），但其恢复对象不是会话标签、且无 `Cmd/Ctrl+Shift+T` 键绑定，PRD 语义仍判未实现，主结论不变。

### 13) 会话自动标题 —— 已实现（CLI 侧）

- **首轮模型生成 ✔**：`apps/zcode-cli/packages/core/src/runtime/methods/session-title.ts:34-60` `maybeStartSessionTitleGeneration`（首轮输入触发）；`title-generation-sidecar.ts:60-79` 标题生成 system prompt（3-7 词、用户主语言、独立 sidecar 请求，`:54-56` 超时 60s/输入 1200 字/标题 100 字上限）。
- **用户可改 ✔**：`renameTask`（`packages/services/src/session/zcodeTaskService.ts:720`）→ `TaskRenameDialog`。
- **改后不覆盖 ✔**：`packages/services/src/session/taskIndexRepo.ts:980-988` —— `cli_title=CASE WHEN cli_title_source='custom' AND ?<>'custom' THEN cli_title ELSE ? END`：custom 标题不会被后续 CLI 自动标题覆盖；`:129` `titleOverridden` 投影、`:1320` 搜索也按 overridden 优先。

### 14) 历史视图 —— 部分实现

- **独立子视图 △**：无独立"历史"页；入口 = WorkspaceSidebar 任务列表 + `TaskSearchDialog` 跨会话搜索。
- **全文搜索 ✗（不含工具输出）**：搜索走 `tasks-index.sqlite` `searchable_text` LIKE（`packages/services/src/session/taskIndexRepo.ts:1320`）；而 `searchable_text` 只索引**用户可见聊天正文**——`packages/services/src/zcode-agent/zcodeTaskIndexSyncer.ts:1897-1900` 注释明确"只索引默认可见的聊天正文，不包含思考过程、tool 调用和 compaction 折叠区"，且总量截断（`:1930-1931` `TASK_SEARCH_TEXT_MAX_CHARS`）。**PRD 要求搜"折叠的工具输出"未满足。**
- **按工作区过滤 ✔**：workspace_key 隔离（`taskIndexRepo.ts:1320` 查询按 workspace_key + workspace_path；identity 统一见 AGENTS.md Workspace Identity 口径）。
- **按时间过滤 ✗**：无时间范围过滤 UI；排序支持 manual/created/updated（`TaskList.tsx:64,321-325`），可视为时间排序 ✔。
- **批量删除 △**：仅归档任务支持批量（`DeleteAllArchivedTasksButton.tsx`、"删除所有归档任务" `zh-CN.ts:806-814`）；普通会话无多选批量删。
- **元数据 △**：时间 ✔、工作区 ✔（分组/归属标注）；**模型 ✗、Token ✗、估算费用 ✗**（列表项不显示，shared `cost` 字段无 UI 消费）。
- **排序 ✗（花费/Token）**：仅 manual/created/updated，无按花费/Token 排序。
- **收藏 △**：pin/置顶 ✔（`TaskList.tsx:76,183-187` `onSetTaskPinned`、置顶分区 `WorkspacePinnedTasksSection.tsx`）；但**未发现"删除确认时收藏项单独提示"**——删除确认文案不区分 pinned（`grep confirmDialog.taskDelete` 仅两条通用文案）。
- **导出单会话 Markdown ✗**：全仓无会话 Markdown 文件导出（搜索 `exportSession|exportMarkdown|导出会话|toMarkdown` 于 packages/ui、packages/shared、apps/zcode-cli/packages/core：无会话导出实现；唯一导出是插件诊断日志 `apps/zcode-vscode/src/container.ts:589-600`）。最接近的是**云端分享链接**（`packages/ui/src/v4/conversationShareMarkdown.ts:63-90` `normalizeConversationShareMarkdown` 做公开页脱敏：剥离 citation directive、远程图片降级防 tracking pixel）——是 share link 不是本地 Markdown 文件，也无"不含密钥"的导出声明。
- 另注：侧栏还有归档区（`WorkspaceArchivedTasksFlatSection.tsx`、`WorkspaceGroupedTasksSection.tsx:959-1133` 归档/恢复簿记）。

> [复核:确认]（2026-11-07）逐项换词重验：① 语料——实读 `zcodeTaskIndexSyncer.ts:1896-1900` 注释原文"全局会话搜索只索引默认可见的聊天正文，不包含思考过程、tool 调用和 compaction 折叠区"，`:1893` `TASK_SEARCH_TEXT_MAX_CHARS = 200_000` 截断，✗ 维持；② 排序——`TaskList.tsx:36,64,321-325` 仅 manual/created/updated，无花费/Token，✗ 维持；③ 批量删除——`rg "batchDelete|deleteAll|multiSelect|批量|全选"` 于任务列表组件零命中，仅归档有 `DeleteAllArchivedTasksButton.tsx`（`:18,66-79`），△ 维持；④ 删除确认——`rg "taskDeleteTitle|archivedTaskDeleteTitle"` 全仓仅这两条通用文案（`zh-CN.ts:802,804`），无置顶/收藏特别文案，△ 维持；⑤ 导出 Markdown——用 `导出|export.*markdown|markdown.*export|exportSession|exportConversation|saveMarkdown|download.*md` 换词重搜，唯一落地面是诊断日志导出（`container.ts:590`）与云端分享链接家族（`packages/ui/src/v4/conversationShare*.ts*`，非本地文件），✗ 维持；⑥ 元数据——`TaskListItem.tsx` 无 model/cost/token 渲染，✗ 维持。结论维持"部分实现"。

### 15) 聊天内搜索 Cmd/Ctrl+F —— 部分实现

- **触发 ✔**：`findInTask` 默认 `CmdOrCtrl+f`（`shortcutCommands.ts:70`），`App.tsx:1048` 接 `handleOpenTaskFind` → `TaskFindDialog`（`packages/ui/src/quickpick/TaskFindDialog.tsx:49-`）；重复触发回焦搜索框（`:97-105`）。
- **Enter/Shift+Enter 跳转 ✔**：`packages/ui/src/quickpick/conversationFindSearch.ts:8-22`（Enter=next、Shift+Enter=previous、↑/↓ 也支持）；导航在 `TaskFindDialog.tsx:198-214` `moveSelection`。
- **双 scope ✔（超出 PRD）**：会话 + 文件变更两个查找范围（`TaskFindDialog.tsx:28` `TaskFindScope`，切到文件变更时自动打开文件变更面板 `:107-113`）。
- **大小写/全词/正则 ✗**：无任何匹配选项（`conversationFindIndex.ts:38` `normalizeConversationFindQuery` = trim + toLocaleLowerCase 纯子串匹配；`grep caseSensitive|wholeWord|regex` 于 quickpick/ 目录零命中）。
- **语料 ✗（不含工具输出/代码块）**：查找索引只覆盖 `userInput` + `assistantText` 两类行（`packages/ui/src/v4/conversationFindIndex.ts:1-2,15` `ConversationFindRowKind`），DOM 高亮锚定已渲染正文（`useConversationTimelineFind.ts:1-116`）。
- **Alt+Cmd+↑/↓ 提问间跳转 ✗、Alt+Cmd+PgUp/PgDn 代码块间跳转 ✗**：无对应键位（搜索 `alt+cmd|AltCmd` 于 shared/ui 零命中）；替代品是可视化导航条 `ConversationTurnNavigator.tsx`（问题 rail，zh-CN 文案 `zh-CN.ts:2451-2455`），无键盘快捷键。

> [复核:确认]（2026-11-07）实读 `conversationFindIndex.ts:2`（`ConversationFindRowKind = "userInput" | "assistantText"` 两类，无工具输出/代码块行）与 `:38`（`normalizeConversationFindQuery` = trim + toLocaleLowerCase 纯子串）；`rg -i "caseSensitive|matchCase|wholeWord|useRegex|正则|全词|大小写"` 于 quickpick 与 v4 目录零命中；`rg -i "alt\+cmd|altCmd|alt\+meta"` 于 shared/ui/扩展零命中。正面项 Enter/Shift+Enter/↑/↓ 导航实读确认（`conversationFindSearch.ts:8-22`）。结论维持"部分实现"。

### 16) 检查点 —— 大部分实现（CLI 侧；机制为等价快照，非影子 Git）

- **生成时机 ✔**：每次**工具结果落定后**自动生成 —— `apps/zcode-cli/packages/core/src/runtime/methods/tool-result-settlement.ts:185-194`（`emitFileMutationCheckpoint`，注释明确"checkpoint 是 tool result 闭合后的附加操作"）；实现于 `methods/tools.ts:171-253`：仅**成功的文件变更类工具**（输出含 `filePath+structuredPatch+originalFile`，`helpers/rewind.ts:38-56`）产出 `CheckpointCreated` 事件（scope=Workspace，`tools.ts:204-217`）。注意两点与 PRD 有出入：checkpoint 粒度是**单文件**（`fileCount: 1`，`tools.ts:214`）而非全 workspace 快照；纯对话步骤/失败调用不产 checkpoint。
- **快照机制 ✔（等价快照，含未纳入 Git 文件）**：不是影子 Git，而是内容级 artifact —— `stringifyWorkspaceCheckpointArtifact`（`helpers/rewind.ts:58-81`）存 `beforeContent`（改动前**整文件**内容）、`afterContent`、`structuredPatch`、`existedBefore`；artifact 落盘 per-session 目录（`apps/zcode-cli/packages/adapters/src/storage/index.ts:71-82`，URI `zcode-artifact://<sessionId>/<artifactId>`）。因不依赖 Git，未纳入 Git 的新建文件同样可快照/还原 ✔（PRD 验收"未纳入 Git 的文件能还原"成立）。持久化与冷恢复：`methods/workspace-checkpoint-persistence.ts:28-61,101-170`（session entry 落库，重启后重建事件）。
- **每步骤 Compare/Restore 按钮 △**：无"每个步骤旁"的双按钮。Compare ≈ 文件卡"审阅 Diff"按钮（`MessageChangeSummaryPanel.tsx:236-251`、`ConversationFileSummaryPanel.tsx:391-417`）打开 diff；Restore ≈ 卡片撤销按钮（整轮 `:140-162` / 逐文件 `ConversationFileSummaryPanel.tsx:381-389`）。粒度是"轮/文件"，不是"步骤（单次工具调用）"；checkpoint 列表 API 存在（`listWorkspaceCheckpoints`，`workspace-checkpoints.ts:98-131`，含 preview/diffRef）但**无 UI 消费方**（`grep listWorkspaceCheckpoints` 于 packages/ui、packages/shared：零命中）。
- **消息悬停倒带 △（形态不同）**：消息行动作常驻而非 hover-only（`ConversationRowView.tsx:1403-1424` 注释明确"动作行常驻（复制/编辑/时间）：hover 降噪方案在远控、触屏和大屏场景都出现过入口不可发现的问题"）。两条倒带路径：① 用户消息"编辑"（`:1411-1420`，`editUserQuery`，提交时可选 `workspaceMode: "preserve"|"rewind"` —— `packages/shared/src/zcode-protocol-v4/command.ts:170-188`，rewind 即"对话回退+文件恢复"，`rows.ts:25` 注释"rewind = editUserQuery 的 UI 入口"）；② 助手消息 "fork"（`:1611-1621`，TID_V4_FORK → `forkWorkspaceFromCheckpoint`，`workspace-checkpoints.ts:133-336` —— **分叉新会话**并恢复文件，不是原会话倒带）。
- **恢复三选一 △（能力等价、入口分散）**：CLI 层 `RewindScope` 全集存在：`RewindScope.Workspace`（只恢复文件，`applyFileRewind`，不截断聊天 —— `command.ts:5-6`）、`RewindScope.Conversation`（只回退对话，`rewind-message.ts:497` 等）、`RewindScope.Both`（`helpers/rewind.ts:90-92` 过滤可见）。但 UI 无单一"三选一"对话框：文件撤销走 `ConversationFileRewindDialog`（勾选文件→确认）；对话回退走编辑重发；"文件+对话"走编辑重发+rewind 模式；编辑冲突时另有"仅回退对话"回退按钮（`ConversationFileRewindDialog.tsx:291-310` `variant="editConflict"` + `onConversationOnly`）。
- **恢复前二次确认 ✔**：文件撤销有预检（safe/unsafe/ignored 分区 + 数量说明）+ 确认按钮（`ConversationFileRewindDialog.tsx:196-321`）；单文件入口若预检 unsafe 则确认禁用、绝不静默扩大范围（`fileRewindSelection.ts:4-17`）。
- **恢复前自动生成检查点以支持 Redo ✗**：CLI 全仓无 redo（`grep -rn "redo|Redo"` 于 `apps/zcode-cli/packages/core/src/runtime`：零命中）；恢复动作本身不产生新 checkpoint（checkpoint 只随工具调用生成，`tools.ts:171-253`）；UI 无"恢复后再回到恢复前"的入口。唯一相近机制是 `/rewind` 的 fork 动作（`rewind.ts:73-80`）与 `session.revert` 的消息分支保留（`methods/resume.ts:100-102`），均非 PRD 的 Redo。
- **保留策略（默认 100、超限删最旧留痕）✗**：artifact 存储无数量上限/裁剪逻辑（`adapters/src/storage/index.ts` 全文无 prune/limit；`grep retention|prune|deleteOldest|上限` 于该文件零命中；`ToolArtifactRetention = "session"|"project"|"temporary"`（`packages/contracts/src/interfaces/tool-artifact-store.port.ts:8`）只定义生命周期档位，无计数上限）；VS Code 扩展设置（`src/configSettings.ts`、package.json configuration）无检查点上限项。
- **历史视图留痕 ✗**：无超限删除，亦无留痕 UI。

> [复核:确认]（2026-11-07）换词重验：`\bredo\b|\bRedo\b` 于 CLI runtime/adapters、packages/services、packages/ui 仅命中白板组件 undo/redo（`WhiteboardPane.tsx:318`、`zh-CN.ts:1363` whiteboard.redo），CLI 运行时零命中；`rg -i "prune|retention|deleteOldest|删除最旧"` 于 `adapters/src/storage/index.ts`（498 行）零命中，`ToolArtifactRetention` 仅 `session|project|temporary` 三档（`tool-artifact-store.port.ts:8`，实读）；`listWorkspaceCheckpoints` 于 ui/shared/services/client 零消费方（独立重搜确认）；粒度单文件 `fileCount: 1`（`tools.ts:214,231`）与外部修改 hash 检测（`file-rewind.ts:472-481`）、editConflict 仅回退对话入口（`ConversationFileRewindDialog.tsx:35-36,146`）、`RewindScope` 全集存在于 runtime（`types.ts:752`、`internal-turn-methods.ts:126-156`）均实读确认。结论维持"大部分实现"，五个 △/✗ 子项不变。

### 17) 无障碍视图 Alt+F2 —— 未实现

- 全仓无 Alt+F2 绑定（`grep "F2"` 于 `apps/zcode-vscode/package.json`、`packages/shared/src/shortcutCommands.ts`：零命中）；无"逐段读当前回答"的无障碍视图组件（`grep -rni "accessib"` 于 apps/zcode-vscode/src、packages/ui/src 仅命中 aria-label 类基础无障碍实践与 CUA 设置节）。PRD 第 26 章的"Diff 键盘可达审查顺序"同样未见对应实现（diff 区域无 focus 顺序管理代码）。

> [复核:确认＋一处引注偏差]（2026-11-07）`F2` 于 `package.json`/`shortcutCommands.ts`/`keyboardShortcuts.ts` 零命中；`朗读|readAloud|逐段` 于 ui/扩展仅命中 aria `role="status"` 读屏与无关 persona/speaking 状态，无逐段读无障碍视图组件，Alt+F2 未实现维持。**偏差修正**：实读 PRD 后发现"Diff 键盘可达的审查顺序"在 PRD 中仅出现于 15.5 的括号引用"（第 26 章）"，而第 26 章实为「非功能需求」（性能预算/稳定性/兼容性，L1194-1221），并无 Diff 键盘审查顺序细则——故该子句应表述为"PRD 自身交叉引用落空（第 26 章无对应细则）"，而非"第 26 章的实现未找到"；这不改变 Alt+F2 未实现的主结论。

---

## 附：搜索范围与方法说明（"未找到"结论的依据）

- **关键词**：`ChangeSet|changeset`、`Hunk|hunk`（排除 chunk）、`workingSet|working_set|工作区改动`、`Ctrl+I|ctrl+i`、`转到侧栏|moveToSession`、`skip|跳过`（待执行动作）、`redo|Redo`、`retention|prune|deleteOldest|上限`（检查点）、`exportSession|exportMarkdown|导出会话|toMarkdown`、`caseSensitive|wholeWord|regex`、`alt+cmd|AltCmd`、`F2`、`favorite|星标|starred`、`reopen|recentlyClosed`。
- **范围**：`apps/zcode-vscode/src`（全部 88 个 ts/tsx 文件已列出并按需通读关键文件）、`packages/ui/src`、`packages/shared/src`、`packages/services/src`（session 索引/同步）、`apps/zcode-cli/packages/core/src/runtime`（含 methods/ 与 helpers/）、`apps/zcode-cli/packages/adapters/src/storage`、`apps/zcode-cli/packages/contracts/src`。
- **未运行**：未执行任何测试/构建/运行时验证（本任务为只读静态核对）；PRD 验收标准（如"拒绝中间 Hunk 后文件可编译""恢复后逐字节一致"）无法在不运行的情况下核实，报告中只针对实现存在性/形态下结论。

---

## 复核纪要（2026-11-07，独立复核员）

**方法**：对全部 16 条「未实现/部分实现/大部分实现」结论逐条独立验证，搜索关键词与文件范围均与原报告不同（新增覆盖 `packages/rpc/src`、`packages/client/src`、`apps/zcode-cli/packages/adapters|contracts` 层；`package.json` keybindings 用脚本结构化解析而非 grep；负面结论均先换词、再泛搜、再读实现文件确认）。复核方式为纯静态读码，未运行测试/构建。

**总裁决**：16 条负面/部分结论全部经独立证据确认（15 条 [复核:确认]，1 条 [复核:确认＋补充修正细节] 条目 12，1 条 [复核:确认＋一处引注偏差] 条目 17），无一条被推翻，无存疑条目。正面结论（条目 3/13）抽查亦一致。

**修正/补充与存疑条目汇总**：

1. **条目 12（多标签会话与快捷键族）——确认，附一处细节补充**：报告"无'最近关闭'栈"仅对**会话标签**成立。复核发现右侧 SidePane 标签（Diff/Terminal/Git/Browser）确有最近关闭恢复栈与可视化入口（`packages/ui/src/hooks/useAppPanels.ts:1621` `handleReopenClosedSidePaneTab`、`packages/ui/src/app-shell/SidePaneTabOverview.tsx:246`），但其恢复对象不是会话标签，且无 `Cmd/Ctrl+Shift+T` 键绑定（`shift\+t` 全仓仅 Shift+Tab 无关逻辑）。PRD 15.2"重开最近关闭的会话"仍判未实现，主结论不变。
2. **条目 17（无障碍视图）——确认，修正一处引注**：PRD 15.5 的"Diff 键盘可达的审查顺序"括号引用"（第 26 章）"落空——第 26 章实为「非功能需求」（PRD L1194-1221：性能预算/稳定性/兼容性），并无 Diff 键盘审查顺序细则。原报告"PRD 第 26 章的…同样未见对应实现"应改为"PRD 自身交叉引用落空"；不影响 Alt+F2 未实现的主结论。
3. **条目 11（会话列表）——确认，补充一条佐证**：`gode.openUsage`（`apps/zcode-vscode/src/commands/hostCommands.ts:137`）虽提供用量面板命令，但其推入的 `open-panel` 宿主帧在现行 webview 无订阅方（`App.tsx` 仅订阅 `workspace`/`session-switch`/`capabilities` 三种帧），用量面板实际不可达——比"属未挂载槽位体系"更进一步的死链证据。
4. **条目 8（审批/检查点口径）——确认，深挖一层**：QuickEdit 底层 `generateWorkspaceText`（`apps/zcode-cli/packages/core/src/runtime/methods/workspace-generate-text.ts:111-280`）实读确认只发 ModelRequest/ModelComplete 事件并记 usage fact，无权限请求、无 checkpoint 产出，口径分裂从插件侧下沉到 CLI 侧双重坐实。

**其余条目（1/2/3/4/5/6/7/9/10/13/14/15/16）**：均以独立关键词与（必要时更宽的）文件范围重搜并实读关键实现后确认，无修正。关键零命中项（ChangeSet、Hunk 状态机、Working Set、Ctrl+I、inline chat/ZoneWidget、转到侧栏、skip 待执行动作、redo（CLI 运行时）、prune/retention、F2、朗读组件、case/word/regex 查找选项、Alt+Cmd 组合键）均以不少于两套关键词复核。

**复核未覆盖**：PRD 各条验收标准的运行时行为（逐字节一致、可编译、断网提示等）未运行验证；`packages/web`、`packages/desktop` 未纳入本轮换词重搜范围（FR-07/08/09 的 webview 面以 `packages/ui` 共享壳为准，桌面/web 壳不改变插件侧判读）。
