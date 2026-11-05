# zcode-vscode 端到端真机回归清单（test/e2e.checklist.md，T13/T14）

> 本文是 §8.1 成文验收件：把 PRD DoD（prd-full.md §6「端到端」+ prd.md P0-1..P0-10）
> 落成可逐项打勾的真机回归清单。执行环境约定：
>
> - ✅ 已验证 —— 在本机以标注的命令/方式实际执行并观察通过；
> - ⬜ 未运行 —— 需要真机（VS Code 扩展宿主 + 真实 `zcodium` CLI + 真实模型）交互，
>   本环境无法执行，**如实标注未运行**，发布前须人工逐项打勾；
> - 🤖 自动回归 —— 由 vitest 门禁承接（命令见 §1），随每次回归自动执行。
>
> 真机前置：安装 zcodium CLI（`zcodium --version` 可用）；`pnpm --filter zcode-vscode
> package` 产出 `dist/zcode-vscode-0.2.0.vsix`；`code --install-extension <vsix>`；
> F5 扩展开发宿主亦可。诊断出口：`ZCodium: 显示 ZCodium 日志`。

## 1. 构建与门禁（自动回归面）

| 门禁 | 命令 | 状态 |
|---|---|---|
| 单测（桥/装配/平台服务/P0 等价/onboarding） | `pnpm --filter zcode-vscode test` | 本轮见 §4 执行记录 |
| 类型 | `pnpm --filter zcode-vscode typecheck`（`tsc -b`） | 本轮见 §4 执行记录 |
| 架构治理 | `pnpm architecture:check`（根脚本） | 本轮见 §4 执行记录 |
| 构建 | `pnpm --filter zcode-vscode build` | 本轮见 §4 执行记录 |
| 体积门禁（§7.2 预算） | `pnpm --filter zcode-vscode size` | 本轮见 §4 执行记录 |
| 打包（vsce，零 node_modules） | `pnpm --filter zcode-vscode package` | 本轮见 §4 执行记录 |

## 2. 端到端真机清单（DoD）

### A. 会话主链路（流式帧渲染 → 审批卡 → turn.completed）

| # | 场景 | 步骤 | 期望 | 状态 |
|---|---|---|---|---|
| A1 | 新会话建链 | 侧栏输入首条消息 | `createSession` ACK 返回 sessionId；hello 握手与订阅无错误帧 | ⬜ 未运行 |
| A2 | 流式帧渲染 | 发送让模型长回复的指令 | text_delta 实时渲染；reasoning 折叠块默认展开（AppSettings.messageStreamShowReasoning，缺省 true；原 `zcodium.showReasoning` 设置零消费方已移除） | ⬜ 未运行 |
| A3 | 工具时间线 | 指令触发读文件/跑命令 | `tool.updated` scheduled/started/progress/result 呈现为时间线 | ⬜ 未运行 |
| A4 | 文件 diff 审批 | 让 Agent 修改文件 | VS Code 原生 diff（左磁盘/右提议）+ 卡片 应用/拒绝；应用后落盘 | ⬜ 未运行 |
| A5 | 命令审批三选 | 让 Agent 跑 shell 命令 | 卡片 允许一次 / 本次会话允许 / 拒绝；「本次会话允许」写回 `zcodium.permissions.allowlist` | ⬜ 未运行 |
| A6 | 危险命令升级 | 让 Agent 跑 `rm -rf` 类命令 | 卡片升级警告样式；拒绝后 turn 继续/失败呈现可读 | ⬜ 未运行 |
| A7 | turn 生命周期 | 正常/失败各一轮 | turn.started → completed 驱动输入框与状态；失败给可读错误与重试 | ⬜ 未运行 |

### B. 崩溃换代恢复（P1-6）

| # | 场景 | 步骤 | 期望 | 状态 |
|---|---|---|---|---|
| B1 | kill 进程自动恢复 | 对话中 `pkill -f "zcodium.*app-server"` | 进程重建 → 横幅（restart 帧）→ 自动 resume 最近会话（回放可达当前） | ⬜ 未运行 |
| B2 | 约束沿用 | B1 后继续对话 | resume 恒带 allowlist/denylist/mcpServers/附加目录（诊断日志 `[runtime]` 行可查） | ⬜ 未运行 |
| B3 | 手动重启 | 执行 `ZCodium: 重启 Agent 进程` | 运行时释放、下次对话重拉；无孤儿进程 | ⬜ 未运行 |
| B4 | 恢复失败降级 | 令 resume 失败（如临时改坏 cliPath 后换代） | 诊断日志 `[runtime] 自动恢复失败（降级）` + 状态栏「已崩溃」，不静默 | ⬜ 未运行 |
| B5 | turn 中换代风暴 | 短时间多次 kill | 换代编排串行排队，不并发重复 resume（`[runtime]` 日志可查） | ⬜ 未运行 |

