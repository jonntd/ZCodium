# PRD：ZCodium VS Code AI 编程助手插件（codium-vscode）

## 1. 项目信息

- **Language**: 简体中文
- **Programming Language**: TypeScript + esbuild（与主仓库一致）；扩展 UI 采用 VS Code Webview（Vanilla JS/TS，不引入 React 以控制包体积；如团队偏好可换 Vite + React 构建 Webview 前端，P2 再议）
- **Project Name**: `zcodium_vscode_extension`
- **原始需求复述**: 基于当前工程（ZCodium monorepo）的代码结构与技术栈，开发一个类似 Augment / Claude Code 的 VS Code AI 编程助手插件。

## 2. 架构前提与分发形态假设（必须遵守）

1. **独立消费方**：插件是独立 VS Code 扩展包（.vsix），**不深度导入 ZCodium 仓库内部模块**，仅通过 `zcodium app-server --stdio` 的 stdout/stdin 与 Agent 运行时交互（ZCode Protocol JSON 帧）。协议 schema 以 `packages/shared/src/zcode-protocol/index.ts` 为唯一契约参考。
2. **分发形态**：.vsix 独立扩展（MVP 阶段不发布 Marketplace，先本地/内部分发）。用户本机需已安装 `zcodium` CLI；插件提供：
   - CLI 路径配置项（settings: `zcodium.cliPath`，默认探测 PATH 中的 `zcodium`）；
   - 未检测到 CLI 时在欢迎页引导安装（展示安装命令文档链接）。
3. **模型自由由运行时承担**：插件不实现任何模型调用，模型/端点选择通过协议参数（`model`）透传给 Agent。

## 3. 竞品参照与对标取舍

| 维度 | Augment | Claude Code | 本插件取舍 |
|---|---|---|---|
| 代码补全（inline completion） | ✅ 核心能力 | ❌ | **P2，MVP 不做**。补全需要独立的高频低延迟通道，与协议服务器模式不匹配 |
| 代码库上下文索引 | ✅ 核心能力 | 间接（读文件） | **P1**。先依赖 Agent 自身的文件读取能力，后续再评估是否需要本地索引 |
| 对话式任务下发 | ✅ | ✅ | **P0**，核心入口 |
| Agentic 文件编辑 + diff 审批 | 有限 | ✅ 核心体验 | **P0**，对齐 Claude Code 的审批流体验 |
| 终端命令执行 + 审批 | ❌ | ✅ | **P0**（展示与审批），执行由 Agent 侧完成 |
| 会话恢复/历史 | ✅ | ✅ | **P1**（MVP 先做单会话内恢复，跨窗口恢复 P1） |
| 权限分级（自动/询问/拒绝） | ❌ | ✅ | **P0 基础版**（询问+允许一次/本次会话/拒绝），细化分级 P1 |

**结论**：对标 Claude Code 的 agentic 工作流（对话 → 流式回复 → 工具执行 → diff/命令审批），不做 Augment 的补全与索引（P2 再议）。

## 4. 产品目标（Product Goals）

1. **G1 — 零门槛接入**：VS Code 用户安装 .vsix + 配置 CLI 路径后，5 分钟内可在编辑器内完成一次"对话式编码任务 → 查看 diff → 审批应用"闭环。
2. **G2 — 信任可控**：所有文件写入与终端命令在执行前可见、可审批、可拒绝，审批交互不阻塞用户继续阅读代码。
3. **G3 — 协议解耦**：插件仅依赖 ZCode Protocol JSON 帧契约，Agent 运行时升级不影响插件核心逻辑；协议版本不匹配时给出明确错误提示。

## 5. 用户故事（User Stories）

1. 作为**开发者**，我想在 VS Code 侧边栏用自然语言下发编码任务（"给 utils/date.ts 补测试"），以便不离开编辑器完成开发。
2. 作为**开发者**，我想实时看到回复文本流与推理过程（可折叠），以便了解 AI 的思路并随时纠正方向。
3. 作为**开发者**，当 Agent 要修改文件时，我想看到逐文件 diff 并选择"应用 / 拒绝"，以便保护我的代码不被误改。
4. 作为**开发者**，当 Agent 要执行终端命令时，我想先看到完整命令并审批，以便防止危险操作。
5. 作为**开发者**，我想在重开 VS Code 后恢复上一次会话继续对话，以便跨天延续任务。
6. 作为**多仓库开发者**，我在多根工作区（multi-root workspace）中想让 Agent 明确针对某个 workspace folder 操作，以便它不会改错项目。
7. 作为**初次使用者**，未安装 CLI 时我想看到清晰的安装引导而非报错堆栈，以便顺利上手。

