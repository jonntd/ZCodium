# PRD 与工程实现全量对比报告

- 日期：2026-11-07
- PRD 原文：`/Users/jonntd/Downloads/vscode-all-in-one-prd.md`（v1.1，行号引用以该文件为准）
- 代码基线：monorepo `/Users/jonntd/ZCodium`，分支 `feat/vscode-editor-native`
- 本报告合并以下 5 份核对材料（全部存在，无缺失）：
  - 材料1 `report-fr01-fr02.md`（FR-01/FR-02，21 条，含独立复核纪要）
  - 材料2 `report-fr03-fr04.md`（FR-03/FR-04，16 条，深度调查原始结论，无复核标注）
  - 材料3 `report-fr05-fr06.md`（FR-05/FR-06，14 条，含独立复核纪要）
  - 材料4 `report-fr07-fr08-fr09.md`（FR-07/08/09，17 条，含独立复核纪要）
  - 材料5 `report-fr10-fr12-mcp-config.md`（FR-10/11/12 + 第 19/20/22/23 章，16 条，深度调查原始结论，无复核标注）
- 额外核对（本报告新做）：用 python 解析 `apps/zcode-vscode/package.json` 的 `contributes` 全量，对照 PRD 第 24/25 章（命令 30 条、keybindings 2 条、menus 8 组、configuration 8 项、viewsContainers/views 各 1、`activationEvents=["onStartupFinished"]`、`engines.vscode="^1.90.0"`、无 `capabilities` 声明）。注意：当前工作树 package.json 仍为 `gode` 版本，与最近提交「扩展改名 zcodium.code」存在未同步本地改动（`git diff --stat`：108 insertions / 113 deletions），本报告按工作树实况记录。
- 证据标注约定：`材料N #x` 指该材料第 x 条；`file:line` 为材料给出的代码证据；带 [复核:...] 的条目一律以复核后结论为准。

---

## 1. 执行摘要

### 1.1 整体架构差异

PRD 第 6 章设想的是**扩展内自研五层架构**：宿主层（贡献点/生命周期）、UI 层（Webview 界面）、Agent 层（会话状态机/模式/工具调度/子代理）、工具层（统一工具接口与审批拦截）、数据层（会话/检查点/配置/用量持久化），并给出 `src/{extension,host,agent,tools,providers,storage,protocol,webview}` 的目录结构建议（PRD L243-296）。**现状完全不是这个形状**：`apps/zcode-vscode` 是一个薄壳扩展——扩展 host 只做贡献点声明、host 帧桥接（`composer-insert`/`session-switch`/`workspace`）、少量平台方法（saveFile/showDiff 等）；聊天 UI 完全复用共享桌面壳 `@zcode/ui` 的 `Root`（12 层 Provider 栈，`apps/zcode-vscode/src/webview-react/App.tsx:171-189`）；Agent 层、工具层、数据层全部落在独立 CLI 运行时 `apps/zcode-cli/packages/{core,bootstrap,adapters,contracts}`；协议在 `packages/shared`；业务服务在 `packages/services`。PRD 设想的五层中，只有「宿主层」勉强对应扩展壳，「UI 层」对应共享 `packages/ui`（且与桌面端共用，非插件独有），其余三层由 CLI 运行时承担。架构身份也是 fork 自有品牌：命令前缀 `gode.*`、指令文件 `GODE.md`、全局目录 `~/.zcodium`（材料2 开篇）。这意味着 PRD 中凡是「CLI 运行时已有」的能力（bash 截断持久化、子代理、后台工作、MCP 状态、检查点、审批决策）在扩展里天然可见，而 PRD 假定「扩展宿主层」承担的功能（Agent Manager、Worktree 并行、会话集成终端、内联聊天、浏览器标签页、SecretStorage、月度用量桶、敏感扫描）在扩展壳与共享 UI 中均无实现（材料5「补充说明」）。

另一个系统性现象是**「已写好但未挂载」的半成品层**：扩展自有 `layout.tsx`（modelSelect/usage 等面板槽位）、`header/modelSelect.tsx`、`usage/usagePanel.tsx`、`SessionListPanel.tsx` 均有实现与单测，但当前 `App.tsx` 只挂共享 `Root`，这些面板无生产 importer；`gode.openUsage` 推送的 `open-panel` 宿主帧在现行 webview 无订阅方，实际不可达（材料4 #11 复核、材料3 摘要）；还有两处管道两端齐备、缺中间装配的回写半成品（`wrapAgentServiceForModelWriteback`、store stage `persistingWorkspace`，材料3 #2 复核）。

### 1.2 实现状态档位统计

五份材料共 **84 条对比条目**，按档位统计（带复核标注的条目以复核后结论为准）：

| 档位 | 条数 | 占比 | 分布说明 |
|---|---|---|---|
| ✅ 已实现 | 6 | 7% | FR-02 多行输入/附件芯片/Stop 标注/图表/Enhance（5 条）、FR-09 会话自动标题（1 条） |
| 大部分实现 | 4 | 5% | FR-07 文件卡片、FR-09 检查点、FR-10 子代理、FR-11 输出截断+看全文 |
| 🟡 部分实现 | 46 | 55% | 各模块主体骨架均在，普遍缺 PRD 规格中的具体子项 |
| ❌ 未实现 | 27 | 32% | 集中在：FR-08 内联聊天（整模块）、FR-10 Agent Manager/Worktree/Swarm、FR-11 会话终端/终端内联、FR-04 六档枚举与只读不可见、FR-06 三层/8 类开关、FR-03 索引/#引用/Token 校验、FR-01 三形态/多入口、FR-02 `!` 前缀/三动作下拉/占位文案、FR-05 Auto/Sticky Models |
| 口径不同 | 1 | 1% | FR-06 模式与默认审批强度（六模式机制 vs PRD Agent/Debug/Auto 映射） |

分模块速览：FR-01（9 条：部分 5 / 未实现 4）、FR-02（12 条：✅5 / 部分 4 / 未实现 3）、FR-03（9 条：部分 6 / 未实现 3）、FR-04（7 条：部分 3 / 未实现 4）、FR-05（8 条：部分 7 / 未实现 1）、FR-06（6 条：部分 3 / 未实现 2 / 口径 1）、FR-07（5 条：大部分 1 / 部分 3 / 未实现 1）、FR-08（5 条：部分 2 / 未实现 3）、FR-09（7 条：✅1 / 大部分 1 / 部分 4 / 未实现 1）、FR-10（5 条：大部分 1 / 部分 1 / 未实现 3）、FR-11（4 条：大部分 1 / 部分 1 / 未实现 2）、FR-12（2 条：部分 2）、第 22 章 MCP（2 条：部分 2）、第 19/20 章（2 条：部分 2）、第 23 章（1 条：部分 1）。

总体判读：**「对话主流程 + 模型接入 + 权限审批 + 检查点撤销 + 历史/会话管理」的骨架是完整且质量较高的**（多数为部分实现，且很多子能力超出 PRD，如队列面板拖拽排序、fork 分叉、SidePane 最近关闭栈、双 scope 查找）；**PRD 的差异化卖点层（逐 Hunk 审查、内联聊天、多 Agent 并行、会话终端、六档模式、三层审批、索引/Token 可视化）基本缺失**。未做任何运行时/真机验收：五份材料均为静态源码核对（PRD 各章验收标准的行为级验证未执行），本报告沿用该边界。

### 1.3 P0 缺口清单

PRD 第 28.1 章 M1（P0）范围 = FR-01、FR-02、FR-03（不含索引增强）、FR-04（6 档与 Plan）、FR-05 基础、FR-06（三层审批与 8 类授权）、FR-07、FR-08、FR-09、FR-11 会话终端基础、第 19/20 章基础、第 23 章基础。按此范围，P0 级缺失如下（细证据见第 2 节）：

