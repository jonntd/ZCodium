# Spec: 侧栏文件预览标签（Side Pane Preview Tab）

本 spec 定义右侧面板 code-viewer 标签的**预览（preview）语义**：文件树里浏览多个文件时，
单击只占用一张可被替换的「预览标签」，不再每个文件追加一个永久标签；用户显式的
「正式打开」动作（双击、右键打开、钉住）才转为普通标签。解决快速连续预览多个文件时
标签条爆满、来回切换困难的问题。

> **修订（2026-09-27，分栏浏览模式）**：files tab 升级为「树 | 预览」分栏后，**files tab
> 内**的树单击改为替换 tab 内嵌预览栏（§7），不再创建预览槽标签；预览槽语义保留给
> 左侧「查看文件」覆盖层文件树与已恢复的旧标签。§1-§6 中"文件树单击"的描述相应限定
> 为左侧覆盖层入口。

## 1. 范围

- 仅作用于 `openCodeViewerSidePane` 的文件树入口（`WorkspaceFileTree` 的
  `onOpenPreview` 链路，含右侧面板 files tab 与左侧「查看文件」覆盖层文件树）。
- 消息内文件链接、assistant 产物批量打开（`openCodeViewerSidePanes`）、白板/其它
  面板的 `onOpenCodeViewer` 调用**语义不变**（intent 缺省 `"open"`，永远开普通标签）。
- 不改动：PreviewPane 渲染、sourceKey 去重规则、标签拖拽/关闭/重开、memory 持久化格式。

## 2. 状态所有权与事件顺序

```text
workspaceSidePane.ts（唯一事实源，沿用 WorkspaceSidePaneState）
  CodeViewerSidePaneTab 新增 preview?: boolean
  预览标签 id 固定为 code-viewer:preview:${sidePaneOwnerKey(ownerTaskId)}（同 owner 唯一）
  openCodeViewerSidePane(current, source, owner, intent: "preview" | "open" = "open")
  pinCodeViewerSidePaneTab(current, tabId) ─ 预览标签转正

文件树单击（intent=preview）
  ├ 已有同 sourceKey 标签（普通或预览）→ 激活并刷新 source，不新增
  ├ 已有本 owner 预览标签 → 原位替换 id 保持不变、source/title 换新 → 激活
  └ 都没有 → 追加 1 张预览标签 → 激活
文件树双击 / 右键「打开」/ Enter 于上下文菜单（intent=open）
  ├ 命中预览标签 → 就地转正（preview=false，id 换回 code-viewer:${sourceKey}）
  ├ 命中普通标签 → 激活（现状）
  └ 无 → 追加普通标签（现状）
预览标签上双击 / 右键「钉住标签」
  └ pinCodeViewerSidePaneTab：转正规则同上；若同源普通标签已存在则合并
    （删除预览槽、激活普通标签并刷新 source），不允许出现重复 id
```

- 预览标签的 owner/workspace 冻结沿用既有 `stampSidePaneTabsOwnership`；可见性过滤
  （per-owner）不变，因此预览槽天然按对话隔离。
- memory 恢复（`restoreSidePaneTab`）按原样还原 tab 对象，`preview` 字段随 tab 持久化，
  恢复后仍是预览标签（与 VS Code 恢复预览标签的行为一致）。

## 3. 行为规则

1. 预览槽唯一性：同 owner 同时至多一张预览标签；替换时保持其在标签条中的位置。
2. 预览标签视觉：标题斜体（VS Code 惯例），其余样式与普通标签一致。
3. 转正入口：文件树行双击（`event.detail > 1`）、预览标签双击、预览标签右键菜单
   「钉住标签」（`sidePane.pinTab`）、文件行右键菜单「打开」。
4. 单击文件树行时目录行为不变（detail>1 的连击对目录忽略，避免连击展开又收起）。
5. `sourceKey === null` 的 source（无法去重的内容型 source）不支持预览语义，按
   intent=open 处理，不进入预览槽。
6. 钉住/转正只改标签身份（id/preview），不触碰文件内容与只读门槛；不新增协议、
   服务或跨包导出。

## 4. 失败语义

- 转正目标 id 冲突（同源普通标签已存在）按 §2 合并规则收敛，不报错、不产生重复标签。
- 其余错误沿用 WorkspaceFileTree / PreviewPane 既有错误态。

## 5. 验收场景

1. 右侧面板文件树连续单击 3 个不同文件 → 标签条始终只有 1 张预览标签，内容依次替换。
2. 单击已在普通标签中打开的文件 → 激活该普通标签，预览槽不变。
3. 双击文件树行 → 该文件转为普通标签；再次单击其它文件 → 新预览标签与普通标签并存。
4. 预览标签双击或右键「钉住标签」→ 转为普通标签（斜体消失，id 稳定）。
5. 转正后同源普通标签已存在 → 预览槽消失，激活普通标签，标签总数不增。
6. 消息内点击文件链接 → 仍然新开普通标签（回归）；assistant 产物批量打开不受影响。
7. 切换对话再切回：预览标签按 memory 原样恢复；跨对话不串预览槽。
8. 左侧「查看文件」覆盖层文件树同样具备预览/双击语义（同一组件链路）。

