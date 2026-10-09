# 分析：远程中继页与本地桌面 App 的 UI 一致性

> 状态：**P0 已落地（2026-10-09）；P1 / P2 与 4 个决策点待确认**
> 对比对象：**路线 A** —— `deploy/vps-relay/relay.mjs` 托管的手机页面（产物 = `packages/web/dist`，
> 入口 `packages/web/src/main.tsx`） **vs** 本地桌面 App（`packages/desktop/src/renderer/src/main.tsx`）。
> 两者渲染的是**同一个** `@zcode/ui` 的 `Root`，所以"长得不一样"从来不是组件库的问题。

---

## 0. 结论速览

两侧 UI 的差异**全部**来自 4 个来源，按影响面排序：

| #   | 来源                                                                                                                                         | 性质         | 该不该统一                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------------------------- |
| 1   | `Root` 的 5 个开关 props（`isDesktop` / `supportsEmbeddedBrowser` / `allowRemoteWorkspace` / `preferDirectoryBrowser` / `supportsSettings`） | 显式能力裁剪 | 一半该统一（见 §2.1），一半是刻意的 |
| 2   | `IPlatformService` 方法差集（`createWebPlatform` 未实现的方法为 `undefined`）                                                                | 隐式能力裁剪 | 呈现规则该统一，功能不该            |
| 3   | Web 入口**自建**的 4 处实现（启动壳、启动失败页、断线提示、主题/语言初值）                                                                   | 重复实现     | **必须统一**（当前是两套真相源）    |
| 4   | 中继托管的是**手动 scp 的静态产物**                                                                                                          | 版本漂移     | 需要加护栏                          |

**最需要修的 4 处"真·不一致"**（同一功能出现两套实现/两种布局）：

1. ⏸ 工作区头部在 Web 草稿态**整体消失**（桌面始终有）—— `WorkspaceShellLayout.tsx:1497`
   → 需先确认 spec 边界（§5 决策点 1）
2. 🟡 首屏启动画面**两份 SVG 真相源**（`index.html` 内联 vs `RootStartupLoading.tsx`）
   → 动画参数已对齐（§6 P0-1），手抄副本本身仍在
3. ✅ Web 的启动失败页 / 断线提示原为**裸 HTML + 硬编码中英文**，绕过 `@zcode/ui` 组件与 i18n
   → 已改走 `Button` + `intl`（§6 P0-2）
4. ⏸ `isMobileViewport` 在 3 处**硬编码 `false`**，移动端两条已写好的交互分支永不生效
   → 方向未定（§5 决策点 2）

---

## 1. 根因定位：三个"开关面" + 一个结构性风险

### 1.1 开关面 1：`Root` props（入口传给组件的布尔）

| prop                      | 桌面（`desktop/.../main.tsx:310-324`）  | Web（`web/src/main.tsx:577-592`） | 直接后果                                                                         |
| ------------------------- | --------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| `isDesktop`               | `true`                                  | **不传 → `undefined`**            | 窗口装饰、缩放、更新、资源管理器、CUA、迁移、桌面设置项、多窗口同步全部消失      |
| `supportsEmbeddedBrowser` | 未传 → 回退 `Boolean(isDesktop)` = true | **显式 `false`**                  | 内嵌浏览器 / browser-use 整套消失（`Root.tsx:402`）                              |
| `allowRemoteWorkspace`    | 默认 `true`                             | **`false`**                       | `SSHDialog` 不渲染（`Root.tsx:850`）、远程工作区入口传 `undefined`（`:990-992`） |
| `preferDirectoryBrowser`  | 不传                                    | **`true`**                        | 打开工作区走 App 内自绘目录浏览器，而非原生选择框                                |
| `supportsSettings`        | 显式传入                                | 不传 → 默认 `true`                | 无差异（但 Web 是靠默认值，不是显式声明）                                        |

`isDesktop` 是最大的单一开关：`packages/ui/src` 内约 60+ 处渲染分支读它。它同时承担了
"我是桌面"和"我有原生能力"两个语义 —— 这是 §3-P2 要收敛的结构性问题。

