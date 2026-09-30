# Spec: 多端会话准入控制（Multi-client session admission）

本 spec 定义「同一个 workspace 下、同一份 `~/.zcode` 数据被**多个 ZCode 端**（桌面 App、
`zcode --web` 自托管实例、未来的手机远控 Host）同时使用时，如何保证**同一个 session 在任一时刻
只被一个 owner 推进**」的准入规则、状态所有者、失败语义与验收场景。

> 现状（2026-09-30 实测，见 §1）：多端**共库是设计内场景**且不会损坏数据，但**没有任何跨进程
> session 级互斥**。同一个 task 被两个 Agent 同时推进时，会产生**两条并行回复链**。
> 本 spec 只补「准入」这一层，不改动共库与 WAL 策略本身。

## 1. 问题与实测证据

在本机以隔离 workspace 起两个独立实例（`PORT=3131` / `3132`，同一 `ZCODE_SERVER_WORKSPACE`），
两边打开同一 task 并先后提交提示词：

| 时刻 | 事件 |
| --- | --- |
| 12:20:05 | 实例 A 提交提示词，A 的 Agent 开始执行 |
| 12:20:49 | 实例 B 打开同一会话，UI 显示**「已停止」**（此时 A 正在跑） |
| 12:21:02 | B 提交提示词 —— **被成功接受** |
| 12:21:02–12:21:55 | 两个 run 真实重叠 |
| 12:22:44 | 两边都跑完，`tasks-index.sqlite` 的 `task_status='completed'` |

`~/.zcode/cli/db/db.sqlite` 终态（`message.sequence` 0..5，**无重复**）：

```text
user seq=0 (A) ──► assistant seq=1 (step-finish: tool-calls) ──► assistant seq=4 (stop)
user seq=2 (B) ──► assistant seq=3 (step-finish: tool-calls) ──► assistant seq=5 (stop)
```

结论：

- **不损坏**：WAL + 锁等待兜住了写入；无丢 turn、无重复序号、两边均正常收尾。
- **语义被破坏**：一个 session 内出现**两条互不相干的回复链**，靠 `parentID` 分链。对用户而言
  等于「两个人在同一个对话里同时说话」。
- **无互斥的根因**（代码侧）：
  - `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-residency.ts:20-23` 注释：
    「**Prompt admission 的 busy/idle authority 已归 Core**」⇒ busy/idle 是**每进程各自**的视图。
  - `packages/shared/src/zcode-protocol-v4/command.ts:269,275` 的 `session_busy` 只表示
    「会话有活动 turn」，是**单进程内**判定。
  - `packages/desktop/src/host/windowRemoteConnectionRegistry.ts:168-198` 的
    `hasRunningTasks` / `sessionOwnsWorkspace` / `hasOtherWorkspaceOwner` 只覆盖**本窗口内的
    LogicalSession**，看不到另一个进程。
  - `apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/dwf-journal.ts:388-391`
    明确为「WAL 下 zcode 允许多个 Agent 共享同一个库」做了序号竞争防护 ⇒ 共库本身是**有意设计**。

因此本 spec **不引入新的存储引擎**，只在既有共享库上加一层租约，并把准入做在**两个端都会经过的
那一个咽喉**上。

## 1.1 现实用法与优先级修正（重要，先读这节）

**用户的实际用法是「远端在用时本地不操作」。** 在这种用法下，本 spec 的原始动机
（两个 Agent 抢同一个 session）**基本不会发生**，因此**原方案被过度设计了**。修正如下：

### 仍然会咬人的三种情况

「本地不操作」≠「桌面进程不干活」。桌面 App 开着（哪怕没人在碰）时：

1. **离开时任务还在跑**。用户走开前启动的长任务（构建 / 测试 / 长终端）仍在桌面 Agent 上推进；
   此时从远端对**同一个 session** 发指令 → 仍是真实冲突。
2. **cron scheduler 一直在派发**。`packages/desktop/src/scheduler/index.ts` 是常驻进程
   （`POLL_INTERVAL_MS = 20_000`），持续轮询 `tasks-index` 并**认领到期任务派发到本地 host**
   （`packages/desktop/src/main/desktopCronScheduler.ts:2-3`：
   「把 scheduler 的派发请求路由给某个本地 host（转成 CronRun）」）。
   自动化通常是 `createTask + sendPrompt` **新建 task**，不往用户正在看的 session 插话，
   撞车概率低但非零。
