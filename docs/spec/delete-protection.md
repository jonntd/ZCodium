# Spec: 删除保护与批量删除审批

本 spec 定义「设置 → 系统」中的**删除保护**开关与**批量删除审批**阈值的行为规则、
状态所有权、协议边界与验收场景。目标是让 Agent 在工作区里删除文件时默认可恢复
（移入系统废纸篓/回收站），并在单次删除规模过大时强制用户审批。

## 1. 范围

- 设置项（App 全局偏好）：`deleteProtectionEnabled`、`batchDeleteApprovalThreshold`。
- 偏好同步：设置变更 → 运行中的 Agent（workspace 协议方法）+ 跨窗口广播 + 新会话启动路径。
- CLI 执行面：Bash 工具的 `rm` / `rmdir` / `unlink` 删除语义（移废纸篓）与批量审批。
- 不改动 UI 侧文件删除（回收任务等管理操作）与其余删除命令（`find -delete`、`git clean`、
  脚本内删除）——见 §7 边界。

## 2. 设置项与默认值

| 字段                           | 类型      | 默认   | 说明                                                                                               |
| ------------------------------ | --------- | ------ | -------------------------------------------------------------------------------------------------- |
| `deleteProtectionEnabled`      | `boolean` | `true` | 开启后 Agent 的 `rm`/`rmdir`/`unlink` 优先移入系统废纸篓/回收站；关闭后按系统删除（直接 unlink）。 |
| `batchDeleteApprovalThreshold` | `int ≥ 1` | `50`   | 单条 Bash 命令的删除目标数达到该数量时，执行前需要用户审批。仅在删除保护开启时生效。               |

- 持久化：`AppSettings`（`validationAppSettings.ts` 的 object schema 与 patch schema 同步登记；
  只进 patch 会被 zod strip，开关表现为点击后回弹）。
- 设置 UI：设置 → 系统 新增独立 `SettingsGroupCard`，两行：
  1. 「删除保护」Switch（带说明文案：开启后优先移到废纸篓/回收站，关闭后按系统删除）；
  2. 「批量删除审批」数字输入（说明文案：需开启删除保护；一次删除达到该数量时需要审批）。
     删除保护关闭时该输入禁用（视觉 + 交互，`disabled`）。
- 非法输入（空、非数字、< 1）提交时归一为默认值 50；输入框允许暂时性的非法草稿。

## 3. 状态所有权与同步链

```text
设置 UI patch ─→ settingService.update(AppSettings)          ← 持久化事实源（唯一写入方）
                    ├→ zcodeAgentService.syncAppRuntimePreferences ─→ 协议 workspace/updateDeleteProtectionPreferences
                    │        └→ CLI appRuntimePreferences（workspace 级权威缓存）→ 逐 session 应用（runtime config）
                    ├→ botsService.syncAppRuntimePreferences（Bot 远程桥同链路）
                    └→ broadcast settings:app-runtime-preferences（跨窗口，防回环由 payload 校验兜底）
新会话 ─→ session/requestRuntimePreferences（Host 从 AppSettings 解析）→ runtime config 初始值
```

- **唯一事实源**是 AppSettings；CLI 侧 `appRuntimePreferences` 与 runtime config 都是投影，
  不落盘、不反向写。
- 协议方法是**独立方法**（`workspace/updateDeleteProtectionPreferences`），带独立 params/result
  schema：旧 CLI 收到新 Host 的未知方法报 method-not-found，services 层按
  `isProtocolMethodNotFoundError` 降级（与 model-io 偏好同模式），不阻塞其他偏好同步。
- `session/requestRuntimePreferences` 结果 schema 增加可选 `deleteProtection` 字段；
  旧 Host 缺省时 CLI 按默认值（开启 + 50）处理。
- 会话内生效时机：偏好更新命令到达后逐 session 调用 app setter（`updateConfig` 通道），
  当前 turn 的下一次工具调用即生效；执行中的命令不受影响。

## 4. CLI 运行时语义

### 4.1 移废纸篓（删除保护开启）

- 注入点：Bash 工具的执行请求携带 `bashDeleteProtectionPrelude`（仅
  `posix-bash` shellProfile），由执行适配层物化为 shell 函数，与 embedded-search prelude
  同一机制、同一 POSIX 方言门槛（`posix` / `git-bash`；`cmd` / PowerShell 不注入）。
- 覆盖命令：shell 内直接调用的 `rm`、`rmdir`、`unlink`（shell 函数优先于同名二进制；
  参数在进入函数前已完成 glob 展开）。经外部程序间接执行的删除（`sudo rm`、`xargs rm`、
  `find -delete` 等）不被函数拦截，属于 §7 边界。函数把操作数移入系统废纸篓：
  - macOS：`~/.Trash`（重名追加时间戳后缀）；
  - Linux：优先 `gio trash`；不可用时回退 freedesktop `~/.local/share/Trash/files`
    （重名追加时间戳后缀）；
  - Windows（git-bash）：PowerShell `Microsoft.VisualBasic.FileIO.FileSystem` 的
    Recycle Bin 语义。