### 1.2 开关面 2：`IPlatformService` 方法差集

`createWebPlatform`（`web/src/main.tsx:111-291`）相对 `createDesktopPlatform`
（`desktop/.../desktopPlatform.ts:9-166`）**完全没有提供**、且 UI 会做存在性探测的方法：

- `remoteRelayGetStatus/Start/Stop/SetConfig` → **整个「浏览器直连」面板在 Web 不渲染**
  （`RemoteRelayAccessPanel.tsx:114-115` 的 `supported`，`:198` 直接 `return null`）
- `saveFile` / `printPageToPdf` → 图片与 PPTX 预览的「另存为 / 导出 PDF」按钮隐藏
- `getApplicationIcon` → CUA 应用图标不显示
- `openCuaPermissionOnboarding` → CUA 权限引导按钮消失
- `browserView*` 全家族 → 内嵌浏览器能力缺失（与 `supportsEmbeddedBrowser=false` 叠加）
- `openDataRootImport` / `modelhubProbeVision` / `createLocalMediaPreviewUrl`
- `getDesktopWindowChromeState` / `onWindowControlsOverlayChanged` → 原生窗口状态不可读
- `onSettingsChanged` / `syncAppSettings` / `setShortcutRecordingActive` / `onUpdateCheckResult`

**返回降级值**（方法存在但结果不同）：`canSelectFilePath=false`（附件改走 `<input type=file>`）、
`getPathForFile=null`、`createTempTextAttachment` reject、`openInFileManager/openInEditor/
openExternalFile` 返回 `success:false`、`getInstalledEditors=[]`（"用编辑器打开"按钮无内容）、
`exportLogs` 失败。

> 现状的**呈现原则是对的**：一律隐藏，不出现"能点但点了没反应"
> （教训已写在 `WorkspaceHelpMenuButton.tsx:37-41` 的注释里）。
> 问题是**"隐藏后如何交代"没有统一组件** —— 目前只有 `BrowserSettingsSection.tsx:306-310`
> 一处写了 `settings.browser.desktopOnly` 降级文案。

### 1.3 开关面 3：Web 入口的自建实现（**这是真正的"两套 UI"**）

| Web 自建       | 位置                                               | 与桌面/组件库的关系                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 首屏启动壳     | `packages/web/index.html:361-427` + CSS `:105-152` | 复刻了 `RootStartupLoading.tsx:27-30` 的 `ZCodeStartupLogoBadge`：**SVG path 数据、渐变、24px 圆角、96px 尺寸全部手抄一遍**。动画参数原先也不一致（Web `1.5s` 三段交错脉冲 vs React `1.8s` 整枚呼吸），**2026-10-09 已对齐**，但手抄副本仍在 |
| 卡 logo 自诊断 | `index.html:150-358`（刻意 ES5）                   | 15s watchdog，与 `web/src/bootstrapRetry.ts` 的有界重试职责重叠                                                                                                                                                                              |
| 启动失败页     | `web/src/main.tsx:421-453`                         | 裸 `<button>` + `bg-destructive` 小圆点 + 手写卡片；**文案用 `navigator.language` 正则判中英，不走 i18n**（因此 fa-IR 等语言拿不到译文）                                                                                                     |
| 断线提示       | `web/src/main.tsx:477-526`                         | 同上；且 `4004 被顶替` / `桌面离线` 两种语义的判断逻辑（`connectionLostNotice.ts`）是 Web 独有                                                                                                                                               |

另外两处**初值**不一致：

- **语言**：桌面传 `resolveSystemLocale={desktopPlatform.getSystemLocale}`（`desktop/.../main.tsx:159,307`）；
  Web 的 `ZCodeIntlProvider` **不传**该 prop（`web/src/main.tsx:577-580`），且 `createWebPlatform`
  **没有** `getSystemLocale` 方法 → 回退 `navigator.language`。同一台机器上桌面跟随系统、Web 跟随浏览器。
