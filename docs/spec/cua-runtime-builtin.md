# Spec: CUA 运行时内置（computer-use 二期）

状态：已实现｜日期：2026-09-29｜范围：desktop 构建链 + 打包签名 + host dev 接线 + UI + 退役装机后 patch

## 动机

一期（[[builtin-zcodepro-plugins]]）把 computer-use 插件包内置进了官方市场 bundled 分片，但 0.6.3
插件是 **skills-only**（无 mcpServers，`package.json` 自述执行由共享 node_repl host 提供）——真正
的执行面是桌面 host 内联的 `@zcode/zcode-cua` broker + 一个 Developer-ID 签名的
"ZCode Computer Use.app" helper。fork 现状两者都缺：

- workspace 里 `packages/zcode-cua` 是 fail-closed stub（每个面返回
  "Computer Use is not available in this build."），经 tsup `noExternal` 内联进 main/host/scheduler、
  经 esbuild 内联进 node-repl-host `dist/mcp/server.js`；
- 真 runtime `runtimes/zcode-cua`（纯 JS 自包含，1.5MB，零构建零依赖，vendor 自上游 0.6.3 编译产物）
  只被装机后野路子 `install.sh` + `tools/patch-cua-runtime.cjs` 使用——对已安装 app 做 asar
  二进制 patch + helper 补丁 adhoc 重签 + launchctl setenv，每次更新都要重跑。

历史包袱说明：这些野路子是 ZcodePro 镜像带来的「让官方 ZCode.app 获得计算机控制」的补丁方案；
fork 拥有自己的打包链后，正确位置是构建期。

## 已钉死的平台事实（vendor dist-index.js 实证）

1. **生产态 helper 只有 bundled 一个来源**：`resolveCuaHelperInstallPlan`（vendor :7640-7706）在
   非本地开发运行时要求 `bundledAppPath` 与内嵌 build id 双双存在，缺任一直接 fail-closed：
   - 无 buildId → "Packaged ZCode is missing its embedded Computer Use Helper build identity"；
   - 无 bundledAppPath → "missing its bundled ZCode Computer Use.app path"；
   - download 分支仅本地开发运行时可达，且默认 deps base 是上游内网地址（`ZCODE_DEPS_BASE_URL`
     未设时不可用），对外部 fork 无意义。
2. **helper 信任门**（`verifyCuaHelperBundle`，vendor :7331 起）：`codesign --verify` 通过、
   **非 adhoc**、TeamIdentifier === `8A5X4JJ39T`（上游 ZCode 团队）、`bundleInfo.buildId === plan.expectedBuildId`。
   上游 stock 语义里 unsigned 逃生口 `ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL` 只在本地开发运行时生效
   （`COMPILED_LOCAL_DEVELOPMENT_RUNTIME` 且 `ZCODE_RUNTIME_ENV !== "production"`），且打包态 installer
   会显式删除该变量——fork 在 §B 偏离中把 gate 的 production 门与这条删除一并反转（见下）。
3. **结论**：fork 没有 Apple 证书且 app 本体是 adhoc 签名，stock 发布 helper 的 launcher
   信任门对 adhoc 外壳永远不满足——唯一可行路径是随包携带 **local-dev 补丁 + adhoc 重签**
   的 helper 变体（官方 ZCode.app 的 `Contents/Resources/cua-helper/` 提供 pristine 件源，
   构建期打补丁，详见 §B 的信任模型偏离）。运行期信任走 vendor 的
   `local_dev_unsigned` 分支（buildId/arch 校验保留）。
4. 审计 7 开关（`officialPlatformPolicy`）不涉及 CUA；CUA 是纯本地链路（本地 unix socket broker），
   无策略冲突。

## 数据流与所有者

### A. runtime 替换（构建期 alias，dev/打包同构）