| # | P0 缺口 | 依据 |
|---|---|---|
| P0-1 | **FR-08 内联聊天整模块未实现**：Ctrl+I 浮层、浮层内提问回答、内联 Diff Keep/Undo、转到侧栏会话全缺；现有 `gode.quickEdit` 是「选区改写器」（InputBox + 独立 diff 标签页 + 一次性生成），无会话、无浮层、不走审批/检查点 | 材料4 #6-#10 |
| P0-2 | **FR-07 ChangeSet/Hunk 数据模型未实现**：无轮级改动集、无逐 Hunk 接受/拒绝状态机、无 Working Set 展开区、无编辑器内联 Diff；现粒度为「轮/文件」，部分接受=按文件勾选撤销 | 材料4 #1/#2 |
| P0-3 | **FR-11 会话终端未实现**：扩展从不创建集成终端，Agent 命令在 CLI 执行器跑、输出经工具行回流；`!` 前缀直执行（FR-02 [必须]）也无 | 材料5 #6、材料1 #17 |
| P0-4 | **FR-04 六档模式枚举整体不符**：实际为 build/edit/plan/yolo/guarded/auto（auto 显式未实现），Ask/Quick Ask/Debug 不存在；只读模式「工具不可见」未实现（实际 deny 报错）；默认模式不可配置 | 材料2 #10-#12、材料3 #10 |
| P0-5 | **FR-06 三层审批与 8 类授权开关未实现**：无 L2 分类模型代审、无 8 类开关 UI；审批为模态弹窗非消息流内联、无 Diff 预览入口、无风险标注；yolo 模式压过 deny 规则（与 PRD「deny 大于一切」相反） | 材料3 #9/#11/#12/#13/#14 |
| P0-6 | **FR-03 隐式上下文发送链路断线**：收集器齐备但组装链 `buildPrompt` 全仓无调用点，自动上下文不生效；上下文条默认「工作区+当前文件」无、Token 估算/80% 警告/发送校验无；`#` 引用不存在 | 材料2 #1/#2/#4/#6 |
| P0-7 | **FR-01 布局与入口缺半**：仅侧栏单一形态，三形态停靠/位置记忆/Open in New Tab/New Window 未实现；编辑器标题栏入口、Ctrl+Alt+I、Cmd/Ctrl+Esc 缺失；Activity Bar 运行任务数字角标无 | 材料1 #1/#2/#5/#6/#7 |
| P0-8 | **FR-02 发送中行为缺 PRD 规格**：无三动作下拉（Add to Queue/Steer/Stop and Send）、无队列上限 10、Continue 是「合成『继续』文本重发」而非原轮续跑、占位文案无模式名/快捷键插值 | 材料1 #11/#13/#15 |
| P0-9 | **密钥未存 SecretStorage**（PRD 19.1/20.5/23.3 [必须]）：扩展侧 `SecretStorage` 零命中，个人供应商 API Key 落 `provider_config.json`（0o600 原子写）——有加密意识但违反「密钥不进普通文件」的 P0 验收 | 材料3 #4/#5 复核 |
| P0-10 | **FR-09 检查点收尾项缺**：Redo 无（恢复动作不生成恢复前检查点）、保留上限 100 无、无障碍视图 Alt+F2 无；历史全文搜索语料不含工具输出 | 材料4 #14/#16/#17 |
| P0-11 | **第 19 章存储子项**：检查点为等价快照（合规✅）但用量「按月分桶」未实现（本地无月度口径，仅套餐周期额度） | 材料5 #17、材料3 #7 复核 |
| P0-12 | **第 20 章设置界面**：13 标签名目与 PRD 不一致、无「值来自哪一层」的来源层标注、无会话内临时设置层、图形表单↔配置文件双向同步为单向写回+回读 | 材料5 #16 |

---

## 2. 逐模块对比

### 2.1 FR-01 入口与布局（PRD 第 7 章，P0）——材料1 #1-#9

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| Activity Bar 图标 + 运行中任务数字角标（7.2） | 🟡 部分实现 | 图标：`apps/zcode-vscode/package.json:29-35`（viewsContainers.activitybar，icon `media/gode.svg`）；角标：仅 `src/ui/statusBar.ts:66-67` 状态栏审批 `⚠ n` | 图标有；Activity Bar 数字角标无（VS Code 稳定 API 也无容器图标角标，需 TreeView/状态栏承担）。[复核:确认] |
| 编辑器标题栏图标入口（7.2） | ❌ 未实现 | `contributes.menus` 8 组无 `editor/title`（仅 `editor/title/context` 变体 package.json:296-301）；`grep createWebviewPanel` 于 src 零命中 | 无「编辑器右上角打开会话」入口。[复核:确认] |
| 状态栏状态区：七态枚举、出错红色、点击查看详情（7.2） | 🟡 部分实现 | `src/ui/statusBar.ts:11-17`（inactive/starting/ready/busy/crashed/restarting 六态）、`:29-33` crashed 红色 `editorError.foreground`、`:45` command=`gode.openChat`、审批角标 `:66-68`（数据源 container.ts:739-747） | 六态 vs PRD 七态（无思考中/读文件/写代码/等输入/运行命令细分，这些细分仅存在于 webview 内部 ConversationTurnGroup.tsx:665-683 不投影到状态栏）；出错红色✅；「查看详情」无专用动作（点击=打开面板）。[复核:确认] |
| 命令面板提供 24.1 全部 12 条命令（7.2） | 🟡 部分实现 | `contributes.commands` 共 30 条（python 实测，PRD 24.1 12 条）：New Conversation=`gode.newSession`、Manage MCP=`gode.openMcpSettings`、Generate Tests=`gode.writeTests`、Review Code=`gode.reviewChanges`、Insert @-Mention≈`gode.addToContext`（editorCommands.ts:109-141 push `composer-insert` 帧） | 12 条中 7 条缺失：Open in New Tab/New Window/Sidebar、Open Agent Manager、Focus Input、Reopen Closed Session、Set Background；Insert @-Mention 语义等价但名称与 Alt+K 键位不符（实际 ctrl+alt+a）。另发现缺陷：`menus.view/title` 的 when 全写陈旧 `view == code.chat`（实际 `gode.chat`，chatPanel.ts:15），5 条 view/title 菜单项不显示。[复核:修正→部分修正] |
| `Ctrl+Alt+I` 打开并聚焦聊天输入框（7.2/24.2） | ❌ 未实现 | keybindings 全量仅 2 条（ctrl+alt+k、ctrl+alt+a）；`gode.openChat` 仅 `view.show(true)`（hostCommands.ts:98、chatPanel.ts:52-54）；webview `requestComposerFocus`（ConversationComposer.tsx:1073）无宿主→webview 聚焦帧 | 键位无、聚焦链路断裂（打开面板≠聚焦输入框）。[复核:确认] |
| 面板三形态停靠（左栏/右栏/编辑器标签）+ 同会话互通 + 位置记忆（7.3） | ❌ 未实现（仅侧栏单一形态） | chatPanel.ts:4 注释「插件原生形态（唯一形态）」；单实例单视图（chatPanel.ts:19、hostRuntime.ts:120-148 固定 id）；无 workspaceState 布局持久化 | 三形态、互通、位置记忆全部未实现，仅依赖 VS Code 原生视图布局。[复核:确认] |
| `Cmd/Ctrl+Esc` 编辑器与聊天焦点切换（7.3/24.2） | ❌ 未实现 | keybindings 2 条无 Esc；`grep Escape` 于 src 仅 quickEdit.ts:56 提示文案 | 无任何焦点切换逻辑。[复核:确认] |
| 无模型引导态：提示配置、输入框禁用、历史可看（7.4） | 🟡 部分实现 | 门禁 `packages/ui/src/v4/composer/useDraftModelReadinessGate.ts:29-33/:133-157/:175-182`；横幅 `ChatErrorBanner.tsx:164,244-255`（code `model_config_missing` → 「设置模型」跳转）；「历史可看」✅（gate 仅草稿态 sessionId===null，:52） | 门禁拒发+拒启动+横幅引导齐备；「输入框禁用」未做（textarea disabled 不因无模型置 true，ConversationComposer.tsx:2589）。注意 PRD 任务提示中点名的 welcomePage.ts 实为 CLI 未找到引导、onboarding.ts 为 Claude 导入引导，均非无模型引导。[复核:确认] |
| Webview 回收后重开恢复会话与滚动位置（7.4） | 🟡 部分实现 | 会话✅：`extension.ts:31-33` retainContextWhenHidden + bootstrap `data-session-id`（chatPanel.ts:66-89、container.ts:318-327/:397）；滚动🟡：`packages/ui/src/lib/chatSessionScrollMemory.ts:13` 模块内存 Map（LRU 200，:29-38） | 会话恢复成立；滚动记忆仅 webview 单生命周期内有效，销毁重建清零，「跨回收恢复滚动位置」不成立。[复核:确认] |

