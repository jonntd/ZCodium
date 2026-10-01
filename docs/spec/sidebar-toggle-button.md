# Spec: 「切换侧边栏」按钮的三端呈现（macOS / Windows·Linux 桌面 / Web）

本 spec 定义 workspace 顶部浮层里「切换侧边栏」（toggle sidebar）按钮的**展示契约**：
哪些平台显示、以哪种形态显示、点击后做什么。涉及 `packages/ui` 的 `DesktopTopOverlay`。

## 1. 背景

桌面端（macOS）顶部浮层左上角有切换侧边栏按钮（`PanelLeftClose`/`PanelLeftOpen` 图标），
收起/展开左侧任务侧栏。Web 端此前没有这个按钮——`DesktopTopOverlay` 的两个渲染分支
分别只覆盖 Windows/Linux 桌面（`usesCustomCaptionArea`）与 macOS（`isMacDesktop`），
Web（`isDesktop` 缺省 false）两个分支都不命中，只能靠快捷键 ⌘B 收起、却没有任何
**可见入口**再展开（侧栏收起后侧栏内按钮随之消失），属于可达性缺口。

## 2. 规则

**状态与动作所有者**：`useAppPanels`（`packages/ui/src/hooks/useAppPanels.ts`）的
`isSidebarVisible` / `handleToggleSidebar`，三端共用，不因平台分叉。
快捷键 `toggleSidebar`（默认 `CmdOrCtrl+B`，`packages/shared/src/shortcutCommands.ts`）
监听是 `window` 级（`useAppKeyboard`），Web 同样生效；tooltip 的键位 label 来自生效
快捷键表（`useShortcutCommandLabel`），与实际按键一致。

**按钮呈现**：由纯函数 `resolveSidebarTogglePresentation`
（`packages/ui/src/desktopTopOverlayModel.ts`）唯一判定：

| 平台 | 判定输入 | 呈现 |
| --- | --- | --- |
| macOS 桌面 | `isDesktop && isMacDesktop` | `icon`：直接显示侧栏开/合图标 |
| Windows / Linux 桌面 | `isDesktop && (isWindowsDesktop || 其余即 Linux)` | `logo-hover`：常态显示应用 logo，悬停切换为侧栏图标（自绘标题栏区域） |
| **Web** | `isDesktop` 缺省 false | `icon`：与 macOS 相同的图标按钮（**本次新增**） |

即：按钮在**所有平台**都必须可见；平台间只允许「图标 vs logo 悬停」的形态差异。
理由：Web 与桌面共用同一份 `isSidebarVisible` 状态与 ⌘B 快捷键，没有理由缺少可见入口；
且侧栏收起后 Web 没有第二入口可找回，按钮是唯一锚点。

**位置与层叠**：按钮仍由 `WorkspaceShellLayout` 顶部的 `DesktopTopOverlay` 浮层渲染，
落在侧栏顶部预留的 `h-12` 空白条内（`WorkspaceSidebar` 首个子元素），不与侧栏内容重叠；
侧栏收起时浮层保持 `w-fit`，按钮跟随图标态（`PanelLeftOpen`）提示可展开。

## 3. 事件顺序

```text
用户点击按钮 / 按下 ⌘B
  └─ handleToggleSidebar（useAppPanels）
      └─ setIsSidebarVisible(visible => !visible)
          ├─ 侧栏面板容器 width/opacity 过渡（WorkspaceShellLayout）
          └─ DesktopTopOverlay 按钮图标随 isSidebarVisible 切换（Close/Open）
```

无网络、无持久化参与；刷新后回到默认展开态（现状不变，不在本 spec 扩展）。

## 4. 验收场景

| 场景 | 期望 | 测试 |
| --- | --- | --- |
| Web（三平台标志缺省） | 呈现 `icon` 按钮 | `packages/ui/test/desktopTopOverlayModel.test.ts` |
| macOS 桌面 | 呈现 `icon` 按钮 | 同上 |
| Windows 桌面 | 呈现 `logo-hover` 按钮 | 同上 |
| Linux 桌面（isDesktop，非 mac/win） | 呈现 `logo-hover` 按钮 | 同上 |

运行：`pnpm --filter @zcode/ui test`（tsx --test，`TSX_TSCONFIG_PATH=tsconfig.json`）。
交互验证：web 与桌面各点一次按钮确认侧栏开/合（人工/E2E）。