```
packages/zcode-cua（stub，保留：类型与契约来源，typecheck/CLI bundle 继续用它）
        │  tsup alias ／ esbuild alias（仅 bundler 层，仅 main/host/scheduler + node-repl-host）
        ▼
runtimes/zcode-cua/index.js → vendor/dist-index.js（自包含，仅 node: builtins）
        │  内联进产物
        ├─ out/main、out/host、out/scheduler（tsup，+~1.4MB/chunk）
        └─ node-repl-host dist/mcp/server.js（esbuild，同量级）
        ▼
桌面 host：cua-permission-broker 拉起本地 broker → resolveBundledCuaHelperAppPath(env)
        → ensureInstalled（bundled 来源）→ verify（TeamID+buildId）→ helper 进程
node_repl：computer-use-client.mjs → Symbol bridge → broker socket（既有链路不变）
```

- alias 所有者：`packages/desktop/tsup.config.ts`（3 个 node 入口）与
  `apps/zcode-cli/packages/node-repl-host/scripts/build.mjs` 两处，机械一致。
- core/adapters 只 import `frame-contract`/`request-access-contract` 纯契约（两包同版本
  0.6.3、语义一致），CLI bundle 维持 stub，不 alias。
- 构建守卫：node-repl-host build.mjs 构建后断言产物**不含** stub marker
  `"Computer Use is not available in this build."`（desktop 侧由 bundle.mjs 产物校验覆盖
  host chunk）。早期的 `__ZCODE_CUA_HELPER_BUILD_ID__` define 折叠守卫已随该 define 一并
  退役（2026-09-30，原因见 §C）。

### B. helper 随包（macOS，local-dev 补丁 + adhoc 变体）

```
官方发布 CDN（…/ZCode-<pin>-mac-<arch>.zip）或本机官方 ZCode.app（ZCODE_CUA_HELPER_LOCAL_APP）
        │  prepare-cua-helper.mjs（darwin-only；ZCODE_SKIP_CUA_HELPER=1 可跳过）
        │  抽 Contents/Resources/cua-helper/ZCode Computer Use.app → bundled-cua-helper/<key>/
        │  ① 验明正身：codesign --verify + TeamID 8A5X4JJ39T（对 pristine 上游件 fail-fast）
        │  ② patch：字节替换 SEA 内嵌 allowUnsignedLauncherLocalDev=false → true（长度不变）
        │  ③ adhoc 重签（确定性，cdhash 稳定）；buildId（Info.plist）落盘 build-id.txt
        ▼
electron-builder extraResources：bundled-cua-helper/<key> → Contents/Resources/cua-helper
  （mac.signIgnore 排除 cua-helper；afterPack 的 --deep adhoc 对相同字节确定性重签）
        ▼
运行时信任（local_dev_unsigned 模式，vendor verifyCuaHelperBundle 的 allowUnsignedLocalDev 分支）：
  期望 buildId：desktopRuntimeEnv 主进程实读随包 helper Info.plist → env 下发
          ZCODE_CUA_HELPER_BUILD_ID（dev/打包同构；vendor env 优先 patch 消费），
          vendor 内嵌的上游字面量只作 env 缺失时的兜底，不参与 fork 配对；
          早期 __ZCODE_CUA_HELPER_BUILD_ID__ build-time define 已退役（§C）
          ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1 由主进程确定性下发（不继承用户 shell），
          覆盖两条消费链：host env（desktopRuntimeEnv.buildHostProcessEnv）与 onboarding
          installer env（desktopCuaHelperInstaller → applyBundledCuaHelperTrustEnv）
  dev 态：desktopRuntimeEnv 自动接线注入 ALLOW_UNSIGNED + BUNDLE_ID + 实测 BUILD_ID
```

**信任模型偏离（与上游的唯一实质差异，fork 既定决策）**：stock 发布 helper 要求启动方与
broker 客户端父链满足 Apple 锚定的 ZCode 签名要求——只有官方 Developer-ID app 能满足；
ZCodium 是 adhoc 外壳，永远不满足，pristine helper 在 fork 里必然「验证通过但拉起即退」
（2026-09-29 真机实测复现）。因此 fork 同时 patch 两处（延续 b63d033 的 seeded-install patch）：

- **helper 侧**（prepare 阶段）：随包 helper 一律为 patch+adhoc 变体，编译门字面量翻真；
- **runtime 侧**（`vendor/dist-index.js` 的 `isUnsignedHelperLocalDevRequested`）：去掉
  「仅非 production 运行时」限制——否则打包态必然走严格校验、必然拒收 patched+adhoc
  helper。opt-in（`ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1`）由桌面主进程确定性下发，
  用户 shell 注入无法改变行为。