## 6. 需求池（Requirements Pool）

### P0 — MVP 必须

| ID | 需求 | 说明 |
|---|---|---|
| P0-1 | 扩展激活与 CLI 探测 | 激活时探测 `zcodium` CLI（settings 路径优先），未找到则展示欢迎/引导页 |
| P0-2 | Agent 进程生命周期管理 | 以 `zcodium app-server --stdio` 启动子进程；stdout 帧解析、stderr 收集、stdin EOF 视为正常退出；崩溃自动重启（带退避），状态显示在状态栏 |
| P0-3 | 会话创建 | 通过 `zcodeSessionCreateParamsSchema` 创建会话，携带 workspace 路径、mode、model；多根工作区时每个 workspace folder 建独立会话或以参数区分子任务（实现取其一，见 Open Questions） |
| P0-4 | 侧边栏聊天 Webview | 输入框 + 消息流；发送用户指令、渲染 `model.streaming` 的 text_delta |
| P0-5 | 流式回复与推理过程 | text_delta 实时渲染；reasoning_delta 折叠显示（"显示思考过程"开关） |
| P0-6 | 工具执行可视化 | 渲染 `tool.updated`（scheduled/started/progress/result）为任务时间线 |
| P0-7 | 文件 diff 审批 | Agent 提议文件修改时，VS Code 原生 diff 视图展示"当前 vs 提议"，Webview 内提供 应用/拒绝 按钮；通过 `permission.requested` / `permission.resolved` 应答 |
| P0-8 | 终端命令审批 | 命令执行前在 Webview 展示命令全文，允许 允许一次 / 本次会话允许 / 拒绝 |
| P0-9 | turn 生命周期与错误呈现 | `turn.started/completed/failed` 驱动 UI 状态（进行中/完成/失败）；失败展示可读错误与重试按钮 |
| P0-10 | 协议版本守卫 | 握手时校验协议版本，不匹配时给出升级指引而非静默失败 |

### P1 — Should have

| ID | 需求 |
|---|---|
| P1-1 | 会话持久化与恢复：保存会话 ID 与上下文，重开窗口后恢复 |
| P1-2 | 会话历史列表：侧栏切换/新建/删除历史会话 |
| P1-3 | 多工作区增强：workspace folder 选择器，@folder 引用语法 |
| P1-4 | 权限分级设置：全局 allowlist 配置（如允许 `git status` 类只读命令自动执行），映射协议 `toolAllowlist` |
| P1-5 | 选中代码作为上下文：编辑器选区一键发送（@selection） |
| P1-6 | 内联引用：@file / @symbol 快捷引用，基于工作区文件搜索（不建索引） |
| P1-7 | 诊断联动：把 VS Code 诊断错误作为上下文一键发送 |
| P1-8 | 断线恢复：进程重启后自动重建会话并回放最近事件 |

### P2 — Nice to have

| ID | 需求 |
|---|---|
| P2-1 | 内联代码补全（inline completion），需评估协议支持与延迟 |
| P2-2 | 代码库索引/上下文检索增强 |
| P2-3 | Marketplace 发布 + CI 打包流水线 |
| P2-4 | MCP 服务器管理 UI（协议已支持 mcpServers 参数） |
| P2-5 | Webview 前端迁移 Vite + React，提升可维护性 |
| P2-6 | 成本/Token 用量展示 |

## 7. UI 设计稿（文字 + ASCII）

### 7.1 侧边栏聊天面板（Activity Bar 图标 → Webview Panel，主侧栏）

```
┌──────────────────────────────────────────┐
│ ZCodium Agent          [状态: ●运行中] ▾ │  ← 顶部：Agent 状态 + 会话切换
├──────────────────────────────────────────┤
│ ▾ 会话: main (workspace: zcodium)        │  ← 会话/工作区标识
├──────────────────────────────────────────┤
│ You: 给 utils/date.ts 补单元测试          │
│                                          │
│ Agent: 好的，我先查看现有代码…            │
│ ┌ ▸ 显示思考过程 (reasoning) ───────────┐│  ← 折叠的推理流
│ └──────────────────────────────────────┘│
│ ● 读取 utils/date.ts            完成     │  ← 工具时间线
│ ● 提议修改 utils/date.test.ts   待审批 ⚠ │
│ ┌──────────────────────────────────────┐│
│ │ diff 预览摘要: +48 -2                 ││  ← 点击打开 diff 视图
│ │ [打开 Diff]  [✓ 应用]  [✕ 拒绝]      ││
│ └──────────────────────────────────────┘│
│ ● 执行命令 npm test              待审批 ⚠ │
│ │ $ npm test                           ││
│ │ [✓ 允许一次] [✓ 本次会话允许] [✕ 拒绝]││
├──────────────────────────────────────────┤
│ > 输入任务…                    [发送 ➤]  │  ← 底部输入框
└──────────────────────────────────────────┘
```

