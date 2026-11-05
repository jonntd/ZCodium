# 增量 PRD：zcode-vscode 插件 v0.2.0（协议能力面全量还原 + 对标功能）

> **增量 PRD**：只描述 v0.1.0 基线（commit ddd55712，P0-1..P0-10 已交付）之上的变更。基线见同目录 `prd.md`。
> **范围口径（用户拍板）**："还原 zcodium 的所有功能，加上 Augment/Claude Code 能加的功能；inline 代码补全、代码库索引不要。"
> **UI 策略（用户拍板）**：直接复用 `packages/ui`（`@zcode/ui`：React 组件 + Zustand store，桌面端/Web 端同源），不自建聊天 UI。
> 协议勘察基准：`packages/shared/src/zcode-protocol/index.ts`（`zcodeProtocolMethods` ~90 方法 + `session/create`/`resume` 完整参数面）；CLI 旗标基准：`apps/zcode-cli/packages/cli/src/arguments.ts`。不确定处标 **[待架构师核实]**。

## 0. 前置架构变更（本期的地基，非可选）

### 0.1 依赖策略：推翻"纯协议消费方"

| 变更项 | 旧 | 新 |
|---|---|---|
| 协议类型 | `src/zcodeProtocol/types.ts` 手工同步（曾致 8 处契约漂移 Bug） | **删除 types.ts**，直接 import `@zcode/shared` 的 zod schema 与推导类型 |
| 传输/Agent 层 | 插件内独立实现 spawn 与帧解析 | 复用 `@zcode/services` 的 `zcodeStdioTransport` / `zcodeAgent` / 进程管理 |
| 客户端层 | 自行封装请求/事件 | 必要时复用 `@zcode/client`（边界由架构师裁定，见 Q1） |
| UI 层 | Webview Vanilla JS 自建 | **复用 `@zcode/ui`**（React + Zustand，见 0.2） |
| 架构政策 | 独立消费方登记 | 更新 `architecture-policy` 中 zcode-vscode 模块 `requires`：`@zcode/shared`、`@zcode/services`、`@zcode/ui`（+`@zcode/client` 若采纳）；保持无循环依赖。**用户已接受深度绑定仓库内部模块** |

### 0.2 UI 策略：复用 `@zcode/ui` 的现成对话界面（决策已定，架构师出适配方案，此处只写需求与验收）

1. **postMessage 通信桥**：Webview ↔ extension host 的协议 IO 转发层，把 `@zcode/ui` 期望的服务连接形态适配到 VS Code Webview 消息通道。
2. **IPlatformService 的 VS Code Webview 实现**：`@zcode/ui` 依赖的平台能力（选文件、打开 diff 等）经 extension host 代理到 VS Code 原生 API。
3. **打包**：React + `@zcode/ui` 打进 Webview bundle；主题跟随 VS Code（Dark/Light/High Contrast 映射），i18n 跟随 VS Code locale。
4. **风险声明（不推翻决策，仅登记评估项）**：若 `@zcode/ui` 存在无法在 Webview 沙箱满足的硬依赖（如 `window.zcode` 直访、Electron/Tauri 专有 API、Desktop 专有组件如 `DesktopWindowControls`），由架构师逐项列出并给替代方案（mock/shim/条件渲染裁剪）。

## 1. 项目信息

- **Language**：简体中文
- **Programming Language**：TypeScript + esbuild；Webview = React + `@zcode/ui`（复用）
- **Project Name**：`zcodium_vscode_extension_p1`
- **排除项**：inline 代码补全、代码库索引（需改 zcode-cli 运行时，下期）

## 2. 产品目标（增量）

1. **G4 — 会话可管理**：历史会话浏览/切换/移除、跨根工作区隔离、崩溃自动重建、Claude Code 历史一键导入。
2. **G5 — 上下文触手可及**：@ 引用、选区、编辑器诊断零摩擦注入对话。
3. **G6 — 能力面全量可配**：allowlist/denylist、MCP、模型/模式/思考深度、自定义指令、附加目录——协议支持的参数都有对应 UI/设置。
4. **G7 — 同源 UI**：插件复用桌面端 `@zcode/ui`，功能与体验随主产品同步演进，插件侧 UI 定制代码趋近于零。

## 3. 能力面还原矩阵

> 档位：**A** = 核心高频，本期必须；**A+** = 协议现成且低成本，本期一并实现；**B** = 协议现成但 UI 工程量大，下期优先；**✕** = 不做/需运行时扩展。

