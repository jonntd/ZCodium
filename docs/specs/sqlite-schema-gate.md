# SQLite schema 只增门禁

## 所有者与入口

`scripts/check-sqlite-schema.ts` 从真实 app/CLI 迁移生成 schema，检查历史兼容及工作树 baseline 精确一致；`--update` 仍必须通过历史只增检查，不能借更新基线接受破坏性改动。

`scripts/sqlite-schema-git.mjs` 唯一负责 Git 历史选择及读取。架构检查的 resolver 支持当前分支 upstream、push 前 SHA、HEAD fallback，不能直接复用于此反篡改边界。

`scripts/sqlite-schema-baseline.mjs` 统一执行历史只增检查及 baseline 校验/写入；check 与 update 共享同一条历史检查路径。

## 基线合同

1. 优先 `SQLITE_SCHEMA_BASE_REF`，其次 GitLab `CI_MERGE_REQUEST_DIFF_BASE_SHA`、`CI_MERGE_REQUEST_TARGET_BRANCH_SHA`：解析成不可变 commit SHA，配置无效立即失败，不静默降级。
2. 有 `GITHUB_BASE_REF` 时使用 `origin/<target>` 的 merge-base，优先于 origin/HEAD；目标不存在或无共同祖先立即失败。
3. 无 CI 目标时依次使用 origin/HEAD、origin/main、origin/master、main、master 的 merge-base。不使用当前分支 upstream 或上次 push SHA；没有可用目标直接失败并提示 fetch/显式指定，不回退 HEAD。
4. 历史 commit/tree 及文件读取失败必须报错。仅成功列举目标 tree、确认该路径不存在时，允许首次引入 baseline；现有文件读取失败不能视为新库。

```text
显式/CI/目标分支 → helper 固定历史 SHA → tree 确认路径 → 历史 SQL
真实迁移 → 当前 SQL → 历史只增检查 → baseline 精确检查或更新
```

## CI 与验收

PR workflow 按持久化源码、schema 工具/测试、安装配置路径触发，checkout fetch-depth: 0，显式传入 PR base SHA；运行 node 合同/临时仓库测试及两库 schema check，不运行 update。

自动化临时仓库必须覆盖：干净已提交的删列与同步篡改 baseline（check/update 都拒绝）、合法新增 baseline、显式无效 ref、CI 无效/准确 SHA、GitHub target 优先 origin/HEAD、无目标拒绝、历史读取错误拒绝。现有八个 SQLite 结构合同测试继续保留。
