# Spec: 侧栏任务维度操作的服务解析

本 spec 定义任务列表侧栏（分组区 / 时间线 / 归档区）对**单条任务**发起操作
（归档、删除、重命名、置顶、未读、打开文件树等）时解析目标 workspace 服务的契约。
涉及 `packages/ui/src/lib/workspaceServiceResolver.ts` 与三个
`Workspace*TasksSection` 组件。

## 1. 背景

应用反馈：任务列表里「归档任务失败，删除不了任务」，且 host 侧零日志、无任何报错。

调查结论（代码链路 + 现场证据）：各操作的入口统一是
`workspaceServiceLookup.get(buildTaskWorkspaceKey(task.workspacePath, task.workspaceIdentity))`，
而 lookup 只由 `buildWorkspaceServiceLookup(workspaceTabs, …)` 用**已打开的 workspace
tab** 建条目——任务归属的 workspace 没开 tab（IDE 插件单 tab 场景、桌面关闭 tab 后）
时 `get()` 返回 undefined，各 handler **静默 return**：点击无反应、无错误、无日志。
跨工作区任务区（`project_id IS NULL` 的本地任务，任意 cwd）与归档区按设计会展示
这些未开 tab 的任务，操作必须可用。

## 2. 规则

**统一入口**：任务维度操作一律经 `resolveTaskWorkspaceServices(task, lookup, baseServices)`
解析：

1. lookup 命中（已开 tab）→ 用 tab 解析结果（远端任务 = 远端 session services）；
2. 未命中且任务无 `workspaceIdentity`、`hostId` 为 local/缺省 → 回落
   `baseServices`（与 `resolveWorkspaceServices` 对本地 tab 的回落同源；
   本地任务的服务与 tab 是否打开无关）；
3. 未命中且任务带 `workspaceIdentity` 或 `hostId` 非本地（远端任务）→ **保持 null**：
   远端 session 未恢复时禁止落回本机 services（用本机 sqlite 查远端 workspace 会
   缓存空结果，同 `resolveWorkspaceServices` 的远端防护注释）。

**写者边界不变**（session-management skill §1）：归档/置顶/未读仍走
`zcodeTaskService`（Host 组织态唯一写者）；删除仍走
`taskFacts.mutate(delete)` → CLI 软删除。本 spec 只修「找到正确的服务」，不新增
任何字段的写者。

## 3. 边界

- lookup 的构建方式不变（仍只索引 open tabs）；本规则在消费端兜底。
- `WebRemoteControlTaskIndex`（手机远控）维持原 lookup 语义，不接本规则。
- 时间线对远端 tab 的独立刷新分支（`isRemoteWorkspace` 判定）不受影响。
- **controller 路由守卫**：`mutateProjectTask`/`readProjectTaskMeta`（task-mutation.ts）
  对**纯本地任务**（无 identity / remoteSessionId / sourceServerId）直连
  `ports.service`，不走 `ports.controller`——controller 是
  `RemoteServiceAccess` 无条件构造的频道代理（恒真值），插件 host 不注册
  IWindowControllerService，本地任务写入打空频道 ~1s 拒绝且 host 零日志
  （CDP 自动化实测：toast「归档任务失败」、DB 不动）。桌面 controller 对本地
  地址的解析终点同为本机 task service，直连语义等价；远端/跨 Source 不变。
- **hook 顺序**：`useZCodeSessionService`/`useZCodeAgentService`/`useZCodeTaskService`
  禁止按 `workspacePath` 真值条件调用 hooks——两个 hook 无条件调用后按条件选结果
  （workspacePath 跨渲染翻转时条件分支会造成 hook 顺序错位，React deps 比较器
  读 undefined.length 崩溃，副作用是任意 setState 触发的重渲染报操作失败）。
- **墓碑单调**（skill I14）：tasks-index 所有 upsert（writeRecord 的
  ON CONFLICT UPDATE、ACP 迁移 UPDATE）对 `deleted` 必须取
  `MAX(现有, 新值)`——删除事实只能由明确事件写入，CLI 删除拒绝（busy）后
  存活事实回源不得清除墓碑；回归测试 `taskIndexRepoTombstone.test.ts`。

## 4. 验收场景

1. IDE 插件单 tab（如只打开 /tmp/gode-ui-test）→ 归档/删除属于其它本地 workspace
   的任务 → 操作成功（此前静默无反应）；
2. 桌面关闭某 workspace 的 tab 后，在任务区/归档区归档/删除其任务 → 成功；
3. 远端任务在 session 未恢复时操作 → 仍不可用（不误用本机服务），恢复后可用；
4. 已开 tab 的任务操作行为与此前一致（远端走远端 session，本地走 baseServices）。