### 3.1 会话生命周期

| 协议方法/参数 | 插件功能 | 状态标注 | 档 |
|---|---|---|---|
| `session/list`、`session/read`、`session/messages`、`session/subscribe`、`session/resume`、`session/close` | 历史会话列表、切换、回放（P1-1）。**删除无协议方法**（无 session/delete/archive；close 仅关运行时）→ 降级：插件侧移除引用，文案"从列表移除"；CLI 真删除入口 [待架构师核实] | ✅ 有现成方法（删除除外） | A |
| `session/create.workspace` | 多根工作区 folder 选择器（P1-2） | ✅ 现成 | A |
| `session/create.model` + `session/setModel` | 会话内模型切换 | ✅ 现成（v4 收敛形态 [待架构师核实]） | A+ |
| `session/create.mode` + `session/setMode`；`thoughtLevel` + `session/setThoughtLevel` | 会话模式 / 思考深度选择 | ✅ 现成 | A+ |
| `session/compact` | 长会话压缩上下文按钮 | ✅ 现成 | A+ |
| `session/goal`、`session/stop`、`session/cancelBackgroundTask` | 目标卡 / 停止 / 取消后台任务 | stop 基线已覆盖；goal/cancelBackgroundTask v4 化中 [待架构师核实] | A+ |
| `session/fork` | 消息分叉 | ⚠ 客户端链已删、op 留存供 v4 钩子 → 本期不做 | B |
| `session/debug` | 调试通道 | ✕ 运维向 | ✕ |
| `session/subagents`（含 revision/running/ended 投影） | 子代理运行面板（Claude Code Task 可视化对标） | ✅ 现成 | A+ |

### 3.2 历史导入（亮点功能）

| 协议 | 插件功能 | 状态标注 | 档 |
|---|---|---|---|
| `session/create.importedHistory`（`source:"claudeCode"`，title/createdAt/messages[]） | **导入 Claude Code 本地历史**：读取 `~/.claude/projects/<project>/*.jsonl` → 映射 `zcodeSessionImportMessageSchema[]` → `session/create` 建导入会话；命令面板 + 会话列表入口 | ✅ 协议现成；jsonl 字段映射规范 [待架构师核对 schema] | A+ |
| 同上 `source:"sharedContext"` | 分享上下文导入 | ✅ 现成，依赖分享产物 | B |

### 3.3 会话配置面（create/resume 参数，全部协议现成）

| 协议参数 | 插件功能 | 状态标注 | 档 |
|---|---|---|---|
| `toolAllowlist` / `toolDenylist`（create+resume；resume 不带会绕过约束） | 权限 allowlist 持久化（P1-3）：settings 存规则，create/resume 携带；对应 CLI `--disallowed-tools` 旗标 | ✅ 现成 | A |
| `mcpServers`（create+resume）+ `mcp/list`（mode: connect/status） | MCP 配置 UI + 状态列表（P1-8）。**局限**：无 mcp/add|remove，运行中动态增删不可行 → 改动后重建会话生效 | ✅ 现成（含局限） | A |
| `additionalDirectories`（max 256） | 附加可访问目录设置 | ✅ 现成 | A+ |
| `persistence`、`titleGenerationEnabled`、`parentSessionId`、`offPeakToolEnabled`、`dynamicWorkflowEnabled/Mode` | 持久化/标题生成开关、灰度门禁透传 | host 裁决下发，默认策略 [待架构师核实] | B |

### 3.4 Workspace 偏好（对标 CLAUDE.md 项目记忆）

| 协议方法 | 插件功能 | 状态标注 | 档 |
|---|---|---|---|
| `workspace/updateSystemPrompt`（空串=恢复默认）、`workspace/updateSystemSegments` | 自定义指令（项目记忆）：设置页按 workspace 配置 | ✅ 现成。运行时是否自动读仓库规则文件（CLAUDE.md/ZCODIUM.md）[待架构师核实] | A |
| `workspace/updateLanguagePreference` | 回复语言偏好 | ✅ 现成 | A+ |
| `workspace/updateDeleteProtectionPreferences` | 删除保护 + 批量删除审批阈值 | ✅ 现成 | A+ |
| `workspace/updateInteractionPreferences`、`updateModelIoPreferences`、`updateOffPeakToolPolicy`、`updateDynamicWorkflowPolicy`、`workspace/hooks/trustGrant` | 交互/IO/灰度偏好、hooks 信任 | ✅ 现成 | B |
| `workspace/readPresentation`、`workspace/generateText` | 投影/文本生成（services 内部消费） | ✕ 非插件面 | ✕ |

