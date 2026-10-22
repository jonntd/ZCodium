# Spec: 运行中工作状态的 DeepSeek 风格胶囊（assistant working status pill）

本 spec 定义 v4 会话时间线里「正在工作」状态的**呈现契约**：运行中的 assistant 轮次
用什么形态表达"仍在工作、已用时多久"，以及它与既有折叠触发行、ChatLoading 兜底的关系。
涉及 `packages/ui` 的 `ConversationTurnGroup`、`chatLoadingVisibility`、`styles.css`。

## 1. 背景

现状运行中的最后一轮会同时渲染两个状态元素（实测 DOM 证据）：

1. `AssistantHistoryStatus`（`ConversationTurnGroup.tsx`）：折叠触发行，纯文本
   「工作中 {duration}」+ 全宽细分隔线（`border-b`），同时是这轮历史的
   CollapsibleTrigger；
2. `TurnChatLoadingSlot` → `ChatLoading`（`chat-loading.tsx`）：轮次内容尾部一个
   **裸的旋转 loader**（`LoaderIcon animate-spin`），无边框、无文字。

用户反馈（对照 DeepSeek 桌面端）：裸圆圈没有语义，期望改成 DeepSeek 那样的
**状态胶囊**——带边框的胶囊里并排「图标 + 状态词 + 已用时 + 动态省略号」。

## 2. 规则

**状态所有者**：不变。运行判定与耗时仍由
`buildConversationTurnWorkSegments`（`conversationTurnWorkSegments.ts`）从 turn header
与行事实推导（`workStatus.state/durationMs`），UI 每秒的 `liveNowMs` 时钟只驱动运行中
`durationMs` 增长。胶囊是纯呈现，不新增状态、不新增计时器。

**运行中（`workStatus.state === "running"`）**：`AssistantHistoryStatus` 的触发行
渲染为状态胶囊（`ConversationWorkingStatusPill`）：

| 元素       | 呈现                                                                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 容器       | `rounded-full` 胶囊按钮（仍是 CollapsibleTrigger，保留 testid 与折叠语义），`border border-border bg-surface`，DESIGN.md 的 `rounded-full` 胶囊豁免 |
| 图标       | `LoaderIcon`（静态，不旋转——遵循仓库既有性能规则：长驻运行态不放旋转动画），`text-foreground-subtle`                                                |
| 状态词     | 「工作中」（i18n `chat.history.workingPill.status`），`animated-gradient-text` 扫光，沿用仓库运行态视觉语言                                         |
| 已用时     | 「用时 {duration}」（i18n `chat.history.workingPill.elapsed`），`text-foreground-subtlest`；`durationMs` 缺失时整段不渲染                           |
| 动态省略号 | 3 个圆点 CSS 错相位呼吸（`styles.css`），`prefers-reduced-motion` 时静止为半透明                                                                    |
| chevron    | 沿用现状：`assistantHistoryDefaultOpen` 为 false 时才渲染（运行中默认展开，无 chevron）                                                             |

完成/中断（`completed`/`interrupted`）维持现状纯文本（「已工作 {duration}」/「已停止」），
与 DeepSeek「胶囊只在运行中存在」的语义一致。

**重复兜底的抑制**：主轮流程（`ConversationTurnFlow`）在**任一 segment 处于 running**
（胶囊已可见）时，不再渲染尾部 `ChatLoading`；API 重试状态（`ChatApiRetryStatus`）
不受影响，仍按原阈值显示。规则收口为纯函数
`shouldShowTurnChatLoadingWithRunningPill({ showLoading, hasRunningWorkSegment })`
（`chatLoadingVisibility.ts`）。

**范围边界**：

- `timelineOnly` 分支与后台结果流（`BackgroundResultTurnFlow`）没有状态胶囊，
  维持 `ChatLoading` 兜底不变；
- 分享只读时间线（`ConversationShareReadonlyTimeline`）维持纯文本，不在本次范围；
- `ChatLoading` 组件本身保留（其他兜底 surface 继续使用）。

