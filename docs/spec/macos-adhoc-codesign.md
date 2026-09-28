# Spec: macOS 无证书打包的 adhoc 兜底签名

本 spec 定义 ZCodium fork mac 安装包在**没有 Apple 开发者证书**时的 adhoc bundle
签名规则。目标：让 mac 更新包具备自洽的 bundle 密封。 sealing 结果的两个消费方：
Squirrel.Mac 的结构校验（仅对 3.14.6+ 之后的"已密封旧安装"有效），以及直替换安装器的
`codesign --verify --strict` 自检（见 `macos-direct-swap-update.md`——对 3.14.3 这类
未密封旧安装，Squirrel 的 requirement 校验是 cdhash 锁死、任何新包都无法满足，mac
安装已改为直替换，不再依赖 Squirrel）。

> 现状：`mac.identity` 在未启用 `ZCODE_ENABLE_MAC_SIGN` 时为 null，electron-builder
> 完全跳过签名，产物 .app 只有内部二进制的 linker adhoc 签名，bundle 级
> `_CodeSignature/CodeResources` 缺失。Squirrel.Mac 在 `update-downloaded` 后立即对
> 解包出的新 .app 做 `SecStaticCodeCheckValidity`，未签名 bundle 直接失败：
> `SQRLCodeSignatureErrorDomain code -1 "code has no resources but signature
indicates they must be present"`，`autoUpdater.ts` 随后清掉 ready 状态——下载完成
> 却永远装不上（2026-09-28 四次尝试全部复现，见 `~/.zcode/v2/logs/2026-09-28.log`）。
> 上游官方 ZCode.app（Developer ID 签名）走同一套更新代码可成功安装，证明差异只在
> 产物签名状态。

## 1. 范围

- 作用面：`packages/desktop/scripts/adhoc-codesign-mac.mjs`（新增）、
  `packages/desktop/electron-builder.config.js` 的 `afterPack` 钩子、
  `packages/desktop/tests/adhoc-codesign-mac.test.mjs`（新增）。
- 不改动：更新运行时链路（`autoUpdater.ts`、electron-updater）、发布工作流
  （`release-fork.yml` 仍保持 `CSC_IDENTITY_AUTO_DISCOVERY=false` 与无证书产物）、
  Windows/Linux 打包、DMG 首启 Gatekeeper 解除说明（adhoc 包仍会被 Gatekeeper
  拦截，用户体验不变）。

## 2. 规则

- **唯一执行点**：mac 产物签名的兜底动作只存在于 `afterPack` 末尾，签名决策由
  `resolveMacAdhocCodesignPlan` 单点给出；`electron-builder.config.js` 只负责接线，
  不内联 codesign 逻辑。
- **触发条件**（全部满足才签）：
  1. 打包目标平台为 darwin（`context.electronPlatformName === "darwin"`）；
  2. 当前构建机为 macOS（`process.platform === "darwin"`，codesign 只在 macOS 存在）；
  3. 未启用真实证书签名（`ZCODE_ENABLE_MAC_SIGN=1` 且提供了
     `APPLE_SIGNING_IDENTITY`/`CSC_NAME` 时让位，避免与 electron-builder 的
     Developer ID 签名互相覆盖）。
- **钩子位置约束**：必须挂在 `afterPack` 末尾（asar 注入/sourcemap 清理等改动
  bundle 内容的动作之后）。原因：
  - `afterPack` 位于 electron-builder mac 签名步骤 `doSignAfterPack` 之前，真实
    签名场景下 adhoc 结果会被证书签名覆盖，方向安全；
  - `identity: null` 时 electron-builder **不会触发 `afterSign` 钩子**
    （app-builder-lib 明确打日志 "skipping afterSign hook as no signing occurred"），
    兜底签名不能挂在那里；
  - `afterPack` 里的 asar 重写会破坏任何先做的签名，所以签名必须最后执行。
- **签名命令**：`codesign --force --deep --sign - <App>.app`（adhoc 无 hardened
  runtime、不注入 entitlements，避免 Electron JIT 在无 allow-jit 授权的 hardened
  runtime 下被杀）。
- **自校验（fail-fast）**：签名后立即执行 `codesign --verify --strict <App>.app`，
  非零退出码让打包直接失败，防止再发出校验不过的产物。
- **幂等**：`--force` 重复签名安全；CI 重试、本地重复打包无副作用。

## 3. 状态所有权与事件顺序

```text
electron-builder.config.js afterPack（唯一接线点）
  └─ adhocCodesignMacApp(context, { enableMacSigning })
       ├ resolveMacAdhocCodesignPlan(...)  → sign | skip(原因)
       ├ skip → 记录跳过原因，返回
       └ sign
           ├ codesign --force --deep --sign - <App>.app
           └ codesign --verify --strict <App>.app  ← 失败即抛错中断打包
后续（electron-builder 内部）：doSignAfterPack（identity:null 时跳过）→ zip/dmg 目标打包
```

- 签名状态的所有者是**产物本身**（.app 的 CodeResources），本改动不引入任何运行时
  状态；`autoUpdater.ts` 的 ready/manifest 状态机不变。

## 4. 为什么 adhoc 能让自动更新走通

Electron 内嵌的 Squirrel fork 支持 adhoc 签名应用的自更新：新包通过
`SecStaticCodeCheckValidity`（结构自洽，即 CodeResources 存在且密封一致）后，按
bundle identifier 匹配而不是 Developer ID designated requirement 校验（本机
`Squirrel.framework` 内可见 `initWithApplicationIdentifier:` / `bundleIdentifier`
符号）。结构校验只作用于**新下载的包**，因此已安装的旧版 3.14.3（无 bundle 签名）
在 3.14.6 修复版发布后可以直接被自动更新升级，无需先手动重装。

## 5. 验收场景

1. `codesign --verify --strict` 通过：本地打包出的 mac zip 解包后，对内层
   `<App>.app` 执行 `codesign --verify --strict` 退出码为 0；修复前为
   "code has no resources but signature indicates they must be present"。
2. 安装包副本演练：对本机已安装 app 副本执行同一 adhoc 签名命令后，校验由失败变
   通过（最小化验证签名命令本身，不依赖完整打包）。
3. dev 自更新闭环（发布前回归）：`ZCODE_AUTO_UPDATE_DEV=1` +
   `--zcode-update-feed-url` 指向本地 feed（含修复版 zip 与 latest-mac.yml），
   观察日志出现 `downloaded: <version>` 后**不再**出现
   `SQRLCodeSignatureErrorDomain`，点击"重启以更新"能 relaunch 进入新版。
4. 真实签名让位：`ZCODE_ENABLE_MAC_SIGN=1` 且提供身份时，afterPack 不执行 adhoc
   签名（由单测覆盖决策函数）。
5. 非 macOS 构建机或非 darwin 目标：跳过并记录原因，不报错（单测覆盖）。

## 6. 回滚边界

回滚 = 移除 afterPack 中的 `adhocCodesignMacApp` 调用与对应脚本/测试；产物回到
未签名状态（自动更新在 macOS 恢复为不可用），不影响其他平台与运行时行为。
