# Spec: workspace-header 顶栏状态提示（横幅行并入单排）

本 spec 定义宿主壳层（VS Code/Antigravity 插件 webview）向工作台顶栏注入
**状态提示**（链路降级、能力缺失等非操作型通知）的契约。涉及
`apps/zcode-vscode/src/webview-react/App.tsx`、`src/webview-react/capabilities.ts`、
`packages/ui/src/store/workspaceHeaderHintStore.ts` 与 `packages/ui/src/WorkspaceHeader.tsx`。

## 1. 背景

应用反馈：聊天面板顶部出现**三排**头部区域——

1. IDE 原生视图标题行（"Gode: 对话" + 视图操作/关闭）：IDE chrome，插件不可移除或重排；
2. 能力提示横幅行（`capability-unsupported-hint` / `capability-binary-frame-hint`，
   App.tsx 独立 `<div>` 全宽行）；
3. 工作台 `WorkspaceHeader` 行（h-12，任务标题 + 右侧操作区）。

第 2、3 排同属 webview 内容，横幅行多数时间只有一条短文案却独占一行，浪费纵向空间。
目标：webview 内容侧收成**单排**——提示文案并入 WorkspaceHeader 行，作为紧凑 chip 展示。

## 2. 规则

**所有者**：提示事实由宿主壳层写入（唯一写入方），WorkspaceHeader 只读渲染。
通道是 `packages/ui/src/store/workspaceHeaderHintStore.ts` 的模块级 zustand 单例
（与 zcodeSessionStore 同款模式；不用 prop 穿透——Root→RootWorkspaceContent→App→
ShellLayout→Header 五层共享组件链只为一枚 chip 穿线，改动面不成比例）：

```ts
interface WorkspaceHeaderHint { message: string; tone: "warning" | "info"; }
setWorkspaceHeaderHint(hint: WorkspaceHeaderHint | null): void;
```

**tone 语义**（沿用原横幅配色语义，遵循 DESIGN.md 表面色 token，不手调 alpha）：

- `warning`：能力面整体缺失（旧 CLI / 握手未达降级）→ `bg-warning-surface`
  + `text-warning-surface-foreground`（原 `text-warning` 横幅）；
- `info`：**已下线**。链路降级（binaryFrames=false 的 base64 退化）横幅在 VS Code
  插件宿主里无可操作性且挤占窄侧栏顶栏，投影与常量均已移除，不再产生 info hint。
  `WorkspaceHeaderHint.tone` 联合类型保留该值以兼容既有渲染分支。

**映射**：`capabilities.ts` 纯函数 `headerHintFromCapabilities(projection)`——
仅 `unsupportedHint` 在场时返回 warning，其余情况（含投影为 null）返回 null。

**渲染**（WorkspaceHeader）：hint 在场时渲染为标题区与操作区之间的紧凑 chip
（`role="status"`，`data-testid="workspace-header-hint"`，图标 + 单行截断文案 +
`title` 全文兜底），`ml-auto` 贴操作区左侧；不在场不占位。

**窄屏适配**：chip 挂在 `@container/workspace-header` 容器查询下——
`@sm/workspace-header`（≥24rem）才显示；容器过窄（VS Code 侧栏拖窄）时整枚隐藏，
不挤压标题截断。文案始终 `truncate` + `max-w-[45%]`，宽容器内自动完整展开。

**复位**：`hint === null` 即消失；宿主每次 capabilities 帧全量覆写（无 TTL、无累加）。
`RuntimeRestartBanner`（带重试按钮的可操作错误面）与 IDE 原生标题行不在本 spec 范围。

## 3. 边界

- 桌面/Web 入口从不调用 setter → store 恒为 null → WorkspaceHeader 零视觉变化。
- 多个 WorkspaceHeader 实例（主视图 / Side Pane / 远控壳）读同一 store，提示同显——
  状态提示语义上就是 workspace 级事实，不区分实例。
- 提示为纯通知（非交互、不阻挡输入）；点击行为与详情跳转如后续需要，再扩展
  `WorkspaceHeaderHint`（加可选 `onAction`），不塞进 message 文本。

## 4. 验收场景

1. 插件 webview capabilities 帧 `binaryFrames=false` → 顶栏仅一排（原生标题除外），
   WorkspaceHeader 行尾出现 info chip「当前链路不支持二进制帧，传输已退化为 base64 文本帧」，
   宽容器完整展示；
2. 能力面整体缺失 → chip 为 warning tone「当前 CLI 版本不支持」；
3. capabilities 正常（binaryFrames=true）→ 无 chip，header 高度不变；
4. 侧栏拖窄至 <24rem → chip 隐藏，标题与操作区布局不变；
5. 侧栏拖窄至 24–36rem → chip 显示但文案截断，hover `title` 看全文；
6. 桌面/Web 形态 → 永远无 chip（回归：WorkspaceHeader 其余行为不变）。
