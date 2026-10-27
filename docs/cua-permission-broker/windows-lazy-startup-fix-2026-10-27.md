# Windows 电脑控制懒启动链修复记录（2026-10-27）

## 背景

Windows 实机验证（ZCodium v1.17.x 安装包，含真实 producer）发现电脑控制全链路失效：
调用永远报 `permission broker socket is not accepting connections`。人工拉起 helper 后
MCP 仍连不上，除非绑定从插件宿主进程内存中扫出的随机管道名；工作区
`start-cua-helper.ps1` 是验证过的人工兜底。完整断链分析与修订决策见
[lazy-startup spec §九](../../docs/cua-permission-broker/2026-09-21-cua-helper-lazy-startup-spec.md)。

## 根因（三处）

1. **producer `ensureStandaloneHelperLaunched` 无 win32 分支生效**：随包
   node-repl-host 0.6.1 首调兜底 `if (process.platform !== "darwin") return;`，spec §3.3
   的 win32 fork 分支（MC-5/MC-6）未生效；services 侧注入的 `ZCODE_CUA_WIN_HELPER_RECIPE`
   无任何消费方。
2. **管道名双规范分裂**：共存层（cua-runtime-builtin §E）写死稳定名
   `\\.\pipe\zcode-cua-helper-zcodium` 经 `ZCODIUM_CUA_BROKER_SOCKET` 注入；懒启动层
   `getStableCuaPipeName()` 无条件铸随机名（不读 env）。探测 / spawn env / Host fork
   用随机名自洽，共存层稳定名在 win32 CUA 链路上成死值。
3. **设置页触发链不通**：win32 `supportsLocalMacWorkspace=false` → `path=null` →
   `useCuaPermissionStatus` 从不查询；开关切换后的 `refresh()` 仅对 macOS 执行。

## 修复

### D1：管道名收敛（services）

- `packages/services/src/cua-permission-broker/stableCuaTransport.ts`：
  `getStableCuaPipeName()` 优先读 host bootstrap 恢复后的标准键
  `ZCODE_CUA_PERMISSION_BROKER_SOCKET`（即共存层稳定名，由
  `restoreZCodiumCuaBrokerSocketEnv` 从 fork 键恢复），env 缺失（CLI 直跑等）回退铸随机名。
- `packages/services/src/node.ts`：`resolveSpawnEnv` 与 `probeStableCuaHelperSocket`
  统一走 `getStableCuaPipeName()`，darwin/win32 平台分叉抹平；`[cua-permission] broker
  socket resolved` 启动日志同源，直接反映真实生效的管道名。

### D3：设置页触发链接通（services + ui）

- `packages/services/src/node.ts`：`restartHelper` 删除 darwin-only 短路；win32 走托管
  host 的 `resolver.restart()`（复用既有 socket/token，语义与 darwin 一致）。
- `packages/ui/src/settings/ComputerUseSection.tsx`：`path` 门控与插件开关后的
  `refresh()` 放宽到 `supportsLocalWindowsWorkspace`——进设置页电脑控制区即经
  `getStatus` 拉起 helper，输入框入口隐藏的用户也有启动路径；TCC 权限行仍仅 macOS 渲染。

### D2：producer 侧 win32 ensure 分支（producer 仓库，待办）

随包 producer 补齐 spec §3.3 的 win32 fork 分支，消费已注入的 recipe。本仓以
`packages/services/test/agentProxyEnv.test.ts` 的 wiring 断言锁定契约（键名
`ZCODE_CUA_WIN_HELPER_RECIPE`、JSON 字段 entryPath/command/root/addonPath/commandEnv/
hostPid、argv 形态），producer 落地后人工兜底脚本可退役。

## 验证

- `pnpm typecheck`、`pnpm lint`（0 error）、`pnpm architecture:check --changed`（0）。
- 新增单测：
  - `packages/services/test/stableCuaTransport.test.ts`（env 优先 / 回退铸名 / 进程内
    稳定 / reset 跟随）；
  - `packages/ui/test/computerUseSectionWindowsWiring.test.tsx`（win32 path 非空 / 开关
    触发 refresh / TCC 行不渲染 / macOS 行为不变）；
  - `agentProxyEnv.test.ts` 追加 spawn env wiring 断言。
- Windows 实机回归（待补，spec §9.3）：MC-5'（首调自拉）、MC-9'（设置页拉起）、
  MC-11（重启后 pipe 名不变）。

## 边界澄清（非缺陷，不做修复）

- helper 90s 认领自退（`DEFAULT_STARTUP_CLAIM_TTL_MS`）与 peer 门 win32 未实现
  （`WINDOWS_PEER_IDENTITY_GATE_TEMPORARILY_OPEN` + 本地豁免 env）均按既有设计工作。
- 会话非 Active（锁屏 / 远程画面断开）时 Graphics Capture 拿不到像素（Accessibility 树
  读写不受影响），属 OS 行为；解锁后自动恢复。
