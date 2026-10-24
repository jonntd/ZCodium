# Desktop dev：跳过 Agent CLI 全量重建

## 背景

`pnpm dev:desktop` 在启动 Electron 之前，`scripts/dev-desktop-env.mjs` 会调用
`scripts/build-desktop-agent-cli.mjs`，把整条 CLI 链重建一遍：

```text
dev:desktop
  `--> dev-desktop-env.mjs
          +--> build-cua-helper-app.mjs        (darwin + 真实 Computer Use producer)
          +--> pnpm --filter @zcode/desktop pre-dev
          +--> build-desktop-agent-cli.mjs     <-- 全量重建 9 个 workspace 包
          `--> pnpm --filter @zcode/desktop dev:runtime
                  `--> concurrently(tsup --watch, vite dev, dev.mjs)
```

即使一行 CLI 代码都没改，这一步也会重跑 tsc / tsup 整条链路（`@zcode/shared-types` →
`@zcode/bootstrap` → `@zcode/cli` 的 `zcode.cjs`），外加两个独立 MCP runtime
（`@zcode/node-repl-host`、`@zcode/browser-use-plugin`）。在外置卷（如
`/Volumes/date`）上实测耗时 **3-9 分钟**，期间 CPU 与磁盘 IO 长时间打满，是「dev 一跑
CPU 就 100%」的主要来源——不是 Electron 或 Vite 在跑满。

## 开关

```bash
pnpm dev:desktop:fast          # 等价于下面这条，跨平台（Windows 也可用）
ZCODE_SKIP_AGENT_CLI_BUILD=1 pnpm dev:desktop
```

- **opt-in，默认关闭**。不设置该变量时行为与之前完全一致；CI、prebuild、
  `zcode-server-cli` 打包链、`pre-dev:local-cli` 都不受影响。
- 只有在判定「产物比全部相关源文件新」时才跳过；判定为陈旧则照常全量重建，并打印原因。
- 跳过时仍然执行 staging（`stageBuiltinProviderConfig` / `stageDevAgentBundle` /
  `stageDevCuaPluginRuntime`）——staging 依赖当前环境（`ZCODE_ENV`、平台 key、目标目录），
  不能省略。实测跳过路径整体约 **7 秒**。
- 开关只注入 `build-desktop-agent-cli.mjs` 这一次子进程环境，不会带进 Electron / Agent
  运行时；因此不能用「在 shell 里 export 一次就长期生效」的方式依赖它。

> 不要用 `ZCODE_BOOTSTRAP_WITH_REMOTE=1` 当作替代开关：那个变量还会改变
> `prepare-agent-node-bundle.mjs` 与 `prepare-prebuilds.mjs` 的分支语义，副作用远大于本开关。

## 判定规则

实现：`scripts/agent-cli-build-freshness.mjs`。

| 项 | 规则 |
|---|---|
| 产物 | `apps/zcode-cli/packages/cli/dist/zcode.cjs` |
| 源范围 | 从 `@zcode/cli` 出发沿 workspace `dependencies` / `optionalDependencies` / `peerDependencies` 做依赖闭包，收集每个包的 `package.json` + `src` + `scripts` |
| 额外源 | 调用方显式补入 `requiredDevPluginRuntimeBuilds`（两个独立 MCP runtime 不在 CLI 依赖闭包里） |
| 比较 | `bundle.mtime >= 所有源路径的最大 mtime` 才算新鲜（相等也算：复制/解包会抹平 mtime） |
| 目录 mtime | 计入。新增/删除文件即使保留旧文件时间戳，目录 mtime 仍会变化 |
| 忽略目录 | `node_modules` / `dist` / `out` / `.git` / `.turbo` / `.cache` / `coverage` |
| 保守回退 | 产物缺失、产物不可读、源路径一个都读不到 ⇒ 一律按「不新鲜」处理 |

源范围**动态推导**，不维护第二份包清单。历史上 `cliWorkspaceBuilds` 就是手写清单，
新增 `@zcode/telemetry` 时只改了一条路径、另一条漏掉，导致干净 CI 构建失败；
这里的闭包会随 `package.json` 自动跟随。

## 日志

```text
[build-desktop-agent-cli] skip rebuild: bundle is newer than all CLI sources (ZCODE_SKIP_AGENT_CLI_BUILD=1)
[build-desktop-agent-cli] full build required (reason=source-newer); ZCODE_SKIP_AGENT_CLI_BUILD=1 was ignored
```

`reason` 取值：

| reason | 含义 | 处理 |
|---|---|---|
| `fresh` | 可复用 | 跳过全量构建 |
| `bundle-missing` | `dist/zcode.cjs` 不存在（首次、`clean` 之后） | 正常，会全量构建一次 |
| `source-newer` | 有源文件比产物新 | 正常，说明这次确实改了 CLI 侧代码 |
| `bundle-unreadable` | 产物 stat 失败（权限/挂载问题） | 需要排查文件系统 |
| `sources-unreadable` | 源目录全部读不到（路径错、卷未挂载） | 需要排查工作区 |

看到 `source-newer` 却确信自己没改 CLI 侧代码时，用下面的命令定位是哪个文件：

```bash
node --input-type=module -e '
import { resolveAgentCliSourceRoots, findNewestSourceMtimeMs } from "./scripts/agent-cli-build-freshness.mjs";
const roots = await resolveAgentCliSourceRoots(process.cwd(), {
  additionalPackageNames: ["@zcode/node-repl-host", "@zcode/browser-use-plugin"],
});
console.log("newest source:", new Date(await findNewestSourceMtimeMs(roots)).toISOString());
'
```

常见原因：`git checkout` / `rebase` 把文件 mtime 刷到当前时间；从别的分支复制文件；
`pnpm install` 重写了某个包的 `package.json`。

## 为什么不做成默认行为

跳过的正确性依赖 mtime。以下场景会让 mtime 判定失真：

- 用 `cp -p` / `rsync -a` / 解包工具同步代码，文件 mtime 被保留成旧时间（目录 mtime
  能兜住「新增/删除」，但「内容替换且保留旧 mtime」兜不住）；
- 时钟回拨（NTP 校正、手动改时间）后产物的 mtime 落在未来；
- 在别的机器/容器里构建后同步 `dist` 过来。

这些情况下默认全量构建是唯一安全的。需要「改完 CLI 立刻在 dev 里生效」时不要设这个变量。

## 相关：仓库 I/O 本身

外置卷上 `git status` 曾经要 4 秒（纯 I/O 等待）。仓库级修复（可回退）：

```bash
git config core.untrackedCache true
git config core.fsmonitor true
```

实测 `git status --porcelain` 从 4.09s 降到 0.01s。另外 `/Volumes/date` 默认开着 Spotlight
索引且没有 `.metadata_never_index`，建议在系统设置里把仓库目录加入 Spotlight 排除项，
否则 mdworker 会在构建期间持续抢占 IO。

## 产物重建自动重启 Electron（2026-10-22）

**背景**：tsup watch 在 App 运行中重建 `out/main` 时，运行中的主进程可能被 JS 热循环烧死
（实测：事件循环 100%、定时器/日志全饿死 10 小时，只能重启电脑；进程消失后无法定罪，
怀疑与运行中进程 + 重建产物同框有关）。

**机制**（`scripts/dev.mjs`）：main bundle 或任一 `.build-ready` 标记 mtime 变化
（= 某个 tsup 目标成功重建）后，静默 1.5 秒（等这一轮多目标构建全部写完），然后
SIGTERM →（1.5s 未退则）SIGKILL 旧 Electron，重新拉起新实例加载最新产物。
「运行中的 App」与「磁盘上的产物」不再同框。

- 关闭：`ZCODE_DEV_MAIN_RESTART=0`
- 日志特征：`[dev] detected bundle rebuild, restarting Electron...`
- 一次保存可能触发两轮重启（main/host/preload 多目标各自完成时各触发一次），属预期
- CLI 链（apps/zcode-cli / shared dist）不在 watch 范围：改这些仍需手动重启 dev
  （fast 模式的增量判定会处理重建）