### 7.2 Diff 审批交互

- Agent 提议写文件 → 扩展在编辑器组打开 **VS Code 原生 diff 编辑器**（left: 磁盘当前内容，right: 提议内容，标题栏 `[待审批] file.ts`）。
- diff 编辑器顶部命令条叠加操作按钮：`✓ 应用`、`✕ 拒绝`、`⤢ 查看全部变更`（多文件时列出全部待审批 diff）。
- 应用 = 通过协议应答 permission → Agent 写入文件 → diff 视图自动关闭并提示；拒绝 = 回复 resolved(rejected)，Agent 收到拒绝后继续对话说明替代方案。
- 多文件变更时在 Webview 中聚合为"变更清单"卡片，逐文件或一键全部审批。

### 7.3 权限确认交互

- **非阻塞策略**：审批请求以 Webview 内联卡片 + 状态栏角标（⚠ 1）呈现，不使用模态弹窗打断阅读；紧急/危险命令（写入系统路径、rm 类）升级为 VS Code 警告对话框。
- 卡片内容：工具类型、目标（文件路径/命令全文）、影响摘要；操作按钮：允许一次 / 本次会话允许 / 拒绝。
- 超时策略：turn 结束仍未应答的请求自动标记为待处理，恢复会话后重新呈现。

### 7.4 错误/引导页

- CLI 未安装：欢迎页展示安装命令 + 文档链接 + "重新检测"按钮。
- 进程崩溃：状态栏变红 + Webview 顶部横幅（错误摘要 + "重启 Agent"）。

## 8. 技术规范要点（给架构师的约束）

- 扩展使用 esbuild 打包为单文件 `extension.js`；Webview 资源独立目录，CSP 限制本地资源。
- 帧解析/传输层参考 `packages/services/src/zcode-agent/zcodeStdioTransport.ts` 的行为语义（逐行 JSON 帧、stderr 缓冲、EOF 正常退出），但**代码独立实现**于插件仓库/模块内，不 import 主仓库源码。
- 遵守 architecture-policy：插件作为独立模块登记，公开入口 `contract.ts`，禁止与主仓库形成循环依赖。
- 测试：vitest 覆盖帧解析、会话状态机、审批流状态机（模拟 stdio 双端）。

## 9. 待确认问题（Open Questions）

1. **多根工作区策略**：每个 workspace folder 一个 Agent 会话，还是单会话 + folder 上下文参数？影响 P0-3 的会话管理模型，需与架构确认协议侧的最佳实践。
2. **插件代码位置**：作为 monorepo 内新 workspace 包（如 `apps/zcodium-vscode`）还是独立仓库？影响 CI、版本号与 .vsix 打包流水线。
3. **审批默认策略**：文件写入默认"全部询问"还是可配置"自动应用"？涉及安全与效率权衡，建议 MVP 全询问、P1 提供设置。
4. **协议版本兼容窗口**：插件支持哪些协议版本？是否要求 CLI 与插件版本严格匹配，或承诺向后兼容 N 个小版本？
5. **目标 VS Code 版本/引擎**：最低 `engines.vscode` 版本（建议 ≥1.85），是否需兼容 VSCodium / 其他 fork？
6. **会话恢复的数据归属**：会话状态由 Agent 侧（CLI）持久化，还是插件侧仅保存会话 ID 引用？取决于 CLI 是否内建会话存储。

## 10. 验收标准（MVP Definition of Done）

- 在装有 zcodium CLI 的机器上安装 .vsix，未额外配置即可完成一次端到端任务：对话 → 流式回复 → diff 审批应用 → 终端命令审批执行。
- 所有文件写入与命令执行均经过审批流，无旁路。
- Agent 进程崩溃后扩展可自动恢复并在 UI 明确提示。
- 协议不匹配、CLI 缺失两种异常均有引导性错误提示。