### 2.2 FR-02 聊天输入框与消息流（PRD 第 8 章，P0）——材料1 #10-#21

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| 多行自适应高度；Enter 发送/Shift+Enter 换行；发送键可配置（8.2） | ✅ 已实现 | `packages/ui/src/LexicalChatInput.tsx:1575`（min-h-10 max-h-40）、`:542-687`（Enter/Shift+Enter/Ctrl+Meta+Enter）；`shortcuts/composerShortcuts.ts:28-53` 可改绑 | 无差距 |
| 占位文案显示当前模式名与发送快捷键（8.2） | ❌ 未实现 | `packages/ui/src/lib/chatPlaceholder.ts:20-25` 三态静态文案（zh-CN.ts:4980-4983）；快捷键仅在发送按钮 tooltip（ConversationComposer.tsx:1889-1902） | 无模式名与快捷键插值。[复核:确认] |
| 粘贴图片/拖文件转附件，芯片可预览可删除（8.2） | ✅ 已实现 | `useComposerAttachments.ts:848-869`（粘贴）、`:937-994`（拖入）；芯片删除 ConversationComposer.tsx:2051-2053；预览 :2058-2079（gallery/PDF/图标） | 无差距 |
| 发送中按钮变下拉：Add to Queue / Steer with Message / Stop and Send；队列上限 10（8.3） | ❌ 未实现（语义用其他形态承担） | 生成中为独立停止按钮（ConversationComposer.tsx:2357-2374，无 DropdownMenu）；排队/转向=设置默认 `guide|queue` + Ctrl/Cmd+Enter 反向投递（followupModeSettings.ts:4-16、ConversationComposer.tsx:1698-1714）；队列面板✅可拖拽/编辑撤回/删除/立即发送（ConversationQueuePanel.tsx:382-405）；队列上限：`PROTOCOL_V4_LIMITS`（shared/zcode-protocol-v4/core.ts:64-110）与 CLI 准入（steering.ts:222 起）均无条数门 | 无下拉三动作、无 10 条上限与「先处理队列」提示。[复核:确认] |
| Stop 保留已产出文本并标注「已停止」（8.3） | ✅ 已实现 | ConversationComposer.tsx:1734-1736；`chat.history.stopped`=「已停止」（ConversationTurnGroup.tsx:674-678、zh-CN.ts:5047）；停止后队列保留（zh-CN.ts:6259） | 无差距 |
| Continue 用原模型原模式续跑被打断的那一轮（8.3） | 🟡 部分实现（语义偏差） | `composerContinueAction.ts:5-12`：空格拼接「继续」文案走同一 submit 通路（ConversationComposer.tsx:1764-1794）；按钮常驻仅 disable（:2461-2476） | 非「原 turn 恢复」；「输入框为空时才出现」未实现。[复核:确认] |
| 斜杠命令菜单（分组/模糊搜索/Esc/方向键）+ 内置 9 命令（8.4） | 🟡 部分实现 | 菜单✅：`slashCommandPanelSections.tsx:20-91`（commands/skills/subagents 三组）+ `slashCommands.ts:5-36` 模糊搜索 + MentionPlugin.tsx:620-700 键盘交互；目录只有 `goal/workflow/compact/init`（bootstrap/src/slash-command-surface.ts:8-13）+ CLI 帮助表 20 条（packages/shared/src/zcode-slash-command-help.ts） | PRD 的 `/clear /usage /test /review /explain /improve /docstring /fix` 中：`/clear` 仅 CLI 终端侧 `/new` 别名（slash-commands.ts:160）不在聊天面板，其余 7 个均无；UI 明确「命令目录必须完整来自 CLI catalog，不追加内建命令」（ConversationComposer.tsx:2621-2626）。测试/审查能力以编辑器命令形态存在（editorCommands.ts:175/:232）。[复核:确认] |
| `!` 前缀直接执行终端命令、回显输出与退出码、不计用量（8.4） | ❌ 未实现 | 全仓 `startsWith("!")`/bang/bashMode 零命中；CLI command-center 入口判定 `if (!input.startsWith("/")) return null`（slash-commands.ts:41） | 无该消息类型与执行路径。[复核:确认] |
| 图片附件单条上限 5 张；语音输入（8.5） | 🟡 上限口径不同 + ❌ 语音 | `MAX_CHAT_ATTACHMENTS = 8`（chatAttachments.ts:37）按**全部附件**计数，溢出 revoke+toast（useComposerAttachments.ts:715-731）；语音：无 MediaRecorder/转写链路（`mic-selector.tsx` 为无消费方死组件） | 上限 8≠5 且口径为全部附件非图片；语音无。[复核:确认+补充] |
| 对话内图表渲染、生成图片内嵌+Save（8.5 可选/应该） | ✅ 已实现（Mermaid 口径） | mermaid-block.tsx（@streamdown/mermaid）、message.tsx:1530 MarkdownImage、image-preview-dialog.tsx:329-370 → container.ts:647-682 saveFile | 「结构化图表数据」若指通用图表组件未见用于对话流；以 Mermaid 为准 |
| Enhance Prompt 改写按钮（8.6 P1） | ✅ 已实现 | ComposerEnhanceButton.tsx:46-91：回填不自动发送、失败保留原文、Ctrl+/ 快捷键（:93-98） | 无差距 |
| 消息流：角色样式、工具默认折叠、代码块复制+「插入到光标」「应用为改动」、平滑追加、上滚暂停滚动、悬停复制/倒带/重新生成（8.7） | 🟡 大部分实现 | 角色样式/默认折叠✅（ToolLayout.tsx:115-117）；复制✅（code-block.tsx:448-502）；上滚暂停✅（timelineScrollAnchor.ts:4-8）；悬停动作=复制/赞/踩/分叉（ConversationRowView.tsx:1466-1644）；「插入到光标」「应用为改动」❌（zh-CN.ts:1722-1733 无词条）；重新生成❌（onRetry 全链路传透但 JSX 不渲染，:250-251 注释）；平滑追加🟡（无文本动画层） | 缺代码块两个动作与重新生成入口；「倒带」以 fork 分叉替代（另有文件级 rewind 与 CLI /rewind）。[复核:确认] |

### 2.3 FR-03 上下文系统（PRD 第 9 章，P0）——材料2 #1-#9

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| 隐式上下文自动包含当前文件/选区/诊断，上下文条一行摘要可点开（9.2 [必须]） | 🟡 部分实现（能力在，发送链路断线） | 收集器齐备：`src/features/contextCollector.ts:37-123`；但组装链 `buildPrompt`（:361-420）全仓无调用点；`gode.autoContext` 设置（featureConfig.ts:58）无消费者；实际生效路径=显式命令 `gode.addToContext`（editorCommands.ts:236-255）+ 诊断注入（webview-react/index.tsx:200-222、injection.ts:78-90） | 自动上下文实际不生效——P0 [必须] 的实质缺口；「一行摘要上下文条」不存在 |
| 显式上下文条常驻输入框上方，默认工作区+当前文件，芯片 hover/预览/移除（9.3） | 🟡 部分实现 | chip 行：`ConversationComposer.tsx:2261-2294` 四类特化 chip + `ContextAttachmentPill.tsx`（hover 浮层+叉号） | 默认「整个工作区+当前文件」无；chip 仅 4 种特化场景非通用上下文条；文件类 mention pill 无 hover 预览/叉号；扩展自有 selectionChip.tsx/mentionSource.ts 已写好未挂载 |
| 可添加类型：选区/文件/文件夹/外部文档/其他仓库/图片/网页抓取（9.3） | 🟡 部分实现 | 文件/文件夹 `gode.addFileToContext`（editorCommands.ts:281-300、editorContextFiles.ts:60-64）；选区 contextFromSelection；图片走附件；另有 git diff（git.ts:113-119）、终端选区（terminal.ts:30-34） | 外部文档、网页抓取、Workspace Context 芯片缺失（`gode.context.additionalDirectories` 仅设置项 config.ts:35 传 CLI，非芯片） |
| 芯片 Token 估算、80% 变色警告、发送校验裁剪不静默截断（9.3） | ❌ 未实现 | `turnStats.ts:16` estimateTokens 仅轮次统计；`ComposerContextMeter.tsx` 是会话上下文占用环，无 80% 阈值告警 | 全缺 |
| `@` 引用：@file 模糊搜索、@文件#起止行、@terminal、@workspace（9.4） | 🟡 部分实现 | MentionPlugin.tsx（@ 触发）+ mentionSearch.ts + fileMentionProvider.ts；行范围以选区生成 pill（pendingContext.ts:34-42） | 无 `@文件#起止行` 语法解析；@terminal/@workspace 无——`mentionSource.ts:8-10` 明注「@symbol、代码库索引：明确不做（PRD P1-4.3 降级口径）」 |
| `#` 引用：#file/#folder/#codebase/#selection/#terminalSelection/#terminalLastCommand/#fetch（9.4） | ❌ 未实现 | MentionPlugin.tsx:169-174：`#`=sessions、`$`=skills、`@`=文件 | PRD 口径的 # 体系不存在；近似替代为 `gode.sendTerminalSelection`、`gode.addToContext` |
| 编辑器聚焦 Alt+K 插入 @ 引用并聚焦聊天（9.4/24.2） | 🟡 部分实现（键位行为均不同） | keybindings：ctrl+alt+k→quickEdit（改写选中代码）、ctrl+alt+a→addToContext（push composer-insert 后 openChat） | 功能近似、键位与语义均非 PRD 的 Alt+K 插 @ 引用 |
| 索引状态四态/进度重放/.aiignore/大文件符号大纲（9.5，状态显示 P0） | ❌ 未实现 | 全仓无 codebase 索引；`.aiignore` 零命中（文件搜索用 `.zcodeignore`，fileService.ts:206,275）；大文件 >256KB 只给路径 chip（editorContextFiles.ts:6,17-23） | 无索引、无四态、无重试；大文件是截断策略非符号大纲 |
| 项目规则文件：AGENTS.md 主、CLAUDE.md/.clinerules 只读导入、冲突提示、设置页可编辑且新消息即时生效（9.6 [必须]） | 🟡 部分实现 | AGENTS.md✅：CLI `adapters/src/context/index.ts:24/:204-243`（DEFAULT_PRIORITY_FILES、逐级向上+全局 `~/.zcodium/AGENTS.md`）、注入系统提示（request-user-context.ts:44-76）；CLAUDE.md 仅扩展设置页一次性导入（container.ts:835-862，GODE.md 优先命中即止）；`.clinerules` 无；设置页编辑的是 customSystemPrompt（WorkspaceInstructionsPanel.tsx，「随下次会话生效」） | 无运行时自动合并与冲突提示；「对新消息立即生效」不成立 |

