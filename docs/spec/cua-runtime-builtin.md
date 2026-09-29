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
  `"Computer Use is not available in this build."`（仿既有 `__ZCODE_CUA_HELPER_BUILD_ID__`
  守卫；desktop 侧由 bundle.mjs 产物校验覆盖 host chunk）。

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
  打包态：__ZCODE_CUA_HELPER_BUILD_ID__ define ← CI 从 build-id.txt 导出；
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
- **buildId define 双来源（2026-09-30 补）**：CI 由 release-fork.yml 导出 `build-id.txt`；
  本地打包（`pnpm bundle:desktop`）没有该 step——bundle.mjs 在 prepare 之后、build 之前
  从 staging 读 `build-id.txt` 注入 `ZCODE_CUA_HELPER_BUILD_ID`（显式 env 优先，CI 零变化）。
  否则打包态 plan 解析在信任门之前 fail-closed（`!localDevelopmentRuntime && !expectedBuildId`，
  vendor :7670）——main 进程不自设 `ZCODE_RUNTIME_ENV`，`NODE_ENV=production` 折叠 compiled=false
  后无 env 兜底。
- **捆绑注入的另外两个 dev 信任门 env（2026-09-29 真机验收实测补上）**：
  - `ZCODE_CUA_HELPER_BUNDLE_ID=dev.zcode.cua-helper`：dev 变体默认期望 `dev.zcode.cua-helper.dev`，
    而本机/随包 helper 都是官方 stock id——缺它必报 "bundle id … does not match …"。
  - `ZCODE_CUA_HELPER_BUILD_ID=<helper plist 实值>`（plutil 读 ZCodeCUAHelperBuildId）：vendor
    内嵌期望值是上游某次发布的字面量，与本机 helper 不一定一致；dev 打包 define 折叠为空串时
    env 覆盖生效（`resolveExpectedCuaHelperBuildId` 的 embedded || env 顺序）。
- 打包态 installer env 同点位反转：上游 delete → fork 确定性置 `1`（§B 偏离第三条，
  `applyBundledCuaHelperTrustEnv`）；dev 未打包、无 bundledAppPath 时不代持。
- `__ZCODE_LOCAL_DEVELOPMENT_RUNTIME__` define 按构建机 NODE_ENV 折叠（非 production → true）：
  桌面 tsup/vite 由 run-production-build.mjs 注入 NODE_ENV=production，折叠正确；node-repl-host
  经 prepare:runtime-assets 子链构建、不经过该 runner，bundle.mjs 的 buildEnv 补齐
  NODE_ENV=production 兜住。host 链另有 ZCODE_RUNTIME_ENV=production 运行时兜底，但 define
  必须与打包语义一致，不留「编译期本地开发信任」进正式包。

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
   CI 注入的 `ZCODE_CUA_HELPER_BUILD_ID` 一致、helper 二进制含 patched
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

## 回滚边界

回滚 = 撤销 alias 两处 + extraResources/signIgnore 两项 + prepare 脚本挂载 + dev 接线段 +
installer 信任门覆盖（applyBundledCuaHelperTrustEnv）+ bundle.mjs 的 NODE_ENV 注入 +
UI 解隐藏；产物回到 stub fail-closed 语义（CUA 不可用但不崩），一期插件内置化不受影响。