- **主进程 installer 链**（`desktopCuaHelperInstaller.ts`）：上游在有随包 helper 时 delete
  该 opt-in（"已签名 app 必须确定性"），fork 的随包件必然 adhoc、严格验证永远失败——同点位
  反转为确定性置 `1`（纯函数 `applyBundledCuaHelperTrustEnv`，`node --test` 直测）。
  dev（未打包、无 bundledAppPath）保持上游语义：由文档化的 dev 流程显式 opt-in，不代持。

运行时信任走 `local_dev_unsigned` 分支（buildId/arch 校验保留，TeamID/adhoc 检查跳过）。
TCC 稳定性不受影响：helper 字节在同一上游版本间不变，adhoc 签名对相同字节是确定性的，
授权跨更新持久。

- Windows：`runtimes/cua-helper`（入库预编译 win32-x64，含 `runtime-manifest.json`+sha256）
  由 extraResources 直引到 `tools/cua-helper`
  （`windowsCuaDevRuntime` PRODUCT_RUNTIME_SEGMENTS 既有 fail-closed 校验兜底）。
  **未真机验证**，问题会显式报错而非静默。
- Linux：无 helper 无 runtime 面，UI `local-linux → supported:false` 维持 fail-closed。

### C. dev 态自动接线（desktopRuntimeEnv.ts，替代 launchctl setenv）

```
darwin + 未打包（app.isPackaged === false）：
  env ZCODE_CUA_BUNDLED_HELPER_APP_PATH（显式覆盖，优先）
    → ~/.zcode/computer-use/dev/ZCode Computer Use Dev.app
    → ~/.zcode/computer-use/ZCode Computer Use.app
    → packages/desktop/bundled-cua-helper/<key>/ZCode Computer Use.app（prepare 产物，亦供全新机器）
  命中 → host env 注入 ZCODE_CUA_BUNDLED_HELPER_APP_PATH + ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL=1
  全空 → 不注入；runtime 报 helper 未安装，设置页引导（web/linux 同语义）
```

- `ALLOW_UNSIGNED_LOCAL=1` 仅 dev 注入：容忍 install.sh 时代遗留的 adhoc 补丁副本；
  上游原签 helper 在 dev 态走严格校验同样通过。
- **buildId 配对收敛为运行时注入单机制（2026-09-30 修订，替代「define 双来源」）**：
  build-time define `__ZCODE_CUA_HELPER_BUILD_ID__`（desktop tsup 与 node-repl-host esbuild
  两处）与配套折叠守卫整体退役。原因：该 define 依赖被 bundle 的源码里存在 bare 标识符，
  而 fork 的 vendor 产物（runtimes/zcode-cua/vendor/dist-index.js）是上游预构建件——
  buildId 在 vendor 构建期就折叠成上游字面量（pipeline-293504-ab4d5e6b），fork 侧 esbuild
  的 define 无处可替换，守卫「env 值必须出现在产物里」在 env ≠ vendor 烙死值时**恒假**
  （2026-09-30 v3.14.8 首次发版构建实证：CI 导出当日 CDN helper 的 buildId，五个桌面
  job 全数在 build-desktop-agent-cli → node-repl-host 阶段失败；本地此前能过只是因为
  staging helper 尚与 vendor 字面量同源）。打包态 plan 解析的 `!expectedBuildId`
  fail-closed（vendor :7670）不受影响：vendor 内嵌字面量永不为空，env 缺失时兜底；
  真实配对由主进程运行时实读 Info.plist 注入 env 钉住（§B 图）。消费面清理：
  desktop tsup define、node-repl-host define+守卫、bundle.mjs staging 注入、
  release-fork.yml 的 GITHUB_ENV 导出。