**胶囊吸顶（状态必须留在视口内）**：胶囊挂在运行轮的 work history 头部，本轮工作行随
工具调用持续追加，会把「工作中 + 用时」不断向上顶出视口；而贴底跟随（`following = true`）
恰恰是用户最常停留的位置。规则：

- 运行中（`workStatus.state === "running"`）时 `AssistantHistoryStatus` 行吸顶
  （`sticky top-0 z-10 bg-background`），收口为
  `resolveAssistantHistoryStatusStickyClass`（`conversationWorkingStatusPillModel.ts`）；
- 不透明底色是必需的：工作行会从吸附行下方滚过，透明会让两段文字叠在一起；
- 吸附范围天然被限制在本轮内容内（运行轮是 `liveUnit`，滚动容器里的普通块），本轮结束
  回归纯文本时自动释放，历史轮次不参与吸附；
- 完成 / 中断态不吸顶：那时状态只是历史事实，不该抢占视口顶部。

**离屏兜底（本轮整体滚出视口时仍能回到运行态）**：吸顶只覆盖「本轮还在视口内」，
用户上滚到更早的历史轮时胶囊仍会离开视口。规则：

- 触发源 = `backToBottomVisible`（`!followingRef.current && 有渲染单元`，与「回到底部」
  按钮同源）**且** `showLoading`（最后一轮 running / 未建轮）**且** 胶囊本体不在视口内；
- 「胶囊是否在视口内」由 `IntersectionObserver` 观察 `[data-zcode-working-pill="true"]`
  得到（root = 滚动容器），**不读滚动几何、不参与跟随判定**，web-remote 恢复链路同样成立；
  吸顶胶囊在本轮内恒可见，因此用户在本轮内部上滚时不会多出第二个同义控件；
- 收口为 `shouldShowTimelineWorkingPillChip({ showLoading, backToBottomVisible,
  workingPillInViewport })`（`chatLoadingVisibility.ts`）；
- 呈现 = composer dock 上方正中一枚圆形按钮（与「回到底部」同壳同款），位置为 dock 的
  `bottom-full` 相邻上方，避开离开挂的贴底 mask 遮罩区；点击 = `handleBackToBottom`
  （回到贴底，吸顶胶囊此时落在视口顶部），**不**新增第三种滚动跳转语义；
- 与「回到底部」按钮按 8px 间距左右并排共存于同一贴底锚点容器内，两个控件都保留；
- `readOnly` / `shareActive` 等没有 composer dock 的 surface 不渲染（timeline 内不再出现
  独立于 dock 的悬浮兜底）。

> 修正记录（2026-10-17）：旧版本把「贴底时胶囊或尾部落盘槽本来就在内容末端」当作前提，
> 据此让兜底按钮只在离底时出现。该前提不成立——胶囊在**头部**，尾部是持续追加的工作行；
> 本轮高度超过视口后，贴底跟随看到的只是尾部，胶囊反而在视口上方，此时既无胶囊也无兜底
> 按钮（尾部 `ChatLoading` 也被「胶囊已可见」的规则抑制）。现改为「胶囊吸顶 + 按可见性
> 兜底」。

## 3. 事件顺序

