# ZcodePro

面向开源版 ZCode 的官方插件补齐包。

[![LINUX DO](https://img.shields.io/badge/LINUX_DO-%E7%A4%BE%E5%8C%BA%E8%AE%A4%E5%8F%AF-blue)](https://linux.do)

[English](MARKETPLACE.md)

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
git clone https://github.com/luxi233/ZcodePro
cd ZcodePro
.\install.ps1                 # 自动探测安装目录
# 或: .\install.ps1 -InstallDir D:\Apps\ZCode
```

脚本会依次：

1. 把全部插件复制到 `<安装目录>\resources\glm\packages\`
2. 在 `~/.zcode/cli/config.json` 里把 `computer-use@zcode-plugins-official`
   写入 `plugins.enabledPlugins`——官方构建里 Computer Use 是默认关闭的
   可选插件，seed 安装需要显式启用（合并写入，不覆盖已有配置）

完全退出并重启 ZCode 后：插件会出现在内置官方市场下，设置里会出现
「电脑控制 / Computer Use」开关。

说明：旧的 stub 补丁步骤（helper 运行时拷贝、asar patcher、`ZCODE_CUA_DEV_MODE`）
已于 2026-09-29 退役。ZCodium 构建自带完整 Computer Use 运行时与签名 helper
（docs/spec/cua-runtime-builtin.md）；官方 ZCode 构建本身就有真实现，从不需要补丁。

### macOS 已安装版本

```bash
git clone https://github.com/luxi233/ZcodePro
cd ZcodePro
./install.sh                    # 自动探测 /Applications/ZCode.app
# 或: ./install.sh /path/to/ZCode.app
```

脚本会依次：

1. 把全部插件复制到 `<app>/Contents/Resources/glm/packages/`
2. 在 `~/.zcode/cli/config.json` 启用 `computer-use@zcode-plugins-official`
   （官方构建里它默认关闭，seed 安装需显式启用；合并写入不覆盖现有配置）
3. 保留 app 原始签名（resource seal 有意保持不匹配——见下方「App 签名」）

macOS 注意事项：

- **隐私权限**：首次使用 Computer Use 时，macOS 会为 "ZCode Computer Use"
  弹出「辅助功能」和「屏幕录制」授权请求——在 系统设置 → 隐私与安全性
  中批准。ZCodium 随包携带上游 Developer-ID 签名的 helper，授权跨更新持久。
- **App 签名**：向 `Contents/` 写入文件会让 resource seal 不再匹配——但
  安装器**特意保留原始签名**：去掉 quarantine 后 LaunchServices 会正常
  启动这个 bundle，`codesign --verify` 报告的封条不匹配是 seed 安装的
  预期稳定状态。**不要重签 app**——ad-hoc/自签名的 bundle 反而会被
  Gatekeeper 判为已损坏。
- **写保护**：被 macOS 登记为托管状态的 app bundle（例如内置更新器安装的）
  会拒绝向 `Contents/` 写入。安装器会先探测，遇到时会提示重新拷贝 app。
- **自动更新**：ZCode 内置更新会整体替换 app bundle，清掉 seed 的插件——
  每次更新后需要重新跑 `install.sh`。
- 完成后完全退出并重启 ZCode。

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
zcode plugins marketplace add luxi233/ZcodePro
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

插件包保留各自 manifest 声明的许可证：

- **MIT**：`android-emulator`、`ios-simulator`、`plugin-creator`、
  `restore-legacy-sessions`、`skill-creator`、`computer-use`、`zcode-guide`
- **Apache-2.0**：`image-search`
- **Z.ai 非商用许可**（`skills/*/LICENSE.txt`）：`documents`、`pdf`、
  `presentations`、`spreadsheets`——仅限个人/教育/非商业用途，
  商用需 Z.ai 书面授权

安装脚本与仓库脚本以 MIT 发布。

---

本项目积极参与并认可 [LINUX DO 社区](https://linux.do)。