3. **`setting.json` 双写**（与准入无关，见 §10.3）。桌面开着 + 远端操作**必然同时发生**，
   且该文件**没有 WAL**。这是本用法下**确定性存在**的问题。

### 由此得出的重新定位

- **互斥（hard exclusion）不是第一优先级**：只在「情况 1」需要，且可以用更轻的
  **状态可见 + 提示** 覆盖大部分价值。
- **真正该先做的是**：
  - **(A) 运行状态跨端可见**：本次实测已证明当前**做不到** —— 实例 B 打开一个正在被 A 运行的
    会话时，UI 显示「**已停止**」。用户远端接管时看不到「那边正在跑」，这才是日常会遇到的坑。
  - **(B) 明确的接管语义**：远端要能继续推进，且知道自己在接管什么。
  - **(C) 硬互斥**：仅作为 (A)(B) 之上的兜底，且**必须只作用于用户发起的输入**（见 §5.1）。

### ⚠ 顺带确认的产品事实

**cron scheduler 只存在于桌面端**：`packages/desktop/src/scheduler/` 由
`desktopCronScheduler.ts:59-65` 以 `electronUtilityProcess.fork` 拉起
（`serviceName: "zcode-cron-scheduler"`），`packages/server/src` 与 `packages/web/src`
**没有任何 scheduler**（已 grep 确认）。⇒ **纯 `zcode --web` 且桌面未开时，自动化与闲时任务
根本不会触发。** 这是产品行为，不是 bug，但需要在文档/UI 上明确。

## 2. 范围

- 作用面：`packages/services/src/session/`（租约表 + 准入）、`zcodeTaskService` 的
  `sendPrompt` / `resumeTask`、`packages/shared` 的 task 行投影字段、
  `packages/ui` 的运行中徽标与输入禁用、`packages/server` 与 `packages/desktop` 的 owner 身份注入。
- **不改动**：
  - `tasks-index.sqlite` 的 WAL / `busy_timeout` / 1 小时锁等待策略
    （`packages/services/src/session/tasksDatabase/startup.ts:28,45,71-77`）。
  - Agent 侧 `db.sqlite` 的写入路径与 `dwf_event` 序号竞争防护。
  - `desktop-continuous` / `web-remote-replayable` 两档投递语义与握手校验。
  - `CommandInbox` 既有的 `in-flight` / `live input` pin 与 512/session LRU 语义。
- **不引入新存储**：租约复用 `tasks-index.sqlite`。

## 3. 状态所有权与事件顺序

```text
session_run_lease（tasks-index.sqlite，唯一租约事实源；由 TaskIndexRepo 承载）
  ├─ claimSessionRun(workspaceKey, taskId, ownerId, ttlMs)   ← 单条 BEGIN IMMEDIATE 事务
  │    1. 回收：DELETE WHERE expires_at <= now
  │               OR (owner_pid 已不存在 AND expires_at <= now + GRACE)
  │    2. 抢占：INSERT ... ON CONFLICT(workspace_key, task_id) DO UPDATE
  │               WHERE owner_id = :ownerId OR expires_at <= :now
  │    3. changes === 0 → { ok:false, holder }
  └─ renewSessionRun / releaseSessionRun（幂等，只允许 owner_id 匹配者）

zcodeTaskService（唯一准入事实源；桌面 Host 与 web server 各自进程内各有一份）
  sendPrompt / resumeTask
    ├─ claimSessionRun(...)  ← 唯一的跨进程闸门
    │    ├─ ok:false → 抛 SessionRunLeaseHeldError(holder)
    │    └─ ok:true  → 继续既有派发（Agent 命令 / 队列 / optimistic overlay）
    ├─ turn 生命周期驱动 renew（step 边界 + 30s 定时兜底）
    └─ turn 终态（completed/failed/cancelled）→ releaseSessionRun

Agent 侧 CommandInbox.guard（加固层，同步、读缓存，非权威）
  guard(envelope)
    ├─ envelope.type ∉ {sendText, resumeWorkflowRun, ...} → allow
    ├─ 本 session 的租约缓存未命中 → allow（fail-open，见 §6）
    └─ 缓存 owner_id ≠ 本端 owner_id → reject { reasonCode: "guard.sessionRunLeaseHeld" }
```