## 6. 边界

- 移动端 Web 沿用同一实现；桌面/远程 workspace 无差异逻辑。
- 悬停预览、分屏对比、独立预览窗口不在本 spec 范围（后续独立 spec）。

## 7. files tab 分栏浏览模式（2026-09-27 修订）

目标：连续阅读/编辑多个文件时无需在「文件」标签与内容标签间来回切换——树与内容
始终并排可见，树自动跟随当前浏览的文件。

### 7.1 状态所有权与事件顺序

```text
FilesSidePaneTab 增加 previewSource?: CodeViewerSource（含 workspacePath/workspaceIdentity/
  workspaceRemoteSessionId 作用域，由调用方附加）
  ─→ 随 tab 持久化进 side pane memory：跨工作区各记各的、重载后原样恢复、
     关闭 files tab 即随 tab 丢弃；不新增独立 store 或协议。
  workspaceSidePane.ts 纯函数：
    openFilesTabPreview(current, source)  ─ 设置/替换 id="files" tab 的 previewSource
    closeFilesTabPreview(current)         ─ 清空 previewSource（回到全宽树）

files tab 内单击树行（intent=preview）
  └─ openFilesTabPreview → 更新 previewSource → files tab 保持激活（不切换标签）
     树定位信号 = previewSource.path（优先）＞ 激活 code-viewer tab（§3.4 现状回退）
files tab 内双击树行 / 预览栏「在标签打开」（intent=open）
  └─ onOpenCodeViewer(intent=open) → 真实 code-viewer 标签（§2 转正语义原样复用）
预览栏「关闭」（PreviewPane onClose / 动作条 X）
  └─ closeFilesTabPreview → 全宽树；不触碰任何 code-viewer 标签
```

- `openFilesTabPreview` 在 files tab 不存在时不隐式创建（浏览入口只存在于 files tab 内），
  也不改变 activeTabId（点击发生在已激活的 files tab 内）。

### 7.2 行为规则

1. 布局：`ResizablePanelGroup`（水平）[树 | 预览栏]，`layoutId="side-pane-files-browse-layout"`
   持久化分栏比例；无 previewSource 时为全宽树（单面板）。树面板 minSize 20%，预览面板
   minSize 30%。
2. 预览栏渲染 PreviewPane（与 code-viewer 标签同源渲染，含 renderHeavyContent 门控；
   门控的 isActiveTab 按 files tab 是否激活计算），顶部动作条：文件名 + 「在标签打开」
   （`sidePane.filesPreview.openInTab`）+ 「关闭预览」（`sidePane.filesPreview.close`）。
3. 内嵌预览与 code-viewer 标签相互独立：消息内链接打开的标签不改变 previewSource；
   previewSource 也不随标签激活自动变化（尊重用户显式浏览位置）。
4. 左侧「查看文件」覆盖层文件树行为不变（§2-§5 的预览槽语义仅剩该入口使用）。
5. WorkspaceFileTree 组件零改动——分栏与意图分流全部在消费方（AnimatedSidePanePanel
   files 分支）接线。

### 7.3 验收场景

1. files tab 单击文件 → 右栏出现内容，树保持可见并定位该文件；再单击其它文件 → 右栏
   替换，标签条不新增任何标签。
2. 双击树行 → 打开/转正真实 code-viewer 标签（切到该标签）；回到 files tab → 预览栏
   仍是之前浏览的文件。
3. 预览栏「在标签打开」→ 当前文件成为真实标签（同双击）。
4. 预览栏「关闭」→ 全宽树；code-viewer 标签不受影响。
5. 拖动分栏线 → 比例持久化；重载后恢复。
6. 切换工作区再切回 → previewSource 跟随各 workspace 的 memory，不串内容；经「打开文件
   面板」按钮触发的挂起打开也不得把恢复出的 previewSource 重置（files tab 单例复用
   语义，与 browser 单例同规则）。
7. side pane memory 为会话级（renderer 模块缓存），整页重载后所有标签类型统一回到
   初始态——previewSource 不例外，不单独持久化。

## 8. 与当前文件对比（2026-09-27，P2）

分栏模式下"读两个文件做对比"的动作：树行右键菜单「与当前文件对比」，以**内嵌预览栏
当前文件为基线**（`previewSource`），目标为右键的文件行，打开一张 `multi-file-diff`
真实 code-viewer 标签（PreviewPane 既有 diff 渲染，sourceKey 含双方内容哈希——同一对
文件重复对比复用同一标签，任一侧内容变化则新开）。

### 8.1 状态所有权与事件顺序

