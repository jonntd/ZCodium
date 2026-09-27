# Spec: 右侧面板文件浏览器（Side Pane Files Tab）

本 spec 定义右侧面板（AnimatedSidePanePanel）中的**文件浏览 tab**：复用左侧「查看文件」
的 `WorkspaceFileTree` 浏览工作区文件，点击文件后通过既有 code-viewer tab 链路在右侧
面板内查看内容，渲染能力与主界面查看器完全同源。左侧边栏行为不受影响。

## 1. 范围

- 新增右侧面板 tab 类型 `files`（单例，id 固定 `"files"`），入口在面板「+」新增标签菜单。
- tab 内容 = `WorkspaceFileTree`（与左侧文件树同一组件：目录懒加载、搜索、Git 变更
  过滤、排序规则完全一致）。
- 点击/回车文件行 = 通过 `onOpenCodeViewer` 打开**主界面 code-viewer tab**（同属右侧
  面板），全部文件类型（code/markdown/svg/image/media/pdf/pptx/diff）由 PreviewPane
  同源渲染；不新增任何渲染分支。
- 不改动：左侧边栏文件树（点击文件仍走主界面 code-viewer 链路）、PreviewPane、
  聊天文件链接、其余 side pane tab 行为。

## 2. 状态所有权与事件顺序

```text
workspaceSidePane.ts（唯一事实源，沿用既有 WorkspaceSidePaneState）
  FilesSidePaneTab { id: "files", type: "files", ownerTaskId?, workspaceKey?, openedAt? }
  activateFilesSidePane(current) ─ 单例激活：已存在则激活，不存在则创建
  WORKSPACE_GLOBAL_SIDE_PANE_TAB_TYPES += "files"（与 git/developer-tools 同为 workspace 级，
      不随对话 scope 收窄）

入口 A：右侧面板「+」菜单 → 文件
  useAppPanels.handleOpenFiles
  ─→ commitOpenedSidePaneState(activateFilesSidePane) + revealSidePaneForCurrentOwner()
  ─→ 记录 [App] 打开右侧面板 mode=files

入口 B：左侧工作区行按钮（… 旁，「打开文件面板」）
  WorkspaceSidebarItem.onOpenSidePaneFiles(tab) ─→ WorkspaceSidebar 透传目标工作区
  ─→ App.handleOpenSidePaneFilesForWorkspace(target)
      ├ 同工作区 / 无目标（「+」菜单）→ 直接 handleOpenFiles()
      └ 跨工作区 → pendFilesOpenForWorkspace(targetKey) + handleStartDraftInWorkspace
            （与行头点击同一事务：裸 activateTab 只改 tab store，不驱动主界面工作区切换）
  ─→ useAppPanels 的挂起意图 effect 在「side pane memory 恢复」effect **之后**执行
     （同组件内按声明顺序）：sidePaneMemoryKey === targetKey 时才
     commitOpenedSidePaneState(activateFilesSidePane) + revealSidePaneForCurrentOwner()；
     切到其它 workspace 则意图过期丢弃。
      禁止提前打开：切换会触发 memory 恢复（tabs 与折叠偏好整体换成目标 workspace 的
      记忆），恢复前打开的 files tab 会被覆盖、面板还会按目标旧偏好折叠回去；
      也不允许在 WorkspaceSidebar 的 effect 里打开（子组件 effect 先于 App 执行，
      同样落在恢复之前）。

files tab 内点击文件
  ─→ onOpenCodeViewer(source + workspace 作用域)（既有链路，sourceKey 去重复用 tab）
  ─→ 右侧面板切到该文件的 code-viewer tab；files tab 保持挂载（TabsContent forceMount），
     展开/滚动状态保留

关闭 = tab 条 X 或 tab 内菜单；恢复 = 既有 restoreSidePaneTab（内存恢复通用路径）
```

- files tab 的归属由既有 `stampSidePaneTabsOwnership` 统一冻结（ownerTaskId /
  workspaceKey）；不新增持久化格式、协议方法或服务。

## 3. 行为规则

1. 入口 A：右侧面板「+」菜单 → 「文件」（`sidePane.files`）。office 模式不提供（与
   Git/终端同门槛）；只读 workspace 由 App 层 `handleOpenFilesIfWritable` 拦截（与
   终端/Git 同门槛，避免必然失败的浏览）。
1a. 入口 B：左侧工作区行「…」旁的文件夹按钮「打开文件面板」
   (`workspaceSidebar.openSidePaneFiles`, TID `workspace-side-pane-files-button`)。
   与既有「查看文件」（左侧覆盖层文件树，ListTree 图标）并存但图标/文案区分；
   非激活工作区行先切换工作区再打开（见 §2 入口 B）；断连远程行不显示，
   只读行禁用（与「查看文件」同门槛）。行头是 Collapsible 触发器，按钮 click
   必须 preventDefault + stopPropagation，否则会被当成行折叠切换把项目意外收起。
2. tab 条：图标 FolderOpen，标题取 `sidePane.files`；Command Center 搜索提示
   `"files file tree workspace browser"`。
3. tab 内容顶部不显示「返回任务」按钮（`WorkspaceFileTree` 新增可选 prop
   `hideBackButton`，缺省 false，左侧用法不变）；关闭由 tab 条承担。
4. 文件树跟随定位：files tab 的 `activePreviewPath` 取当前激活 code-viewer tab 的
   文件路径（仅带 `path` 的 source 类型），树自动展开祖先目录定位当前文件。
5. 点击文件打开的 code-viewer tab 按 sourceKey 复用（同文件不重复开 tab），这是既有
   `openCodeViewerSidePane` 语义，未改动。
6. `temporaryExternalDirectory`、远程 workspace 作用域（workspaceIdentity /
   remoteSessionId）等语义与左侧文件树一致。

## 4. 失败语义

- 目录读取失败、文件缺失/过大等错误沿用 WorkspaceFileTree 与 PreviewPane 既有错误态，
  不新增兜底分支。

## 5. 验收场景

1. 右侧面板「+」→「文件」→ 出现「文件」tab，展示当前工作区文件树；再点一次菜单只激活
   不新开。
1a. 左侧工作区行「…」旁按钮 → 无论右侧面板是否收起，一次点击后面板展开并显示文件树；
    在非激活工作区行点击 → 先切到该工作区，面板文件树展示的是该工作区内容。
2. 点击 `.ts` → 右侧面板切到该文件的 code-viewer tab，语法高亮可滚动；「文件」tab 展开
   状态保留。
3. 点击 `.md`/`.png`/`.pdf`/`.pptx`/视频 → 与主界面相同的渲染器与操作菜单。
4. 打开文件后回到「文件」tab → 树已自动展开并定位该文件。
5. 切换对话/工作区：files tab 为 workspace 级，不随对话消失；切到另一 workspace 不串内容。
6. 左侧边栏文件树行为与改动前一致（回归）；office 模式与只读 workspace 无「文件」入口。

## 6. 边界

- 不新增协议、服务或跨包导出；tab 状态持久化沿用 side pane 既有内存恢复逻辑。
- 移动端 Web 沿用同一实现。
- 不与左侧文件树共享打开状态（各自独立的 UI 状态，数据同源 workspacePath）。