- **主题**：两侧默认都是 `zai-dark`、都用 `localStorage["zcode-theme"]`，**基本一致**；
  但 Web 的 `index.html:16-63` 额外维护了 `data-zcode-bootstrap-theme` /
  `data-zcode-browser-theme-surface` / `meta[theme-color]` 一套平行标记。

### 1.4 结构性风险：静态产物版本漂移

`deploy/vps-relay/README.md` 明确：中继托管的是**手动 `scp` 上来的 `packages/web/dist`**
（`web/` 是只读 bind mount，换产物不重建镜像）。桌面 App 自动更新后，中继上的 bundle
可以长时间停在旧版本 —— 用户看到的"界面不一致"很可能只是**版本漂移**，而不是布局分叉。
当前 Web 侧没有任何版本比对提示（桌面有 `appVersion`，`web/src/main.tsx:363-398` 解密
host-report 时已经拿到 `report.appVersion`，但只用于显示 serverId/version 之外没做比对）。

> **→ 2026-10-09 已实测发生**：用户在手机中继页看到「设置 → 系统提示词」与桌面 App 不一致，
> 根因就是本条。详见 §7。

---

## 2. 差异清单（哪些要统一、哪些不要）

### 2.1 A 类：同一功能两套实现 —— **应统一**

| #   | 界面元素                  | 桌面                                                                                                     | Web                                                                                                  | 位置                                           |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| A1  | **工作区头部**            | 任何状态都渲染（`variant="draft"` / `"task"`）                                                           | **无 active task 时整个 header 不渲染** → 没有项目名、分支/变更摘要、帮助菜单、终端与 side pane 开关 | `app-shell/WorkspaceShellLayout.tsx:1497-1499` |
| A2  | **首屏启动画面**          | `RootStartupLoading`（React，整枚呼吸 1.8s）                                                             | `index.html` 内联壳（**动画已对齐**，见 §6）+ 自诊断提示                                             | 见 §1.3                                        |
| A3  | **启动失败页 / 断线提示** | 走 `ScopedErrorBoundary` / `toast` / `Card` + `intl`                                                     | ~~自绘裸 HTML + 硬编码中英文~~ → **已改走 `Button` + `intl`**（见 §6）                               | `web/src/main.tsx:421-526`                     |
| A4  | **设置页顶部布局**        | 面板 `p-1 ps-0 pt-0` + `data-settings-top-inset` + 顶部 `h-1 [app-region:drag]` 拖拽条 + 内联窗控/帮助组 | `p-0`、无拖拽条、帮助菜单绝对定位                                                                    | `SettingsPage.tsx:1275-1305`                   |
| A5  | **窗口根底色**            | mac：`bg-background-alt` + vibrancy                                                                      | 走 `bg-background-win-alt`（**Windows 的 token**）                                                   | `DesktopWindowFrame.tsx:28,40-42`              |
| A6  | **语言初值**              | 系统 locale                                                                                              | `navigator.language`                                                                                 | §1.3                                           |

### 2.2 B 类：平台能力缺失 —— **不应"统一功能"，但应统一"交代方式"**

内嵌浏览器 / browser-use、界面缩放子菜单、检查更新与"关于"、资源管理器、
Computer Use 设置分区、项目记忆查看器、Claude 会话迁移、在文件管理器中打开、
在编辑器打开、导出日志、多窗口 tab 与未读徽标同步、窗口装饰与拖拽区、
快捷键的原生菜单加速键、Docker/WSL/SSH 候选、MCP 用户目录管理、原生附件选择框、
桌面通知、CUA 权限引导。

现状：多数已由 `isDesktop` / 能力探测**正确隐藏**（例：`settings/settingsPageConfig.ts:194`
隐藏 Computer Use 分区；`WorkspaceHelpMenuButton.tsx:103-143` 隐藏资源管理器/更新/关于；
`WorkspaceSidebarFooter.tsx:300-333` 隐藏缩放子菜单、`:339-345` 隐藏「移动端远程控制」入口；
`GitPane.tsx:84` 关闭"在文件管理器中打开"）。

