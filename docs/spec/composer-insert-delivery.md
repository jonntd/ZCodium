# Spec: composer-insert 上下文注入的投递契约

本 spec 定义「把文件/选区上下文注入聊天 composer」这条链路的投递契约：
host 命令（资源管理器右键「加入 Gode 对话」、编辑器选区「加入对话上下文」⌘⌥A、
终端送入、Code Action 等）→ `composer-insert` 帧 → webview store → composer 应用。
涉及 `apps/zcode-vscode/src/host/hostRuntime.ts`、`src/features/editorCommands.ts`、
`packages/ui/src/v4/SessionPane.tsx`、`v4/ConversationComposer.tsx`、
`LexicalChatInput.tsx` 与 `store/zcodeSessionStore*`。

## 1. 背景

应用反馈：有活动会话时右键「加入 Gode 对话」/ 选区「加入对话上下文」点击无反应。
调查确认三个静默丢弃点：

1. **gate**（`SessionPane.tsx`）：`externalTextInsertRequest={focused && sessionId === null ? … : null}`
   —— 有活动会话时请求被静默丢弃且无人清理（悬空在 store）；
2. **判重**（`LexicalChatInput.prependEditorMentionIfMissing`）：按 `category+value` 去重，
   同文件不同行选区的 value 相同 → 第二次「假成功」，零可见反馈；
3. **投空**（`hostRuntime.pushHostFrame`）：webview 懒解析，面板从未打开时
   `connections` 为空，帧直接蒸发，且命令里的 `chatPanel.reveal()` 此前为空操作；
   另外 host 对 N 条上下文循环 push N 帧，落在 store 单槽上有覆盖竞态。

## 2. 规则

**消费 gate**：外部插入请求只要求 **focused**（前台 pane），不再要求 `sessionId === null`。
活动会话态下 mention 落进排队输入框（「继续输入以排队后续修改」），草稿态落进草稿。
非前台 pane 一律收到 null（多实例不抢消费）。

**批量**：`ComposerTextInsertRequest` 增加 `mentions?: ComposerMentionPrefill[]`
（单数 `mention` 保留兼容，二者互斥使用时以 `mentions` 优先）。host 侧对 N 条上下文
**只 push 一个帧**；composer 侧循环应用全部 mentions：

- `mode: "prepend-if-missing"`：按**逆序**逐条 `prependMentionIfMissing`（每条插到最前，
  逆序应用后最终顺序与传入顺序一致），全部应用后一次 `updateText`（文本 = 各 mention
  markdown 以空格连接）+ 一次 `requestFocus`；
- 其它 mode（replace 类）：单 mention 语义不变；`mentions` 多条时按顺序拼接后按
  既有 mode 处理。

**判重**：`prependEditorMentionIfMissing` 的去重键从 `category+value` 改为
**`mention.id`**（host 侧 `contextCollector.fileMentionRef` 的 id 已含行号后缀
`file:<fsPath>:<start>-<end>`，同文件不同选区是不同 id）。判重命中（重复加入同一
上下文）时不再静默：至少 `requestFocus` 让用户看到输入框已被关注。

**pill 展示口径**：文件类 mention pill 展示统一带 `@` 前缀（Claude Code/Augment
口径）：`@name` / 选区上下文 `@name start-end`（`PromptMentionNode.displayLabel`）。
`@` **只进展示文案**——canonical markdown 的 label/链接目标不变，消息回显
（`parseMentionMarkdown`）与 Agent 收到的正文亦不含 @ 变化。

**选区与整文件互斥**：`gode.addToContext` 有选区时只带选区 mention
（`contextFromSelection`），无选区才回退整文件 + 光标行（`contextFromActiveFile`）——
两者同时生成会产生「选区 + 整文件」重复 pill。

**资源管理器多选**：`gode.addFileToContext` 接受 VS Code explorer/context 约定的
第二参（全部选中资源数组），N 个文件/目录合并为一个批量 mention 帧一次加入。
背景：Antigravity 的「资源管理器多选拖拽进 webview」不产生任何 DOM drag 事件
（探针实测，单拖正常），多文件加入走右键多选入口。

**落点 key（2026-11-22 修订）**：webview 侧 `requestComposerTextInsert` 与聚焦请求
`requestComposerFocus` 的 workspace key，以及会话归属上报
（`notifySessionCreated`/`notifySessionDeleted`）与编辑器页签标题
（`notifyEditorTabUi`）读取的 activeTaskId，必须是**当前可见对话区**的 workspace，
即 tabStore 的 active workspace
（`resolveRootWorkspaceShellTarget` 同一解析面：path + workspaceIdentity），不能再用
App/bootstrap 层的 `workspacePath`（1915364a 起侧栏挂载桌面 Root 后两者是**独立状态**：
Root 页签内切换工作区不产生任何 host workspace 帧，App 层 key 冻结在 bootstrap folder）。
会话上报附加语义：**切页签不是删除**——旧会话仍活着、其 folder 恢复键保持不动；
新页签有会话则重报归属（host 侧幂等），仅同 key 内的 activeTaskId→null 才走删除判定
（`shouldReportSessionDeleted`）。
分叉时请求会落进一个没有可见 composer 消费的 store 桶——host 日志显示帧已推送、
命令链路全程无错，用户侧表现为「右键加入毫无反应」（2026-11-21 事故：面板页签
切到 zcode-patcher 后在 IDE 主 folder 里 6 次右键全部落空）。tabStore 尚无 active
workspace（面板刚打开、Root 未挂载）时回退 App 层 key——此刻 Root 首个页签就是
bootstrap folder，两者将收敛为同一值。