- **捆绑注入的另外两个 dev 信任门 env（2026-09-29 真机验收实测补上）**：
  - `ZCODE_CUA_HELPER_BUNDLE_ID=dev.zcode.cua-helper`：dev 变体默认期望 `dev.zcode.cua-helper.dev`，
    而本机/随包 helper 都是官方 stock id——缺它必报 "bundle id … does not match …"。
  - `ZCODE_CUA_HELPER_BUILD_ID=<helper plist 实值>`（plutil 读 ZCodeCUAHelperBuildId）：vendor
    内嵌期望值是上游某次发布的字面量，与本机/随包 helper 不一定一致；fork 的 env 优先 patch
    在 local-dev 或 opt-in 门开启时让 env 恒生效，而 desktop 主进程对两态都确定性下发 opt-in
    （ALLOW_UNSIGNED_LOCAL=1），所以实测值在 dev 与打包态都稳赢内嵌兜底。
- 打包态 installer env 同点位反转：上游 delete → fork 确定性置 `1`（§B 偏离第三条，
  `applyBundledCuaHelperTrustEnv`）；dev 未打包、无 bundledAppPath 时不代持。
- `__ZCODE_LOCAL_DEVELOPMENT_RUNTIME__` define 按构建机 NODE_ENV 折叠（非 production → true）：
  桌面 tsup/vite 由 run-production-build.mjs 注入 NODE_ENV=production，折叠正确；node-repl-host
  经 prepare:runtime-assets 子链构建、不经过该 runner，bundle.mjs 的 buildEnv 补齐
  NODE_ENV=production 兜住。host 链另有 ZCODE_RUNTIME_ENV=production 运行时兜底，但 define
  必须与打包语义一致，不留「编译期本地开发信任」进正式包。

### D. 设置页权限状态查询可靠性（2026-09-30 实测补，四层修复）

故障模型（真机日志 + 本地复现实证）：

1. **探测挂起（本次冻结的直接根因，host 侧）**：stable socket（`/tmp/<uid>/broker.sock`）
   按 user 全局唯一——官方 ZCode.app 与本 fork 共享。fork 的 getStatus →
   `probeStableCuaHelperSocket` → connect 上**官方 helper** 的 socket；官方 helper 是
   token 模式，对未过 peer 校验的裸 ping 既不回包也不断连（helper 日志
   "peer verification failed" 与 fork 侧"EEXIST/already in use"同一战场）。而 probe 在
   connect 成功后 `clearTimeout`，对沉默对端**无限等待**→ host 的 getStatus RPC 永不
   完成（rpc 日志只在完成时打）→ 全场零条 getStatus 日志。
2. **store 永久锁（renderer 侧放大器）**：inFlight 去重把后续所有 fetch（开关 refresh /
   focus / 重新挂载）合并进 rerunRequested 且永不发出，UI 永久卡在 settled=false 的
   「已授权，正在验证 + 未知」，唯一交互入口还 `disabled={!settled}`。
3. **传输静默丢请求（renderer 侧潜在点）**：ChannelClient.sendRequest 的 send 异常被
   `catch { /* noop */ }` 吞掉，请求 promise 永久 pending——与 dispose() 的 fail-closed
   原则相悖。
4. **stub/vendor 谓词漂移（结果侧）**：成功结果**不带** available 字段；vendor 谓词是
   `available !== false`，stub 是 `available === true`。renderer（vite 无 alias，解析
   stub）把每个成功状态判成 unavailable——即使查询正常返回，设置页也只能显示「未知」。

修复分层，责任分明：

```
node.ts probeStableCuaHelperSocket      cuaPermissionStatusStore（ui）      ChannelClient（rpc）
  300ms 覆盖整个探测生命周期               fetch 发起查询 ── 武装看门狗 30s     sendRequest 返回是否送出
  （connect 后不清计时器，对沉默            ├─ 查询 settle → 解除看门狗         └─ send 抛错 → 立即 reject
    对端有界收敛 null）                    └─ 超时触发 → 丢弃迟到 settle           （fail-closed）
                                              ├─ rerunRequested? → 立即补查
                                              ├─ 否则按既有有界退避重试（1s/2s/4s）
                                              └─ 额度用尽 → lastKnown + fresh=false
  packages/zcode-cua（stub 契约副本）
    broker-ports.js 两个值谓词与 vendor 逐字一致（alignment 测试按行为对照防守）
```