- 失败语义：移动失败（权限、跨盘等）→ 该次调用报错退出非 0，**绝不回退为直接删除**。
- 删除保护关闭：不注入 prelude，命令原样执行（系统删除）。

### 4.2 批量删除审批（删除保护开启且阈值生效）

- 判定点：Bash 工具的 `resolvePermissionCapability`（同步、无 I/O）。
- 计数规则：对解析出的每条删除调用，取非选项操作数个数求和：
  - 操作数含通配符（`*` `?` `[`）→ 无法同步展开，**按达到阈值处理**（宁可多问）；
  - 命令解析失败 / 含不支持语法，但原文出现删除命令词 → 按达到阈值处理；
  - 计数单位是操作数（顶层目录算 1），不递归统计目录内容。
- 达到阈值 → capability 自报 `alwaysAsk` + `needsApproval`：ask 压过 yolo / plan readOnly /
  项目 allow 规则（复用 PermissionService.checkAlwaysAsk 优先级），仍尊重 deny 规则与
  会话级 allow（用户本会话显式放行过的命令不再重复打扰）。ask 理由说明将删除的文件数。
- 未达到阈值 → 不改变既有判定（是否 ask 仍由模式与规则决定）。
- 阈值关闭路径：删除保护关闭时整条判定不生效。

## 5. 验收场景

1. 删除保护开启，Agent 执行 `rm notes.txt`：文件出现在系统废纸篓，工作区内不再可见；
   会话输出无删除失败。
2. 删除保护开启，`rm -rf build`（目录）：目录移入废纸篓。
3. 删除保护开启，阈值 50，`rm a b c`（3 个）：无需审批直接移废纸篓。
4. 删除保护开启，阈值 3，`rm a b c`（3 个，达到阈值）：弹审批；拒绝则命令不执行。
5. 删除保护开启，阈值 50，`rm *.log`：含通配符，弹审批。
6. 关闭删除保护：`rm notes.txt` 直接系统删除，不出现在废纸篓；批量审批输入禁用。
7. 设置变更实时生效：会话运行中把阈值从 50 调到 2，下一次删除命令按新阈值判定。
8. 旧 CLI + 新 Host：services 层对 method-not-found 降级，偏好同步不报错；旧 CLI 保持
   系统删除行为。
9. `mv`、`cp`、非删除命令不受影响；prelude 不覆盖 `cmd`/PowerShell 会话（边界，见 §7）。

## 6. 不变量

- 移废纸篓失败不得静默降级为系统删除（fail-safe：宁可让命令失败）。
- AppSettings 是唯一持久化事实源；CLI 投影不落盘。
- 广播回放不得绕过 payload schema 校验（沿用 `appRuntimePreferencesChangedBroadcastPayloadSchema`）。
- 权限判定保持同步、无 I/O；计数不访问文件系统。

## 7. 已知边界（v1 明确不做）

- 纯 TUI / headless 直跑（无 Host 同步偏好）不生效：runtime config 无 deleteProtection
  字段即视为关闭；协议服务路径由 appRuntimePreferences 默认值（开启 + 50）兜底。
- `find -delete`、`git clean`、脚本/解释器内的删除不经 prelude，仍按系统删除；本 spec
  的审批计数也不覆盖它们。若后续纳入，应扩展 prelude 覆盖面并同步更新 §4.2 计数规则。
- `sudo rm` / `command rm` / `env rm` / `xargs rm` / `nohup rm` 会 exec 真实二进制、绕过
  shell 函数：移废纸篓不生效，但审批层把它们按「数量不可知」处理（删除保护开启时必审批）。
- `cmd` / PowerShell 会话不注入 prelude（执行适配层仅支持 posix-bash 启动脚本）。
- 沙箱环境若拒绝工作区外写入，移废纸篓会以可见失败结束（不静默删除）。
- 协议 schema 与 CLI bundle 必须同构建（lockstep）：`deleteProtection` 随
  `session/requestRuntimePreferences` 返回值下发，旧 CLI 的 strict schema 会以
  `unrecognized_keys` 硬拒该字段，且材料化兜底只覆盖 -32601/-32020（旧 Host），
  不覆盖成功响应的解析失败——表现为每条 v4 命令 `fault.command.executionFailed`。
  产品路径 Host 与 CLI 始终同版本发布，此状况仅出现在 dev 环境的陈旧
  `apps/zcode-cli/packages/cli/dist/zcode.cjs`；修改 zcode-protocol schema 后需
  `pnpm --filter @zcode/cli build` 重建并重启 dev server / 重杀已拉起的 CLI 进程。
