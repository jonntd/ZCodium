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

## 3. 事件顺序

```text
行事实（turn header / rows）+ liveNowMs(每秒)
  └─ buildConversationTurnWorkSegments → workStatus(state=running, durationMs)
      ├─ AssistantHistoryStatus → ConversationWorkingStatusPill（胶囊触发行）
      │    └─ 点击 = 折叠/展开本轮工作历史（既有 Collapsible 语义）
      └─ ConversationTurnFlow
           └─ hasRunningWorkSegment = true → shouldShowTurnChatLoadingWithRunningPill=false
                → 尾部不再渲染裸 ChatLoading（apiRetry 状态照旧）
运行结束 → workStatus.state = completed → 胶囊消失，回到纯文本「已工作 {duration}」
```

## 4. 验收场景

| 场景                                          | 期望                                    | 测试                                             |
| --------------------------------------------- | --------------------------------------- | ------------------------------------------------ |
| 运行中且任一 segment running                  | 尾部 ChatLoading 被抑制，不出现双状态   | `packages/ui/test/chatLoadingVisibility.test.ts` |
| 运行中但无 segment running（timelineOnly 等） | ChatLoading 兜底照旧                    | 同上                                             |
| 胶囊模型：duration 存在                       | 状态词 + 用时段 + 动态省略号都渲染      | 同上（pill 纯模型）                              |
| 胶囊模型：duration 缺失                       | 只渲染状态词 + 动态省略号               | 同上                                             |
| 运行结束                                      | 胶囊消失，回纯文本「已工作 {duration}」 | 既有行为，人工验证                               |

运行：`pnpm --filter @zcode/ui test`（tsx --test，`TSX_TSCONFIG_PATH=tsconfig.json`）。