**缺的是统一的降级说明组件**：现在只有 `settings.browser.desktopOnly` 一条先例，
其余地方是"静默消失"。

### 2.3 C 类：行为/链路差异 —— **需先定方向再改**

| #   | 行为                              | 现状                                                                                                                                                                                                                                                                                               | 位置                                                                              |
| --- | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| C1  | **composer 自动聚焦**             | 纯函数已写"移动端不自动聚焦（避免弹软键盘）"，但调用点把 `isMobileViewport` **写死 `false`** → 手机上也自动聚焦                                                                                                                                                                                    | `v4/composer/composerAutoFocus.ts:26-28` vs `v4/ConversationComposer.tsx:797-805` |
| C2  | **"分题"斜杠命令**                | 纯函数已写"移动端不提供"，同样被写死 `false` → 手机上照常提供                                                                                                                                                                                                                                      | `slashCommandHelpers.ts:70-79` vs `v4/SessionPane.tsx:1870-1880`                  |
| C3  | **首屏 loading 阻塞**             | `shouldShowRootStartupLoading` 含 `Boolean(state.isDesktop)` → Web **永不**显示 `RootStartupLoading`                                                                                                                                                                                               | `lib/rootStartupGate.ts:37-41`、`Root.tsx:579,916`                                |
| C4  | **Web 首屏 fallback 是死代码** ✅ | 分支要求 `initialWorkspaceLoadingFallback`，**两个入口此前都没传**（prop 只在 `root/types.ts:38` 定义）→ Web 在"已给 `initialWorkspaceAbsPath`、workspace tab 未注入"的首帧落不到该分支，渲染空 `RootShell` 露白底。**2026-10-09 已修**：Web 入口传 `<WebInitialWorkspaceLoading />`（见 §6 P0-4） | `Root.tsx:932-947`                                                                |
| C5  | **流式链路**                      | 桌面 `desktop-continuous`（实时）vs 手机 `web-remote-replayable`（快照恢复）                                                                                                                                                                                                                       | 协议层差异，不在本方案范围，但会影响"状态面板/流式呈现"的观感                     |

---

## 3. 修改方案

### P0 —— 消除"两套实现"（改动小、风险低、收益最直观）—— **已落地 2026-10-09**

1. ✅ **启动画面参数对齐**（做了"至少"那一档，未做构建期注入）
   把 `packages/web/index.html` 内联壳的动画改成与 `RootStartupLoading.tsx` 逐值一致
   （整枚 logo 呼吸：`begin="3s"` / `dur="1.8s"` / `values="1;0.4;1"`，原来的是三段
   `dur="1.5s"` / `values="1;0.3;1"` 交错闪烁）。两侧各加了「改这里必须同步那边」的交叉引用注释。
   ⚠ **这是一处审美判断**：以桌面 App 为准（用户诉求是"与本地 app 一致"）。
   若认为手机首屏更需要"立刻动起来"，可反向对齐（把 React 侧改成 1.5s 脉冲），改一行即可。
   **未做**：构建期把 SVG 注入 `index.html`（彻底消除手抄副本）——需要动 Vite 配置，
   留待 P2 一并处理。

2. ✅ **Web 的启动失败页 / 断线提示改用 `@zcode/ui` 组件 + i18n**
   - `WebBootstrapErrorScreen`、`WebConnectionLostNotice` 的裸 `<button>` 换成 `Button`；
   - 文案从 `/^zh\b/i.test(navigator.language)` 手判中英改为 `intl.formatMessage`，
     新增 4 条词条（`webBootstrap.failed`、`webConnectionLost.{replaced,disconnected,reconnect}`）
     写入 zh-CN / en-US / fa 三份 locale；
   - 两处都渲染在 `Root` 之外，因此各自套了一层 `ZCodeIntlProvider`（其 props 全可选，
     无服务时按 `localStorage` → `navigator` 解析语言）。