### 2.4 FR-04 模式系统（PRD 第 10 章，P0）——材料2 #10-#16

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| 6 档模式：Ask/Plan/Agent/Auto/Debug/Quick Ask，各自能读/能改/能跑/审批方式（10.2 [必须]） | ❌ 未实现（枚举不符） | 实际枚举 `CollaborationMode = "plan"\|"build"\|"edit"\|"yolo"\|"guarded"\|"auto"`（contracts/src/interfaces/session.port.ts:32）；UI 目录 build/guarded/plan/yolo+遗留 edit（packages/shared/src/zcode-agent-model-state.ts:19-45）；`auto` 被显式 deny「Auto mode is reserved but not implemented yet」（core/src/permission/service.ts:159-166） | Ask/Agent/Auto/Debug/Quick Ask 五档名不存在；ask/debug/quickAsk 全仓 0 命中；权限映射是另一套现实体系（service.ts checkBuildMode/checkPlanMode 等）。这是与 PRD 冲突最大的单一模块 |
| 切换入口唯一 + 新会话默认模式可配置（默认 Agent）（10.3） | 🟡 部分实现 | 入口≥2：composer 模式选择器（V4ComposerModeControls.tsx）+ 会话头部 modelSelect.tsx:31 `switchCollaborationMode`；CLI 还可经 EnterPlanMode 工具自切（plan-mode.ts:130）；默认模式：`gode.mode` 设置自述「不读取本设置」（package.json），新任务草稿硬编码 "build"（newTaskDraft.ts:26） | 入口不唯一；默认模式实际不可配置 |
| 只读模式工具「不可见」而非报错（10.3） | ❌ 未实现 | plan 模式非只读工具走 deny「mode.plan.nonReadOnly」（service.ts:482-488）；`getTools` 无按模式过滤（config.ts:169-183） | 与 PRD 相反：是报错/拒绝而非隐藏 |
| 模式切换只影响下一轮，进行中一轮执行到底（10.3） | 🟡 部分实现（两路行为不一致） | 满足侧：composer 选择器只编辑草稿（V4ComposerModeControls.tsx:44）+ 提交瞬间冻结执行配置（composerSubmissionConfig.ts:22）；不满足侧：会话头部 switchCollaborationMode 即时生效，协议层自认「无 active turn guard」（model-config.ts:74） | 进行中的一轮可能被中途换模式 |
| Plan 模式：Markdown 方案在编辑器标签页打开、分段批注、可反复修改、不自动落盘（10.4 [必须]） | 🟡 部分实现 | 已实现：EnterPlanMode/ExitPlanMode（plan-mode.ts:107-190）、只读策略、方案审批弹窗 approve=执行/freeText=反馈（interaction-broker.ts:433-457） | 未实现/相反：方案不在编辑器标签页打开；无分段批注（仅单一 freeText）；**批准后自动落盘 `.zcode/plans/plan-<sessionId>.md`**（plan-file-continuity.ts:22-28、plan-mode.ts:218-232）——与 PRD「保存在会话内不自动落盘」直接相反 |
| Debug 模式（P1）（10.5） | ❌ 未实现 | grep debug mode/test loop 无命中 | 无复现→定位→假设→改动→测试循环、无 5 次上限 |
| 自定义 Agent（P1）（10.6） | ❌ 未实现（PRD 形态） | `.agents/` 只用于 skills（skills/roots.ts:108-119）；subagent 体系是内置两类 general-purpose/explore（subagent/profile.ts:29-35）；模式选择器无「自定义」分组 | Markdown+frontmatter 的自定义 Agent 定义不存在 |

### 2.5 FR-05 模型接入与供应商管理（PRD 第 11 章，P0）——材料3 #1-#8

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| 模型选择器与模式选择器并排、显示供应商+模型名、可搜索、按供应商分组（11.2） | 🟡 部分实现 | 位置/并排✅：`V4ComposerToolbar.tsx:1119-1158`（ModelConfigSelect）与模式下拉并排；显示✅（modelTriggerDisplay.ts:39-50）；分组✅（ModelConfigSelect.tsx:386-404）；可搜索❌（grep search/filter 零命中）[复核:确认] | 缺搜索框；扩展自有 header/modelSelect.tsx 面板为遗留未挂载件（PluginHeader 无 importer，仅 test/switchCommands.test.ts:30 引用） |
| 切换作用域：默认当前会话下一轮；可设全局默认；中途换模型按新上限重校验（11.2） | 🟡 部分实现 | 会话级✅：switchModelConfig CAS（model-config.ts:69-96）→ session-facade.ts:644-697 → 下一轮 intent.modelSelection（input-facade.ts:217,255,279,381）；「改全局默认」❌无 UI；重校验：auto-compact 按当前模型 contextWindow（compact/policy.ts:90-155） | 全局默认切换入口缺失（回写半成品两端存在：`wrapAgentServiceForModelWriteback` hostSettingsBridge.ts:284-317 与 store stage `persistingWorkspace`，无装配点）[复核:确认]；切换时的用户可见超限提示无——存在完整死文案 `chat.modelSwitch.contextWindowGuard.*`（zh-CN.ts:5250-5258，全仓无代码引用）[复核:补充] |
| 供应商管理：增删改/设为默认/连通性测试/API Key 存 SecretStorage/模型自动拉取（11.3 [必须]） | 🟡 部分实现 | 新增✅（ModelProviderSection.tsx:990-1001）、删除✅（modelProviderActions.ts:6-48）、编辑✅（InlineEditableProviderCard）、连通性✅（providerSettingsConnectivity.ts:25-46）、拉取✅（modelhubFetchModels.ts:14-36）；「设为默认」❌；SecretStorage❌（grep 零命中）：API Key 落 `provider_config.json` 0o600（runtime-paths.ts:5、privateFilePersistence.ts:100） | 缺「设为默认」；密钥非 SecretStorage——P0 验收项（23.3「SecretStorage 之外搜不到密钥落盘」）不过 [复核:确认] |
| 内置类型 Anthropic/OpenAI/Google/OpenAI 兼容/Ollama；BYOK 界面声明（11.3） | 🟡 部分实现 | 枚举仅三类型：anthropic-messages/openai-chat-completions/openai-responses（provider-data-schema.ts:3-8）；Ollama 无适配（唯一命中为 bash 命令元数据表）；gemini 仅遗留数据兼容读取（legacyModelProviderSerialized.ts:26-36）；BYOK 仅套餐文案（zh-CN.ts:3318），「本体免费/不做二次计费」声明零命中 | Google/Ollama 原生类型缺；通用 BYOK 免费声明缺 [复核:确认+补充] |
| Auto Models / Sticky Models（11.4，P1） | ❌ 未实现 | 换词 stickyModel/autoModel/modelRouting 全仓仅 1 条测试注释；设置分区清单无模型策略页（settingsPageConfig.ts:53-185） | PRD 标 P1，如实记录 [复核:确认] |
| 用量显示：会话用量+费用、本月累计、按会话/按模型明细、与 /usage 一致（11.5 [必须]） | 🟡 部分实现 | 会话累计/每轮行✅：扩展自有 usagePanel.tsx:56-186（属未挂载 layout 槽位体系，`open-panel` 帧无订阅方）；跨会话按模型明细✅：共享设置页「使用情况」分区（settingsPageConfig.ts:172 → AppUsagePanel.tsx:96-113，schema usage-stats.ts:181-185，source agent-db）[复核:修正]；30d 滚动区间✅（usage-stats.ts:178）；费用❌（grep cost 零命中）；自然月口径❌；`/usage` 命令❌（CLI 斜杠注册表亲读无 usage） | 无费用估算、无自然月累计、无 /usage 口径可对齐 [复核:修正→按模型明细与近似月度口径实存在] |
| 失败分类显示/重试 2 次/不做故障转移（11.6 [必须]） | 🟡 部分实现 | CLI 分类齐全：401/403→ProviderNotConfigured、429→ModelRateLimited、529→Overloaded、上下文超限（failure-classifier.ts:128-227）；UI 套餐业务码分类+恢复动作✅（providerBusinessError.ts:16-103、ChatErrorBanner.tsx:260-285 详情展开+复制 TraceID）[复核:修正]；重试：默认 10 次（DEFAULT_MAX_RETRIES=10，retry-policy.ts:13,28）；无故障转移✅ | 重试 10 次 ≠ PRD 的 2 次；个人供应商原生 401/403 无本地化鉴权引导文案（分类仅覆盖套餐业务码域）[复核:确认] |

