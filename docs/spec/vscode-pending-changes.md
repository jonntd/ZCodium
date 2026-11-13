# Spec: VS Code 扩展文件改动审查与历史（Pending Changes）

本 spec 定义 `apps/zcode-vscode` 宿主侧的「文件改动审查」能力：AI 每轮改动文件后，
用户可以在 VS Code 中**按需打开**该文件的原生双栏 Diff（左=改动前，右=当前磁盘文件），
对单个文件**独立撤销**（恢复到本轮改动前，逐字节一致）或**保留**，并在侧边栏
TreeView 中**跨轮次浏览修改历史并随时恢复**。

> 现状：CLI 侧检查点、逐文件撤销（`applyFileRewind` + `paths`）、撤销预检
> （`conversationFileRewindPreviewV4`，含 external_modified 哈希检测）、轮改动明细
> 查询（`v4/conversation/fileChanges`）全部就绪（见 docs/spec/per-file-rewind.md）；
> 聊天内 `ConversationFileSummaryPanel` 已提供逐轮逐文件撤销。本 spec 补的是
> **编辑器原生面**：宿主感知轮改动 → TreeView/状态栏提示 → 原生 Diff 审查 →
> 撤销/保留。CLI 零改造。

## 1. 范围

- 作用面：扩展宿主新模块 `src/host/pendingChanges/`；TreeView 视图
  `gode.changesHistory`（挂现有 activitybar 容器 `gode`）；状态栏待审计数；
  编辑器标题栏「撤销/保留」按钮；`gode.changes.*` 命令族。
- 不改动：CLI 协议与引擎；webview（聊天内既有文件卡片独立工作，两处经 CLI 事件
  天然同步）；`DiffViewer` 既有审批路径（仅泛化其内容提供器）。
- 产品拍板（2026-11-07）：呈现形态=**原生双栏 Diff**；**不自动打开**文件（轮完成后
  仅 TreeView/状态栏提示，点击才开）；历史入口=**侧边栏 TreeView**。

## 2. 明确不做

- 单栏「幽灵删除行」内联 diff（VS Code 公开 API 不可达，需自定义编辑器）；
- 轮完成后自动打开文件（用户已排除）；
- Redo（重应用已撤销内容；CLI 无对应能力）；
- 多 workspace folder 并行跟踪（v1 仅跟踪主 folder 的活跃会话，见 §6）。

## 3. 状态所有权与事件顺序

```text
CLI 运行时                      扩展宿主（apps/zcode-vscode）                VS Code
──────────                     ──────────────────────────────             ────────
tool 写文件 → CheckpointCreated
轮结束 TurnComplete
  │ 投影 row.upserted(turnHeader:
  │   state=completed*,
  │   fileChanges{files>0, state:"active"})
  │ [结构性 delta 批次必以
  │  state.updated{revision} 结尾]
  ▼
onDynamicConversationFrame ───▶ ChangesService（订阅编排）
                                 ├ TopicWireFrameAssembler 解帧
                                 ├ ChangesTracker.applyFrame（唯一状态所有者）
                                 │   ① 轮终态+files>0+state=active → pending 入列
                                 │   ② conversationFileChangesV4 拉每文件明细
                                 │      （patches 用于 diff 左栏重构）
                                 │   ③ 发 onChange → Tree/状态栏/setContext 刷新
                                 ▼
                        HistoryTree(TreeView)      StatusBar（📝 n 待审）
                        待审查 / 历史 两段
                                  │
                        用户点击文件 → ChangesDiffOpener
                          vscode.diff(改动前虚拟文档, 磁盘文件)
                        编辑器标题栏 [撤销] [保留]（gode.pendingFile 上下文键）
                                  │
              撤销：conversationFileRewindPreviewV4 预检
                ├ canApply=false → 中文警告（external_modified 等），不动文件
                └ canApply=true → sendConversationCommandV4(
                    applyFileRewind { target, paths },
                    envelope{commandId, clientId, sessionId,
                             baseRevision, baseLogEpoch})
                    → ack.applied → CLI 落盘还原
                    → RewindTriggered(reason=file_summary_rewind)
                    → 投影 row.upserted(fileChanges.revertedPaths / state)
                    → Tracker 消费 → 状态/树刷新
```

- **`ChangesTracker` 是 pending/history 的唯一所有者**；文件内容以磁盘为准（撤销落盘
  由 CLI 执行，宿主零文件写入）；webview 与宿主各自独立投影，靠 CLI 事件收敛。
