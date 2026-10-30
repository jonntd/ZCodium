# macOS 未签名版本手动更新 E2E 场景

关联合同：`packages/desktop/specs/github-updates.md`。

## 环境与执行边界

- 需要打包态 production macOS 应用（开发态不会启用 manualInstall），以及能返回更高稳定版本的 generic feed。
- 使用 `--zcode-update-feed-url` 指向受控 feed；更新包不必实际安装。
- 本文件为待人工执行场景，不是已通过的自动化证据。jsdom 的真实组件交互回归见 `packages/ui/test/updateManualInstall.test.ts`。

## 场景

1. 分别使用 Apple silicon / Intel 包，在旧版曾下载完成的用户配置及全新配置中启动；包含已保存“自动下载安装=true”的配置。
2. 检查更新，确认不会自动打开浏览器、不会下载 ZIP、不会显示“重启以更新”。
3. 从更新入口打开弹窗，确认明确提示未签名、无法自动安装、官方 Releases、选择对应架构 DMG、退出后替换；主按钮为“前往下载并手动安装”，没有自动下载复选框。
4. 点击主按钮并连点：仅通过 DownloadUpdate IPC 打开官方 Releases，不退出应用、不启动安装器；打开成功后无需等待定时器即可再次点击。
5. 注入 shell.openExternal 失败，确认沿用更新错误呈现且没有未处理 Promise rejection，重新检查后可再次操作。
6. 切换中文、英文、波斯文与 Zai Light / Zai Dark；检查独立更新窗口及窄窗口文字换行、按钮可达、布局不溢出。
7. Windows / Linux 和 macOS 开发态对照：字段缺省保留自动下载安装偏好、下载进度、取消和下载完成后重启流程。

## 本次执行状态

未执行打包态 E2E：当前实现会话只完成源码和 jsdom 组件验证，未准备 production 打包应用、双架构安装环境和受控更新 feed。不得将组件回归等同为真实 DMG 替换验证。