3. ❌ **撤回：Web 入口补 `getSystemLocale` —— 这不是缺陷**
   核实后 `ZCodeIntlProvider` **本来就**在 `resolveSystemLocale` 缺席时回退到
   `navigator.language`（`i18n/IntlProvider.tsx:164-181` 的 `resolveNavigatorSystemLocale`），
   而 Web 端拿不到 OS locale 是浏览器沙箱的硬限制。给 `createWebPlatform` 再加一个
   只是重复同一套映射，属于无效改动，故不做。

4. ✅ **处理 `Root.tsx:932-947` 死分支**：按方案 (a) 落地
   `packages/ui/src/index.ts` 导出 `RootStartupLoading`，Web 入口传
   `initialWorkspaceLoadingFallback={<WebInitialWorkspaceLoading />}`（内部走
   `intl` + `common.loading`）。该分支不再是死代码，Web 首帧不再渲染空 `RootShell` 露白底。

5. ⏸ **`isMobileViewport` 接真实视口**（C1/C2）—— **未做，等决策**
   理由：本任务的目标是"让中继页与本地 App **保持一致**"，而接上真实视口会让手机
   _变得与桌面不同_（不自动聚焦、不出现"分题"命令）。方向未定，不动比乱动好。
   见 §5 决策点 2。

### P1 —— 布局对齐

6. **工作区头部：Web 草稿态也渲染 header**（A1）
   把 `shouldRenderWorkspaceHeader` 的 `(activeTaskId !== null || isDesktop)` 改为恒真，
   由 `WorkspaceHeader` 内部继续按 `isDesktop` 裁剪桌面 chrome（窗控、拖拽区、更新按钮）。
   ⚠ **与现有 spec 冲突**：`WorkspaceShellLayout.tsx:1492-1496` 的注释写明"手机远控无 active task
   时仍不渲染桌面 chrome，继续遵守 replayable overlay 边界"。**需要你确认**这条边界指的是
   "不渲染桌面 chrome"还是"不渲染整个 header"——本方案按前者理解。

7. **设置页顶部装饰层收敛**（A4）
   抽出"面板顶部 inset / 拖拽条"为一个可选装饰组件，两侧共用同一容器，仅由 `isDesktop`
   决定是否渲染拖拽条（而不是整段 JSX 分叉）。

8. **窗口根底色给 Web 独立 token**（A5）
   `usesOpaqueRootSurface` 当前把 Web 与 Windows/Linux 归为一类，复用 Windows 的
   `bg-background-win-alt`。给 Web 一个自己的不透明底色 token，避免"手机页带着 Windows 的底色"。

### P2 —— 结构性收敛（防止不一致反复出现）

9. **把"能力"从 `isDesktop` 布尔里拆出来**
   引入一个 `PlatformCapabilities` 描述符（`canRevealInFileManager` / `canOpenInEditor` /
   `supportsEmbeddedBrowser` / `supportsNativeWindowChrome` / `canInstallUpdate` /
   `canManageCuaPermission` / `hasRemoteRelayControl` …），由两个入口各自声明，
   `packages/ui` 只读描述符、不再各自 `platform.xxx != null` 探测。
   收益：新增能力时只需在一处声明；也顺手消掉 `Root` 的 5 个布尔 props。

10. **降级说明统一组件**
    新增 `<PlatformUnavailableHint>`（图标 + 一行说明，复用现有 `TriangleAlert` 样式），
    把 §2.2 里"静默消失"的位置补成"可见但不可用 + 原因"，先例是
    `settings.browser.desktopOnly`。

11. ✅ **版本漂移护栏**（已实现，2026-10-09，见 §7）
    按 **commit 戳优先、version 兜底、缺信息不提示** 的规则比对 bundle 与桌面 Host，
    不一致时给一条可关闭的底部横幅。落地文件：`packages/web/src/relayBundleFreshness.ts`、
    `packages/web/vite.config.ts`、`packages/web/src/main.tsx`、
    `packages/desktop/src/main/remoteRelayClient.ts`、三份 locale。

---

## 4. 验收

- **视觉**：同一 URL 分别在桌面窗口宽度与手机宽度截图，逐项核对 §2.1 的 A1–A6；
  首屏动画帧对比（`dur` 一致）。
