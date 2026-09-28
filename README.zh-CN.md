# zcode-plugin

面向开源版 ZCode 的官方插件补齐包。

[English](README.md)

开源版本只附带了一小部分内置插件。本仓库提供完整的官方插件集——包括
Computer Use（电脑控制）运行时——让开源安装补齐到与官方产品一致的功能。

## 内容

| 插件 | 说明 |
| --- | --- |
| `computer-use` | 桌面自动化：agent 驱动鼠标、键盘和 UI 元素。Windows helper 运行时位于 `runtimes/cua-helper` |
| `documents` | DOCX 文档生成技能 |
| `spreadsheets` | XLSX 表格生成技能 |
| `presentations` | PPTX 演示文稿生成技能 |
| `pdf` | PDF 生成技能 |
| `image-search` | 官方图片搜索 MCP 服务 |
| `android-emulator` | Android 开发与模拟器自动化 |
| `ios-simulator` | iOS 开发与模拟器自动化 |
| `plugin-creator` | 插件开发与本地市场调试工具 |
| `skill-creator` | 技能创建与迭代工具 |
| `zcode-guide` | ZCode 使用指南与诊断 |
| `restore-legacy-sessions` | ACP 旧会话迁移 |

目录结构：

```
plugins/               每个目录一个插件包（.zcode-plugin/plugin.json）
runtimes/cua-helper/   Computer Use helper 运行时（windows-helper.js + ax_native.node）
runtimes/zcode-cua/    Computer Use 运行时包（broker 客户端/服务端、helper 生命周期）
tools/                 打包版运行时启用器（安装脚本调用）
marketplace.json       标准 ZCode 插件市场清单
install.ps1            Windows 一键安装
install.sh             macOS / 源码目录安装
```

## 快速开始 —— seed 安装（推荐）

ZCode 启动时会从应用入口旁的 `packages` 目录（`resources/glm/zcode.cjs` 旁边）
发现内置插件，并注入到内置官方市场（`zcode-plugins-official`）。安装脚本就是
把插件复制到这个布局里。

### Windows 已安装版本

```powershell
git clone https://github.com/luxi233/zcode-plugin
cd zcode-plugin
.\install.ps1                 # 自动探测安装目录
# 或: .\install.ps1 -InstallDir D:\Apps\ZCode
```

脚本会依次：

