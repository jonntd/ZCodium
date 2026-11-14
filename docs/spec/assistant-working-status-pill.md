# Spec（已退役）：运行中工作状态胶囊（assistant working status pill）

> **状态：已回退（2026-11-14）。** 运行中工作状态的呈现已恢复为 main 实现：
> `AssistantHistoryStatus` 纯文本状态行（「工作中 {duration}」/「已工作 {duration}」/「已停止」）
>
> - 轮尾裸 `ChatLoading`（`LoaderIcon animate-spin`，`TurnChatLoadingSlot` 兜底）。
>   胶囊组件、吸顶、离屏兜底 chip、双状态抑制规则已全部移除，相关文件与 origin/main 对齐：
>
> * 删除：`ConversationWorkingStatusPill.tsx`、`conversationWorkingStatusPillModel.ts`
> * 还原：`ConversationTurnGroup.tsx`、`ConversationTimeline.tsx`、`chatLoadingVisibility.ts`、`styles.css`（胶囊省略号动画块）
> * 删除 i18n `chat.history.workingPill.*`、`TID_V4_TIMELINE_WORKING`、`chatLoadingVisibility.test.ts`
>
> 状态所有者不变：运行判定与耗时仍由 `buildConversationTurnWorkSegments` /
> `resolveConversationTurnWorkStatus`（`conversationTurnWorkSegments.ts`，与 main 一致）推导，
> 本文件不再定义任何呈现契约。

## 历史决策记录

1. **2026-10（一期+二期）**：对照 DeepSeek 桌面端引入 DeepSeek 风格状态胶囊
   （图标 + 状态词扫光 + 用时 + 动态省略号），运行中取代纯文本触发行；随后补
   sticky 吸顶（长轮工作行持续追加会把头部顶出视口）与离屏兜底 chip
   （本轮整体滚出视口时 dock 上方的「工作中」入口），并规定胶囊可见时抑制尾部
   裸 ChatLoading。E2E `WPK01` 于 2026-11-14 在 manual-review 下实跑通过
   （此前因 E2E harness 数据根漂移——seed 写 `{home}/.zcode` 而 app 读
   `{home}/.zcodium` 且要求 `.zcodium-root.json` 归属清单——从未在冷启通过，
   修复见 wdio.conf `writeE2EDataRootManifest` 与 desktop-app 常量拆分）。
2. **2026-11-03**：官方 v3.17.2 已改为像素九宫格加载行且不在公开 origin/main 上，
   当时决策不跟进官方视觉、维持本胶囊设计。
3. **2026-11-14（最终）**：用户决策回退到 main 的实现（纯文本状态行 + 裸
   ChatLoading），胶囊整套呈现下线。若未来上游公开其新版加载行，在 merge main
   时按影响评估流程重新决策，不再维持本 spec 的胶囊契约。