### C. 会话列表与多根切换（P1-1/P1-2）

| # | 场景 | 步骤 | 期望 | 状态 |
|---|---|---|---|---|
| C1 | 会话列表/排序 | 打开顶部会话列表面板 | 列表按时间排序、标注 folder 归属 | ⬜ 未运行 |
| C2 | 切换会话 | 列表选择另一会话 | resume 回放完整历史；turn 中禁切有提示 | ⬜ 未运行 |
| C3 | 真删除 | 删除会话（二次确认） | 走 v4 `deleteSession`；列表移除；CLI 拒绝时呈现原因 | ⬜ 未运行 |
| C4 | 多根 QuickPick | 双 folder 工作区执行 `ZCodium: 切换工作区` | 每 folder 独立会话键控；切 folder 后对话区重绑该 folder 最近会话 | ⬜ 未运行 |
| C5 | activate 恢复 | 重载窗口 | 每 folder 最近会话自动恢复（globalState 键控） | ⬜ 未运行 |

### D. MCP 与权限（P1-8/P1-3）

| # | 场景 | 步骤 | 期望 | 状态 |
|---|---|---|---|---|
| D1 | MCP 配置→连接 | 设置 `zcodium.mcp.servers`（stdio 与 http 各一）→ 新建会话 | 随 create 下发；设置面板 `mcp/list` 状态条展示已连接/失败/工具数，刷新可用 | ⬜ 未运行 |
| D2 | MCP 重建生效 | 会话运行中改 `zcodium.mcp.servers` | 保存提示「改动后需重建会话生效」；重建后新配置生效（旧会话不变） | ⬜ 未运行 |
| D3 | allowlist/denylist | 配置 `Bash(git status)` 允许 + `rm` 拒绝 → 新会话 | create/resume 携带（`[agent-spawn]` 日志可查）；命中规则自动放行/拒绝 | ⬜ 未运行 |
| D4 | resume 约束不丢 | 配置规则后重载窗口恢复会话 | resume 参数仍带 allowlist/denylist（回归断言见 test/settingsBridge.test.ts） | 🤖 自动回归（真机复核 ⬜ 未运行） |

### E. Claude Code 历史导入（P1-12）

| # | 场景 | 步骤 | 期望 | 状态 |
|---|---|---|---|---|
| E1 | 扫描与预览 | `ZCodium: 导入 Claude 会话` | 列出 `~/.claude/projects` 候选（标题+时间+workspace 归属） | ⬜ 未运行 |
| E2 | 导入并续聊 | 勾选候选导入 | 生成新会话并打开；历史可回放、可续聊（发新消息正常响应） | ⬜ 未运行 |
| E3 | 错误可读 | 构造损坏/超大 jsonl | 失败/跳过原因逐条呈现，不静默 | ⬜ 未运行 |
| E4 | 原文件不删 | 对比导入前后 `~/.claude/projects` | 文件集合与内容不变 | ⬜ 未运行 |
| E5 | 非桌面拦截 | （如可构造）非桌面位 | 呈现「仅桌面可用」引导而非报错 | ⬜ 未运行 |

### F. @ 引用 / 选区 / 诊断注入（P1-4/P1-5）

| # | 场景 | 步骤 | 期望 | 状态 |
|---|---|---|---|---|
| F1 | @ 文件引用 | 输入 `@` 补全选文件 | composer 生成引用 chip；发送后 Agent 收到正确路径（多根为相对 folder 路径） | ⬜ 未运行 |
| F2 | 选区 chip | 编辑器选中代码 → 侧栏点选区 chip | `[file Lx-Ly]` 注入区块进入 composer | ⬜ 未运行 |
| F3 | 诊断注入 | 制造 Error 后 `ZCodium: 发送诊断信息`（两档） | 仅错误/全部两档内容正确预填 composer；无诊断时入口禁用 | ⬜ 未运行 |

### G. 模型/模式/思考/压缩/用量/子代理（P1-11/P1-14/P1-7/P1-15）

| # | 场景 | 步骤 | 期望 | 状态 |
|---|---|---|---|---|
| G1 | 模型切换 | 会话头部下拉切换模型/思考档 | 即时生效（`switchModelConfig`）；失败回滚 UI | ⬜ 未运行 |
| G2 | 模式切换 | 切 build/plan/edit/yolo/guarded | 即时生效（`switchCollaborationMode`）+ 消息流系统行 | ⬜ 未运行 |
| G3 | 压缩 | `compact` 入口 | idle 立即执行 / busy 排队；进度与摘要行呈现 | ⬜ 未运行 |
| G4 | 用量 | 完成一轮 turn | 每轮用量行（输入/输出/缓存）可折叠；会话头部累计 | ⬜ 未运行 |
| G5 | 子代理 | 触发派生子代理的指令 | 时间线子代理卡（running/waiting/blocked/ended）；点开看列表 | ⬜ 未运行 |