### 2.6 FR-06 权限与审批（PRD 第 12 章，P0）——材料3 #9-#14

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| 三层审批 L1 逐步/L2 分类模型代审/L3 全自动（显式开启、常驻可见）（12.2 [必须]） | ❌ 未实现为三层模型 | L2 代审无（grep classifier/triage 零命中；`autoApproveHighRisk` 静态布尔默认 false，service.ts:731,738）；L3 等价物**存在**：审批窗「完全访问」完整闭环（product-projection.ts:3475-3487 合成 fullAccessOption → PermissionDialog zh-CN.ts:6362-6363 → interaction-registry.ts:181-200 → permission-full-access.ts:54 切 yolo+receipt，新建会话回 build 默认）[复核:修正] | L1/L2/L3 命名体系与 L2 分类代审不存在；实际决策轴=模式×工具能力自报×规则集（checkPermission :99-273）；L3 开关在审批窗内而非设置页常驻开关 |
| 模式与默认层级：Agent/Debug 默认 L1、Auto 默认 L2（12.2） | ⚠️ 口径不同 | 六模式默认强度表（build 只读 allow/critical ask；edit workspace 编辑 allow；plan 只读+deny 其余；guarded 危险 ask；yolo 直通；auto deny）——service.ts 各分支 + configSettings.ts:29 默认 build | 无 Agent/Debug/Auto 模式名，映射不成立；build 默认强度接近 L1 但低风险自动放行 [复核:确认] |
| 8 类授权开关（读项目内/外、改项目内/外、跑安全/全部、浏览器、MCP）（12.3 [必须]） | ❌ 未实现 | 无八类开关 UI（设置目录 grep 零命中）；实际轴=riskLevel×sideEffectScope×readOnly/destructive/needsApproval/alwaysAsk（service.ts:39-53、contracts model/index.ts:476-483）；`PermissionCapabilityGroup` 仅 `official_cua`（permission.port.ts:12-14）；项目外维度靠 additionalDirectories（hostSettingsBridge.ts:23,130） | 8 类开关与「改项目外/跑全部首次二次确认」均无；默认行为近似覆盖核心意图但非 PRD 形态 [复核:确认] |
| 细粒度规则 Tool+glob→allow/ask/deny；随项目配置两处同源；deny>ask>allow（12.4 P1） | 🟡 部分实现 | 规则形状✅：PermissionRuleset（permission.port.ts:24-32）+ prefix/*/精确匹配（service.ts:330-343、bash-command-rule-evaluator.ts:16-45）；扩展设置 `gode.permissions.allowlist/denylist`（package.json:329-344）仅 allow/deny 两态；存储为 sqlite local_settings 而非项目配置文件（local-settings.ts:10-45）；优先级 deny>ask>allow 成立，**但 yolo/guarded 直通先于 deny**（service.ts:155-157 先于 :168/:177，代码注释自认 :366） | 无 ask 态、无图形化编辑/撤销 UI、非「两处同源」；yolo 压过 deny 与 PRD「deny 大于一切」相反——真实冲突点 [复核:确认] |
| 审批交互：消息流内、Diff 预览入口、命令全文、风险标注、deny 说明来源、无超时（12.5 [必须]） | 🟡 部分实现 | 内容✅（工具名+分类预览块 PermissionDialog.tsx:277-336、命令全文 ExecuteCommand.tsx:27-40 可展开）；批准/拒绝/记住✅（allowAlways 写入规则）；deny 带来源分类✅（rule.project.deny/rule.disallowedTools）；无超时✅（broker.ts:108-126，bootstrap/cli 未配 permissionTimeoutMs）；弹窗形态❌（V4InteractionDialogs.tsx:327-371 + SessionPane.tsx:5113 overlay，非消息流内联；v4 投影带 anchorRowId 锚定工具行）；Diff 入口❌（inlinePreview type:"none"、onOpenCodeViewer undefined，:388/:397/:410）；风险标注❌（三文件 grep 零命中） | 审批时刻看不到 Diff（Diff 预览由消息流面板承担）；无管道/重定向/删除风险标注 [复核:确认] |
| 终端命令白名单：设置页两张命令模式列表；拦截命中不弹审批（12.6 [必须]） | 🟡 部分实现 | 两列表为 VS Code settings JSON 数组（package.json:329-344，Tool/Tool(args) 形式）经 normalizeToolRules 透传；deny 不弹审批✅（service.ts:177-181）；bash 只读/危险命令策略是内置判定（bash-command-permission-policy.ts:15-28） | 无独立命令模式白名单设置页；**例外**：yolo/guarded 直通先于 deny 检查——yolo 下 denylist 不拦、guarded 下 denylist 危险命令先弹审批 [复核:确认] |

### 2.7 FR-07 改动审查与 Diff（PRD 第 13 章，P0）——材料4 #1-#5

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| ChangeSet/Hunk 数据模型：轮级改动集+整体状态+Hunk 为最小接受/拒绝单位（13.2 [必须]） | ❌ 未实现 | `rg changeset` 全仓零命中（含 rpc/client/adapters 层）；`hunk` 仅 diff 文本解析显示（patchDiffPreview.ts:36-176）；实际结构=checkpoint artifact 单文件（rewind.ts:58-81，fileCount:1，tools.ts:214/231）+ 轮级快照投影 | 无「待审/部分接受/已接受/已拒绝」状态机；最接近的部分接受=按文件勾选撤销（fileRewindSelection.ts:10-17），粒度文件非 Hunk [复核:确认] |
| 三种审查视图共用改动集：并排 Diff（逐 Hunk 操作、先编辑新文本）/内联 Diff（Keep/Undo）/Working Set（输入框上方）（13.3 [必须]） | 🟡 部分实现 | 数据同源✅（fileChanges 快照+snapshot before/after，messageChangeSummaryPreview.ts:9-61）；审批 Diff=`diffViewer.ts:69-86` 磁盘文件+虚拟文档，非 vscode.diff 双栏、只读无 Hunk 操作，且 showDiff 平台方法无任何调用方（休眠路径）[复核:确认]；内联 Diff Keep/Undo ❌；Working Set ❌（改动摘要在消息流内 ConversationTurnGroup.tsx:1680 非输入框上方） | 三视图均不达 PRD 规格；「不依赖 Git」满足（数据来自 checkpoint） |
| 文件卡片：折叠组、增删行数、点开并排 Diff、Undo（13.4 [必须]） | 大部分实现 | MessageChangeSummaryPanel.tsx:101-163（+/- 行数 :134-137/:226-233）、点开 diff :193-249、整轮 Undo :140-162、逐文件 Undo（ConversationFileSummaryPanel.tsx:161/:380-384/:432）；快照来源=checkpoint（file-rewind.ts:41-53） | 点开的是 webview 内代码查看器 diff，非 VS Code 原生 diff [复核:确认] |
| 动作展开与纠正：每步可展开、跳过待执行动作、停止整轮、执行中 Steer（13.5 [必须]） | 🟡 部分实现 | 展开✅（ToolCallBlocks 渲染器族）；停止✅（gode.stop，editorCommands.ts:265-283）；Steer✅（guide 通道→steerTurn，tool-result-settlement.ts:252-258）；跳过待执行动作❌（skipStep/skipAction/跳过 零命中） [复核:确认] | 缺「跳过某个待执行动作」 |
| 冲突处理：外部修改标记冲突、二进制文件级处理、部分 Hunk 行号重算（13.7 [必须]） | 🟡 部分实现 | 外部修改检测✅但在撤销侧：file-rewind.ts:472-481 hash 比对→unsafe `external_modified` 整体拒绝，UI 呈现（ConversationFileRewindDialog.tsx:41-52/:244-252）；二进制不进快照面（rewind.ts:38-58 要求 structuredPatch）→「文件级接受/拒绝」UI 无；行号重算不适用（无逐 Hunk 机制） [复核:确认] | PRD 场景是「应用 Hunk 时对不上」，实现只覆盖「撤销时文件被外部改过」 |

### 2.8 FR-08 内联聊天（PRD 第 14 章，P0）——材料4 #6-#10

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| Ctrl+I 选区上方浮出输入框、显示作用范围（14.2 [必须]） | ❌ 未实现 | keybindings 无 Ctrl+I（脚本结构化解析仅 2 条）；`rg ctrl\+i|zone.?widget` 零命中；现有 `gode.quickEdit`=ctrl/cmd+alt+k 的 showInputBox（quickEdit.ts:46-59） | QuickEdit 是 InputBox 流程非浮层 widget，且必须有选区 [复核:确认] |
| 纯提问浮层内回答；改动以内联 Diff Keep/Undo 呈现（14.3 [必须]） | ❌ 未实现 | quickEdit.ts:64-78 prompt 明文「只输出改写后的完整代码」；解释类命令推到侧栏 composer（editorCommands.ts:74-140）；Keep/Undo 控件不存在 [复核:确认] | 全缺 |
| 改动走 FR-06 审批与 FR-09 检查点，口径一致（14.3） | 🟡 部分实现 | Agent 会话改动✅口径一致；QuickEdit ✗：底层 `generateWorkspaceText`（workspace-generate-text.ts:111-280）无权限请求、无 checkpoint 产出，应用为本地 WorkspaceEdit（quickEdit.ts:145-159） [复核:确认+深挖] | QuickEdit 定位本地编辑，口径分裂坐实到 CLI 侧 |
| 「转到侧栏会话」（14.4 [应该]） | ❌ 未实现 | moveToSession/sendToSidebar 等换词重搜零命中 [复核:确认] | 无 |
| Esc 丢弃/模型不可用浮层内提示/单实例（14.5 [必须]） | 🟡 部分实现 | Esc 等价成立（未应用前不落盘，quickEdit.ts:54-60/:133-136）；模型失败走全局 showErrorMessage（:94-98）非浮层内提示；单实例平凡满足 [复核:确认] | 失败提示形态不符（打断编辑流） |

### 2.9 FR-09 历史、检查点与会话管理（PRD 第 15 章，P0）——材料4 #11-#17

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| 会话列表：标题/时间/模型/用量，新建/重命名/删除确认/搜索（15.2 [必须]） | 🟡 部分实现 | 生效列表=共享 Root 的 WorkspaceSidebar 任务列表（WorkspaceShellLayout.tsx:1933）：标题/相对时间/状态/变更摘要✅（TaskListItem.tsx:131/:369/:400-404）、重命名✅（TaskRenameDialog）、删除确认✅（zh-CN.ts:802,804）、搜索✅（TaskSearchDialog）；模型/用量✗（TaskListItem 无 model/usage/cost 渲染；shared cost 字段无消费） [复核:确认] | 缺模型与用量摘要列；扩展自有 SessionListPanel/layout 槽位为未挂载遗留件 |
| 多标签会话+快捷键族：Cmd+Alt+Left/Right、拖动排序、Cmd+N、Ctrl+L、Cmd+Shift+T（15.2） | 🟡 部分实现 | 标签✅但为 workspace 级（tabStore.ts:34-44）非「每会话一签」；拖动排序✗（reorderTabs 无生产调用方）；上/下会话实际键=Cmd/Ctrl+Shift+[ / ]（shortcutCommands.ts:77-78）；newTask 为 menu 通道（:86）；Ctrl+L/Cmd+Shift+T ✗；SidePane 标签有最近关闭栈但非会话标签（useAppPanels.ts:1621） [复核:确认+补充] | PRD「同窗口多会话标签」以「多 workspace 标签+单 workspace 任务切换」近似；键位族几乎全缺 |
| 会话自动标题：首轮生成、可改、改后不覆盖（15.2） | ✅ 已实现 | session-title.ts:34-60 + title-generation-sidecar.ts:60-79；`cli_title_source='custom'` 防覆盖（taskIndexRepo.ts:980-988） | 无差距 |
| 历史视图：全文搜索含工具输出、过滤、批量删除、元数据、排序、收藏防误删、导出 Markdown（15.3 [必须]） | 🟡 部分实现 | 搜索走 tasks-index.sqlite searchable_text LIKE（taskIndexRepo.ts:1320），语料**只索引可见聊天正文**「不包含思考过程、tool 调用和 compaction 折叠区」（zcodeTaskIndexSyncer.ts:1896-1900，200k 截断）[复核:确认]；按工作区过滤✅/时间排序✅；批量删除仅归档任务（DeleteAllArchivedTasksButton）△；元数据缺模型/Token/费用；按花费排序✗；置顶✅但删除确认无收藏特别文案 △；导出 Markdown ✗（唯一导出=诊断日志 container.ts:590 + 云端分享链接） [复核:确认] | 语料不含工具输出为与 PRD 明确不符项；导出无 |
| 聊天内搜索 Ctrl/Cmd+F：Enter/Shift+Enter 跳转、大小写/全词/正则、Alt+Cmd+↑/↓、Alt+Cmd+PgUp/PgDn（15.3） | 🟡 部分实现 | 触发✅（findInTask 默认 CmdOrCtrl+f，App.tsx:1048→TaskFindDialog）；Enter/Shift+Enter/↑↓✅（conversationFindSearch.ts:8-22）；双 scope 超出 PRD（会话+文件变更）；选项❌（纯子串 toLocaleLowerCase，conversationFindIndex.ts:38）；语料仅 userInput+assistantText 两类（:2）；Alt+Cmd 组合键✗（替代=可视化导航条 ConversationTurnNavigator） [复核:确认] | 缺匹配选项与代码块/提问间键盘跳转 |
| 检查点：每工具调用后生成、影子 Git 或等价快照含未纳 Git 文件、Compare/Restore、悬停倒带、三选一恢复+确认、Redo、保留 100（15.4 [必须]） | 大部分实现 | 生成时机✅（tool-result-settlement.ts:185-194，成功文件变更工具产出，粒度单文件）；等价快照✅含未纳 Git 文件（rewind.ts:58-81，artifact 落盘+冷恢复 workspace-checkpoint-persistence.ts:28-170）；恢复能力等价但入口分散：RewindScope 三档全集存在（types.ts:752），UI 无单一三选一对话框（文件撤销 ConversationFileRewindDialog / 对话回退=编辑重发 rewind 模式 / Both=编辑重发+rewind）；恢复前二次确认✅（预检+确认按钮）；消息倒带△（动作常驻非 hover：编辑回退 + fork 分叉）；Redo ✗（CLI 全仓无 redo，恢复不生成恢复前检查点）；保留上限✗（adapters/src/storage/index.ts 无 prune/limit） [复核:确认] | Redo 与保留策略为 [必须] 段内缺失；三选一为分散入口非单一对话框 |
| 无障碍视图 Alt+F2 逐段读、Diff 键盘审查顺序（15.5） | ❌ 未实现 | F2 零绑定；无逐段读组件；注：PRD 15.5 括号引用「第 26 章」落空（第 26 章实为非功能需求，无 Diff 键盘审查顺序细则） [复核:确认+引注偏差] | 无 |

### 2.10 FR-10 多 Agent 并行与 Agent Manager（PRD 第 16 章，P1）——材料5 #1-#5

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| Agent Manager 全屏标签、左栏会话+Worktree 列表、右栏三页签、会话卡片（16.2） | ❌ 未实现 | 30 条命令无 agent-manager 类；`grep agentmanager` 零命中；无 Cmd/Ctrl+Shift+M | 整体缺失 |
| Worktree 隔离：独占 worktree、置顶+Ctrl+Alt+1~9、Setup Script、同提示 4 路并行（16.3） | ❌ 未实现 | `worktree` 唯一命中是「对另一 worktree 的 diff 做审查」展示（App.tsx:473-487）与 bash 风险分级 | 整体缺失 |
| 子代理：独立上下文、内置 Explore/Plan/General、只读查看器、不绕过权限（16.4） | 大部分实现 | Agent 工具（agent.ts，含 async_launched 后台态）；内置 Explore（explore.ts:10 只读工具白名单）+general-purpose（profile.ts:17），**无内置 Plan 类型**；只读查看器 SubagentDrilldown.tsx（仅最近 20 条 assistantText，非完整记录）；不绕过权限✅（interaction-origin.ts 回传主会话、tool-policy 剔除 plan 工具、runner 继承 disallowedTools） | 缺 Plan 内置类型与「完整记录」查看 |
| 后台 Agent 条：常驻条、五状态、Stop/Stop all/Dismiss/Clear finished/Continue（16.5） | 🟡 部分实现 | ConversationBackgroundWorks.tsx + 触发 badge；状态枚举 running/resultPending/failed/cancelled（snapshot.ts:367-385）≠ PRD 五态；动作仅单项取消（command.ts:272） | 缺 Stop all/Dismiss/Clear finished/Continue |
| Swarm Board（16.6，P2） | ❌ 未实现 | `swarm` 零命中 | P2，如实记录 |

### 2.11 FR-11 终端与浏览器工具（PRD 第 17 章，P1/终端基础 P0）——材料5 #6-#9

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| 会话终端：每会话一个集成终端、`!` 共用同一终端与白名单（17.1，终端基础 P0） | ❌ 未实现 | `grep createTerminal|pty.` 于扩展零命中；命令在 CLI 执行器跑、输出经 bash 工具行回流（renderers/execute.tsx + ExecuteOutput.tsx）；`!` 前缀无（材料1 #17） | PRD P0「终端基础」实质缺口 |
| 终端内联聊天 Ctrl+I + #terminalLastCommand（17.1） | ❌ 未实现 | terminalLastCommand/inlineChat/ctrl+i 零命中 | 无 |
| 输出过长截断+「看全文」，全文存会话附件（17.1） | 大部分实现 | CLI：inline 30KB 截断+persistOutput 落盘（bash.ts:81-82/:488，5GB 上限）回「Full output saved to…」；UI：BackgroundBashOutputSidePane.tsx:79 fullFile 入口；全文以运行时持久化文件承载（非「会话附件」形态） | 形态差异小，能力达标 |
| 浏览器工具：browser_open 类离散动作、localhost 默认+公网审批、页面诊断、集成浏览器标签、会话面板（17.2，P1） | 🟡 部分实现（形态不同） | 能力在 browser-use-plugin + core/src/browser-client（Browser facade/Playwright API）+ node-repl-host browser-bridge；形态为 JS REPL `browser.tabs.new()/playwright.domSnapshot()` 而非离散 browser_* 工具；localhost 限制仅是 tab 复用判定（selection.ts:37-47），无「公网走审批」强制门；页面诊断（console/网络失败采集）无；扩展侧无 iab 集成浏览器标签 | 非 PRD 口径；审批门与诊断缺 |

### 2.12 FR-12 测试生成、代码审查与辅助命令（PRD 第 18 章，P1）——材料5 #10-#13

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| 入口：斜杠命令 6 条、编辑器右键 5 项、Alt+Shift+T/C、侧栏顶部快捷区（18.2 [必须]） | 🟡 部分实现 | 斜杠 6 条无（v4/slashCommands.ts 只内置 plan/compact/goal/side/btw，仓库无 test.md/review.md 等命令文件）；编辑器右键✅（gode.editorContext 子菜单 5 项：explain/fix/refactor/writeTests/addToContext；SCM 标题栏 generateCommitMessage/reviewChanges）；快捷键 Alt+Shift+T/C ✗（仅 2 条 keybinding）；侧栏快捷区无测试/审查按钮（layout.tsx:19-45 七槽位） | 字面入口大体对得上（Improve→refactor、Git Diff Review→scm/title 的 reviewChanges），斜杠命令与快捷键缺 |
| /test：行为路径覆盖、框架识别、逐条接受/修改/拒绝、落盘（18.3） | 🟡 部分实现（无独立流水线） | 实际机制两路：①一句话指令→composer 预填（editorCommands.ts:54-62 INSTRUCTIONS + runOnSelection :336-365 → composer-insert 帧），交给 CLI 会话按当前模式跑，仅弹「写操作会先征求确认」提示；②无会话一次性生成 oneShotText.ts（用于 quickEdit/generateCommitMessage） | 无逐条用例接受 UI、无框架识别代码、无行为路径覆盖清单 |
| /review：范围选择（选区/文件/Local Review/指定分支 Diff）、多类别检查、一键应用修复（18.4） | 🟡 部分实现 | `gode.reviewChanges`（git.ts:96-127）：repo.diff 24KB 截断拼 `<git-diff>` 上下文发对话，要求「像 code review 一样指出缺陷/触发条件/直接修改」 | 只有 Local Review 口径；无选区/文件范围选择、无指定分支 Diff、无 Bug/破坏性/安全/性能分类与一键应用 |
| /explain /improve /docstring /fix（18.5） | 🟡 部分实现 | explainSelection/fixSelection/refactorSelection 注册（editorCommands.ts:220-234）；`gode.fixDiagnostics`（codeActions.ts:108-137 诊断+附近代码发指令）；docstring 无对应命令 | explain/fix 语义覆盖；improve→refactor 近似；docstring 缺；/fix 未走「内联 Diff 呈现」（无内联 Diff 机制） |

### 2.13 第 19 章 数据模型与存储——材料5 #16-#17 + 材料3 #4

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| 存储划分：密钥→SecretStorage、全局/项目配置、会话 globalState 索引+每会话数据文件、检查点影子仓库、用量按月分桶、索引数据（19.1 [必须]） | 🟡 部分实现 | 会话索引✅：扩展 globalState 按 workspace 键存会话 ID（store.ts:2-41、container.ts:489-492）+ CLI session store；schemaVersion 迁移✅：迁移前备份+checksum 失败回滚（migration-runner.ts:106-110）；密钥✗（0o600 JSON，见 2.5）；检查点影子仓库：以**内容级 artifact 等价快照**实现（rewind.ts:58-81，per-session 目录 zcode-artifact://，PRD 允许「等价快照机制」→ 合规）；用量按月分桶✗（月度口径仅 CodingPlan 配额 CodingPlanUsageRemainingPanel.tsx:263）；索引数据不适用（无索引） | 密钥存储与月度分桶为缺口；PRD 19.2 的 ChangeSet/Hunk/MODE/ApprovalLevel 类型体系未按定义实现（对应各模块结论） |
| 数据迁移：schemaVersion、失败备份不丢弃（19.3） | ✅（本条目并入上行「部分实现」统计外的正面点） | migration-runner.ts:106-110 备份到 `<dataRoot>/backup`，checksum mismatch 报错回滚 | 符合 PRD 精神 |

### 2.14 第 20 章 配置系统与设置界面——材料5 #16

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| 配置分层：会话内临时>项目>全局>默认，界面标明来源层（20.1 [必须]） | 🟡 部分实现 | CLI 侧权威分层✅：System→User(`~/.zcodium/cli/config.json`)→Project（root→cwd 多份）→Env→CLI overrides（config-factory.ts:113-119、config-merger.ts）；扩展侧 `gode.*` 仅 8 项（python 实测：cliPath/mode/model/permissions.allowlist/denylist/mcp.servers/context.additionalDirectories/autoContext）经 hostSettingsBridge 归一进 create/resume | 项目配置 schema 无 PRD 的 defaultMode/approvals/terminal 白名单字段；**「界面标明来源层」未实现**；「会话内临时设置」层未见 |
| 设置页 13 标签、图形表单↔配置文件双向同步（20.2 [必须]） | 🟡 部分实现（名目不同） | 实际设置分区 21 节（settingsNavigation.ts:4,67-92：general/appearance/modelProvider/mcp/skill/usage/hooks/automations 等）≠ PRD 13 标签（Providers/Behaviour/AutoApprove/…/About）；扩展配置面为独立面板；settings.json 为唯一真相源，属单向写回+回读（SessionParamsPanel、workspacePreferences 读写 gode.*/AppSettings） | 名目不一致；双向同步不成立（改配置文件不会即时刷新图形表单） |
| 个性化/通知/Keep Awake（20.3/20.4） | 未逐条核对（材料未覆盖） | — | 材料未提供证据，如实标注未核对；PRD 标 P2/P1 |