- CAS 水位：Tracker 从 snapshot 取 `{logEpoch, revision}`，随后每个结构性 delta 批次
  末尾的 `state.updated{revision}` 递增（product-projection.ts `attachRevision` 保证）。
  查询（fileChanges/rewindPreview）与命令信封统一用该水位。
- **订阅所有权（话题级监听，2026-11-13 修复帧断流）**：CLI 的 topic 订阅语义是
  「同 connectionId 重复 subscribe 即作废旧订阅」。聊天 webview 连接后会在同一条
  连接上订阅同一 topic，把扩展宿主的后台订阅顶掉（实测 wire subId 由 `-1` 变 `-2`，
  旧流此后停帧）。因此 Service 侧按 **topic 采纳当前活跃流**，不按 subId 过滤：
  每当出现新 subId 就换新 `TopicWireFrameAssembler` 从头接收（新订阅者首帧是完整
  resume/snapshot，`applyFrame` 对 snapshot 幂等，状态可重建），并且**永不主动重
  订阅**——否则会反过来顶掉聊天面，陷入订阅所有权战争。
- **帧驱动的账本变更必须广播（2026-11-14 修复角标不消）**：撤销清账有两条路径——
  宿主自己的命令回流（`markReverted`）与 CLI 投影帧回流（`applyFrame` 的
  revertedPaths/reverted 消费）。后者同样改变了 pending/history，`applyFrame` 必须
  在发生账本变更时 `emit()`，否则角标与持久化静默失真（账已清、角标仍挂）。
  撤销路径同形收敛依赖 `setWorkspaceRoot` 注入（必须在 importPersisted / 订阅快照
  之前）。

## 4. 数据形状与路径形态契约

```ts
interface PendingFileChange {
  /** artifact 原始路径（rawPath，相对或绝对同 CLI artifact；见 per-file-rewind.md §2）。 */
  path: string;
  /** 解析后的绝对路径：绝对则原样，相对则 resolve(workspaceRoot, path)——与 CLI
   *  file-rewind.ts 的归一语义一致；UI 打开 diff 用它。 */
  resolvedPath: string;
  sessionId: string;
  /** turnHeader 行定位（row target：rowId + entityId）。 */
  target: { rowId: number; entityId: string };
  turnRowId: number;
  turnTitle: string;
  turnEndedAt: number;
  additions: number;
  deletions: number;
  /** 每文件最终 patch（first-before → final-after），重构 diff 左栏用。 */
  patches: ReadonlyArray<{
    oldStart: number; oldLines: number;
    newStart: number; newLines: number;
    lines: string[];
  }>;
}

interface HistoryTurnEntry {
  sessionId: string;
  target: { rowId: number; entityId: string };
  rowId: number;
  title: string;
  endedAt: number;
  /** 该轮全部文件及其文件级状态：pending（在待审）│ kept（已保留）│ reverted（已撤销）
   *  │ superseded（同路径被后续轮改写，哈希预检必然拦截）。 */
  files: Array<{ path: string; resolvedPath: string; additions: number;
                 deletions: number; state: "pending"|"kept"|"reverted"|"superseded" }>;
}
```

- 撤销命令 `paths` 传 **rawPath**（与 fileChanges items、revertedPaths 同形，CLI 侧
  归一）；`revertedPaths` 匹配按 rawPath 字符串精确比对（per-file-rewind.md §2 契约）。
- 同路径多轮：pending 恒指向**最新**写入轮；旧轮该文件标记 `superseded`（恢复会被
  external_modified 拦截，UI 直接呈现为不可恢复，语义一致）。

## 5. 宿主模块（src/host/pendingChanges/，headless 优先）

| 文件 | 职责 | vscode 依赖 |
|---|---|---|
| `types.ts` | 上述类型 + Tracker 输入帧/输出事件形状 | 无 |
| `beforeContent.ts` | `reverseApplyPatches(current, patches)`：把 DiffHunk[] 反向应用到当前内容重构「改动前」全文；失败返回 null（降级只读打开） | 无 |
| `changesTracker.ts` | 纯状态机：applyFrame（snapshot/deltas）→ pending/history；keep/revert/外部 revertedPaths 流转；CAS 水位跟踪；onChange | 无 |
| `changesService.ts` | vscode 编排：按主 folder 活跃会话订阅（observeRuntime 范式，见 services groupRuntimeSnapshot.ts）+ 换代重订；拉明细；预检+派发 applyFileRewind；workspaceState 持久化（≤100 轮）；setContext/状态栏/树刷新 | 是（经注入，可测） |
| `diffOpener.ts` | 注册 `zcode-before` 内容提供器；`vscode.diff(beforeUri, fileUri, title, {preview:true})`（范式同 features/quickEdit.ts）；删除文件右栏为空虚拟文档 | 是 |
| `historyTree.ts` | TreeDataProvider：待审查（文件节点+行内撤销/保留按钮）、历史（轮→文件，superseded/reverted 禁用恢复） | 是（经注入，可测） |

