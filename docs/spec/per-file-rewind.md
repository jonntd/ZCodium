# Spec: 按单文件撤销（Per-file Rewind）

本 spec 定义轮次文件摘要的**按文件撤销**语义：在每轮对话的文件摘要里，用户可以勾选
本轮改动中的任意文件子集（含单个文件）进行撤销，而不再只能整轮全部还原。整体撤销
（不勾选筛选）仍是缺省动作，按文件撤销是其超集能力。

> 现状：每轮 turnHeader 的 fileChanges 摘要面板有一个「撤销」按钮，预览弹窗确认后
> `applyWorkspaceFileRewind` 将本轮**全部** safe 文件还原；`fileChanges.state` 只有
> `active | reverted` 两态。CLI core 已按文件粒度记录 checkpoint artifact
> （每文件 beforeContent/afterContent），因此按文件撤销不需要新的存储，只需要把
> 计划/执行/投影三层加上路径维度。

## 1. 范围

- 作用面：`ConversationFileSummaryPanel` 的撤销弹窗（fileRewind variant）与摘要文件
  列表行的单文件撤销入口；`applyFileRewind` v4 命令；`fileRewindPreview` v4 查询；
  core `previewWorkspaceFileRewind` / `applyWorkspaceFileRewind`。
- 不改动：`editUserQuery` 的 `workspaceMode: "rewind"` 组合回滚（仍整轮 fail-closed）、
  `/rewind`、`/fork`、checkpoint 记录（`emitFileMutationCheckpoint`）、journal 补偿
  机制、对话级 rewind（conversation/both scope）。
- 不引入新存储：撤销记录复用 `RewindTriggered` 事件（append-only），快照复用既有
  workspace checkpoint artifact。

## 2. 状态所有权与事件顺序

```text
core file-rewind.ts（唯一执行事实源）
  buildWorkspaceFileRewindPlan(options + paths?: string[])
    ├ 读取本轮 CheckpointCreated 事件 → artifact → operations（每文件每操作一条，
    │  携带 rawPath = artifact 原始路径，绝对路径仅用于文件系统）
    ├ 排除已撤销路径：扫描 RewindTriggered(reason=file_summary_rewind, scope=workspace,
    │  targetMessageId 命中本轮) 的 files 集合 → excludedPaths
    ├ paths 过滤：仅保留 resolve(workspaceRoot, p) 命中的 operations/ignored
    └ 逆序模拟（每路径独立 hash 预检）→ safe/unsafe/ignored + canApply(仅针对选中子集)
  applyWorkspaceFileRewind
    ├ plan.canApply=false → applied:false（fail-closed，行为同现状）
    ├ journal → 逐文件还原/删除 → commitAfterApply（组合闸不变）
    └ 追加 RewindTriggered { ..., files: rawPath[] }（仅 paths 过滤时携带）

bootstrap product-projection（唯一投影事实源）
  onRewindTriggered(file_summary_rewind)
    ├ payload.files 缺席（旧事件 / 整轮撤销）→ state:"reverted"（现状不变）
    └ payload.files 在场 → header.fileChanges.revertedPaths ∪= files
       revertedPaths 数 ≥ fileChanges.files → state:"reverted"，否则保持 "active"
```

- `fileChanges.state` 仍是 turn 级聚合态；`revertedPaths` 是文件级撤销账本，与
  `fileChanges` items 的 `path` 同源同形（artifact 原始路径），UI 直接字符串比对。
- **路径形态契约**：preview 结果的 `safeFiles / unsafeFiles / ignoredFiles[].path`
  一律暴露 artifact 原始路径（rawPath），与 fileChanges items、`revertedPaths` 同形；
  绝对路径（`resolve(workspaceRoot, rawPath)`）是 core 内部 FileSystemPort 细节，
  不跨协议暴露。UI 的单文件预选与「已撤销」徽标匹配都依赖该同形契约——若任一侧
  改成绝对路径，精确相等匹配会静默失配（单文件入口表现为空选、确认禁用）。
- `canRewindFiles` 投影条件由 `state === "active"` 放宽为 `state !== "reverted"`：
  部分撤销后剩余文件仍可继续撤销。
- 并发窗口：两个窗口同时看到同一轮，A 窗口撤销文件 1 后 B 窗口再撤销（含或不含
  文件 1），core 因 excludedPaths 排除文件 1，不会误报 `external_modified`。

## 3. 协议（packages/shared zcode-protocol-v4）

1. `applyFileRewind` 命令 payload 增加 `paths?: string[]`（min 1 项，≤500 项）：
   本轮内要撤销的文件路径；缺席 = 整轮撤销（现状语义）。CAS / 幂等 / row-target
   规则不变。
2. `v4ConversationFileRewindPreviewResultSchema` 增加 `revertedPaths?: string[]`：
   core 预览时排除的「此前已撤销」路径，UI 用于在弹窗内标注。safe/unsafe/ignored
   条目的 `path` 形态即 artifact 原始路径（见 §2 路径形态契约）。
3. `turnHeaderRowSchema.fileChanges` 增加 `revertedPaths?: string[]`（可选、加值偏斜
   安全：旧桌面 parse 丢弃整个 turnHeader 行属既有已记录偏斜档，CLI 与桌面同批发布）。

## 4. UI 行为（ConversationFileSummaryPanel / ConversationFileRewindDialog）

1. 弹窗 safe 文件列表每行前置 Checkbox，**缺省全选**（保持「一键整轮撤销」习惯）；
   unsafe / ignored 列表不提供勾选（不可撤销，仅说明原因）。
2. 确认按钮文案随勾选数变化（`撤销 {count} 个文件`），勾选为 0 时禁用；勾选数少于
   safe 数时显示部分撤销提示（`仅撤销勾选的文件，其余改动保留`）。
3. `revertedPaths` 非空时弹窗显示说明行（另有 N 个文件此前已撤销，不会重复处理）。
4. 摘要面板展开后的文件列表：每行新增「撤销此文件」入口（仅 `canUndo` 且该文件未被
   撤销时可见），点击 = 打开弹窗并**只勾选该文件**；已撤销行显示「已撤销」徽标，
   不再提供撤销入口。
5. 确认始终经弹窗（destructive 按钮 + 文件清单），单文件入口不跳过确认，防止误触。
6. 应用成功后依赖投影推送关闭弹窗、刷新行状态；ACK rejected 时在弹窗内显示错误。

## 5. 验收场景

1. 整轮撤销：不改动勾选直接确认 → 全部 safe 文件还原，`state:"reverted"`（现状回归）。
2. 单文件撤销：文件列表行点「撤销此文件」→ 弹窗仅该文件勾选 → 确认后仅该文件还原，
   摘要保持 `state:"active"` 且该行出现「已撤销」徽标，其余文件 diff 不变。
3. 剩余文件继续撤销：再次撤销剩余文件 → 全部撤销后 `state:"reverted"`。
4. 选中文件外部被改：core 预检 `external_modified` → 确认按钮禁用并展示原因
   （仅当不安全文件在勾选集内时阻断）。
5. 冷启动：重启后历史会话部分撤销轮仍显示 `revertedPaths` 徽标与剩余可撤销入口
   （事件重放经同一投影归约）。
6. 旧 CLI + 新 UI：preview 缺 `revertedPaths` 字段 → 弹窗不显示说明行，整轮撤销照常。