### 2.15 第 22 章 MCP 集成——材料5 #14-#15

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| 添加/删除/启停、env 密钥存 SecretStorage、三处入口同源、分组显示+来源标注、128 工具上限、异常标红+日志、内置浏览器注册为 MCP 服务器 | 🟡 部分实现 | CRUD/启停✅：McpSettingsPanel.tsx（写回 `gode.mcp.servers`、listMcpServerStatuses、allowlist/denylist、会话内允许写回）；状态模型 mcpServersModel.ts:54-70/:127-146（`● N connected / M failed`）；入口：命令面板 `gode.openMcpSettings`（hostCommands.ts:127-130）+ 设置页 McpSettingsSection.tsx（两处半，`/` 菜单无 Customize 分组，slashCommandPanelSections 仅 commands/skills/subagents）；来源标注✅（renderers/mcp.tsx:26-118 从 `mcp__server__tool` 解析 serverName）；128 上限✗（grep 零命中）；**env 为明文 schema**（shared/src/mcp.ts:35），SecretStorage 零命中；状态行纯文本未见标红（McpSettingsPanel.tsx:276-281），日志有 gode.showLogs；内置浏览器：node_repl MCP 服务器（node-repl-host/src/server.ts:4-5 + browser-bridge.ts）可暴露浏览器自动化，但非「注册 browser_* 工具集」的独立服务器 | 密钥明文 env（P0 验收项）、无 Customize 入口、无 128 护栏、异常不标红 |

