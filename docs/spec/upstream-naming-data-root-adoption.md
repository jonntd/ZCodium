# Spec: 官方上游 #17/#19 采纳评估(命名统一 + 数据根迁移)

> 上游 2026-10-03 两笔大改动:`b95b5a8`(#17 P0 命名统一 zcode→zcodium,139 文件)
> 与 `417c961`(#19 数据根归属 + 用户决策式迁移,feat!)。本清单是 fork 采纳前
> 的适配点盘点与合并顺序结论,合并后本文件转为基础 spec 留档。

## 1. 上游改动概要

- **#17(P0 命名)**:仅用户/外部可见层——bin 命令 `zcode`→`zcodium`、deep link
  `zcode://`→`zcodium://`(无兼容)、i18n 文案 "ZCode"→"ZCodium"、README。
  **内部 `ZCODE_*` env、`@zcode/*` 包名、产物文件名属 P1a/P2,本笔不动。**
- **#19(数据根)**:`{base}/.zcode` → `{base}/.zcodium`;归属文件
  `.zcodium-root.json`(product=appId,唯一合法性依据);旧数据**用户决策式
  迁移**(只复制不删除);唯一初始化器 `initializeDataRootInteractive`(桌面)/
  `NonInteractive`(CLI/server);`ZCODE_DATA_BASE_DIR` env 名保留,显式注入
  成为 dev/e2e 隔离硬边界(`isDataBaseDirEnvOverrideActive`,settings 不回拉)。

## 2. fork 现状盘点(有利条件)

fork 早年已完成产品身份 zcodium 化(`desktop-product-identity.mjs`):

- appId `dev.zcodium.app` == 上游归属文件 product 家族值,**归属判定天然匹配**;
- productName `ZCodium`、linux 包名/可执行名已是 `zcodium`;
- 官方 ZCode.app(`dev.zcode.app`)继续用 `~/.zcode`,迁移后两产品数据天然分流,
  CUA 共享 socket 冲突根因(数据互踩)同时缓解。

## 3. 适配点清单

### #17(影响小,跟随上游即可)

| 项               | fork 位置                                                                                              | 动作                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| deep link scheme | `desktopOAuthDeepLink.ts`、`desktopFinderOpenFolderWorkflow.ts`、`desktopLinuxDeepLinkRegistration.ts` | 随上游改 `zcodium://`;fork 无存量 deep link 用户,不设兼容 |
| bin 命令         | CLI 包 `package.json#bin`(fork 未单独改过)                                                             | 随上游                                                    |
| i18n 文案        | `packages/ui`、`apps/zcode-cli/i18n`                                                                   | 随上游;fork 已有的 ZCodium 文案会自然收敛                 |
| 设计文档         | `docs/spec/` 内 "ZCode" 指称                                                                           | 仅指官方客户端处保留,产品自称改 ZCodium                   |

### #19(核心工作量在 fork 自有硬编码)

上游已收口 `packages/services/src/paths.ts`;fork 在 main 侧的**自有硬编码**
需逐处对齐新根(或改走 paths.ts 收口):

| fork 位置                          | 现值                                             | 动作                                                                                                              |
| ---------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `desktopDataBaseDirBootstrap.ts:7` | `~/.zcode/v2/setting.json`(启动读设置)           | 改走新根;bootstrap 时序在初始化器**之前**,需用上游提供的只读探测口径                                              |
| `desktopCommandHandlers.ts:96-107` | 清除数据删 `~/.zcode/v2`                         | 改删新根 `v2`(归属文件保留,与上游「清数据不删归属」一致),文案同步                                                 |
| `desktopCuaBrokerSocket.ts:52`     | linux 私有 socket `~/.zcode/cua-broker-zcodium/` | darwin/win 不受影响;linux 建议随新根 `~/.zcodium/cua-broker-zcodium/`,注意与 519f808 的私有 socket 下发链回归验证 |
| `remoteRelayControlIpc.ts:67`      | `~/.zcode/v2/remote-relay.json`(fork 自有)       | 随新根;迁移决策时该配置随 `v2` 复制自然带入,验证 3030 自托管 server 读新路径                                      |
| `desktopRuntimeEnv.ts:557`         | `ZCODE_HOME` 默认 `~/.zcode`                     | 随新根;env 名本身 P1a 才动                                                                                        |

### 跨线关联

- **server 与桌面共享数据**:两者同走数据根初始化器后仍共享 `~/.zcodium/v2`
  (tasks-index.sqlite 历史共享语义不变);自托管 server 无 UI 走
  `NonInteractive` 路径,先于桌面初始化时行为需实测。
- **发版 workflow**:release-fork.yml 不引用数据根路径,无改动;changelog 翻译
  映射需补 #17/#19 及后续提交条目。
- **CUA 私有 socket**(spec cua-runtime-builtin.md §E):#19 未触碰
  `desktopCuaBrokerSocket.ts`,两段式注入链不受数据根影响,仅 linux 路径按上表调整。

## 4. 合并顺序与验证

```
merge b95b5a8(#17) → 解决冲突(预期集中在 i18n/README/deep link)
→ merge 417c961(#19,依赖 #17 的树)
→ fork 硬编码五处对齐 → typecheck/lint/单测
```

真机验收(逐项记录日志铁证):

1. 迁移决策:`~/.zcodium` 不存在 + 旧根存在 → 桌面弹决策;选「带入」后
   `v2/` 复制完整、归属文件 product=dev.zcodium.app、旧根原样保留;
2. 二次启动直接 ready(不重复决策);dev 实例(`ZCODE_DATA_BASE_DIR` 注入)
   不触发决策、settings 不回拉;
3. server 3030 与桌面同根共享会话历史;
4. CUA 全链路:设置页状态、私有 socket 注入两处观测点日志一致;
5. deep link `zcodium://` 注册与回调;清数据后归属保留、不误判首次运行。

## 5. 不采纳的代价

上游后续 P1a(env 前缀 `ZCODE_`→`ZCODIUM_`)、P2 会持续加大分叉;#19 的
数据互踩修复(官方 ZCode 共用 `~/.zcode`)对 fork 是真实收益——**建议采纳**,
待用户确认时点后按本清单执行。
