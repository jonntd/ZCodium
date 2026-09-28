# zcode-plugin

ZCode 官方插件合集 —— 用于补齐开源版 ZCode（zai-org/ZCode）未随仓库发布的官方插件能力。

本仓库是一个标准的 ZCode / Claude Code 兼容插件市场（marketplace），包含 12 个官方插件包
以及 Computer Use 所需的桌面运行时组件。

## 仓库结构

```
marketplace.json          市场清单（插件名 → ./plugins/<dir>）
plugins/                  12 个官方插件包（每个含 .zcode-plugin/plugin.json）
runtimes/cua-helper/      Computer Use 桌面运行时（helper + 原生组件，Windows）
```

## 插件清单

| 插件 | 说明 |
|---|---|
| computer-use | Computer Use：桌面应用自动化（鼠标/键盘/UI 元素控制） |
| documents / pdf / presentations / spreadsheets | DOCX / PDF / PPTX / XLSX 文档生产技能 |
| image-search | 官方搜图 MCP server |
| android-emulator / ios-simulator | Android / iOS 模拟器自动化工作流 |
| plugin-creator / skill-creator | 插件 / 技能开发工具链 |
| zcode-guide | ZCode 使用指南与诊断 |
| restore-legacy-sessions | ACP 旧会话迁移恢复 |

## 安装

```bash
# GitHub 源
zcode plugins marketplace add <owner>/zcode-plugin

# 或本地目录
zcode plugins marketplace add /path/to/zcode-plugin

# 查看与安装
zcode plugins list --available
zcode plugins install computer-use@zcode-plugins
```

## Computer Use 运行时（Windows）

`computer-use` 插件是 skill 层；实际执行依赖桌面宿主侧的 CUA 运行时，
本仓库 `runtimes/cua-helper/` 提供了 Windows 版运行时组件（`runtime-manifest.json`
内含完整性校验清单）。

开源版开发环境启用方式：

```powershell
set ZCODE_CUA_DEV_ROOT=<本仓库路径>\runtimes\cua-helper
set ZCODE_CUA_DEV_MODE=1
```

打包形态：把 `runtimes/cua-helper/` 放到应用 `resources/tools/cua-helper/` 即可
（manifest 校验已内置）。

## 许可

各插件 manifest 声明 MIT；仓库整体按 MIT 分发。