### 2.16 第 23 章 安全、隐私与合规——材料5 #18

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| 遥测默认关闭或仅匿名崩溃，首次启动明示、设置可改（23.2 [必须]） | 🟡 部分实现（以「不存在遥测」方式成立） | `runtimeEnv.ts:104-125` 注释「审计版不再捕获遥测配置；仍剔除旧环境变量」（ZCODE_MODEL_TELEMETRY_ENABLED 等从子进程环境剔除）；`runtime-telemetry.ts:222` 默认 NOOP 端口；UI 无 telemetry 开关 | 默认关闭以「无遥测」成立，但无用户可见开关面 |
| 发送前敏感信息扫描（P1）（23.2） | ❌ 未实现 | grep sensitive/credential-scan 无产品化实现 | 无 |
| 气隙离线（P1）（23.1） | 🟡 间接支持 | CLI 本地运行+自定义 provider 可指向本地模型；无显式 air-gapped 模式/UI（仅 remote runtime 有 offline 连接模式 RemoteConnectionFields.tsx:86-100） | 无显式形态 |
| 权限边界：不做隐藏进程执行（23.3） | ✅（正面） | 外部命令经 CLI 工具执行器+审批拦截（FR-06 体系） | 无隐藏执行路径证据 |

### 2.17 第 24/25 章 命令、快捷键与贡献点——材料1 #4 复核 + 本报告 python 实测

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| 24.1 命令总表 12 条 | 🟡 部分（4 覆盖+1 变体+7 缺失） | python 实测 contributes.commands 30 条：`gode.newSession/openMcpSettings/writeTests/reviewChanges` 覆盖 4 条；`gode.addToContext`≈Insert @-Mention（名称/键位不符）；缺 7 条（Open in New Tab/New Window/Sidebar、Open Agent Manager、Focus Input、Reopen Closed Session、Set Background） | [复核:修正→部分修正] |
| 24.2 快捷键总表 16 项 | ❌ 大部分缺失（VS Code 层仅 2 条） | python 实测 keybindings 仅 `gode.quickEdit`=ctrl/cmd+alt+k、`gode.addToContext`=ctrl/cmd+alt+a；PRD 16 项中 VS Code 层缺：Ctrl+Alt+I、Ctrl+I（内联/语音）、Ctrl+Shift+Alt+L、Ctrl+L、Cmd+Esc、Cmd+Shift+Esc、Cmd+N、Cmd+Shift+T、Alt+K、Cmd+Shift+M、Alt+Shift+T、Alt+Shift+C、Ctrl+Alt+1~9、Cmd+Alt+Left/Right；Ctrl/Cmd+F 在 webview 内部实现（shortcutCommands.ts:70，非 VS Code 贡献点） | 16 项中 13 项在 VS Code 贡献点层无绑定 |
| 24.3 菜单：编辑器右键/资源管理器右键/终端右键/SCM/编辑器标题栏 | 🟡 部分 | python 实测 menus 8 组：editor/context 子菜单✅、explorer/context（addFileToContext）✅、terminal/context（sendTerminalSelection）✅、scm/title✅、editor/title/context 变体✅、**editor/title❌**；另发现 view/title 的 when 引用陈旧视图 id `code.chat`（实际 `gode.chat`）导致 5 条菜单项不显示（package.json:207-228、chatPanel.ts:15） | 编辑器标题栏图标入口缺；陈旧 id 是实测新发现的贡献点缺陷 |
| 25 章贡献点：viewsContainers 1 个✅、views 主视图+历史视图、commands 全量+图标分类、keybindings 全量+when、menus 5 类、configuration 20 章全项、activationEvents 非 `*`、capabilities 声明 | 🟡 部分 | viewsContainers✅（activitybar 1 个）；views：主视图✅（gode.chat）、**历史视图✗**；commands 30 条（PRD 12 条缺 7）；keybindings 2 条（PRD 16 项）；menus 5/6 类；configuration 仅 8 项 `gode.*`（PRD 20 章全量设置项远多于此，大部分设置在共享 UI SettingsPage 21 节，两套口径）；activationEvents=`onStartupFinished`✅符合 6.5；**capabilities 未声明**（python 实测 null）；engines=`^1.90.0`（PRD 要求 1.95+，低配）；扩展名当前为 gode/Gode，与最近提交「改名 zcodium.code」存在未同步工作树改动（git diff 108+/113-） | 按 25 章验收「缺一项即 P0 不通过」，keybindings/历史视图/capabilities/设置项四块不达标 |

### 2.18 第 26 章 非功能需求——材料未系统覆盖，以下为材料可溯源的散点 + 未验证声明