1. 把全部插件复制到 `<安装目录>\resources\glm\packages\`
2. 把 Computer Use helper 运行时放到 `<安装目录>\resources\tools\cua-helper\`
3. 运行 `tools/patch-cua-runtime.cjs`：检测当前构建是否把 Computer Use
   运行时裁成了空壳（stub），如果是就把它接到 `resources\tools\zcode-cua\`
   下的完整实现上。此步骤要求 **ZCode 完全退出**（包括托盘图标）；如果检测到
   还在运行，脚本会打印稍后手动执行的命令。脚本幂等可重复执行，且会先备份
   `app.asar`。
4. 在 `~/.zcode/cli/config.json` 里把 `computer-use@zcode-plugins-official`
   写入 `plugins.enabledPlugins`——官方构建里 Computer Use 是默认关闭的
   可选插件，seed 安装需要显式启用（合并写入，不覆盖已有配置）
5. 写入用户环境变量 `ZCODE_CUA_DEV_MODE=1`——放宽 helper 的启动方签名校验，
   未签名的开源构建需要这一项（可用 `-SkipDevMode` 跳过）

完全退出并重启 ZCode 后：插件会出现在内置官方市场下，设置里会出现
「电脑控制 / Computer Use」开关。

### macOS 已安装版本

```bash
git clone https://github.com/luxi233/zcode-plugin
cd zcode-plugin
./install.sh                    # 自动探测 /Applications/ZCode.app
# 或: ./install.sh /path/to/ZCode.app
```

脚本会依次：

1. 把全部插件复制到 `<app>/Contents/Resources/glm/packages/`
2. 在 `~/.zcode/cli/config.json` 启用 `computer-use@zcode-plugins-official`
   （官方构建里它默认关闭，seed 安装需显式启用；合并写入不覆盖现有配置）
3. 把 Computer Use 运行时放到 `<app>/Contents/Resources/tools/zcode-cua/`
4. 安装签名过的 **ZCode Computer Use.app** helper 到
   `<app>/Contents/Resources/cua-helper/`——按已安装 app 的版本号和 CPU
   架构从官方发布 CDN 拉取（arm64 和 x64 都支持）；app 已自带则跳过
5. 运行 `tools/patch-cua-runtime.cjs`（优先用系统的 `node`，没有时退回
   `ELECTRON_RUN_AS_NODE=1 <app>/Contents/MacOS/ZCode`），把打包里的 stub
   模块接到完整运行时——与 Windows 同一套语义检测
6. 重新签名 app bundle（见下方「App 签名」）
7. 通过 `launchctl` 设置 `ZCODE_CUA_DEV_MODE=1`（并安装 LaunchAgent 保证
   重新登录后仍然生效）——放宽 helper 对未签名开源构建的启动方校验

macOS 注意事项：

- **隐私权限**：首次使用 Computer Use 时，macOS 会为 "ZCode Computer Use"
  弹出「辅助功能」和「屏幕录制」授权请求——在 系统设置 → 隐私与安全性
  中批准。helper 会自行发起权限申请。
- **App 签名**：向 `Contents/` 写入文件会使 app bundle 的签名失效。在较新的
  macOS 上，签名被破坏或改成 ad-hoc 的托管 app 会被判定「已损坏」拒绝启动，
  所以安装器会用真实证书重新签名——优先用钥匙串里的 Developer ID 证书，
  没有则自动创建自签名的 "ZCode Local Code Signing" 证书。内层组件
  （框架、helper app）保持原签名，同时移除 quarantine 属性让 bundle 不再
  走 Gatekeeper 评估。首次启动可能仍弹出「无法验证开发者」——右键打开
  或在 系统设置 → 隐私与安全性 里放行一次即可。
- **写保护**：被 macOS 登记为托管状态的 app bundle（例如内置更新器安装的）
  会拒绝向 `Contents/` 写入。安装器会先探测，遇到时会提示重新拷贝 app。
- **自动更新**：ZCode 内置更新会整体替换 app bundle，清掉 seed 的插件、
  运行时、helper 和重签名——每次更新后需要重新跑 `install.sh`。
- 完成后完全退出并重启 ZCode；保险起见可以注销/重新登录一次让 launchd
  环境变量生效。

### 源码目录（开发环境）

```bash
./install.sh --repo /path/to/ZCode    # seed 到 <repo>/packages/
```

源码环境使用 Computer Use helper 还需额外设置：

```
ZCODE_CUA_DEV_ROOT=<本仓库>/runtimes/cua-helper
ZCODE_CUA_DEV_MODE=1
```

## 备选 —— 插件市场方式

本仓库同时也是一个标准 ZCode 插件市场，可以直接添加：

```bash
zcode plugins marketplace add luxi233/zcode-plugin
zcode plugins install documents@zcode-plugins
```

注意：这种方式装出的插件 ID 带 `@zcode-plugins` 后缀。设置页里「电脑控制」
开关和 defaultEnabled 默认开启都只认内置官方市场 ID（`zcode-plugins-official`）
——后者只能通过文件系统 seed 注入。要完整对齐请用上面的 seed 安装。

## 兼容性

| 环境 | 插件 | Computer Use |
| --- | --- | --- |
| Windows x64 + ZCode 3.14.x | ✅ | ✅ 已端到端验证 |
| Windows x64 + 其他版本 | ✅ | ⚠️ 大概率可用——补丁器按签名而非文件名识别 stub，但 helper 的 IPC 契约可能随版本漂移 |
| Windows ARM64 | ✅ | ❌ `ax_native.node` 只有 x64 版 |
| macOS arm64 / x64 | ✅ | ✅ 已真机验证（3.14.3, arm64）；x64 同路径未实测 |
| 远程 / WSL workspace | ✅ | ❌ 设计如此——Computer Use 只注入本地桌面会话 |

补充说明：

- helper 运行时的 manifest 声明 `electronVersion: 41.0.3`；补丁器在
  app 的 Electron ABI 不匹配时会打印警告（不阻断）。
- **ZCode 每次更新后需要重新跑一遍 `install.ps1`**——更新会覆盖
  `resources\`。脚本是幂等的。
- 补丁器始终保留回滚备份 `resources\app.asar.zcode-plugin.bak`。

## 许可证

插件包按其 manifest 声明以 MIT 许可发布；安装脚本与仓库脚本同条款提供。
