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

### D2：win32 ensure 分支消费 recipe（node-repl-host）

最初判定为「producer 仓库待办」，后续核实纠正：`ensureStandaloneHelperLaunched`
只是 `createComputerUseRuntime` 的**默认** ensure 值，调用方传入
`ensureBrokerAvailable` 即可覆盖；真正的调用方
`node-repl-host` 的 `captureComputerUseRuntimeFromEnvironment` 就在本仓（vendor
产物 `runtimes/zcode-cua/vendor/dist-index.js` 与其同源，均 git 跟踪）。实现
（`apps/zcode-cli/packages/node-repl-host/src/server.ts`）：

- 解析 spawn env 里的 `ZCODE_CUA_WIN_HELPER_RECIPE`（键名与 JSON 字段
  entryPath/command/root/addonPath/commandEnv/hostPid，畸形值静默回退 vendor 默认，
  不阻塞 darwin 链路）；
- ensure 钩子按 recipe fork Helper：argv `--socket <稳定管道名> --parent-pid <hostPid>`
  （helper 侧严格四参校验）、`cwd=root`、`execPath=command`、env 带
  `ELECTRON_RUN_AS_NODE=1` 与 `HELPER_ADDON_ENV`（native addon 路径），形态与产品
  托管 host（`windowsCuaDevHelperHost.startGeneration`）同构；
- fork 后不等待 `transport_ready`/`ready`：Helper bind 后 SDK 的 warmup 重试环自然
  连上，90s claim TTL 由首调 `broker_info` 解除；fork 失败由重试环（5s 冷却）兜底，
  与 vendor darwin 路径「尽力拉起」语义一致。

生产/消费两侧契约由两侧单测各锁一端：services 侧 `agentProxyEnv.test.ts`（注入
形态），node-repl-host 侧 `test/win32-recipe-ensure.test.ts`（消费形态）。bundle
经 `scripts/build.mjs`（alias 到 `runtimes/zcode-cua` 真实现）重建并过 stub-marker
守卫与加载 smoke。

## 验证

- `pnpm typecheck`、`pnpm lint`（0 error）、`pnpm architecture:check --changed`（0）。
- 新增单测：
  - `packages/services/test/stableCuaTransport.test.ts`（env 优先 / 回退铸名 / 进程内
    稳定 / reset 跟随）；
  - `packages/ui/test/computerUseSectionWindowsWiring.test.tsx`（win32 path 非空 / 开关
    触发 refresh / TCC 行不渲染 / macOS 行为不变）；
  - `apps/zcode-cli/packages/node-repl-host/test/win32-recipe-ensure.test.ts`（ensure
    wiring 挂接 / fork argv-env 契约 / recipe 畸形静默回退 / socket 缺失不 capture）；
  - `agentProxyEnv.test.ts` 追加 spawn env wiring 断言。
- node-repl-host bundle 重建后 stub-marker 为 0、模块加载 smoke 通过；
  `test/bundle-smoke.test.ts` 中 1 项为存量失败（干净树上同样失败，与本次无关）。
- Windows 实机回归（待补，spec §9.3）：MC-5'（首调自拉）、MC-9'（设置页拉起）、
  MC-11（重启后 pipe 名不变）。

## 边界澄清（非缺陷，不做修复）

- helper 90s 认领自退（`DEFAULT_STARTUP_CLAIM_TTL_MS`）与 peer 门 win32 未实现
  （`WINDOWS_PEER_IDENTITY_GATE_TEMPORARILY_OPEN` + 本地豁免 env）均按既有设计工作。
- 会话非 Active（锁屏 / 远程画面断开）时 Graphics Capture 拿不到像素（Accessibility 树
  读写不受影响），属 OS 行为；解锁后自动恢复。
