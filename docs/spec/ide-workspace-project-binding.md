# Spec: IDE 工作区 → 本地工程绑定（新建任务识别当前工程）

本 spec 定义 VS Code/Antigravity 插件把「IDE 当前打开的文件夹」绑定为本地图项目的
契约。涉及 `apps/zcode-vscode/src/features/workspaceProjectBinding.ts`、
`src/container.ts` 与 `packages/services/src/project-storage/project-repository.ts`
（`reserveCreatedTask` 归属规则）。

## 1. 背景

应用反馈：插件聊天面点「新建任务」不识别 IDE 当前打开的工程——任务列表侧栏的
「项目」分组里没有该文件夹，任务落在「本地无项目任务区」。

调查证据（现场实测 2026-11-07）：

- IDE workspace.json 确认 folder `/tmp/gode-ui-test` 打开；bootstrap workspacePath
  正确传入 webview（P1-1.5 会话恢复也命中该 folder 键）；
- `~/.zcodium/v2/tasks-index.sqlite` 的 `tasks` 表有该会话行，但 `project_id` 为空；
  `projects`/`project_roots` 无任何行覆盖该路径；
- 根因：工程注册只发生在项目侧栏的用户动作（新建/编辑工程、项目内建任务）；
  插件是 **workspace-first 入口**，`reserveCreatedTask` 收到 `projectId=null` 后，
  按根目录自动归属的分支只对**远端 Host** 生效——本地任务全部落为未归类。

## 2. 规则

**注册（插件侧）**：插件 host 在服务装配完成后，把 IDE 打开的每个 folder 注册为
本地工程（含 folder 变更时重跑）：

1. `readTree` 读非软删工程的全部 roots，**精确匹配**（path 相等，`normalize` 后比较）
   已声明该根目录的工程 → 复用，不新建；
2. 未命中 → `saveProject({ roots: [folder], primaryRoot: folder })`——不传 `name`，
   工程名按根目录 basename 自动派生（`name_overridden=0`，用户可后续改名；
   重名由仓库层加 `(2)` 后缀）；
3. 注册失败（目录消失、DB 错误等）只记诊断日志，**不阻断对话面**——绑定缺失降级为
   现状（任务未归类）。

**归属（服务侧）**：`reserveCreatedTask` 的按根目录自动归属从「仅远端 Host」放宽为
**本地/远端一致**：调用方未显式传 `projectId` 时，若本 Host 已有**非软删**工程的
roots 精确包含 `task.workspacePath`，任务归入该工程。精确根匹配不猜项目：
子目录（`/repo/apps/x`）不命中声明根为 `/repo` 的工程；从项目侧栏创建的任务本就
显式带 `projectId`，优先级不变。

**草稿锚定（UI 侧）**：「新建任务」（`startNewTaskFromActiveWorkspace`）在本地、
未显式指定项目、**活动工作区在场**时，草稿必须留在活动工作区——不得调
`prepareSession({draftId})`（无 projectId 时它会铸造 `~/.zcodium/workspace/draft-<uuid>`
当 cwd，把草稿从当前工程抢走：实测新任务会话 cwd=draft-uuid，工程上下文全丢，
且 cwd 不匹配导致归属落空）。只有**无活动工作区**的全局新建入口才走草稿目录机制。
有 `draftProjectId` 的活动工作区维持原项目化路径（`prepareSession({projectId})`）。

**事件顺序**：

```text
插件 activate → createPluginServices（同步装配，数据根 ~/.zcodium 共享桌面端）
             → ensureWorkspaceProjectBinding(folders)：readTree → 逐 folder 补注册
folder 变更（onDidChangeWorkspaceFolders）→ 重跑绑定
侧栏「新建任务」→ startNewTaskFromActiveWorkspace：本地无项目 + 活动工作区在场
                → 草稿锚定活动工作区（不调 prepareSession，不铸 draft-* 目录）
草稿首条消息 → createSession(cwd=活动工作区, projectId 未传)
             → reserveCreatedTask：readProjects 精确根匹配 → 命中 → project_id 落值
任务列表侧栏 → 项目分组出现 IDE 工程，新任务在其下
```

## 3. 边界

- 只注册 IDE 打开的 folder（多 root 全部注册）；不为历史目录、草稿 workspace 注册。
- 已存在的未归类任务不回填——归属只发生在任务创建时；存量任务可由用户在侧栏移动
  （`moveTask`）。
- 远端 workspace 不在本 spec 范围（远端继承归属规则既有）。
- 软删工程不参与复用：其 roots 被「删除」后，同根目录重新注册会新建工程（恢复语义
  由 `restoreProjectId` 承担，不经此链路）。

## 4. 验收场景

1. IDE 打开 `/tmp/gode-ui-test` → 重载窗口 → 侧栏「项目」出现 `gode-ui-test` 分组；
2. 「新建任务」发消息 → 任务落在 `gode-ui-test` 分组下（`project_id` 非空）；
3. 桌面端打开已被某工程声明根目录的文件夹新建任务 → 同样归入该工程（本地一致性）；
4. 打开未被任何工程声明的全新目录 → 新建工程并注册，任务归入；
5. 重复重载/重开窗口 → 不产生重复工程（精确根匹配幂等）；
6. 工程 DB 不可写等异常 → 诊断日志可见，聊天面与任务创建不受阻（任务未归类）。
