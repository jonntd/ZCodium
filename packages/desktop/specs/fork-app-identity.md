# Spec：桌面端应用身份与 Electron userData 归属

> 背景：Issue #3。深链 scheme（`zcodium`）与 bundle id（`dev.zcodium.app`）fork 化后，
> 打包正式版应用名仍兜底为上游 `"ZCode"`，导致与官方 ZCode.app 共用 Electron userData；
> 官方版运行时 `requestSingleInstanceLock()` 拿锁失败即 `app.quit()`，双击 ZCodium 约
> 3 秒静默退出。本 spec 约束三档运行身份，防止回归。

## 应用名三档

来源：`packages/desktop/src/main/desktopRuntimeEnv.ts` 的 `runtimeApplicationName`
（可被 `ZCODE_DESKTOP_APPLICATION_NAME` 环境变量显式覆盖，供 e2e 隔离使用）。

| 运行档位        | 应用名            |
| --------------- | ----------------- |
| 本地开发态      | `ZCode Dev`       |
| 打包 Preview 态 | `ZCode Preview`   |
| 打包正式态      | `ZCodium`         |

## 不变量

- 打包正式态应用名**不得**为 `"ZCode"` 或与官方 ZCode.app 相同的任何名字：
  Electron userData、sessionData 与单实例锁作用域均为 `appData/<应用名>`，
  与官方版同路径意味着锁互斥（静默无法启动）与数据互写两个缺陷。
- `ZCode Dev` / `ZCode Preview` 两档名不改：既有开发机与 Preview 安装的数据目录
  已按旧名落盘，改名等于失联，无迁移收益。
- 应用名的唯一消费方是 `app.setName` / `process.title` 与 userData 派生
  （`runtimeUserDataPath` / `runtimeSessionDataPath`），不得新增旁路拼写。

## 与其他数据层的边界

- 本 spec 只约束 Electron 层（userData / 单实例锁）。
- Agent 数据根 `~/.zcodium` 的归属、初始化与迁移见
  `docs/specs/zcodium-data-root.md`，不受本 spec 影响。

## 验收

- `packages/desktop/test/desktopRuntimeEnv.test.ts` 的 runtime identity 用例钉住
  「打包正式态 → `ZCodium` + 独立 userData」与「开发态 → `ZCode Dev` 不变」。
- 打包版 ZCodium 与官方 ZCode.app 可同时运行，互不读写对方 Electron 数据。