订阅生命周期：`subscribeConversationV4({workspacePath, sessionId, visibility:"background"})`；
`onDynamicConversationFrame({workspacePath})` 过滤 `topic === conversation/<sessionId>`
与 `subscriptionId`；换代（`onAgentRuntimeRestarted`）/活跃会话切换（notifySessionCreated、
restore 完成后）→ 重订。运行时不可用或订阅失败：降级为空状态 + 诊断日志，不静默、不崩。

## 6. 多 folder 限制（v1）

仅跟踪主 folder（`workspace.workspaceFolders[0]`，与编辑器命令族 `editorWorkspacePath()`
同口径）的活跃会话。多根工作区其他 folder 的会话改动继续走聊天内文件卡片。后续扩展点：
Tracker 按会话分桶，Service 对每个有活跃会话的 folder 各建一条订阅。

## 7. 贡献点（package.json）

- `views`：容器 `gode` 下新增 `gode.changesHistory`「文件改动历史」。
- `commands`（category Gode）：`gode.changes.openDiff`（打开待审 Diff）、
  `gode.changes.revertFile`、`gode.changes.keepFile`、`gode.changes.revertTurn`、
  `gode.changes.keepTurn`、`gode.changes.revertFromHistory`。
- `menus`：`editor/title`（`when: gode.pendingFile == true`，撤销/保留两按钮）、
  `view/title`（刷新）、`view/item/context`（树行内撤销/保留/恢复）。
- 上下文键：`gode.pendingFile`（活动编辑器命中 pending 时为 true，由 Service 维护）。
- 状态栏：`setPendingChanges(n)`，文本追加 `$(git-staging) n`，点击聚焦 TreeView。

## 8. 持久化与恢复

- workspaceState 键 `gode.pendingChanges.v1`：`{pending: PendingFileChange[],
  history: HistoryTurnEntry[]}`（history ≤100 轮，FIFO 裁剪）。
- activate 恢复：读持久化 → 订阅后以 snapshot/明细**重建校验**（轮是否仍 active、
  文件是否仍存在），恢复动作一律以预检结果为准（预检是唯一安全裁决）。

## 9. 验收场景

1. AI 一轮改 2 个文件 → 轮结束后 TreeView「待审查」出现 2 个文件节点，状态栏出现
   待审计数；打开被改文件，编辑器标题栏出现「撤销/保留」。
2. 点击待审文件节点 → 原生双栏 Diff 打开：左=改动前内容（由当前内容反向应用 patch
   重构），右=当前磁盘文件；被删除行在左栏可见。
3. 撤销文件 A → 文件内容逐字节等于本轮改动前（与 CLI artifact beforeContent 一致），
   待审查剩 1 项，历史中该文件标记「已撤销」。
4. 保留文件 B → 从待审查消失，历史中标记「已保留」，编辑器标题栏按钮消失。
5. 撤销前用户手动修改了该文件 → 预检报 external_modified，弹出中文警告，文件不被
   覆盖，待审状态保留。
6. 新一轮再次改同一文件 → 待审查指向最新轮；历史中旧轮该文件显示「已被后续改动覆盖」
   且恢复禁用。
7. 重启 VS Code → 待审查与历史从 workspaceState 恢复并经快照校验；撤销仍可用。
8. AI 删除文件 → 撤销后文件被删除（restore→delete 语义）；Diff 打开时右栏为空虚拟
   文档。
9. Agent 进程换代 → 订阅自动重建，pending/历史不丢、不重复计数。

## 10. 测试

- `test/beforeContent.test.ts`：反向应用（纯增/纯删/替换/多 hunk/跨行上下文/失败降级）。
- `test/changesTracker.test.ts`：帧→pending；keep/revert 流转；同路径新轮 superseded；
  revertedPaths 消费；snapshot 重建；CAS 水位递进。
- `test/changesService.test.ts`（内存假 services）：轮终态触发查询；撤销信封形状
  （commandId/clientId/sessionId/baseRevision/paths）；预检 unsafe 不发命令；换代重订。
- `test/historyTree.test.ts`：树模型（两分组、行内动作、禁用态、rawPath→绝对路径解析）。