```text
行事实（turn header / rows）+ liveNowMs(每秒)
  └─ buildConversationTurnWorkSegments → workStatus(state=running, durationMs)
      ├─ AssistantHistoryStatus → ConversationWorkingStatusPill（胶囊触发行）
      │    ├─ resolveAssistantHistoryStatusStickyClass(state) → running 时 sticky top-0
      │    │    ⇒ 本轮工作行继续追加也把胶囊钉在视口顶部
      │    └─ 点击 = 折叠/展开本轮工作历史（既有 Collapsible 语义）
      └─ ConversationTurnFlow
           └─ hasRunningWorkSegment = true → shouldShowTurnChatLoadingWithRunningPill=false
                → 尾部不再渲染裸 ChatLoading（apiRetry 状态照旧）
IntersectionObserver(root=滚动容器, target=[data-zcode-working-pill])
  └─ workingPillInViewport = entry.isIntersecting
用户上滚离底 → commitFollowing(false) → backToBottomVisible=true
  ├─ 本轮仍在视口内（吸顶胶囊可见）→ workingPillInViewport=true
  │    └─ shouldShowTimelineWorkingPillChip=false → 不重复状态控件
  └─ 已滚到更早的历史轮（胶囊离开视口）→ workingPillInViewport=false
       └─ shouldShowTimelineWorkingPillChip=true → dock 上方出现兜底按钮（与「回到底部」并排）
            └─ 点击 → handleBackToBottom（恢复跟随 + 贴底）→ 吸顶胶囊回到视口顶部 → 按钮消失
运行结束 → workStatus.state = completed → 吸顶释放，胶囊消失，回到纯文本「已工作 {duration}」
```

## 4. 验收场景

| 场景                                    | 期望                                       | 测试                                               |
| --------------------------------------- | ------------------------------------------ | -------------------------------------------------- |
| 运行中且任一 segment running            | 尾部 ChatLoading 被抑制，不出现双状态      | `packages/ui/test/chatLoadingVisibility.test.ts`   |
| 运行中但无 segment running（timelineOnly 等） | ChatLoading 兜底照旧                  | 同上                                               |
| 胶囊模型：duration 存在                 | 状态词 + 用时段 + 动态省略号都渲染         | 同上（pill 纯模型）                                |
| 胶囊模型：duration 缺失                 | 只渲染状态词 + 动态省略号                  | 同上                                               |
| 运行中（workStatus=running）            | 胶囊行吸顶，长轮任意滚动位置可见           | 同上（`resolveAssistantHistoryStatusStickyClass`） |
| 完成 / 中断 / 无 workStatus             | 不吸顶，回归普通文档流                     | 同上                                               |
| 离底 + 运行中 + 胶囊已滚出视口          | 贴底兜底按钮出现（点击回贴底）             | 同上（`shouldShowTimelineWorkingPillChip`）        |
| 离底但吸顶胶囊仍在视口内                | 兜底按钮缺席，不重复状态表达               | 同上                                               |
| 贴底 / 会话已终态                       | 兜底按钮缺席                               | 同上                                               |
| 尾部落盘槽落盘（ChatLoading 分支 / apiRetry） | 标记随分支出现/缺席                  | `packages/ui/test/v4ConversationTurnGroup.test.ts` |
| 运行结束                                | 吸顶释放，胶囊消失，回纯文本「已工作 {duration}」 | 既有行为，人工验证                          |

运行：`pnpm --filter @zcode/ui test`（tsx --test，`TSX_TSCONFIG_PATH=tsconfig.json`）。
注意 `chatLoadingVisibility.test.ts` 登记在 `vitest.config.ts` 的 `nodeRunTestFiles`，
根 `vitest run` 不收它；单文件可跑：

```bash
cd packages/ui && TSX_TSCONFIG_PATH=tsconfig.json node --import tsx --test test/chatLoadingVisibility.test.ts
```

兜底按钮与吸顶的真机证据走 desktop E2E（`WPK01`）：
`packages/desktop/test/e2e/conversation-session/manual-review/pending/conversation-session-working-pill-offscreen-chip.test.ts`
—— 离底 wheel → 断言 `[data-testid="v4-timeline-working"]` 出现，点击后消失且 `data-following`
恢复为 true（复用 `conversation-session-chat-loading-live-tail` 的
`E2E_CHAT_LOADING_REAL_LINES` fixture；已落库，处于 manual-review/pending，须人工审核运行
后按既有流程转正，本机未跑到该证据）。吸顶的几何断言需要在该用例里补一条：
本轮高度大于视口时贴底，`[data-zcode-working-pill]` 的 `getBoundingClientRect().top`
应等于滚动容器可视区顶部（允许 1px 误差）。