- **owner 身份**：`ownerId = ${ownerKind}:${instanceId}`，`instanceId` 由每个端**启动时**生成
  （`randomBytes`）。`ownerKind ∈ { "desktop-host", "web-server", "bot" }`。
  **不用 pid 做身份**（pid 会复用）；`owner_pid` 仅用于过期回收时快速判定「进程已死」，
  复用 `packages/services/src/bots/channelRuntime.ts:141-152` 的 `isProcessAlive`。
  ⚠ **`clientMode` 不能充当 owner 身份**：它只有 `desktop-continuous` /
  `web-remote-replayable` 两个取值，而自动化派发也用 `desktop-continuous`（见 §5.1）。
  身份必须由**端自己**在启动时生成并贯穿传递，不能从既有参数推断。
- **心跳与 TTL**：`LEASE_TTL_MS = 120_000`（turn 可能长跑），`RENEW_INTERVAL_MS = 30_000`。
  参照量级来自既有 bot 租约 `packages/services/src/bots/channelRuntime.ts:8`
  `BOT_RUNTIME_LOCK_LEASE_MS = 30_000`。
- **幂等键**：`(workspace_key, task_id)`。重复 claim 由同一 owner 发起时是 no-op 更新。
- **stale 规则**：`expires_at <= now` 的租约可被任意端接管，接管时记录 `taken_over_from`，
  并向原 holder 广播（若仍在线）。
- **准入顺序**：`claimSessionRun` 必须发生在**任何** optimistic overlay / 队列写入之前，
  否则被拒绝的输入会留下无法收敛的本地乐观态。

## 4. 数据与协议

1. **新表**（`packages/services/src/session/tasksDatabase/schema-v1.ts` 追加，并加迁移
   `0004_session_run_lease` 到 `migrations.ts:46-72` 的 `definitions`）：

   ```sql
   CREATE TABLE IF NOT EXISTS session_run_lease (
     workspace_key TEXT NOT NULL,
     task_id       TEXT NOT NULL,
     run_id        TEXT NOT NULL,
     owner_id      TEXT NOT NULL,
     owner_kind    TEXT NOT NULL,
     owner_pid     INTEGER,
     owner_label   TEXT,
     acquired_at   INTEGER NOT NULL,
     heartbeat_at  INTEGER NOT NULL,
     expires_at    INTEGER NOT NULL,
     taken_over_from TEXT,
     PRIMARY KEY (workspace_key, task_id)
   );
   CREATE INDEX IF NOT EXISTS idx_session_run_lease_expires
     ON session_run_lease(expires_at);
   ```

   `checksumInput` 必须写入**冻结的 SQL 字面量**，不能引用实时 schema
   （见 `migrations.ts:12` 的既有约束）。

2. **task 行投影**（`packages/shared`）：task 列表项增加
   `runOwner?: { kind: "desktop-host" | "web-server" | "bot"; label?: string; heartbeatAt: number }`。
   可选字段、加值偏斜安全（旧端 parse 丢弃该字段即可，与 `turnHeaderRowSchema.fileChanges`
   既有偏斜档一致）。**不新增 RPC 方法**，随既有 task 列表一起下发。

3. **错误**：`SessionRunLeaseHeldError` 携带 `holder`（含 `kind` / `label` / `heartbeatAt`），
   由 Host 映射为既有 `CommandAck` 的 `reject` + `reasonCode`
   `"guard.sessionRunLeaseHeld"`，`message` 携带可展示文案。

## 5. 两层准入的取舍（必读）

`CommandInbox.guard` 的签名是**同步**的（`command-inbox.ts:32-33`），无法直接读 sqlite。因此：

- **第一层（权威，必做）**：`zcodeTaskService.sendPrompt` / `resumeTask` 内做 async 准入。
  这是桌面 Host 与 web server **都会经过**的同一条路径，且已有 `clientMode`
  （`packages/shared/src/zcode-task-types-core.ts:933`
  `ZCodeTaskClientMode = "desktop-continuous" | "web-remote-replayable"`）、
  `clientId`、`remoteSessionId` 参数可用。
- **第二层（加固，可选）**：`CommandInbox.guard` 读**内存缓存**做二次校验，用于兜住绕过
  service 层的路径（例如未来新增的直连 Agent 通道）。缓存由 Host 在 claim 成功后推给 Agent，
  并按 `RENEW_INTERVAL_MS` 刷新。**注意**：`v4-gateway.ts:632` 目前构造 `CommandInbox` 时
  **没有传 `guard`**，该钩子已声明但未接线，接线本身是这次改动的一部分。

建议按「先做第一层、第二层随后」推进；只做第一层即可覆盖当前两个已知端。

### 5.1 ⚠ 闸门必须只作用于用户输入（否则会误伤定时任务）