### 3.5 MCP / 插件生态 / 工作流 / 自动化（完整覆盖档）

| 协议方法族 | 插件功能 | 状态标注 | 档 |
|---|---|---|---|
| `mcpUi*`（15 方法：resources/sampling/appTools/ui instance） | MCP Apps 富交互界面 | ✅ 现成但工程量大（需 Webview 承载 MCP UI 实例） | B |
| `plugins/*`（list/overview/install/uninstall/update/marketplace/configure/setEnabled 等）、`skills/referenceCatalog` | 插件/技能管理 UI | ✅ 现成 | B |
| `workflows/*`（list/get/save/delete/runs/move/forRun） | 已保存工作流管理 | ✅ 现成 | B |
| `automation/*`、`offPeak/*` | 定时任务/闲时任务 | ✅ 现成 | B |
| `provider/updateAccountConfig`、`refreshRegistry`、`testModelConnectivity` | 账户/端点配置与连通性测试 | ✅ 现成（基线走 CLI 配置） | B |
| `interaction/browserList`、`interactionBrowserExecute` | browser-use 宿主执行器 | ⚠ 仅 CLI 旗标（`--browser-use`/`--browser-executable`）+ 反向请求方法；**需插件实现 CDP executor，属运行时扩展级工程** → 本期不做，UI 预留开关位 | ✕（下期评估） |
| `interaction/requestUserInput` | Agent 反向提问表单（`@zcode/ui` 已有 `ElicitationDialog` 对应组件） | ✅ 现成，随 UI 复用低成本落地，随 P1-9 验收 | A+ |
| `process/childProcesses`、`networkCapture`、`resourceSample` | 资源监控 | ✅ 现成 | B |
| `runtime/capabilities` | 特性探测，驱动 UI 显隐 | ✅ 现成，作为横切机制本期即用 | A |
| `bot/channel/reply`、`topic/resource/*` | 机器人通道 | ✕ 与编辑器场景无关 | ✕ |

### 3.6 用量

| 协议 | 插件功能 | 状态标注 | 档 |
|---|---|---|---|
| `turn.completed` 事件自带 `usage` + `cacheStats`（schema 行 1596-1602 已修） | 每轮 token 用量 + 缓存命中展示（P1-7） | ✅ 现成 | A |
| v4 conversation/usage（`session/usage`、`usage/stats` 已 @deprecated） | 会话累计用量 | ✅ 现成（v4 方法名 [待架构师核实]） | A+ |

## 4. 用户故事

1. 作为**开发者**，我想在侧边栏浏览/切换/移除历史会话，以便多任务来回工作不丢上下文。
2. 作为**多仓库开发者**，我想为每个 workspace folder 建独立会话并快速切换，以便 Agent 不改错项目。
3. 作为**开发者**，我想把 `git status` 类只读命令配置成持久 allowlist，以便安全操作不再反复弹审批。
4. 作为**开发者**，我想输入 `@` 引用文件/选区直接发送，以便不用复制粘贴上下文。
5. 作为**开发者**，我看到编辑器报错想一键把诊断发给 Agent，以便快速修复。
6. 作为**开发者**，Agent 崩溃重启后我想自动回到原会话，以便长任务不中断。
7. 作为**开发者**，我想看到每轮 token 用量与缓存命中，以便了解成本。
8. 作为**进阶用户**，我想在 UI 配置 MCP 服务器并查看连接状态，以便扩展 Agent 能力。
9. 作为**从 Claude Code 迁移的用户**，我想把本地 Claude Code 历史导入 zcodium 会话，以便无缝切换工具。
10. 作为**团队用户**，我想为每个项目配置自定义指令（项目记忆）与回复语言，以便 Agent 遵守团队规范。
11. 作为**初次使用者**，我想在 README 与首次引导中看懂功能与安装步骤，以便快速上手。
12. 作为**插件用户**，我希望插件界面与桌面端 zcodium 长得一样、行为一致，以便零学习成本。

## 5. 功能点验收标准