| PRD 要求 | 实现状态 | 实现位置与证据 | 差距说明 |
|---|---|---|---|
| 26.1 性能预算（激活<300ms、首开<1s、500 条消息虚拟列表、检查点<500ms） | 未验证 | 五份材料均为静态核对，未运行任何性能测量 | 如实标注：无运行时证据，既不能判达标也不能判不达标 |
| 26.2 稳定性：Webview 崩溃重建恢复、流中断保留内容+Continue、写文件走受控封装 | 🟡 部分（散点） | 崩溃重建/会话恢复见 FR-01 #9（会话✅滚动✗）；Continue 见 FR-02 #15（语义偏差）；写文件在 CLI 直接写盘+checkpoint artifact 保障（材料4 #16），QuickEdit 走 WorkspaceEdit | 「Continue 依赖流中断保留」的口径与实现有偏差；无系统验证 |
| 26.3 兼容性：VS Code 1.95+、三平台、远程开发 | 🟡 部分 | engines=`^1.90.0`（本报告实测，低于 PRD 最低 1.95——口径相反）；三平台/远程无证据 | 最低版本声明低于 PRD 要求 |
| 26.4 无障碍与 i18n：键盘可达、高对比度、中英文案、RTL | 🟡 部分（散点） | 中文文案✅（zh-CN.ts 全量 locale；en-US/fa 等多语言 locale 存在）；Alt+F2 无障碍视图❌（材料4 #17）；aria 实践存在（role="status" 等） | 无系统审计；RTL 无证据 |
| 26.5 可观测性：本地日志面板、日志不含密钥与完整代码 | 🟡 部分 | `gode.showLogs`/`gode.showEditorLogs` 存在（本报告 python 实测 commands 表）；日志内容合规性未核对 | 有日志入口，内容合规未验证 |

---

## 3. 优先级建议

### 3.1 P0（对应 PRD M1 验收与发布门槛）

1. **接通或砍掉 FR-03 隐式上下文链路**（P0-6）。`buildPrompt`（contextCollector.ts:361-420）无调用点意味着 `gode.autoContext` 设置是假功能。最省力路径：在 host 侧把「当前文件+选区+诊断」按 PRD 口径作为默认 mention 预填接入发送链（复用现成的 `gode.addToContext` composer-insert 帧），或在 PRD/设置描述中明示降级并移除设置项，二选一，先消除「设置了但无效」。
2. **密钥迁 SecretStorage**（P0-9）。扩展侧加 `context.secrets` 读写，首次迁移把 `provider_config.json` 中的 api_key 搬入并从 JSON 剔除；`credentialService` 已存在（OAuth/JWT 在用），复用其加密面即可。这是 PRD 23.3 验收「SecretStorage 之外搜不到密钥落盘」的硬门槛。
3. **FR-06 补 8 类授权开关 UI + 修 deny 优先级**（P0-5）。开关 UI 可做成现有 `riskLevel×sideEffectScope` 轴之上的 8 个开关映射层（不必重写决策引擎）；deny 优先级修正是单点改动：把 `checkPermission` 中 yolo/guarded 直通分支（service.ts:155-157）移到 disallowedTools/project deny（:168/:177-184）之后（guarded 危险命令 ask 已在直通前，模式不变量是「alwaysAsk 仍问」）。同时把审批窗补上 Diff 预览入口（`onOpenCodeViewer` 已有字段位，接 FR-07 的 webview diff 查看器即可）与命令风险标注（复用 `HIGH_RISK_ROOT_COMMANDS` 表）。
4. **FR-04 模式体系对齐拍板**（P0-4）。六档枚举（ask/agent/auto/debug/quickAsk vs build/edit/plan/yolo/guarded/auto）是 CLI 全局决策轴，代码改动成本极高；**最省力且风险最低的路径是反向更新 PRD**——把现有六模式确立为产品口径（Ask≈build 只读语义可由 plan/build 组合表达，Quick Ask 可并入 Explore 子代理定位），并同步修掉三处明确相反点：只读模式改为「工具不可见」（`getTools` 按模式过滤即可，config.ts:169-183 已有过滤骨架）、会话头部切换补 active turn guard、Plan 方案落盘改为「会话内保存+手动另存」。若产品坚持 PRD 六档，则需重排 CLI 权限映射与全部 UI 目录，建议单独立项。
5. **FR-01/FR-02 交互收口**（P0-7/P0-8，均为小改动）：① keybindings 增补 Ctrl+Alt+I（openChat+新增 Focus Input 命令，需补一条宿主→webview 的聚焦帧——webview 侧 `requestComposerFocus` 已存在）与 Cmd/Ctrl+Esc；② 发送中按钮改 DropdownMenu 三动作（queue/guide/stop 语义层全部现成，只差 UI 组装）；③ 队列上限 10：在 v4 input-admission（bootstrap/src/zcode-protocol-v4/commands/input-admission.ts）加条数门即可；④ 占位文案插值模式名与发送快捷键（chatPlaceholder.ts 加参数）；⑤ 修 `menus.view/title` 陈旧视图 id `code.chat`→`gode.chat`（一行批量替换，恢复 5 条菜单项）。
6. **FR-11 会话终端与 `!` 前缀**（P0-3）。成本最高的 P0 项。建议分两步：先做 `!` 前缀（composer 侧解析 + 复用 CLI bash 工具的只读/审批策略，回显走系统消息行），再评估「每会话集成终端」（可用 VS Code `createTerminal` + `onDidWriteTerminalData` 桥接 CLI 执行器，或反向修订 PRD 承认「工具行回流」形态）。

### 3.2 P1（对应 M2/完整版）

7. **FR-07 逐 Hunk 审查**：成本极高（需新数据模型+行号重算）。务实路径：先把 Working Set（输入框上方展开区）与审批内 Diff 入口补齐（复用现有 fileChanges 快照与文件级撤销），逐 Hunk 作为 PRD 修订候选降级为文件级粒度。
8. **FR-08 内联聊天**：可基于现有 quickEdit 升级（InputBox→浮层 widget、加入会话语义、接审批/检查点），或改接 VS Code 原生 inline chat API。PRD P0 模块，但在现有架构下建议按「quickEdit 2.0」独立立项，不要并入主会话数据面。
9. **FR-09 收尾**：Redo（恢复动作前自动落 checkpoint artifact，机制现成）、保留上限 100（storage 层加 prune + 历史留痕）、历史搜索语料纳入工具输出（zcodeTaskIndexSyncer 扩语料+设置开关）、会话 Markdown 导出（遍历 rows 投影即可）。
10. **FR-05 打磨**：模型菜单加搜索框（ModelConfigSelect 现成列表过滤）、设为默认供应商、接通两处半成品回写管道（`wrapAgentServiceForModelWriteback` + `persistingWorkspace` 补装配）、`/usage` 命令（用量数据面已有，注册斜杠命令对齐口径）。
11. **清理未挂载层**（决定接回或删除）：`layout.tsx`/`header/modelSelect.tsx`/`usagePanel.tsx`/`SessionListPanel.tsx`/`selectionChip.tsx`/`mentionSource.ts`/`wrapAgentServiceForModelWriteback`——当前既占维护面又造成「命令点了没反应」（gode.openUsage 死链）。要么把 modelSelect/usage 槽位接回 App 装配，要么删除并保留单测对应能力。
12. **贡献点清单补齐**（25 章验收）：历史视图贡献点、capabilities 声明、engines 升到 ^1.95、设置项与 20 章对齐（或在 PRD 记录「设置面由共享 SettingsPage 承担」的口径）。
13. **FR-12 流水线**：注册 `/test /review /explain /improve /docstring /fix` 斜杠命令映射到现有编辑器命令（目录走 CLI catalog 追加）；review 补类别分组与范围选择。
14. **MCP 密钥与护栏**：env 密钥改 SecretStorage 引用、128 工具上限、服务器异常标红（22 章 P0 验收项「标红+日志」）。

### 3.3 补齐路径总原则

- **能映射就不重写**：现有权限/模式/审批引擎比 PRD 设计更细（riskLevel×sideEffectScope×alwaysAsk），P0-5、P0-4 的 UI 层缺口都可以做成映射层，不动 CLI 决策核心。
- **先修「反向行为」再补「缺失功能」**：yolo 压过 deny、Plan 自动落盘、模式中途切换即时生效、只读模式 deny 报错四处与 PRD 明文相反的行为，改动面小且直接对应验收红条，优先于任何新功能。
- **半成品二选一**：所有「已写好未挂载/未接线」的组件（本报告 1.1 末段清单）逐个决定接回或删除，避免继续积累双口径。
- **验收补课**：五份材料与本职核对均为静态源码证据，PRD 7.5/8.8/11.7/12.7/13.8/14.6/15.6/20.5/23.3 的行为级验收从未执行；按 27.3 总则，P0 发布前需在干净 VS Code 配置 + 样例仓库上跑一轮人工清单留痕。

---

## 附：本报告与材料的差异处理说明

- 材料1/3/4 的 [复核:...] 标注条目一律按复核后结论呈现（如：命令总数 30 非 31；「按模型明细缺失」不成立；「无 L3 开关」不成立——以「完全访问」闭环为准；「无最近关闭栈」仅对会话标签成立；「第 26 章引注落空」修正）。
- 材料2/5 为深度调查原始结论，无独立复核标注，其 file:line 证据按原样引用。
- 第 2.13-2.18 节（第 19/20/22/23/24/25/26 章）超出单份材料覆盖的部分（24/25 章贡献点、capabilities、engines）为本报告用 python 解析 package.json 实测补齐；20.3/20.4 个性化与通知、26.1 性能预算无材料证据，如实标注未核对。
- 全部结论为静态核对产物，未运行任何测试/构建/扩展宿主；未执行的验证已逐处声明。