**`clientMode` 不能用作 owner 身份，也不能用来区分「用户输入」与「自动化输入」。**
已核实：自动化与闲时任务的派发**同样经过 `zcodeTaskService.sendPrompt`**，且**用的是同一个
`clientMode`**：

- `packages/desktop/src/host/index.ts:639` —— 闲时任务派发
  （上下文含 `offPeakTaskId`、`toolDenylist: ["CronCreate","OffPeakCreate"]`），
  `clientMode: "desktop-continuous"`。
- `packages/desktop/src/host/index.ts:940` —— 自动化「立即运行」派发，同样 `clientMode`。
- `packages/desktop/src/scheduler/index.ts:6` 注释确认链路：
  「scheduler → main → workspace host 执行 **createTask + sendPrompt**」。

⇒ 若把硬闸门无条件放在 `sendPrompt` 上，**远端持有租约时到期的自动化会被拒绝**，
这是一个比原问题更严重的回归。因此：

1. **必须新增显式的来源判别字段**（例如 `origin: "user" | "automation" | "offPeak" | "bot"`，
   或复用既有的 `offPeakTaskId` / automation run 上下文），**不能靠 `clientMode` 猜**。
2. **闸门只对 `origin === "user"` 生效**。自动化/闲时任务按既有语义放行
   （它们本来就有自己的 `claimDue` 认领 + `single-flight` 保护）。
3. 若产品上希望自动化与远端用户输入**互斥**，那是**另一个决策**，需要在 spec 里显式写出
   抢占规则（谁优先、被抢占方如何记录），不能由实现隐式决定。

### 5.2 复用既有认领先例，不要另造一套

`tasks-index.sqlite` **已经有明确的属主方案**：`packages/desktop/src/scheduler/index.ts:2`
注释即写「职责（**tasks-index 属主方案**）」。其认领实现
`AutomationRepo.claimDue`（`packages/services/src/session/automationRepo.ts:750`）
就是跨进程安全的范式：

```sql
SET running = 1, claimed_at = @now, dispatch_status = 'claimed', updated_at = @now
```

—— 单条 `BEGIN IMMEDIATE` 事务内的 `0 → 1` 条件更新，配合
`automation_runs.dispatch_status` 的
`idle → claimed → dispatched / failed_to_dispatch / skipped` 状态机、
`attempts` / `retry_at` 退避，以及 scheduler 重启后的**僵尸回收**兜底。

**本 spec 的 `session_run_lease` 应采用同一形态**（条件 UPDATE + 状态机 + 过期回收），
不要引入与既有认领机制不同构的第二套语义。若实现时发现可以直接复用
`AutomationRepo` 的事务辅助，优先复用。

## 6. 失败语义（需要确认）

| 场景 | 建议行为 | 理由 |
| --- | --- | --- |
| 他人持有效租约 | **fail-closed**：拒绝并提示「该会话正在 <label> 上运行」 | 这正是要防的双写 |
| 租约表读/写失败（存储抖动） | **fail-open** + `warn` 日志 | 避免存储故障让整个应用不可用；退化到当前行为 |
| 租约已过期但 holder 进程仍活 | 允许接管（`taken_over_from` 记录） | TTL 到期即视为放弃；靠 renew 维持 |
| 同一 owner 重复 claim | no-op 成功 | 幂等 |

> 上面「存储抖动 fail-open」是我的建议而非既有约定，落地前需要确认——如果更希望严格一致，
> 可改成 fail-closed 并加显式重试。

## 7. UI 行为

1. task 列表 / 会话头部的「运行中」徽标旁，若 `runOwner.kind` 与当前端不一致，显示
   `正在 <label> 上运行`；`label` 缺省时退化为「另一台设备」。
2. 非本端持有的 running 会话：输入框**保持可编辑但发送按钮禁用**，并在 composer 上方显示
   提示条；不隐藏输入框（避免用户输入丢失的错觉）。
3. 本端持有的会话照常；租约被他人接管时（stale 回收），当前端立即停发并在会话内插入一条
   系统提示（复用既有系统消息投影，不新增行类型）。
4. 所有提示文案走既有 i18n 通道（`packages/ui` 与 `apps/zcode-cli/packages/i18n`）。

## 8. 验收场景

1. **两端并发（本次实测场景）**：A 正在跑 task X，B 打开同一 task X → B 的发送按钮禁用、
   显示「正在 <A 的 label> 上运行」；若强行通过 RPC 发送 → `reject` +
   `guard.sessionRunLeaseHeld`，且 `db.sqlite` 中**不出现第二条回复链**。
