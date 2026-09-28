# macOS 直替换更新安装（macos-direct-swap-update）

## 背景

3.14.3 用户反馈 mac 自动更新“下载完弹窗闪没/闪退”。根因链（已用本机日志与
electron/squirrel.mac 源码证实）：

1. electron-updater 的 MacUpdater 在 `autoInstallOnAppQuit=true` 时，下载完成后立即触发
   原生 Squirrel 暂存（`nativeUpdater.checkForUpdates()`），由 ShipIt 校验并暂存安装。
2. Electron 魔改版 Squirrel（`Squirrel/SQRLCodeSignature.m` 的 `verifyBundleAtURL:`）用
   **正在运行应用的 designated requirement** 校验新包
   （`SecStaticCodeCheckValidityWithErrors(newCode, req)`）。
3. 本 fork 3.14.3 及更早的安装包未做 bundle 签名（`identity=null`），主程序是 linker
   自带 adhoc 签名（`Info.plist=not bound`），系统给它的隐式 designated requirement 是
   **cdhash 精确匹配**。任何内容不同的新包都不可能满足，暂存必然报
   `SQRLCodeSignatureErrorDomain "code failed to satisfy specified code requirement(s)"`，
   随后主进程清空 ready 态，用户看到弹窗直接消失。
4. 给新包做任何 adhoc 签名（3.14.6 已带，见 macos-adhoc-codesign.md）只解决“结构密封”
   校验；cdhash 锁定无法绕过，且未绑定 Info.plist 的旧二进制也无法补密封（补 CodeResources
   会因“资源未绑定”再次校验失败）。Squirrel 安装链路对旧版安装不可修复。

因此 macOS 安装改为**直替换**：保留 electron-updater 的检查、下载、sha512 校验、
blockmap，仅替换安装步骤。Windows / Linux 链路不变。

## 状态所有者

| 状态                                    | 所有者                                                            |
| --------------------------------------- | ----------------------------------------------------------------- |
| 检查/下载/下载缓存（zip + sha512 校验） | electron-updater（MacUpdater）                                    |
| ready 态（readyUpdateVersion 等）       | `autoUpdater.ts`                                                  |
| zip 路径读取、Squirrel 代理服务器关闭   | `autoUpdater.ts`（MacUpdater 内部字段的受控访问）                 |
| 安装（解压→自检→重命名替换）            | `macUpdateInstaller.ts`（决策矩阵见 `macUpdateInstallerPlan.ts`） |
| 退出准备（host/agent 回收）             | `index.ts` `prepareAppQuit`                                       |

## 事件顺序

### 点击“重启以更新”

```
Renderer              autoUpdater.ts                 macUpdateInstaller          index.ts
   | QuitAndInstallUpdate     |                               |                       |
   |-------------------------->|                               |                       |
   |                          | resolveMacDirectSwapPlan      |                       |
   |                          |  ditto 解压 → plist/codesign 自检 → rename 替换       |
   |                          |<-- ok + newExecPath           |                       |
   |                          |   onBeforeQuitAndInstall() ---------------------------> | host/agent 回收
   |                          |   app.relaunch(newExecPath); app.exit(0)                |
```

失败（任一步）：若已 rename 则回滚备份，错误经 `handleAutoUpdateFailure` 回渲染层，
应用保持可用（替换发生在退出准备之前，失败时子进程未被回收）。

### 自然退出（ready 态存在时）

```
app.quit → before-quit(拦截) → prepareAppQuit(host/agent 回收)
        → installReadyMacUpdateOnAppQuit()  # 解压→自检→替换，不重启
        → 放行第二次 quit → 窗口关闭 → exitPreparedApp
```

## 行为规则

- darwin 上 `autoInstallOnAppQuit=false`：MacUpdater 不再在下载完成时触发原生 Squirrel
  暂存，SQRL 错误源消失；`update-downloaded` 照常进入 ready 态。
- 安装前置校验（全部通过才替换）：
  1. darwin + 已打包运行；
  2. zip 路径存在（下载与 sha512 校验由 electron-updater 完成）；
  3. 目标版本 semver 大于当前版本（防重复替换/回退）；
  4. 解压产物 Info.plist 的 CFBundleIdentifier 与当前应用一致；
  5. 解压产物 CFBundleShortVersionString 与目标版本一致；
  6. `codesign --verify --strict` 自检密封自洽（密封由 macos-adhoc-codesign.md 保证）。
- 替换为同卷 rename：旧 bundle → `<name>.app.update-backup-<ts>`，新 bundle → 原路径；
  第二步失败时回滚第一步。rename 原子且不影响运行中进程；点击路径在 host/agent 回收前
  执行（失败可正常报错），自然退出路径在回收后执行。
- relaunch 使用替换后 bundle 的主程序路径（`app.relaunch({ execPath })`）。
- 备份与残留：启动时清理 `<name>.app.update-backup-*` 与 `.zcode-update-staging-*`。
- mac 不再调用 electron-updater `quitAndInstall()`，原生 Squirrel 不参与 mac 安装。

## 验收场景

1. 3.14.7+（已打包）检查更新 → 下载完成进入 ready，无 SQRL 错误、ready 态不被清除。
2. ready 后点击“重启以更新”：应用退出并用新版本重启；旧 bundle 留有备份目录。
3. ready 后直接 Cmd+Q：应用退出；重新手动启动后版本为新版本。
4. zip 缺失 / 版本不新于当前 / bundle id 不一致 / codesign 自检失败：不替换，
   点击路径向渲染层报错，应用保持运行。
5. 新 bundle 主程序缺失：回滚旧 bundle，返回失败。
6. Windows / Linux 更新链路行为不变（原生 quitAndInstall / AppImageUpdater）。

## 回滚边界

- 本模块只接管 darwin 安装步骤；回滚方式：恢复 `autoInstallOnAppQuit` 的平台判断并移除
  两个安装调用点，即回到 electron-updater 原生链路（对旧版安装仍会复现 SQRL 失败）。
- 3.14.3 及更早已装用户因旧代码仍是 Squirrel 链路，无法通过发版自助升级，
  需手动拖一次 DMG；之后的版本自动更新走本方案。