- **单测**（纯函数已可测）：
  - `shouldRenderWorkspaceHeader` 在 `isDesktop=false && activeTaskId=null` 下的新期望
  - `resolveComposerAutoFocus` / `shouldOfferSideSlashCommand` 的 `isMobileViewport=true` 分支
  - `resolveWebInitialTheme` / 新增的 locale 解析
- **回归**：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`
  （`pnpm fmt:check` / `pnpm knip` 是既有存量失败，不作为门禁）。
- **联调**：路线 A 真机（relay + 手机浏览器）走一遍"草稿态 → 建任务 → 断线 → 重连"。

---

## 5. 需要你决策的点

1. **A1 工作区头部**：Web 草稿态到底要不要 header？（现有 spec 注释倾向"不要"，
   本方案倾向"要，但裁掉桌面 chrome"）
2. **C1/C2 移动端交互**：手机远控是**故意**对齐桌面（不区分视口），还是漏接线？
   这决定 `isMobileViewport` 是"改成真实值"还是"删掉这两条分支"。
3. **B 类降级说明**：哪些"桌面专属"功能需要在 Web 上给出可见提示（而不是静默隐藏）？
   建议至少：内嵌浏览器、在编辑器打开、导出日志、更新。
4. **是否保留 `docs/spec` 之外的独立 spec**：本文件是否升格为
   `vps-relay-bridge.md` 的一个章节（§19 UI 一致性），还是独立维护。

---

## 6. 实施记录（2026-10-09）

### 改动清单

| 文件                                               | 改动                                                                                                                                                       |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/web/index.html`                          | 启动壳动画参数对齐 `RootStartupLoading`（三段交错脉冲 → 整枚呼吸），加交叉引用注释                                                                         |
| `packages/web/src/main.tsx`                        | 启动失败页 / 断线提示改走 `intl` + `Button`，各套一层 `ZCodeIntlProvider`；新增 `WebInitialWorkspaceLoading` 并传给 `Root.initialWorkspaceLoadingFallback` |
| `packages/ui/src/index.ts`                         | 导出 `RootStartupLoading`                                                                                                                                  |
| `packages/ui/src/root/RootStartupLoading.tsx`      | 加"与 `web/index.html` 手抄副本必须同步"的注释                                                                                                             |
| `packages/ui/src/i18n/locales/{zh-CN,en-US,fa}.ts` | 新增 `webBootstrap.failed` + `webConnectionLost.*` 共 4 条                                                                                                 |
| `packages/ui/test/webRemoteLocale.test.ts`         | 新增：锁死上面 4 条词条在三份 locale 都存在且非空                                                                                                          |

### 验证结果

- `pnpm typecheck` ✅（`tsc -b` 11 个工程，6m06s，无输出）
- `pnpm lint` ✅ 0 error（1 warning 为存量：`packages/services/src/runtime-tools/appCaCert.ts` 的 triple-slash）
- `pnpm architecture:check -- --changed` ✅ `violations: 0 / baseline: 0 / new: 0`
- `pnpm --filter @zcode/ui test` ✅ 96/96（新增 1 项）
- `pnpm --filter @zcode/web test` ✅ 10/10
- **未做**：真机联调（需要 relay + 手机浏览器）；P0-4 的"首帧不再空 `RootShell`"属渲染行为，
  本仓库测试设施是纯 node（无 jsdom），无法用单测覆盖，只能靠真机/手测。

### 顺带发现的既有问题（不在本次改动范围）

- **三份 locale 存在既有漂移**（用 tsx 直接 import 三份 map 比对得到，2026-10-09 实测）：
  - `fa-IR` 比 `zh-CN` **少 77 条** key（`bots.astrbot.*`、`sidePane.files*`、
    `workspaceFileTree.compare*` / `hoverPreview.truncated` 等）——这些界面在波斯语下会
    直接显示 key 本身。
  - `zh-CN` **缺** `settings.memory.viewer.disabled`（en-US / fa 都有）。
  - 因此**没有**加"三份 map 全量 key 对齐"的断言（会直接红）；本次只加了窄口径的
    4 条词条回归锁（见上表）。全量对齐 + 补译应单独立项。