2. **正常释放**：A 的 turn 结束 → 租约释放 → B 侧发送按钮在下一个投影周期变为可用，
   可直接续接（复用既有 resume 语义）。
3. **崩溃回收**：A 进程被 `kill -9` → 租约 `expires_at` 到期后 B 可接管，
   `taken_over_from` 记录 A 的 owner_id，B 侧不出现永久禁用。
4. **同端幂等**：同一端连续两次 `sendPrompt` 同一 task → 第二次 claim 为 no-op，
   不产生重复租约行。
5. **多 workspace 隔离**：不同 `workspace_key` 下的 task 互不阻塞。
6. **旧端兼容**：未实现本 spec 的端读写同一库 → 不报错；新端读不到 `runOwner` 字段时
   按「无 owner 信息」渲染，行为回退到现状。
7. **回归**：`pnpm typecheck` 与 `pnpm lint` 通过；`tasks-index.sqlite` 的既有迁移
   （`0001`–`0003`）checksum 不变。
8. **自动化不被误伤（关键回归）**：远端持有某 session 的租约期间，到期的 automation /
   闲时任务**仍能正常派发**（其 `origin !== "user"`，见 §5.1）；派发结果与未实现本 spec 时一致。
9. **状态可见（§1.1 的 (A)）**：远端打开一个正被桌面运行的会话 → 显示「正在 <label> 上运行」，
   而不是当前的「已停止」。

## 9. 迁移与兼容

- 迁移 `0004` 只做 `CREATE TABLE IF NOT EXISTS` + 索引，**不回填**历史数据。
- 无租约行的历史 task 视为「无 owner」，不阻塞任何端。
- 本 spec 不改变任何既有的 `CommandAck` 结构，只新增一个 `reasonCode` 取值。

## 10. 已知缺口与待确认

0. **优先级已被修正**（见 §1.1）。建议的落地顺序是 **(A) 运行状态跨端可见 → (B) 接管语义 →
   (C) 硬互斥**，而不是直接做 (C)。本次实测已证明 (A) 当前不成立（远端把正在运行的会话显示为
   「已停止」），这是日常最可能遇到的问题。
1. **`packages/services/src/session/contract.ts` 不存在**。`architecture-policy.yaml` 把
   `session` 模块的 `publicEntrypoints` 声明为该文件，但检出的源码里没有这个文件。
   若本 spec 需要暴露新的跨模块契约（例如让 `packages/ui` 或 `packages/server` 直接消费
   租约状态），必须**先创建**该公开入口并在 policy 中保持一致；`session` 模块当前
   `managed: false`（legacy），新增契约需要单独确认是否顺带迁到 managed。
2. **`architecture-policy.yaml` 的 `maxFileLines: 400`**：`zcodeTaskService.ts`（25 KB）与
   `taskIndexRepo.ts`（91 KB）已远超该值。新增租约逻辑应放进**新文件**
   （如 `session/sessionRunLeaseRepo.ts`），不要继续堆进这两个文件。
3. **`setting.json` 的双写未覆盖**。本次实测发现 web 实例会写
   `~/.zcode/v2/setting.json`（`recentProjects` / `lastWorkspaceSession` 等）。该文件
   **没有 WAL，只有原子写**，是比 session 更隐蔽的冲突点，且**在「远端用、本地不动」的
   用法下确定性发生**（桌面开着就会写）。本 spec 不处理，需另开 spec。
4. **`packages/desktop/src/host/windowRemoteConnectionRegistry.ts` 的窗口内 owner/lease
   与本次新增的跨进程租约的关系**未定义：窗口内租约负责 Host attachment 生命周期，
   跨进程租约负责 session 推进权。两者职责不重叠，但**都需要在接管/释放时保持一致**，
   实现前需要确认二者的调用顺序。
5. **已存在一个 `sendPrompt` 包装点**：`packages/desktop/src/host/index.ts:1394`
   （`shouldWrapSendPrompt`，用于 running prompt 计数 / realtime port / 附件物化）。
   准入逻辑应**与它协调或并入同一处**，不要在同一对象上再包一层——两层包装会让
   「ACK 不等于 Agent 空闲」（`hostWorkspaceTaskTracker.ts:69`）这类语义更难推理。
6. **自动化与远端用户输入是否需要互斥**是产品决策，本 spec 未定（见 §5.1 第 3 条）。
7. **`zcode --web` 无桌面时自动化/闲时任务不触发**（见 §1.1）。若产品上期望「远端也在跑定时
   任务」，需要把 scheduler 从 `packages/desktop` 抽到可复用的位置——这是独立议题。
