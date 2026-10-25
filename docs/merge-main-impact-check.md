# 合并 main 影响评估（pnpm merge:main + pre-merge-commit 闸门）

本仓库长期分支（如 `feat/native-patcher-parity`）与 `main` 分叉很深，并携带大量 fork
定制：electron-builder DMG 布局、`packages/desktop/specs/` 领域 spec、release 工作流、
telemetry 移除、应用身份（`ZCodium` / `dev.zcodium.app` / `zcodium` scheme）。上游同路径
文件的改动会在合并时静默覆盖这些定制——v3.15.1 再基线（de5923d1）曾把 DMG contents
覆盖成上游简化版、删除说明 txt，直到打包后挂载窗口错乱才被发现。

因此「合并 main 前先对比对本分支的影响」固化为机制：

- `pnpm merge:main [ref]`（默认 `origin/main`）：评估影响，无交集或已确认时自动执行
  真正的 `git merge`；有交集且未确认则**在合并动作前拦截**。
- `pnpm merge:impact [ref]`：随时预览影响报告，不发起合并。
- `.husky/pre-merge-commit`：强制闸门，未经评估的直接 `git merge` 一律拦下并给指引。

## 为什么拦截点不在钩子里计算影响

实测 git 2.56 执行 `pre-merge-commit` 时：待合并 ref 不作为 `$1` 传入（`$#` 为 0），
`MERGE_HEAD` 也尚未写入（`git rev-parse MERGE_HEAD` 失败），钩子拿不到「要合入谁」，
无法计算影响报告。因此分工是：

- 影响对比由 `scripts/merge-main-impact-check.mjs` 完成（事实源是 git 三个 diff：
  `merge-base..对方`、`merge-base..HEAD`、交集文件的 HEAD 内容）；
- 评估通过后脚本以 `ZCODE_MERGE_IMPACT_ACK=1` 环境（子进程继承）执行 `git merge`，
  钩子看到 ACK 即放行；
- 钩子本身只拦「未经过评估的合并」，并提示正确入口。

## 事件顺序与所有者

```text
开发者                      merge-main-impact-check.mjs           git / husky
  │ pnpm merge:main               │                                    │
  │ ────────────────────────────► │ git fetch（ref 为 origin/* 时）     │
  │                               │ merge-base 双侧 diff + 交集标记     │
  │  报告：对方改动 ∩ 本分支改动面 │                                    │
  │ ◄──────────────────────────── │                                    │
  │ 无交集 ────────────── 自动 spawn git merge（带 ACK=1）─────────────► │ 钩子放行，merge commit
  │ 有交集且 ACK≠1 ── exit 1，合并未发生；逐个 review 交集文件          │
  │ 有交集且 ACK=1（ZCODE_MERGE_IMPACT_ACK=1 pnpm merge:main）─ 放行 ─► │ 钩子放行，merge commit
  │ 绕过入口直接 git merge ───────────────────────────────────────────► │ 钩子拦下并给指引
```

所有者：报告由脚本计算；放行与否由脚本（`--merge` 模式）与钩子共同执行；
review 结论由开发者负责。ACK 是一次性信任：`ZCODE_MERGE_IMPACT_ACK=1`
只放行当前这一次合并，报告仍会完整输出，供 review 留档。

## 报告内容与风险分级

对 merge-base 两侧各做一次 `git diff --name-status`：

- **对方引入**：`merge-base..ref` 的提交数与文件清单（合并会带进来的全部变化）。
- **本分支改动面**：`merge-base..HEAD` 的文件清单（会被影响的本方资产）。
- **交集**：双方都改过的同路径文件，逐个标注 `对方状态 + 本分支状态`，并读取
  HEAD 版本内容检查 fork 定制标记（`zcodium` / `dev.zcodium.app` / `解除拦截`，
  大小写不敏感）。含标记的文件是最高危项：上游不知道该定制，合并方向若以上游
  为准，定制会被冲掉。
- `--merge` 模式在评估前先 `git fetch` 对应远端分支，避免用陈旧的 `origin/main`
  算出虚假的「无影响」；fetch 失败（离线）时按本地已有引用评估并告警。

## 退出码

| 场景                                        | 退出码 |
| ------------------------------------------- | ------ |
| 无交集；或已确认/无交集后 merge 完成        | 0      |
| `--merge` 有交集且未 ACK（合并未发生）      | 1      |
| 用法错误                                    | 1      |
| 预览模式（`--json` / 无 `--merge`）存在交集 | 2      |

## 边界与已知限制

- **FF 合并不经过钩子**：fast-forward 不产生 merge commit。本仓库长期分支与 main
  必然分叉，同步上游总是 merge commit；快进场景本分支无独立改动可被覆盖。
- **有文本冲突的合并不触发钩子**：冲突使 merge 无法自动提交，Git 本身已强制
  人工介入；本机制主要拦截「无文本冲突、语义被覆盖」的场景（同名文件双方都改、
  fork 标记被上游版本冲掉、modify/delete）。
- **rebase 式同步（`git pull --rebase`）不经过本机制**：同步 main 请使用
  `pnpm merge:main`，不要 rebase 长期分支。
- 合并其他分支（如 fix 分支进特性分支）会被钩子拦下一次；确认无覆盖顾虑后用
  `ZCODE_MERGE_IMPACT_ACK=1 git merge ...` 放行。

## 验收

- `scripts/merge-main-impact-check.test.mjs`（已登记 `vitest.config.ts` unit include），
  在临时 git 仓库上验证：交集识别、fork 标记判定、modify/delete 组合、无交集路径、
  CLI 退出码（0/2）、`--merge` 拦截（HEAD 不变）/ ACK 放行（merge commit 生成）/
  无交集直接放行。
- 真实仓库 `pnpm merge:impact` 可直接预览下一次合并 main 的影响面。