**tabStore 实例生命周期（2026-11-22 修订）**：Root 带 key 重挂载（session-switch /
new-session 帧、restore 失败重挂）会**重建 TabStoreProvider → 新 store 实例**。
`getCurrentWindowTabStore()` 模块镜像随登记即时切换，但已在旧实例上建立
subscription 的 effect 不会自动重跑——跨实例订阅方（vscode App.tsx 的
`notifyEditorTabUi` / 会话归属上报）必须把 `getTabStoreEpoch()` 纳入 effect deps
（配 `subscribeTabStoreEpoch` + `useSyncExternalStore`），实例切换时清理旧订阅并重挂
当前实例；帧驱动的消费者（index.tsx 的 composer-insert / diagnostics）在事件到来时
现取实例，无需订阅。

**pill 持久化保真（2026-11-22 修订）**：编辑器 onChange（含 composer-insert 程序化
插入触发的变化、拖放/菜单插入）进入草稿 store 时必须**同一拍携带 editorStateJson
快照**（`snapshotDraftOfEditor`），不得只写 `text` 等 350ms 防抖补 JSON。背景：
`updateComposerContent` 会无条件抹掉 `editorStateJson/mention`；若 onChange 只写
text，insert→wipe→恢复重放的窗口内（`draftFocusVersion` 翻动即改变
`updateComposerContent` 身份并重放草稿恢复 effect），纯文本草稿经 `setText` 复原会把
mention pill 降级为 canonical markdown 纯文本，且 wipe 经 `persistDraft` 同步落盘、
后续防抖快照拍到的已是降级后的编辑器——降级永久化（2026-11-22 用户实测：pill 显示成
`[README.md 14-17](./README.md)`，webview localStorage 草稿记录为同步 wipe 写实证）。
恢复口径不变：`editorStateJson` 存在即优先结构化复原。

**帧排队**：`pushHostFrame` 在无 webview 连接时进入**有界 FIFO 队列**（≤32 条，
超出丢最旧）；`attachWebview` 后不立即 flush——等收到 webview 的**首条消息**
（bootstrap ctx / notifyRendererReady，证明 main.js 已注册监听）才按序 flush。
这保证「面板从未打开 → 右键加入 → 面板打开 + pill 出现」全链路可达。

**事件顺序**：

```text
命令 handler → pushFrame("composer-insert", { text, mention|mentions, mode })
             → executeCommand("gode.openChat")
hostRuntime：有连接 → 直发；无连接 → 入队（≤32）
webview attach → 首条 webview→host 消息 → flush 队列
webview index.tsx → 落点 key = tabStore 可见工作区（回退 App 层 key）
                   → requestComposerTextInsert(target, …, mentions, mode)
SessionPane(focused) → ConversationComposer.applyExternalTextInsertRequestToComposer
                     → 循环应用 mentions → updateText + requestFocus
                     → onExternalTextInsertApplied → clearComposerTextInsertRequest
```

**诊断**：`editorCommands.ts` 的 addContext/addToContext/addFileToContext 链路增加
debug 日志（mention 数、帧数），投递断点可用输出通道定位。

## 3. 边界

- 请求悬空的「迟到应用」保留（面板后开时请求仍生效）；单槽被新请求覆盖时旧请求
  自然失效，无需 TTL。
- 选区拖拽（从编辑器拖文本进聊天区）DOM 数据只有 text/plain，不带来源文件/行号，
  不在本 spec 范围；`@文件 起止行` 形式由「加入对话上下文」命令承担
  （`contextCollector.contextFromRange` 的 label 为 `${basename} ${start}-${end}`，
  id 含行号后缀）。
- 多实例 SessionPane（SidePane forceMount）消费竞争由 `focused` 单前台条件消除。

## 4. 验收场景

1. 活动会话态：右键文件「加入 Gode 对话」→ pill 出现在排队输入框；
2. 草稿态：同样成功；
3. 面板从未打开：右键 → 面板自动打开且 pill 出现（帧排队 flush）；
4. 同文件不同行选区各 ⌘⌥A 一次 → 两个不同 pill（label `name start-end`）；
5. 重复加入同一选区 → 不新增 pill，但输入框获得焦点；
6. 多文件上下文一次加入 → 单帧批量，N 个 pill 顺序与传入一致；
7. 非前台 pane 不消费；store 请求应用后清理；
8. 面板页签切换过工作区（Root tabStore active ≠ bootstrap folder）：右键加入 →
   pill 出现在**当前可见对话区**（诊断注入同口径）。