### P1-1 历史会话列表与切换/移除 ①【A】
1. 侧边栏展示 `session/list` 会话（标题、状态、最近活动），按最近活动排序；失败时降级为 globalState ID 列表（无标题元数据，UI 不崩）。
2. 点击会话 → `session/resume` + `session/messages`/`session/subscribe` 回放，显示"已恢复"。
3. turn 进行中禁止切换（禁用+提示）。
4. "移除"有二次确认；移除活跃会话先 stop+close 再删引用；文案明确"从列表移除，本地会话数据保留"。
5. globalState 记录最近会话 ID，窗口重开默认恢复（衔接 P1-6）。

### P1-2 多根工作区 folder 选择器 ②【A】
1. 多根工作区显示 folder QuickPick；单根不显示。
2. 新建会话自动携带所选 folder 的 workspace 路径；会话列表标注归属 folder。
3. 切换 folder = 切到该 folder 最近会话或新建（复用 P1-1 机制）。
4. 设计决策：**每 folder 独立会话**（不采用单会话换 folder，避免上下文污染）。

### P1-3 权限 allowlist/denylist 持久化 ③【A】
1. 设置项：`zcodium.permissions.allowlist` / `denylist`（数组，支持 `Tool` 与 `Tool(args)` 规则，与 CLI `--disallowed-tools` 归一化规则一致）。
2. create/resume 时携带两列表；resume 必须带上（协议注释：不带会绕过 allow/deny）。
3. P0-8 审批卡的"本次会话允许"可选择性写入工作区级 allowlist（保存前确认）。

### P1-4 @selection/@file/@symbol 上下文引用 ④【A】
1. 输入 `@` 触发文件补全（基于 VS Code workspace 文件索引，不建本地索引）。
2. 编辑器有选区时输入框上方出现"附带选中代码 (文件名 Lx-Ly)"chip，发送时注入。
3. `@symbol`：**降级口径**——协议/运行时无符号索引能力 [待架构师核实]，本期降级为 `@file`/`@selection`；若勘察发现 LSP 零成本接入再升级。
4. 引用以纯文本标记 + 附件载荷（`session/send` attachments 面）注入，格式由架构师定。

### P1-5 诊断错误一键发送 ⑤【A】
- **[协议初判：无需协议方法]** 协议无诊断注入方法（`zcodePluginDiagnosticSchema` 为插件包诊断，无关）；纯插件侧编辑器集成。
1. 消息输入框/命令面板提供"发送当前文件诊断"：收集 Problems 面板当前文件错误+警告，格式化（文件/行/消息/severity/相关代码行）注入消息。
2. 支持"仅错误"与"错误+警告"两种范围；无诊断时按钮禁用。

### P1-6 崩溃重启后会话重建 ⑥【A】
1. 进程崩溃自动重启（基线已有）后，自动 `session/resume` 最近活跃会话并回放消息，UI 横幅提示"Agent 已重启，会话已恢复"。
2. resume 失败（会话损坏）时降级：提示新建会话，保留历史可从列表重新进入。
3. resume 时沿用原会话的 mcpServers/toolAllowlist/toolDenylist/thoughtLevel（协议注释明确冷恢复必须沿用工具面约束）。

### P1-7 Token 用量展示 ⑦【A】
- **[协议初判：✅ 现成]** `turn.completed` 自带 `usage` + `cacheStats`。
1. 每轮 turn 完成后消息流尾部显示用量行（输入/输出/缓存命中），可折叠。
2. 会话头部显示累计用量（经 v4 conversation/usage 或本地累加，路径由架构师定）。

### P1-8 MCP 管理 ⑧【A】
- **[协议初判：✅ 有现成方法]** `session/create`/`resume` 的 `mcpServers` 参数 + `mcp/list`（mode connect/status）。
1. 设置页 CRUD MCP 服务器（stdio/http，字段对齐 `zcodeProtocolMcpServerSchema`），持久化到 settings（工作区级）。
2. 会话头部/设置页展示 `mcp/list` 状态（已连接/失败/工具数），提供手动刷新。
3. **局限声明（写入 UI）**：运行中动态增删不支持；改动保存后提示"将在下次会话/重启会话后生效"。
4. `mcpUi*` 富交互族不在本期（档 B）。