```text
无新增持久化状态：对比是"读双文件 → 组 source → 开标签"的一次性动作。
  树行右键「与当前文件对比」
  └─ WorkspaceFileTree.onCompareWithBaseline(row)（tree 只透传，不读文件）
  ─→ useWorkspaceFileCompare（hooks 层，持有 workspace 作用域的 fileService）
      ├─ fileService.readTextFile × 2（各自 256KB 上限，binary/truncated 即失败）
      └─ buildFileCompareDiffSource（workspace-file-tree/fileCompare.ts 纯函数）
          { type: "multi-file-diff", title: "基线 → 目标", path: 目标路径,
            beforeContent: 基线内容, afterContent: 目标内容, workspace 作用域 }
  ─→ onOpenCodeViewer(source, { intent: "open" }) → 真实标签（§2 语义）
  失败（读取异常/二进制/超过上限）→ toast workspaceFileTree.compareFailed，不开标签
```

### 8.2 行为规则

1. 入口仅在 files tab 分栏模式：基线 = `previewSource`；未开内嵌预览（全宽树）时无
   基线，不显示菜单项。左侧「查看文件」覆盖层不接线（暂无基线来源），后续需要时
   用激活 code-viewer 文件作基线即可复用同一链路。
2. 目标行必须为普通文件：目录、Git deleted 虚拟行、与基线同路径的行不显示菜单项。
3. 对比标签语义 = intent=open（正式标签），与预览槽/内嵌预览互不影响。
4. WorkspaceFileTree 不持有基线内容，只透传行；内容读取一律在 hooks 层经
   workspace 作用域 fileService（远程 workspace 由正确 host 读取）。

### 8.3 验收场景

1. 内嵌预览打开 A 后右键 B → 出现「与当前文件对比」；选择后打开 A→B 的 diff 真实标签。
2. 同一对文件再次对比 → 复用同一 diff 标签（不重复开）。
3. 全宽树（无内嵌预览）右键任何文件 → 无该菜单项。
4. 右键目录/deleted 行/基线自身 → 无该菜单项。
5. 任一文件超 256KB 或二进制 → toast 失败文案，不开标签。

## 9. 树行悬停预览（2026-09-27，P1）

文件树行悬停 600ms → 行侧 HoverCard 轻量预览，不点击先瞄一眼内容；配合 §7 分栏模式
构成"悬停粗看 → 单击细看 → 双击保留"的连续阅读流。

### 9.1 状态所有权与事件顺序

```text
无全局 store、无持久化：悬停状态在 Radix HoverCard 本地（open 随指针），读取状态在
卡片内容组件本地（仅悬停期间挂载，unmount 即弃）。
  指针悬停行 600ms（openDelay）→ HoverCardContent 挂载 → 内容组件 onMount 发起
  fileService.readTextFile({ path, length: 16KB })（workspace 作用域，远程由正确 host 读取）
  ├─ 文本 → 等宽 pre 渲染（max-h 滚动）+ 头部（文件名/大小）+ 截断时脚注提示
  ├─ 图片（isImagePreviewPath）→ fileService.readMediaPreview({ path, maxBytes: 512KB })
  │    → data URL 缩略图（无状态 base64，无 previewId 生命周期负担）+ 头部大小
  ├─ 音视频/PDF/PPTX（resolveHoverPreviewKind 预判）→ 简卡「点击查看」
  └─ 读取失败/图片超上限 → 卡内降级简卡或错误文案（不 toast、不开标签）
  指针离开（closeDelay 100ms）/ 行虚拟化卸载（滚动）→ 卡片关闭、在途读取作废
```

### 9.2 行为规则

1. 仅文件行启用；目录、Git deleted 行不触发。行拖拽中（isDragging）不触发。
2. 一次悬停至多一个在途读取（内容组件单例），无并发限流需求（卡片关闭即卸载）。
3. 文本读取上限 16KB（readTextFile length），截断时脚注「已显示前 16 KB · 点击查看全部」。
4. 图片走 `readMediaPreview`（无状态 base64 返回，随卡片卸载自然丢弃，无释放语义），
   maxBytes 512KB：超限或读取失败降级简卡「点击查看」；音视频/PDF/PPTX 不做预览，
   直接简卡（媒体播放器/大文档不适合悬停卡）。
5. WorkspaceFileTree 组件树只新增 `workspaceRemoteSessionId` 透传（List/StickyFolders/
   RowView），悬停逻辑自包含于 RowView 包裹层与内容组件。

### 9.3 验收场景

1. 悬停文本文件 600ms → 出现内容卡片（前 16KB），移开即关。
2. 悬停大文本（>16KB）→ 内容 + 脚注提示；悬停图片 → 缩略图（超 512KB 降级简卡）。
3. 悬停目录/deleted 行 → 无卡片。
4. 快速扫过多个行 → 不闪烁、无残留卡片、无错误堆栈。
5. 远程 workspace 悬停 → 读取走远程 host；失败显示卡内错误文案。