- 看门狗阈值 30s：host 最坏路径的 2 倍余量，正常慢查询不误杀；触发即落 warn 日志。
- 看门狗与退避重试共用「查询失败是环境瞬态而非授权终态」的既有语义；迟到 settle 整体
  丢弃，不把旧世界结果发布进新一代查询（与 rerunRequested 防的同一类竞态）。
- 跨安装 socket 共享语义：probe 对官方 helper 的 socket 只会返回 null（沉默超时 /
  拒绝），fork 随后走 launchStandaloneCuaHelperForStatus；socket 被占时 helper 端
  EEXIST 失败、getStatus 如实报 unavailable——这是诚实终态，不再挂起。

### E. 跨安装共存（ZCodium 私有 broker socket，2026-09-30 补）

stable socket 按 user 单例（darwin `/tmp/zcode-cua-<uid>/broker.sock`），官方 ZCode.app
的托管 PiP helper 常驻其上——官方运行期间 fork 的 CUA 完全不可用（探测失败 → launch
EEXIST → 50 轮探测白等 ≈20s → unavailable），且 §D 第 1 条的沉默对端正是它。vendor 的
`resolveBrokerSocketPath` 首选 `ZCODE_CUA_PERMISSION_BROKER_SOCKET`，fork 借此获得
**私有 socket**，与官方 app 彻底解耦：

```
main（buildHostProcessEnv，desktopCuaBrokerSocket.ts）
  ensureForkCuaBrokerSocketDir()            预创建父目录（vendor bind 不做 mkdir）
  applyForkCuaBrokerSocketEnv(env)          用户显式注入优先，否则写 fork 私有键
                                            ZCODIUM_CUA_BROKER_SOCKET（标准键会被 host 启动
                                            的 confused-deputy sanitize 剥掉，fork 键不在
                                            剥离清单，能活着穿过 host 启动——2026-09-30 实测）
        ▼ host env（agent / node-repl 继承）
  services node.ts（initializeRuntimeProcessEnv 之后立即执行）
  restoreZCodiumCuaBrokerSocketEnv()        fork 键 → 标准键 ZCODE_CUA_PERMISSION_BROKER_SOCKET
                                            并删 fork 键（不泄入 Bash/tool 子进程，
                                            confused-deputy 语义不变；恢复一次即全链路同源）
        ▼
  ZCODE_CUA_PERMISSION_BROKER_SOCKET =
    darwin  /tmp/zcode-cua-zcodium-<uid>/broker.sock
    win32   \\.\pipe\zcode-cua-helper-zcodium
    linux   ~/.zcode/cua-broker-zcodium/broker.sock
        ▼
  fork getStatus / launchStandaloneCuaHelperForStatus / managed helper / MCP broker client
  全部经 vendor resolveBrokerSocketPath 读到同一路径；helper 由 --socket argv 显式绑定；
  host 启动必打一条 [cua-permission] broker socket resolved 观测日志，直接暴露注入是否穿透
```

- 无条件下发（dev/打包同构）：fork 不复用官方 helper（peer 校验本来就互拒），
  私有路径在官方 app 是否运行时行为一致，没有状态翻转。
- TCC 授权归属 helper bundle（`ZCode Computer Use`），与 socket 路径无关——已有授权
  跨 socket 持续有效。
- Preview/生产两个 fork 实例同时运行仍共享私有 socket（上游单实例语义），超出本节范围。
- 测试：`packages/desktop/tests/desktop-cua-broker-socket.test.mjs`（平台隔离、用户
  注入优先、父目录预创建、vendor 键懒绑定行为探针、fork 键 → 标准键恢复与删除、
  标准键已有值时尊重现状）。

## 退役清单（野路子 → 内置）