- `pnpm fmt:check` / `pnpm knip` 仍是既有存量失败，不作为门禁。

---

## 7. 实证：版本漂移确实发生了 —— 「设置 → 系统提示词」不一致（2026-10-09）

### 现象

用户在**手机中继页**打开「设置 → 系统提示词」，与**桌面 App** 的同一个页面不一致。

### 定位结论

**不是布局分叉，是版本漂移**。两侧渲染的是同一个 `SystemPromptSection`
（`packages/ui/src/settings/SystemPromptSection.tsx`），该组件及其子组件
（`SystemPromptSegmentCard.tsx`、`SettingsFormTextarea.tsx`）里**没有任何 `isDesktop`
或平台能力分支**；内置原文也统一取自 `@zcode/shared` 的 `system-prompt-segments.ts`。
差异只能来自**产物版本**：

- 中继部署的 `packages/web/dist` 构建于 **2026-10-08 21:40**（本机产物目录 mtime；
  VPS 上那份 `web/` 是手工 `scp` 的副本，只会更旧）。
- 而桌面 App 跑的是**当前源码**。三条改动落在构建时间之后：

| 提交                                                  | 时间  | 对提示词页的影响                                                                                 |
| ----------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------ |
| `550493f` feat(settings): 回复语言偏好端到端接线      | 21:44 | 页面**底部新增「回复语言」字段**（`SystemPromptSection.tsx:277-279` 的 `ResponseLanguageField`） |
| `8b3cd1e` style(settings): 按截图规格还原系统提示词页 | 22:36 | 新增「当前作用域」徽标、「常用段落」小节标题、「推荐模板 / 应用」入口；模式文案 `追加`→`添加`    |
| `9b15cf2` fix(i18n): 分段模式「继续」改回「继承」     | 22:56 | 把 `8b3cd1e` 误改的 `mode.inherit` 从「继续」改回「继承」                                        |

### 逐条差异（产物 vs 当前源码）

比对方法：解析 `packages/web/dist/assets/IntlProvider-*.js` 里 zh-CN 的
`settings.systemPrompt*` 词条，与当前 `zh-CN.ts` 逐条对比（词条数 29 vs 33）。

**手机上缺失的 4 个元素**（桌面有）：

| 词条                                         | 文案                | 对应界面                               |
| -------------------------------------------- | ------------------- | -------------------------------------- |
| `settings.systemPrompt.scopePill`            | 当前作用域：{scope} | 标题下的作用域徽标                     |
| `settings.systemPrompt.commonSegments`       | 常用段落            | 「主身份」页签里段落卡上方的小节标题   |
| `settings.systemPrompt.recommendedTemplates` | 推荐模板（{count}） | Agent 身份卡里的「✦ 推荐模板」折叠入口 |
| `settings.systemPrompt.applyTemplate`        | 应用                | 模板预览卡右下角的按钮                 |

另外 `settings.responseLanguage` / `settings.responseLanguageDescription` 在该产物里
**完全不存在**（0 命中）⇒ 手机上连「回复语言」这一块都没有。

**两侧文字不同的 1 处**：

| 词条                                | 中继产物（旧） | 当前源码（新） |
| ----------------------------------- | -------------- | -------------- |
| `settings.systemPrompt.mode.append` | `追加`         | `添加`         |

### 修复

```bash
# 1) 用当前源码重建前端产物
pnpm --filter @zcode/web build

# 2) 拷到中继的 web 根目录（web/ 是只读 bind mount，换产物不需要重建镜像）
scp -r packages/web/dist/* <user>@<relay-host>:<web-root>/

# 3) 手机上重新打开链接（index.html 是 no-store，assets 是内容哈希文件名，
#    普通刷新即可拿到新产物，无需清缓存）
```

⚠ 重建会把**当前工作区里未提交的改动一并打进产物**（本仓库此刻还有
`shared/src/remote-relay.ts`、`ui/src/remoteRelayScenario.ts` 等并行改动线）。
要发布"干净版"就先提交/暂存，再构建。