### H. 自定义指令 / 语言 / 会话参数（P1-13/P1-16）

| # | 场景 | 步骤 | 期望 | 状态 |
|---|---|---|---|---|
| H1 | 自定义指令 | 设置面板写系统提示词 | 新 turn 生效；清空恢复默认 | ⬜ 未运行 |
| H2 | 语言偏好 | 设置回复语言 | 后续回复语言跟随 | ⬜ 未运行 |
| H3 | 附加目录 | 目录选择 ≤256 追加 | 写入 `zcodium.context.additionalDirectories`，重建会话后 Agent 可访问 | ⬜ 未运行 |
| H4 | 指令导入 | ZCODIUM.md/CLAUDE.md 一次性导入 | 内容拷贝进设置；原文件不变（差异口径见 README/文档） | ⬜ 未运行 |

### I. 主题 / i18n / 可见性（P1-9.4）

| # | 场景 | 步骤 | 期望 | 状态 |
|---|---|---|---|---|
| I1 | 主题跟随 | VS Code Dark/Light/HighContrast 切换 | webview 主题 class 实时跟随（theme 帧运行时跟随，非仅挂载一次） | ⬜ 未运行 |
| I2 | i18n 跟随 | 改 VS Code 显示语言重载 | 界面语言随 `env.language` 映射 | ⬜ 未运行 |
| I3 | 可见性暂停 | 面板切走再切回 | 隐藏时渲染暂停、切回恢复，无卡死 | ⬜ 未运行 |

### J. 引导与降级（P1-10.2/P1-10.3，本轮 T13 交付面）

| # | 场景 | 步骤 | 期望 | 状态 |
|---|---|---|---|---|
| J1 | CLI 未找到引导 | 卸载/改名 `zcodium` 后重载窗口 | 激活即呈现安装引导信息条（重新检测/3 步上手/查看日志）；诊断有 `[cli] 未找到` 行 | ⬜ 未运行 |
| J2 | 重新检测 | J1 后安装 CLI → 信息条「重新检测」 | 探测更新、运行时重置（诊断 `[cli] 重新检测：已找到`），对话可建会话 | ⬜ 未运行 |
| J3 | 3 步上手卡 | 呈现 onboarding 卡面 | 3 步说明项 + 重新检测项 + Claude 导入入口项；选导入项打开组4 导入面板 | ⬜ 未运行 |
| J4 | 降级标注 | 老 CLI/无 capabilities 启动 | 能力位投影（capabilities.ts）为预留面（本期侧栏未接线消费）；握手版本不匹配给升级指引，不做部分猜测 | ⬜ 未运行 |
| J5 | 二进制帧退化 | capabilities.binaryFrames=false | 链路提示「传输已退化为 base64 文本帧」且功能可用 | ⬜ 未运行 |

## 3. P0-1..P0-10 基线等价打勾表（新 UI 全量回归）

| 项 | 名称 | 场景/期望（对应 §2 场景） | 状态 |
|---|---|---|---|
| P0-1 | 扩展激活与 CLI 探测 | 激活探测 CLI；未找到呈现欢迎/引导（J1/J2） | ⬜ 未运行 |
| P0-2 | Agent 进程生命周期 | app-server 子进程管理；状态栏生命周期呈现（B1–B5） | ⬜ 未运行 |
| P0-3 | 会话创建 | 携带 workspace/mode/model 创建（A1；D3） | ⬜ 未运行 |
| P0-4 | 侧边栏聊天 Webview | 输入 + 消息流 + 流式渲染（A1/A2） | ⬜ 未运行 |
| P0-5 | 流式回复与推理 | text_delta 实时；reasoning 折叠开关（A2） | ⬜ 未运行 |
| P0-6 | 工具执行可视化 | tool.updated 时间线（A3） | ⬜ 未运行 |
| P0-7 | 文件 diff 审批 | 原生 diff + 卡片应用/拒绝（A4） | ⬜ 未运行 |
| P0-8 | 终端命令审批 | 允许一次/本次会话允许/拒绝（A5/A6） | ⬜ 未运行 |
| P0-9 | turn 生命周期与错误 | started/completed/failed 驱动 UI（A7） | ⬜ 未运行 |
| P0-10 | 协议版本守卫 | 握手版本校验；不匹配给升级指引而非静默（J4/J5） | ⬜ 未运行 |