| 旧机制 | 处置 | 替代 |
|---|---|---|
| `install.sh` Darwin CUA 段（runtime staging / helper 下载+patch+seed / launchctl setenv / LaunchAgent / patcher 调用） | 删除，保留插件 seed 与 `--repo` 模式 | §A/§B/§C |
| `install.ps1` CUA 段 | 删除，保留插件 seed | §A/§B |
| `tools/patch-cua-runtime.cjs`（asar stub 桥接 + server.js 补丁） | 删除 | §A 构建期 alias |
| `MARKETPLACE*.md` 的 CUA patch 章节 | 改写为内置说明 | 本 spec |
| `.gitignore` 的 `scripts/cua-helper-sea-base.mjs` 遗留行 | 删除 | — |
| 本机遗留 launchctl setenv / LaunchAgent（com.zcode.cua-env） | 验收时清理，防旧 env 串扰 | §C 代码内接线 |

## 平台矩阵

| 平台 | runtime（host 内联） | helper | 状态 |
|---|---|---|---|
| macOS arm64/x64 | ✅ alias | ✅ 随包（Developer ID 保签） | 真机验收 |
| Windows x64 | ✅ alias | ✅ 随包（manifest+sha256 校验） | 配置就绪，未真机验证 |
| Linux | stub 保留（无 alias 面） | — | fail-closed（UI supported:false） |

## 验收场景

1. **构建守卫**：`node scripts/build.mjs`（node-repl-host）产物不含 stub marker；
   `pnpm bundle:desktop` 产物 host chunk 同样不含；打包产物含
   `Contents/Resources/cua-helper/ZCode Computer Use.app`，其 Info.plist buildId 与
   主进程运行时实测注入的 `ZCODE_CUA_HELPER_BUILD_ID` 一致、helper 二进制含 patched
   `allowUnsignedLauncherLocalDev = true` 字面量、外壳 `codesign --verify --strict` 通过、
   直替换更新自检不被破坏。
2. **dev 验收**：`pnpm dev:desktop` → 设置页出现「电脑控制」分区（computerUse 解隐藏）→
   host 日志显示 helper resolved（bundled）→ 启用 computer-use 插件 → TCC 授权一次 →
   真实 CUA 调用（截屏/点击）走通。
3. **对照测试**（tsx --test）：`runtimes/zcode-cua` version == `plugins/zcode-cua-plugin`
   manifest version（0.6.3 防漂移）；alias 表两处一致。
4. **签名测试**：adhoc-codesign-mac.test.mjs 扩展用例——嵌套 helper 场景两遍签名后
   helper TeamID 保持上游、外壳 verify --strict 通过。
5. **降级路径**：`ZCODE_SKIP_CUA_HELPER=1` 打包跳过 helper 时产物仍可用（CUA 报未安装，
   不崩）；dev 无任何 helper 时不注入 env、UI 引导。
6. `pnpm typecheck` / `pnpm lint` 通过（如实报告）。
7. **打包态 onboarding（干净机器）**：无 install.sh 时代 launchctl/launchd 残留的机器上运行
   打包版 → 设置页「电脑控制」→ 授权 onboarding/drag → helper 经 local_dev_unsigned 安装验证
   通过（desktopCuaHelperInstaller 置 `1` 链路）；信任门单测 `cua-helper-trust-env.test.mjs`
   通过（含 vendor patch 被 vendored 升级冲掉的回归守卫）。
8. **状态查询看门狗**（ui 单测）：getStatus 永不返回时看门狗在阈值后释放查询槽并按退避
   重试（服务调用次数递增）；随后服务恢复正常结果时，下一次 refresh 能把状态收敛到
   settled=true 的真实值——单次查询丢失不再造成永久冻结。stub/vendor 谓词行为对照
   （alignment 测试）通过，防止契约副本再漂移。
9. **跨安装 socket 占用**（dev 真机）：官方 ZCode.app 持有 stable socket 时，fork 的
   getStatus 在 300ms 探测预算内有界返回 unavailable（不再挂起）；socket 空闲时 fork
   拉起自己的 dev helper 并返回真实 TCC 状态。

## 回滚边界

回滚 = 撤销 alias 两处 + extraResources/signIgnore 两项 + prepare 脚本挂载 + dev 接线段 +
installer 信任门覆盖（applyBundledCuaHelperTrustEnv）+ bundle.mjs 的 NODE_ENV 注入 +
UI 解隐藏；产物回到 stub fail-closed 语义（CUA 不可用但不崩），一期插件内置化不受影响。