### 结论：P2-11「版本漂移护栏」已升为 P1 并**落地**（2026-10-09）

这条风险已经从"可能"变成"已发生"，且症状是**被误判成 UI bug**。护栏已实现：

**判定规则**（`packages/web/src/relayBundleFreshness.ts`，纯函数 + 单测）

1. **先比 commit 戳**（`ZCODE_COMMIT`，git 短 SHA）：两侧都知道且不同 → 提示
   「产物提交 X，桌面提交 Y」；相同 → 直接放行（同一提交的产物，版本号必然一致）。
2. **commit 任一侧不知道时才退到 version**：这条只在"桌面发版更新、中继产物没跟着重发"
   时有效 —— 本地开发两边版本号都是 `package.json` 的同一个值，比不出差异。
3. **fail-open**：任一侧缺信息一律不提示。`unknown` / `0.0.0-dev` / `relay`
   （中继在桌面从未上报 appVersion 时的兜底串）都算"不知道"，绝不用占位值去比。

**为什么是 commit 而不是 version 做主力**：本次实证的两侧版本号都是 `3.14.7`，
只有提交不同（`0901a158` vs 旧 bundle 的构建点）。所以护栏必须能比 commit。

**数据从哪来**

| 侧         | 来源                                                                                                                                                                                           |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| bundle     | `@zcode/shared` 的 `ZCODE_COMMIT` / `ZCODE_VERSION`（构建期 define 折叠）                                                                                                                      |
| 桌面 Host  | host-report 新增 `buildCommitId` 字段（`remoteRelayClient.ts`，值取本进程的 `ZCODE_COMMIT`）                                                                                                   |
| 手机侧读取 | **E2EE 路径**：中继把整份密文原样回给手机，解密后能读到任意字段。**非 E2EE 路径**：中继的 `buildServerInfo()` 只白名单回 `serverId/version/workspaces/…`，拿不到 commit，此时只剩 version 可比 |

**两个必须配套的前提**

- `packages/web/vite.config.ts` 的 `__ZCODE_COMMIT__` 原先只取 `env.ZCODE_COMMIT`，
  本地直接 `vite build` 时恒为 `"unknown"` ⇒ 护栏永远比不出来。已补
  `git rev-parse --short=8 HEAD` 回退（取不到 git 时仍回 `"unknown"`，维持 fail-open）。
  ⚠ **必须带 `--short=8`**：桌面侧就是 `git rev-parse --short=8 HEAD`
  （`build-metadata.mjs` 的 `resolveCommitId()`），不带参数会给 7 位，两边长度不一致
  会让护栏每次都误报。
- 桌面侧的 `ZCODE_COMMIT` 由 `packages/desktop/scripts/build-metadata.mjs` 的
  `resolveCommitId()` 提供，dev/prod 构建都有值（实测 `out/host/*.js` 折叠为 `0901a158`）。

**比对不能直接 `===`**：两侧戳的来源与长度可能不同（桌面 8 位短 SHA / CI 可能注入完整
40 位）。`relayBundleFreshness.ts` 的 `isSameCommit()` 按「一方是另一方的前缀，且较短
一方 ≥ 7 位」判定 —— git 保证 7 位在仓库内唯一，所以这个宽松度不会把两次不同提交判成相同，
但能吸收「短 SHA vs 全 SHA」「7 位 vs 8 位」「大小写/空白」这几类噪声。

**提示形态**：底部非阻塞横幅（`WebBundleStaleNotice`，挂在 `Root` 之外，与断线提示同一套
"不卸载界面"的理由），可关闭；关闭记录写 `sessionStorage` 并按**不一致的组合**去重 ——
重新构建/重新部署后换成新的一组不一致会再次提示。

**验收**：`packages/web/tests/relayBundleFreshness.test.mjs` **10 项**（commit 优先、
短/全 SHA 前缀等价、前缀下界、退到 version、fail-open、占位值、去重键）。