### P1-9 Webview 复用 `@zcode/ui` ⑨【A·决策已定】
1. Webview 渲染 `@zcode/ui` 对话界面（React + Zustand store），消息流/时间线/审批卡与桌面端同源；基线自建 Vanilla UI 退役。
2. postMessage 桥完成协议 IO 转发：`@zcode/ui` 期望的服务连接形态 ↔ extension host ↔ `zcodeAgent`；桥上消息经 `@zcode/shared` schema 校验（杜绝回归手工类型漂移）。
3. `IPlatformService` VS Code 实现：选文件（QuickPick）、打开 diff、打开文件、通知等平台能力经宿主代理；无法代理的能力在 shim 层返回"不支持"而非抛错。
4. 主题跟随 VS Code（Dark/Light/HC 映射）；i18n 跟随 VS Code locale。
5. **沙箱硬依赖排查交付物**：架构师输出 `@zcode/ui` 在 Webview 沙箱不可满足依赖清单（如 `window.zcode` 直访、Electron/Tauri API、Desktop 专有组件）+ 每项的 shim/裁剪方案；插件按清单实现。**该项结论不推翻复用决策。**
6. CSP：仅允许 Webview 资源目录与 nonce 内联，外部资源禁止。
7. 基线功能（P0-1..P0-10 全部交互）在复用 UI 后等价回归通过。

### P1-10 会话内引导与文档 ⑩【A】
1. README 补全：安装、CLI 探测、功能总览（含本期新能力）、FAQ、与桌面端/CLI 的关系说明。
2. 首次打开侧边栏的 onboarding：CLI 缺失引导（基线已有）+ 新增"3 步上手"卡片与 Claude Code 历史导入引导（检测到 `~/.claude` 时提示可导入）。
3. `runtime/capabilities` 标记为不可用的功能在 UI 中隐藏或标注"当前 CLI 版本不支持"。

### P1-11 模型 / 模式 / 思考深度切换【A+】
1. 会话头部下拉：模型（`session/setModel`）、模式（`session/setMode`）、思考深度（`session/setThoughtLevel`）；新建会话时 create 参数同步。
2. 切换即时生效并在消息流插入系统提示行；失败回滚 UI。

### P1-12 Claude Code 历史导入【A+】
1. 命令面板 + 会话列表"导入 Claude Code 会话"：列出 `~/.claude/projects/` 下项目与会话文件（标题+时间+条数预览）。
2. 导入 = 解析 jsonl → `zcodeSessionImportMessageSchema[]` → `session/create(importedHistory:{source:"claudeCode",...})`，完成后打开新会话。
3. 解析失败/超大文件（协议 attachmentMaxBytes 上限）给出可读错误；导入不删除原文件。

### P1-13 自定义指令与语言偏好（项目记忆）【A】
1. workspace 级设置页：自定义系统提示词（`workspace/updateSystemPrompt`，空=恢复默认）、分段提示词（`updateSystemSegments`）、回复语言（`updateLanguagePreference`）。
2. 若运行时支持自动读取仓库规则文件 [待架构师核实]：增加"从 CLAUDE.md/ZCODIUM.md 同步"按钮；不支持则仅 UI 配置并在文档说明差异。

### P1-14 会话压缩【A+】
1. 会话菜单"压缩上下文" → `session/compact`；执行中显示进度，完成后消息流显示压缩摘要行。

### P1-15 子代理面板【A+】
1. turn 内 Agent 派生子代理时，时间线展示子代理卡片（名称/状态：running/waiting/blocked/ended）；点开看 `session/subagents` 的 running/ended 列表。

### P1-16 会话创建参数补全【A+】
1. 设置页补齐 `additionalDirectories`（目录选择，≤256）；删除保护开关与批量删除阈值（`updateDeleteProtectionPreferences`）。
2. `interaction/requestUserInput` 经 `@zcode/ui` 的 ElicitationDialog 渲染为 Webview 内联表单（随 P1-9 验收）。

### 档 B（下期优先，不在本期 DoD）
plugins/skills 管理界面、workflows 管理、automation/offPeak、mcpUi 富交互、provider 账户配置与连通性测试、process 资源监控、session/fork、sharedContext 导入、browser-use 宿主执行器。

## 6. UI 增量（复用 `@zcode/ui` 后的入口/布局差异）

不再是"从零设计聊天 UI"，基线 7.1 的 ASCII 稿中的消息流/时间线/diff 审批/命令审批**全部由 `@zcode/ui` 同源组件承载**。插件侧增量是**入口与装配**：