## 4. 本轮（T13/T14 收尾）实际执行记录

- 执行环境：macOS（darwin 24.1.0 arm64）；无 VS Code 扩展宿主/真实 CLI/真实模型交互条件。
- **真机项（§2/§3 全部 ⬜）均未运行**——如实标注，发布前须人工执行。
- 本轮执行的自动门禁命令与结果（2026-11-05，运行于 T13 变更之上）：

| 命令 | 结果 |
|---|---|
| `pnpm --filter zcode-vscode test` | ✅ 18 文件 / 242 用例全绿（含本清单配套新增 `test/welcomePage.test.ts` 18 例） |
| `pnpm --filter zcode-vscode typecheck` | ✅ `tsc -b` 零错误 |
| `pnpm architecture:check` | ❌ 41 项违规（修订 `src/module.ts` 注释误匹配后由 113 降为 41）；其中 zcode-vscode 域 7 项全部为前序组遗留：缺 `contract.example.ts`（T01 产物面）、5 处 `@zcode/rpc` 直引未登记 policy（修复需改 `module.ts` requires + `CONTRACT.md`，归组1 契约面，本组不改）、组4 `ImportClaudeSessions.tsx` 1 条 lint-disable；其余 34 项在 `packages/ui` 等模块，均为既有状态 |
| `pnpm --filter zcode-vscode build` | ✅ 三产物齐（extension.js / webview/main.js / webview/styles.css） |
| `pnpm --filter zcode-vscode size` | ⚠️ 单产物 4 项全过（extension.js 5.02/9 MB、webview main.js 5.65/8 MB、gzip 1.64/2.5 MB、styles.css 132.4/400 KB）；`dist 总量` 38.59 MB 超 25 MB 原始字节近似——为前序组 webview 懒加载 chunk 集所致（esbuild 已按 §7.2 处置顺序完成桩替换/拆分/minify），**实际 vsix 压缩后 10.64 MB，在 §7.2「vsix 总量 ≤25 MB」预算内**（见下行 vsce 实测）；该门禁为 T01 脚本口径，本组不改其语义 |
| `pnpm --filter zcode-vscode package` | ⚠️ 因上一行 size 门禁非零退出（package 串在 vsce 之前）；vsce 环节直跑 `npx vsce package --no-dependencies --out dist/` 复验：✅ 产出 `dist/zcode-vscode-0.2.0.vsix`（4336 文件 / 10.64 MB / **零 node_modules** / 无 src·test 残留 / package.json 版本 0.2.0、13 条命令与 contributes 一致）。本轮已将 package 脚本的 vsce 段加 `--out dist/`（T14 终稿：产物落 dist/，与 README/本清单路径一致） |

> 结论：build→size→vsce 链路 mechanics 复验通过（vsix 本体在预算内且零 node_modules）；
> 挂点是 T01 的 size 门禁以 dist 原始字节（38.59 MB）近似 vsix 体积，与 §7.2 的
> 「vsix 总量」口径不一致。是否调整门禁口径（改为实测 vsix 大小）或继续压缩 webview
> chunk 集，归 T01/组4 裁决；发布前真机清单（§2/§3）须人工执行。
> 附注：vsix 现落在 dist/ 内，若先打包再跑 size 门禁，`dist 总量` 会把 vsix 本身也计入
> （门禁在 package 链中先于 vsce 执行，链内不受影响）——该口径细节归 T01 处理。

## 5. 门禁修复轮（2026-11-05 复审修复）执行记录

- 独立复审 high/medium 项修复后复跑的自动门禁（运行环境同 §4：无 VS Code 扩展宿主/真实 CLI/真实模型）：
- **真机项（§2/§3 全部 ⬜）在本轮仍未运行**——发布前 DoD §8.2 须人工逐项执行并回填。

| 命令 | 结果 |
|---|---|
| `npx tsc -b`（apps/zcode-vscode） | ✅ 零错误 |
| `npx vitest run`（apps/zcode-vscode） | ✅ 19 文件 / 246 用例全绿（新增 resolver argv 形状与 provider 种子解码守护用例） |
| `node scripts/architecture/architecture-check.mjs check` | ✅ zcode-vscode 域 0 项违规（41→34；余 34 项在 packages/ui 等其他模块，非本 app 范围） |
| `node scripts/check-bundle-size.mjs` | ✅ 单产物 4 项 + 实测 vsix 10.64/25 MB 全过；dist 总量转观测项（不含 vsix） |
| `node esbuild.mjs` | ✅ 三产物齐（extension.js / webview/main.js / webview/styles.css） |
