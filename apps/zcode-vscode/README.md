# ZCodium Agent（VS Code 扩展）

把 ZCodium Agent 接进 VS Code：侧栏对话、流式回复与思考过程、工具时间线、
文件 diff / 终端命令审批、会话切换与多根工作区、MCP 与权限管理、Claude 历史导入、
崩溃自动恢复——对话界面与桌面端同源（复用 `@zcode/ui` 装配面），协议消费
`zcode-protocol-v4` schema（唯一所有者 `@zcode/shared`）。

## 安装

1. 安装扩展（v0.2.0，**内置 CLI bundle**，开箱即用）：

   ```bash
   code --install-extension apps/zcode-vscode/dist/zcode-vscode-0.2.0.vsix
   ```

   从源码产出 vsix：`pnpm --filter zcode-vscode package`（esbuild 构建 → `vsce package
   --no-dependencies` → 体积门禁实测 `dist/*.vsix` 对照 §7 预算），vsix 内零 node_modules。

   **CLI 解析优先级**：设置 `zcodium.cliPath` → PATH 上的 `zcodium` → 内置 bundle
   （`cli-bundle/zcode.cjs`，随扩展分发、与 monorepo 同 commit 构建、协议版本锁死；
   经宿主自带 Node 运行，无需本机安装 Node）。内置 bundle 满足"装完即用"；
   独立安装 CLI 则便于跨编辑器复用与独立升级。

2. 打开 Activity Bar 的「ZCodium Agent」侧栏。CLI 未找到时会呈现上手引导卡
   （安装指引 + 「重新检测」入口）；也可随时执行命令面板「ZCodium: 上手引导」查看 3 步上手。

## 3 步上手

1. **装好 CLI**：`zcodium` 在 `PATH` 即可，或在设置 `zcodium.cliPath` 指定绝对路径。
2. **打开侧栏对话**：输入框直接提问；`@` 引用文件与选区；模型 / 协作模式 / 思考深度
   在会话头部切换；顶部按钮切换 / 删除会话（多根工作区每个 folder 独立会话）。
3. **按需配置与导入**：权限 allowlist / denylist、MCP 服务器、附加目录在设置面板维护；
   Claude Code 历史可一键导入（命令面板「ZCodium: 导入 Claude 会话」，检测
   `~/.claude/projects`，仅读取原文件不删除，桌面环境可用）。

## 配置（settings）

| 项 | 默认 | 说明 |
|---|---|---|
| `zcodium.cliPath` | `""` | CLI 绝对路径；留空从 `PATH` 探测 `zcodium` |
| `zcodium.mode` | `build` | 协作模式（build/plan/edit/guarded/yolo/auto），随 RuntimeController 编排面（恢复/编程式创建）下发；侧栏草稿会话的模式在会话头部切换 |
| `zcodium.model` | `""` | `providerId/modelId`；随 RuntimeController 编排面（恢复/编程式创建）下发，留空用 CLI 默认模型；侧栏草稿会话的模型在会话头部切换 |
| `zcodium.permissions.allowlist` | `[]` | 工具 allowlist 规则（`Tool` / `Tool(args)` 形式），随 create/resume 携带 |
| `zcodium.permissions.denylist` | `[]` | 工具 denylist 规则，随 create/resume 携带（resume 不带会绕过约束） |
| `zcodium.mcp.servers` | `[]` | MCP 服务器配置（stdio/http）；改动后需重建会话生效 |
| `zcodium.context.additionalDirectories` | `[]` | Agent 可访问的附加目录（协议上限 256 个） |

## 命令

- `ZCodium: 打开对话` — 聚焦侧栏对话面。
- `ZCodium: 打开完整界面` — 在 Simple Browser 打开完整 Web 界面（会话历史/模型管理/diff/Git/终端/设置，
  与侧边栏共享同一份会话与模型数据；需要本机 monorepo 构建产物，路径可配）。
- `ZCodium: 上手引导` — 随时呈现 3 步上手卡（P1-10.2；CLI 缺失信息条同款入口）。
- `ZCodium: 新建会话` — 回到草稿态新建（会话数据保留在会话库）。
- `ZCodium: 重启 Agent 进程` — 释放 Agent 运行时，下次对话重新拉起（崩溃后的手动恢复入口）。
- `ZCodium: 显示 ZCodium 日志` — 打开诊断输出（stderr 尾部、帧错误、编排事件）。
- `ZCodium: 检查 Webview/Host 产物体积门禁` — 提示体积门禁执行位置。
- `ZCodium: 切换工作区` — 多根 QuickPick 聚焦 folder（会话按 folder 独立）。
- `ZCodium: 发送诊断信息` — 收集 Problems 当前文件诊断（仅错误 / 错误+警告两档）注入对话。
- `ZCodium: 打开 MCP 设置` — 直达 `zcodium.mcp.servers` 设置面。
- `ZCodium: 打开指令配置` / `ZCodium: 打开会话参数` — 自定义指令/语言、附加目录等会话参数。
- `ZCodium: 导入 Claude 会话` — 打开 Claude 历史导入面板。
- `ZCodium: 查看子代理` / `ZCodium: 查看用量` — 子代理面板、用量面板。
- `ZCodium: 历史会话` — QuickPick 列出 CLI 持久化会话并接续（与桌面端共享同一份历史）。
- `ZCodium: 改写选中代码（Quick Edit）` — 编辑器内一次性改写：diff 预览 → 确认后应用
  （快捷键 Cmd+Alt+K；不消耗工具调用、不产生会话回合）。
- `ZCodium: 生成提交信息` / `ZCodium: 审阅当前改动` — SCM 面板按钮；前者把提交信息填进
  SCM 输入框，后者把 diff 作为上下文发进对话做 code review。
