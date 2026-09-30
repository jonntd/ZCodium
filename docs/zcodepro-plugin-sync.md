# ZcodePro 上游同步手册（plugin 分支合并流程）

上游 `luxi233/ZcodePro`（remote 名 `zcodepro`）是插件市场与分发侧仓库；本地
`plugin` 分支是它的**纯镜像**（upstream 跟踪 `zcodepro/main`）。上游有更新时，
把 `plugin` 快进后 merge 进 fork 主线（`feat/*`）。本手册记录标准流程与冲突决策，
执行者无需重新推断。

## 角色与红线

- `plugin` 分支只做镜像：**只允许 fast-forward 到 `zcodepro/main`，禁止在它上面
  产生本仓库的提交**。
- merge 永远发生在 fork 主线上（`feat/*`），`plugin` 只作为被合并方。
- fork 已退役分发侧 patch 路线（98d2680 CUA 内置化），上游「给官方 asar 打补丁」
  的工具与文档**不进入** fork 代码；上游对官方 runtime / 插件源码的修复**可能
  对 fork 有效**，需逐笔判断（见 §冲突决策）。

## 标准流程

```bash
# 0. 基线检查（工作区必须干净）
node scripts/check-workspace-freshness.mjs
git status --porcelain

# 1. 拉上游，看增量
git fetch zcodepro --prune
git log --oneline plugin..zcodepro/main        # 新提交清单
git log --oneline $(git merge-base HEAD plugin)..zcodepro/main --stat  # 改了哪些文件

# 2. 快进镜像（dfb318a..389cfb0 形态的纯快进）
git fetch . zcodepro/main:plugin

# 3. 合并进当前主线（merge-base 应恰为 plugin 旧位置，只带入增量）
git merge plugin

# 4. 解决冲突（见下表）→ 验证 → 提交
```

## 冲突决策表

| 文件                                                              | 决策                                          | 依据                                                                   |
| ----------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| `README.md` / `README.zh-CN.md`                                   | 保留我方（`git checkout --ours` + `git add`） | 上游是 ZcodePro 分发版安装文档，fork README 独立维护（9c6c7a1 起既定） |
| `tools/patch-cua-runtime.cjs` 等分发侧打包补丁脚本                | 维持删除（`git rm`）                          | fork 走源码内置化，98d2680 已退役「装机后 patch」野路子                |
| `MARKETPLACE*.md` 市场文档                                        | 取上游                                        | fork 不改写市场文档，镜像上游为准                                      |
| `runtimes/zcode-cua/**`、`packages/*-plugin/**` 等运行时/插件源码 | **逐笔评估**                                  | 这是 fork 内置化的真实现，上游同名修复往往同样有效（例见下）           |

### 上游改动的两类判断（核心）

每笔上游提交先归类：

1. **分发侧补丁**——改 `tools/patch-*`、安装文档、打包器。对 fork 无效，冲突时
   保留 fork 方向（通常是删除/我方）。
2. **官方源码修复**——改 `runtimes/`、插件包源码。fork 内置化拷贝了同一份代码，
   上游修的 bug fork 大概率同样存在。这类**自动合并成功也要看 diff**：
   - 语义核对：修复点在 fork 链路上是否被调用、与 fork 已有 patch 是否兼容；
   - 兼容性核对：与 fork 侧已打的补丁（`git log --oneline -- <file>`）有无语义冲突。

实例（c1cf76f 合并）：上游 058f090 修 `queryScreenRecordingPreflight` 只接受
对象结果、漏 bare string（`granted`/`denied`）形态——fork 的
`packages/services/src/node.ts` `resolveCuaScreenRecordingState` 依赖这个底层
预检返回真值，同样的 bug 同样致命。自动合并带入后人工核对确认有效。

## 验证与提交

```bash
pnpm typecheck   # 必须 0 错
pnpm lint        # 必须 0 警告 0 错
# 若合入了 runtime / 插件代码：跑对应包测试（tsx --test 口径见 AGENTS.md）
```

提交信息沿用 `chore(plugins)` 前缀，**必须写明冲突处理决策**，供下次合并对照：

```
chore(plugins): 同步 ZcodePro 上游 N 笔（<旧>..<新>）

分发侧补丁线更新。冲突按 fork 方向解决：
- README.md / README.zh-CN.md 保留我方（…原因）
- tools/patch-cua-runtime.cjs 维持删除（98d2680 内置化决策）
- <若有> runtimes/… 自动合入上游 <hash>：<为何对 fork 有效>
```

## 历史记录

| 合并提交 | 带入范围                 | 备注                                                                                                                 |
| -------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| 9c6c7a1  | plugin@dfb318a 初次拉入  | 12 插件市场内容进入 fork；README 冲突保留我方                                                                        |
| c1cf76f  | dfb318a..389cfb0（6 笔） | 4 笔 CUA 分发补丁 + seed gate + README；仅 058f090 的 bare string 修复实质合入 `runtimes/zcode-cua/broker-server.js` |
