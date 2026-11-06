# 插件收敛为 Claude Code 形态：pane 转正、server 路线下线

## Context

用户拍板产品形态：**编辑器专用对话面 + 底层 spawn CLI**（对标 Claude Code 插件），不再走「server + 完整界面」。

勘察结论（3 个探索代理）：**pane 模式已是该形态的完整实现**——React `@zcode/ui` 同源装配（V4ChatPane/SessionPane：流式回复、思考折叠、工具时间线、审批卡 allowOnce/allowAlways、模型/协作模式/思考深度切换全在位）、进程内 ServiceCollection + postMessage 桥、CliLocator 三级定位 spawn `zcode app-server --stdio`、per-folder 崩溃自动恢复、约 128 个用例锁定（hostBridge 22 + integration.hostUi 13 + p0Equivalence 20 + runtimeRestart 12 + webviewBridge 20 + p0UiParity 41）。

收敛 = pane 转正为唯一模式 + server 路线下线 + 补 2 个 UI 差距。附带收益：消掉 full 分支「无会话时进程内 spawn」的单通道违约隐患（container.ts:509），capabilities 探针从「恒静默」转为正常出帧。

## 前置（顺序敏感）

1. **创建 Issue**（仓库硬性要求）：「收敛插件为编辑器专用形态：pane 转正、server 路线下线」，PR1/PR2 都关联它。
2. **未提交工作处置**：当前分支有未提交改动（§7.9 数据根口径：serverEnv.ts、dataRoot.test.ts、serverHost.ts、serviceAssembly.ts、container.ts、docs/architecture.md 等），与删除清单重叠。先向用户确认这些是否为其另一会话的进行时工作：若是且未提交，先以独立 commit 原样落地（口径修正自洽），收敛分支基于其上；避免删除动作连带丢掉他人未提交工作。
3. 新分支 `feat/vscode-editor-native`（自当前 feat/sync-bundled-plugins）。

## PR1：spec 先行 + server 下线（纯减法）

### 1a. spec 更新（AGENTS.md：行为修改前先改 spec）

- **新写** `docs/architecture-p2-convergence.md`：收敛决策记录——推翻双形态与 server 单通道（断 4 处对 zcodium-vscode PRD 的活引用）、删除面清单、capabilities 语义反转（进程内栈恒活跃，无「full 恒无帧」分支）、数据根「三方同根→两方同根（桌面端 + 插件进程内栈）」、M2-x 编号漂移澄清。
- **改** `docs/architecture.md` §7 条目 9/10（L454-465：数据根去 server 方、exportLogs 删 server 日志源）。
- **改** `docs/architecture-p1.md` L398-404（T07 closeout-2 注记反转）。
- **改** `src/CONTRACT.md` L67-80（删 openFullUi，31→30 条命令；补「单形态：编辑器专用 UI + spawn CLI」定位）。
- **改** `docs/contract-check.md` L86（FR-A03 引用改自描述）。
- **改** `test/e2e.checklist.md` §6（L174-218 整节作废）。
- **改** `README.md`（L51 完整界面命令及「打开侧栏」段落）。

### 1b. 代码删除

- **整删 `src/fullui/`**：serverHost.ts、serverEnv.ts、openFullUi.ts、serverLogTail.ts、hostServices.ts。
- **container.ts**：import L32-34/L54；server 装配块 L285-341；registerWorkspaceProject L343-376；ChatPanel fullUi 注入 L378-390；HostServices + runWithServices full 分支 L397-414（**pane 分支升格为唯一路径**）；restore 跳过 L474-476（取消跳过）；submitToConversation server 路径 L494-524（「发进对话」统一走 composer-insert 帧）；composer-insert full 分支 L529-538；openFullUi 命令 L565-573；dispose L590；exportLogs server 日志段 L685-696；L253-255 capabilities 注释改写。
- **chatPanel.ts**：fullUi 参数、buildFullUiHtml、full-ui-url 推送（L21-26/47-66/84-101/145-195）。
- **协议面**：hostFrameKinds.ts `full-ui-url`（L20/L34/L142-146）、wire.ts L61/L156。
- **package.json**：openFullUi 命令 + view/title 菜单（L58-62/L216-220）、fullUiRepoRoot/fullUiServerEntry/fullUiStaticRoot/nodePath/sidebarUi 五设置（L393-425）、`@zcode/client` 依赖（L458）。
- **esbuild.mjs** 两处 `__ZCODE_REPO_ROOT__` define（L41-44/L106-110）+ types.d.ts L4。
- **测试**：dataRoot.test.ts 删 server 段（L50-56、L68-105；保留 L41-48 services 侧 + L108-127 默认根解析）、diagnosticsExport.test.ts 删 serverLogTail 段（L27/L125-147）、删 `test/e2e-probes/` server 探针。

## PR2：差距补齐（UI 工作）

1. **接回侧栏内 diff**：App.tsx:329 `onOpenCodeViewer` 从 no-op 改真实现（复用 packages/ui v4 code-viewer 装配面，与桌面同源）。
2. **复活会话列表**：挂载死代码 `src/webview-react/sessions/SessionListPanel.tsx`（sessionListModel.ts 已有 13 测试锁定）+ PluginHeader 顶栏，恢复侧栏内会话切换/删除入口。
3. **@symbol/代码索引**：明确记为非目标（mentionSource.ts 已注明），写入 spec。

## 验证

每个 PR：`pnpm typecheck` + `pnpm lint` + `pnpm test` 全绿；`pnpm architecture:check --changed`；`pnpm size`（vsix 预算应下降）。真机 F5：侧栏默认即对话面（无 iframe），发一条消息验证 spawn CLI 链路与 **pane 形态下的凭据/provider 可用性**（此前 E2E 发现 server 数据根 providerCount=0，pane 的 CLI 凭据链路独立，需实测）；验证 capabilities 提示不误报、崩溃恢复（重启扩展宿主自动 resume）。

## 风险与边界

- 不碰 `apps/zcodium-vscode`（正被另一会话修改）；其 PRD server 章节仅在本仓 spec 里断引用，不改旧 PRD。
- 跨仓 `docs/spec/` 无需改动（已核实零耦合）。
- PR1 描述须写明被推翻的决策与理由（AGENTS.md PR 规范），关联 Issue 用 `Closes #<n>`。