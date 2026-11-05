# zcode-vscode 进度评估 + 按 PRD 续作（动态工作流）

## Context

用户要求：① 评估 `/Users/jonntd/ZCodium/apps/zcode-vscode`（v0.2.0，ZCodium Agent 的 VS Code 扩展）的开发进度；② 以 `/Users/jonntd/ZCodium/apps/zcodium-vscode/PRD.md`（v1.25，2523 行）为需求源继续实施。用户已选定范围 = **全部按序推进**（收官清理 → M2 残余 → M3 核心，有上限），并同意**实施前先提交现状快照**。

勘察已确认：zcode-vscode 是 zcodium-vscode 的正式重写，进度已超过 PRD 自身 M1/M2——P0 基线 + T01–T14 基建 + M1 编辑器功能 + M2 完整界面承载 + 内置 CLI bundle 均落地，19 文件 246 用例全绿、typecheck/build/体积门禁通过、vsix 已产出。欠账集中在：真机 E2E 清单未执行（本环境无 VS Code 宿主）、两条真机链路探针（`e2e-autolink.mjs` 验证无 projectId 会话创建 gate 修复、`rows-probe.mjs` 验证 rows 渲染）结论未回填、数据根口径三处矛盾（`src/container.ts:134-138` vs `src/fullui/serverHost.ts:28-36` vs `src/fullui/openFullUi.ts:16-17`）、capabilities 投影未接线、`exportLogs` 仅占位（`src/container.ts:649-655`）、CONTRACT.md 命令数漂移（写 14 实际 31）、6 个探针脚本 + 3 个 1.5MB bundle 散落根目录。

## 第一步：现状快照提交（我，工作流启动前）

整个 `apps/zcode-vscode/` 未跟踪，直接改无法回退。先 `git add apps/zcode-vscode && git commit`（消息：`chore(zcode-vscode): 提交实施前工作流快照`）。`.gitignore` 已排除 out/dist/node_modules/vsix，净增约 20MB（含 cli-bundle 15.7MB 与 3 个探针 bundle，均为现状的一部分）。不动仓库其他未提交改动、不动 zcodium-vscode。此提交同时让工作流内的复审可基于 `git diff` 进行。

## 第二步：CreateWorkflow「zcode-vscode 进度评估与 PRD 续作」

### 子代理拓扑（共 6 个命名子代理）

| 阶段 | 子代理 | 并发 | 返回（typed） |
|---|---|---|---|
| 1. 复核现状（join，下一步需全部结果） | `工程勘察员`（结构/docs 谱系/测试盘点）、`PRD 对照员`（PRD §13 里程碑与 FR ↔ zcode-vscode 代码逐条对照，给出证据与规模估计）、`问题核查员`（核实上列候选问题 + grep 补充，逐条给 file:line 证据、定性 verified） | 3 并行 | 工程勘察 / PrdGap[] / Issue[] |
| 2. 排期 | `排期整理员`：汇总三者产出有序 WorkItem[]，上限 8 项（收官 ≤5、M2 ≤3、M3 ≤2），未入选项记为 notPlanned | 1 | WorkItem[] |
| 3. 逐项实施 | `实施工程师`：**单个共享代理串行**实施（保持代码惯例一致），每项：行为改动先更新 docs/ 对应 spec → 实施 → 门禁 | 串行循环 | ImplResult（逐项） |
| 4. 门禁与复审 | `终审复核员`（全新上下文，只读 git diff + 规范核对，专挑会坏的地方） | 1 | Review（高危发现→触发一轮修复） |
| 5. 报告 | 无子代理，脚本由 typed 数据直接拼装报告 | — | — |

### 门禁（world.run，cwd = apps/zcode-vscode，全部来自 package.json 实有脚本）

- `node ../../scripts/check-workspace-freshness.mjs`（首门；非零 → 实施阶段跳过、如实报告受阻，分析报告照常交付）
- `pnpm typecheck`（每项实施后，失败回灌 `实施工程师` ≤3 轮）
- `pnpm test`（实施完毕后，失败修复 ≤3 轮）
- `pnpm package`（最强门禁：esbuild + vsce + 体积门禁，收尾跑一次）
- `node e2e-autolink.mjs`（自起隔离数据根 server 验证 gate 修复；模块解析失败则回退 `node e2e-autolink-bundle.mjs`）
- 架构检查 `pnpm architecture:check --changed` 由实施者按 AGENTS.md 从仓库根执行并留证据，`终审复核员`核对

### 交付物

- `progress-report`（markdown，primary）：开发进度评估报告——整体结构、已完成模块、待实现核心特性、已知问题（逐条 verified/unconfirmed + 证据）、PRD 差距表、本轮实施记录、门禁验证记录
- `impl-board`（board 预设）：工作项状态看板（待实施/已完成/受阻），逐项 `report()` 实时更新
- 最终 `return` 用 WorkflowReport 形状（conclusion/findings/verified/notCovered），全中文

### 写入实施工程师任务说明的硬约束（来自 AGENTS.md 与 CONTRACT.md）

- 行为改动先改 spec（`docs/prd-p1.md` / `architecture-p1.md` / `architecture-p1b.md`）再改码；修 bug 用中文注释说明根因与依据
- 不引入循环依赖、不跨域导入实现细节、遵守 `src/CONTRACT.md` 门面与依赖方向；UI 改动兼顾桌面/移动 Web 与 i18n
- 日志用既有 logger（`src/features/logger.ts`、`createServiceLogger`），不写凭据
- 工作流内**不做任何 git commit/push**（快照之外）；设计缺陷或需求冲突走子代理升级机制问我，不硬编兜底

## 候选实施池（供排期整理员按证据筛选，非承诺清单）

- **收官**：探针结论回填文档、数据根口径统一（实测行为后统一所有者）、capabilities 接线或明确缓期、exportLogs 实做、CONTRACT.md 命令数同步、探针脚本归位 scripts/ 并清理 bundle 残留
- **M2 残余（PRD）**：M2-5 权限记忆(B14)、M2-7 CLI 兼容(A13)、M2-8 官方 MCP 头(A16)、M2-9 Hooks 信任(A18)、M2-10 会话目标(A19)
- **M3 核心（PRD）**：A07 检查点/回滚（旧工程 `checkpoint-probe.mts` 已验证 v4 链路）、A07b 分叉、A08 附件、B15 计划 UI、B21 符号引用

## 验证

- 工作流自证：上表门禁全过 + 复审无高危发现；完成后我核对 run completed、测试全绿、`pnpm package` 通过、`e2e-autolink` PASS、报告 findings 与证据一致。
- notCovered（如实披露）：真机 E2E 清单（无 VS Code 扩展宿主）、真实模型交互、未进上限的 M3 特性、zcodium-vscode 工程本身（只读参考，不改动）。

## 后续（工作流外，需另行指示）

- 实施产物的正式 commit / PR 按 AGENTS.md GitHub 流程（先关联 Issue）。