```
┌ Activity Bar ──────────┐  ┌ 侧边栏 Webview（@zcode/ui 装配）────────────┐
│ [ZCodium 图标]          │  │ ┌ 顶栏：会话切换 ▾ │ folder ▾ │ 模型 ▾ ┐   │
└────────────────────────┘  │ │        mode/thoughtLevel ▾ │ 用量 Σ │      │
┌ 命令面板新增 ────────────┐  │ ├ 消息流（@zcode/ui 同源：流式/推理折叠/     │   │
│ ZCodium: 导入 Claude     │  │ │ 时间线/子代理卡/用量行/审批卡）            │   │
│   Code 会话…            │  │ ├ MCP 状态条：● 2 connected  [管理]         │   │
│ ZCodium: 发送当前文件诊断 │  │ ├ @ 引用 chips 行（@file/@selection）        │   │
│ ZCodium: 压缩上下文      │  │ └ 输入框（@zcode/ui composer）[发送] ┘      │   │
└────────────────────────┘  └────────────────────────────────────────────┘
┌ 设置贡献点（settings UI）────────────────────────────────────────────┐
│ zcodium.permissions.allowlist / denylist / mcp.servers /             │
│ zcodium.context.additionalDirectories / zcodium.session.* /          │
│ workspace 自定义指令 & 语言（写穿 workspace/update* 方法）              │
└──────────────────────────────────────────────────────────────────────┘
```

布局差异说明：
1. 顶栏聚合会话/folder/模型/模式切换与用量入口（`@zcode/ui` 顶栏组件适配 Webview 窄幅）。
2. 平台差异组件（Desktop 窗口控制等）按 P1-9 排查清单裁剪；`IPlatformService` 差异行为（diff 用 VS Code 原生 diff 编辑器，不用 `@zcode/ui` 内嵌 diff 时）在 shim 层路由。
3. MCP 管理与自定义指令进入 VS Code settings UI + 设置 Webview 页（复用 `@zcode/ui` 表单组件），不新造设计。

## 7. 待确认问题（Open Questions，≤4）

1. **打包与依赖边界**：`@zcode/shared`/`@zcode/services`/`@zcode/client`/`@zcode/ui` 四包进 extension host bundle 与 Webview bundle 的策略（bundle vs external、.vsix 体积）、`@zcode/client` 取用边界，及 `@zcode/ui` Webview 沙箱硬依赖清单与 shim 方案（P1-9.5 交付物）。
2. **v4 vs legacy 方法面**：`setModel`/`setMode`/goal/cancelBackgroundTask/usage/fork 均在 v4 收敛中，插件经 `zcodeAgent` 消费时应走 legacy 方法还是 v4 命令？v4 命令契约位置在哪（决定 P1-11/P1-7 实现路径）。
3. **项目规则文件**：zcode-cli 运行时是否自动读取仓库内规则文件（CLAUDE.md/ZCODIUM.md 类）？决定 P1-13 是"从文件同步"还是纯设置面。
4. **会话真删除与导入规范**：CLI 是否有会话删除运维入口（决定 P1-1 是否补真删除）；Claude Code jsonl → `zcodeSessionImportMessageSchema` 的字段映射规范（决定 P1-12 解析器规格）。

## 8. 验收标准（Definition of Done）

1. **架构**：`types.ts` 删除无残留；`architecture-policy` 登记 requires 通过；桥上消息全部经 `@zcode/shared` schema 校验；沙箱硬依赖清单 + shim 方案文档交付。
2. **端到端场景**（装有 zcodium CLI 的机器装 .vsix）：
   - 多根工作区选 folder 建会话 → 对话 → diff/命令审批 → 切换到另一历史会话并回放 → 移除旧会话。
   - 手动 kill Agent 进程 → 自动重启 → 自动 resume 回到原会话上下文（含 allowlist/MCP 沿用）。
   - 配置 allowlist 后 `git status` 类命令不再弹审批；denylist 工具被拒。
   - `@` 引用文件 + 选区 + 一键诊断发送 → Agent 回复正确引用了上下文。
   - 配置 MCP 服务器 → 新会话 mcp/list 显示已连接；修改配置提示需重建会话。
   - 模型/模式/思考深度会话内切换生效；长会话执行 compact 成功。
   - 导入一份真实 Claude Code jsonl 历史 → 新会话可继续对话。
   - 自定义指令设置后新 turn 生效（Agent 遵守）；回复语言偏好生效。
   - 每轮 turn 显示 token 用量与缓存命中。
   - 基线 P0-1..P0-10 全部交互在新 UI 上等价回归通过。
3. **范围红线**：未实现 inline 补全与代码库索引（显式不做）；档 B 功能不在本期交付但在矩阵中留档。
4. **质量**：vitest 覆盖桥层校验、会话状态机、resume 重建路径、jsonl 导入解析；`runtime/capabilities` 不支持的功能有降级 UI。