- `ZCodium: 发送终端选区到 ZCodium` — 终端右键入口；报错栈自动包成上下文块。
- `ZCodium: 加入对话上下文` — 编辑器/资源管理器右键；把选区、活动文件或文件树结构发给 Agent。
- `ZCodium: 停止生成` — 中断当前会话正在执行的回合。
- Code Action（灯泡）：诊断处「用 ZCodium 修复此问题」、选中代码解释/重构/写测试/加入对话。

## 行为要点

- **协议（v4）**：连接建立先走 hello 握手（`clientHello` / `hello`，协商
  `capabilities` 与投递档位）；会话数据经 `v4/conversation/subscribe` 订阅
  （ACK 携带 `snapshot`/`resume` 模式与 `logEpoch` 水位，增量续传）。命令面
  `createSession` / `sendText` / `resolveInteraction` / `switchModelConfig` /
  `switchCollaborationMode` / `compact` / `deleteSession` 不经 `vscode.commands`，
  由 webview 走桥 rpc 帧下发（消费清单见 `docs/contract-check.md` §3）。
- **会话**：按 workspace folder 键控（globalState 记最近会话，activate 后自动恢复）；
  resume 恒带 allowlist / denylist / mcpServers / 附加目录。会话删除为真删除
  （v4 `deleteSession`，CLI 权威拒绝时 UI 呈现原因）。
- **崩溃恢复**：Agent 进程换代（kill/崩溃）→ `@zcode/services` 进程管理重建 →
  编排层自动 resume 各 folder 最近会话（恢复参数沿用设置面）→ 横幅呈现结果；
  恢复失败降级为诊断日志 + 状态栏「已崩溃」（不静默）。手动入口：
  `ZCodium: 重启 Agent 进程`。
- **审批**：文件编辑走 VS Code 原生 diff（左磁盘 / 右提议）+ 卡片应用/拒绝；
  命令审批支持 允许一次 / 本次会话允许 / 拒绝，交互回执经 v4 `resolveInteraction`
  先到先得（迟到 noop）。「本次会话允许」写回 `zcodium.permissions.allowlist`
  （改动后需重建会话生效）。
- **MCP**：服务器随 create/resume 一次性下发，`mcp/list` 状态可在设置面板查看；
  运行中不可动态增删，改动保存后提示重建会话生效。
- **能力降级**：能力位投影（`src/webview-react/capabilities.ts`）为预留面——
  hello.capabilities → 入口显隐的投影已实现并有测试锁定，本期侧栏装配尚未接线
  消费（终端/原生对话框入口不在插件装配面）；二进制帧缺失时传输退化为 base64
  文本帧并给出链路提示。老 CLI（无 v4）握手失败给出「请升级 CLI」引导。

## FAQ

- **提示未找到 zcodium CLI？** v0.2.0 起扩展内置 CLI bundle，正常安装不会出现该提示；
  若出现（bundle 损坏等），安装 CLI、或在设置 `zcodium.cliPath` 指定绝对路径，
  然后用引导卡/命令「ZCodium: 重启 Agent 进程」重新拉起（`zcodium.restartAgent`）。
  优先级：`cliPath` 设置 → PATH → 内置 bundle。
- **改了 MCP / 权限规则 / 附加目录为什么没生效？** 这些参数随会话 create/resume
  下发，运行中不热更新——重建会话（或重启 Agent 进程）后生效。
- **侧栏某功能不见了或提示「当前 CLI 版本不支持」？** 能力位投影为预留面（见
  「行为要点 · 能力降级」）；二进制帧缺失时会有链路降级提示。升级 CLI 后重新打开会话。
- **「本次会话允许」的规则存到了哪？** 写入工作区设置 `zcodium.permissions.allowlist`，
  可在设置 UI 中编辑，重建会话后生效。
- **导入 Claude 历史会动我的原文件吗？** 不会。导入只读取 `~/.claude/projects`
  下的 jsonl 并解析为 ZCodium 会话，原文件不删除；仅在桌面环境可用（需读本机路径）。
- **多根工作区怎么用？** `ZCodium: 切换工作区` 聚焦 folder；每个 folder 独立键控
  最近会话，侧栏会话列表标注归属。

## 与桌面端 / CLI 的关系

- **桌面端**：同一 monorepo 内共享 `@zcode/ui` 对话界面、`@zcode/shared` 协议 schema
  与 `@zcode/services` 服务装配（`workspace:*` 锁定，同 commit 生效）。差异在宿主壳：
  插件跑在 VS Code 扩展宿主，原生能力经 `PlatformRpcHandler` 白名单方法落地，
  无法代理的能力在 shim 层返回「不支持」而非抛错（如 MCP 本机目录写回、数据目录导入
  由桌面端承担）。
- **CLI**：插件不调用模型——一切 Agent 能力由 `zcodium app-server --stdio` 子进程承担，
  生命周期由 `@zcode/services` 进程管理；升级协议 = 在 monorepo 内改 `@zcode/shared`
  后重新构建扩展。

## 开发

```bash
pnpm --filter zcode-vscode build       # esbuild 双入口 → dist/
pnpm --filter zcode-vscode test        # vitest（桥/装配/平台服务/P0 等价回归）
pnpm --filter zcode-vscode typecheck   # tsc -b
pnpm --filter zcode-vscode size        # 产物体积门禁（§7 预算）
pnpm --filter zcode-vscode package     # vsce package → dist/*.vsix（零 node_modules）
```

模块结构与治理约束见 `src/CONTRACT.md`；桥 wire schema、`@zcode/shared` 版本锁定
关系与 v4 协议命令面消费清单见 `docs/contract-check.md`（协议 schema 唯一事实来源
`packages/shared/src/zcode-protocol-v4/`）。端到端真机回归清单见 `test/e2e.checklist.md`。
