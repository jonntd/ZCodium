# 全量功能清单版 PRD：zcode-vscode 插件 v0.2.0（验收级逐条编号版，prd-full）

> **文档定位**：73 项能力全部展开为完整小节，每项含：**UI 交互细节**（入口/状态流转/空态/错误态/快捷键与命令面板/VS Code 原生协作）+ **实现拆解**（host 桥/webview/store 层、关键技术点、依赖内部包与协议方法）+ **验收标准逐条编号**（AC-Fxx-n，断言式"在…状态下执行…→ 期望…"，覆盖正常路径+边界+错误态/空态，QA 可 1:1 转测试用例）+ 工作量档（S/M/L 相对值）。C 档 3 项另附立项草案（§3）。
> **范围口径（用户拍板）**："还原 zcodium 的所有功能，加上 Augment/Claude Code 能加的功能；inline 代码补全、代码库索引不要。"
> **UI 策略（用户拍板）**：直接复用 `packages/ui`（`@zcode/ui`：React + Zustand），不自建聊天 UI。
> **勘察基准**：`packages/shared/src/zcode-protocol/index.ts`（~90 方法 + create/resume 参数面 + 事件面）；`apps/zcode-cli/packages/cli/src/arguments.ts`；`apps/zcode-cli/packages/core/src/runtime/methods/`。不确定处标 **[待架构师核实]**。

## 0. 技术前提

1. **依赖策略**：删除手工同步的 `src/zcodeProtocol/types.ts`，直接依赖 `@zcode/shared`（zod schema）、`@zcode/services`（`zcodeStdioTransport`/`zcodeAgent`/进程管理）、`@zcode/ui`（Webview UI）、必要时 `@zcode/client`；`architecture-policy` 登记 requires（用户已接受深度绑定仓库内部模块）。
2. **UI 适配件**（架构师出方案）：① Webview↔宿主 postMessage 协议 IO 桥（@zcode/shared schema 校验）；② `IPlatformService` VS Code 实现；③ React+@zcode/ui 打包/主题/i18n 跟随 VS Code；④ 沙箱硬依赖清单+shim 方案（评估项，不推翻决策）。
3. **横切机制**：`runtime/capabilities` 特性探测驱动功能显隐；老 CLI 独立方法 `method-not-found` 静默降级是协议既定模式（deleteProtection 注释），插件沿用该模式做能力降级。

**依赖图例**：S=`@zcode/shared` · V=`@zcode/services` · U=`@zcode/ui` · P=插件宿主（VS Code API）
**档位**：A=本期核心 · A+=本期一并 · B=完整覆盖（随范围决议启用） · C=需上游扩展（立项草案） · ✕=不做

## 1. 功能全景总览

| 档位 | 数量 | 说明 |
|---|---|---|
| A 核心 | 21 | 会话主干+编辑器集成+用量+MCP 基础 |
| A+ 低成本 | 13 | 协议现成顺带交付 |
| B 完整覆盖 | 30 | 逐项验收级细化，随范围决议启用 |
| C 需上游扩展 | 3 | 立项草案见 §3 |
| ✕ 不做 | 6 | 原因见各节 |
| **合计** | **73** | **73/73 已展开为完整小节并逐条编号验收**；本期候选 = A+A+ = 34 项 |

## 2. 验收级功能清单

### 2.1 会话生命周期

#### F-01 会话创建 【A · S】
- **协议/依赖**：`session/create`（zcodeSessionCreateParamsSchema）｜S+V+U
- **UI 交互**：入口=侧栏顶栏"+"按钮 + 命令面板 `ZCodium: 新建会话`（建议绑定快捷键）；状态流转=idle → creating（按钮 loading）→ active / error；空态=无 CLI 时展示安装引导页（P0-1）；多根工作区先弹 folder QuickPick（联动 F-19）；VS Code 协作=创建成功后状态栏 ZCodium 图标转为绿色并显示会话名。
- **实现拆解**：host 桥封装 create 调用，入参经 @zcode/shared schema 校验（非法参数拒发）；store 新增 sessions/currentSessionId/creating 标志；webview 顶栏装配 @zcode/ui；creating 期间重复点击直接忽略（防抖）。
- **验收标准**：
  - AC-F01-1：在 CLI 正常运行状态下点击"+" → 消息区清空并出现新会话空态（引导语+历史入口），状态栏更新为该会话。
  - AC-F01-2：在未检测到 CLI 状态下点击"+" → 显示安装引导页而非错误堆栈。
  - AC-F01-3：在创建请求进行中连点"+"3 次 → 仅发出 1 个 create 请求（防抖生效）。
  - AC-F01-4：在 create 返回错误的注入场景（如版本不符） → UI 无半初始化残留，横幅展示可读原因并可重试。
  - AC-F01-5：在新会话创建完成后 → 自动完成事件订阅，首个流式事件可即时渲染。

#### F-02 会话恢复 【A · S】
- **协议/依赖**：`session/resume`（zcodeSessionResumeParamsSchema）｜S+V+U
- **UI 交互**：入口=历史会话列表点击即恢复；状态流转=恢复中（骨架屏+"正在恢复"）→ 完成（消息区顶部显示"已恢复 N 条历史"）；错误态=resume 失败显示可读错误+"新建会话"按钮。
- **实现拆解**：host 层从会话元数据缓存取回原会话 mcpServers/toolAllowlist/toolDenylist/thoughtLevel 随 resume 下发（协议注释：冷恢复必须沿用，否则绕过 allow/deny 约束）；失败路径接 F-69 降级编排。
- **验收标准**：
  - AC-F02-1：在存在已关闭历史会话的状态下点击该会话 → 3s 内消息流完整回放且输入框可用。
  - AC-F02-2：在原会话带 allowlist 的状态下 resume 后发起含 denylist 工具的任务 → 该工具被拒且 UI 显示拒绝原因（约束未被绕过）。
  - AC-F02-3：在 resume 一个不存在/已损坏 sessionId 的场景 → 可读错误+"新建会话"按钮，不白屏。
  - AC-F02-4：在 resume 进行中重复点击 → 请求不重复发送（恢复中禁用）。

#### F-03 历史会话列表/切换/移除 【A · M】
- **协议/依赖**：`session/list`、`session/read`、`session/messages`、`session/subscribe`、`session/close`｜S+V+U（+P：globalState）
- **UI 交互**：入口=顶栏会话下拉（标题/状态/最近活动，按最近活动排序）+ 命令面板 `ZCodium: 切换会话`（QuickPick）；移除=列表项操作"从列表移除"（二次确认对话框）；turn 进行中切换项禁用+tooltip"当前任务进行中"；空态="暂无历史会话"；降级态=`session/list` 失败时显示 globalState ID 列表并标注"（离线缓存，无标题信息）"。
- **实现拆解**：host 层 list 拉取 + globalState 持久化最近会话 ID 与元数据（联动 F-69/F-70）；移除=插件侧移除引用（活跃会话先 `session/stop`+`session/close`）；协议无 `session/delete`（CLI 真删除入口待 Q4，UI 文案定为"从列表移除，本地会话数据保留"）。
- **验收标准**：
  - AC-F03-1：在存在 ≥2 个历史会话的状态下打开列表 → 全部展示且按最近活动降序。
  - AC-F03-2：在消息区空闲状态下点击另一会话 → 3s 内完成切换回放且无旧会话内容残留。
  - AC-F03-3：在当前会话 turn 进行中的状态下 → 该会话的切换入口禁用且 hover 提示原因。
  - AC-F03-4：在移除非活跃会话并确认后 → 列表即时更新且 globalState 中引用同步移除。
  - AC-F03-5：在移除活跃会话的场景 → 先显示"正在关闭会话…"，stop+close 完成后再移除。
  - AC-F03-6：在注入 `session/list` 调用失败的场景 → 列表降级为离线缓存态仍可浏览与切换（可切换项为已缓存 ID）。

#### F-04 会话内容回放 【A · M】
- **协议/依赖**：`session/read` + `session/messages` + `session/events` + `session/subscribe`｜S+V+U
- **UI 交互**：回放期间消息区骨架占位；超长消息默认折叠（"展开全部"）；工具时间线/审批卡/推理块按原始顺序与状态重建；回放完成前输入框可用（不阻塞）。
- **实现拆解**：@zcode/ui 消息流组件消费投影 schema；messages 快照 + events 增量补齐；pending 审批在回放后重新呈现（衔接基线 P0 超时策略）。
- **验收标准**：
  - AC-F04-1：在含工具调用+审批+推理块的历史会话切换后 → 各消息块顺序、状态徽标与原会话一致。
  - AC-F04-2：在历史中存在未应答审批记录的状态下回放完成 → 审批卡重新呈现并可操作。
  - AC-F04-3：在 >200 条消息的长会话回放场景 → 输入框全程可输入，回放不冻结 UI 线程。
  - AC-F04-4：在回放进行中用户点击停止查看（滚动） → 回放继续但视图不被强制拉到底。

#### F-05 消息发送 【A · S】
- **协议/依赖**：v4 sendText 主链（`session/send` 兼容面，attachments 支持）｜S+V+U
- **UI 交互**：输入框 Enter 发送 / Shift+Enter 换行；发送中按钮变"停止"（联动 F-06）；空消息/纯空白禁用发送；发送失败时文本回填输入框+错误 toast。
- **实现拆解**：基线已交付；迁移 @zcode/ui composer；attachments 载荷接口预留（X-21 图片附件待 Q5）；发送前经桥层 schema 校验。
- **验收标准**：
  - AC-F05-1：在会话空闲状态下发送消息 → 消息立即上屏且 turn.started 驱动 UI 进入进行中。
  - AC-F05-2：在输入框仅有空格/换行的状态下按 Enter → 不发送，按钮保持禁用。
  - AC-F05-3：在进程断连状态下发送 → 消息文本回填输入框并提示"Agent 未连接"。
  - AC-F05-4：在 turn 进行中按 Enter → 输入框进入排队/禁用（与 F-06 停止语义一致，取其一并在 tooltip 说明）。

#### F-06 停止/取消后台任务 【A · S】
- **协议/依赖**：`session/stop`（基线）+ `session/cancelBackgroundTask` [v4 形态待架构师核实]｜S+V
- **UI 交互**：turn 进行中"停止"按钮（原发送位）；后台任务卡右上"取消"入口；停止后流式区显示"已中断"分隔线。
- **实现拆解**：stop 走基线路径回归；cancelBackgroundTask 待 v4 契约确认后接入（不阻塞本期 stop）。
- **验收标准**：
  - AC-F06-1：在流式回复进行中点击停止 → ≤2s 内流式停止、UI 显示"已中断"分隔线、输入框恢复可用。
  - AC-F06-2：在工具执行审批等待中点击停止 → 待审批卡标记为已取消，不悬挂。
  - AC-F06-3：在存在后台任务的状态下点击取消 → 任务卡状态转为 cancelled 且 Agent 侧收到取消。
  - AC-F06-4：在已停止的 turn 上再点停止 → 按钮已隐藏（幂等，无重复请求）。

#### F-07 会话压缩 【A+ · S】
- **协议/依赖**：`session/compact`｜S+V+U
- **UI 交互**：入口=会话菜单（顶栏 ⋮）"压缩上下文" + 命令面板 `ZCodium: 压缩上下文`；状态流转=点击 → 确认提示（"将摘要历史以压缩上下文继续"）→ 执行中（菜单项转进度态、禁用重复触发）→ 完成后消息流插入压缩摘要行；错误态=失败 toast 且会话照常可用。
- **实现拆解**：host 桥调用 compact；store 记录 compacting 标志；@zcode/ui 摘要行组件复用系统消息样式。
- **验收标准**：
  - AC-F07-1：在长会话（上下文接近上限提示出现）状态下执行压缩 → 完成后消息流出现压缩摘要且后续 turn 正常回复。
  - AC-F07-2：在压缩执行中再次点击 → 菜单处于禁用态，无重复请求。
  - AC-F07-3：在压缩失败的注入场景 → toast 展示错误，会话消息与输入不受影响。
  - AC-F07-4：在压缩完成后的会话执行 resume → 压缩后状态保持（不回退为全量历史）。

#### F-08 会话分叉 【B · M】
- **协议/依赖**：`session/fork`（词表在、客户端链已删，v4 forkSessionAtMessage 钩子）[待架构师核实]｜S+V
- **UI 交互**：入口=消息右键/悬浮菜单"从此处分叉为新会话"；分叉后自动跳转新会话并在顶部标注"分叉自 <原会话标题> @ 消息 N"。
- **实现拆解**：待 v4 形态确认；插件侧=fork 请求+新会话创建跳转+来源标注存会话元数据。
- **验收标准**：
  - AC-F08-1：在历史会话任意 assistant 消息上执行分叉 → 新会话包含截至该消息的全部历史且可继续对话。
  - AC-F08-2：在分叉完成后的原会话查看 → 原会话内容与状态无任何变化。
  - AC-F08-3：在 v4 形态未确认期间 → 该入口不显示（capabilities/降级隐藏，不出灰色死按钮）。

#### F-09 目标卡 【A+ · M · 交互面待架构师核实】
- **协议/依赖**：`session/goal`（zcodeSessionGoalSchema + verification schema）｜S+V+U
- **UI 交互**：入口=会话菜单"设定目标"（文本输入）；目标卡置于消息区顶部（目标文本+验证状态徽标）；达成后卡片转绿可展开验证详情；无 goal 时入口折叠不占空间。
- **实现拆解**：goal 设置走协议方法；状态更新依赖事件面（若 goal 事件宿主消费路径缺失，则入口隐藏——能力降级，AC-F09-4）。
- **验收标准**：
  - AC-F09-1：在会话空闲状态下设定目标 → 卡片即时显示目标文本与初始状态。
  - AC-F09-2：在 Agent 推进目标的状态下 → 验证状态徽标随事件实时流转（进行中/达成/失败）。
  - AC-F09-3：在目标达成后点击卡片 → 展开验证详情（校验项与结果）。
  - AC-F09-4：在 goal 事件面不可用的 CLI 上 → "设定目标"入口不显示（降级，不报错）。

#### F-10 会话关闭 【A · S】
- **协议/依赖**：`session/close`｜S+V
- **UI 交互**：无独立入口；切换/移除/重建/退出时内部调用；close 过程 UI 显示瞬时"正在关闭会话…"。
- **实现拆解**：host 层编排（订阅清理→close→元数据更新）；失败静默+输出通道日志。
- **验收标准**：
  - AC-F10-1：在切换走某会话后 → 该会话不再推送任何事件到 UI（订阅已清理，注入旧会话事件验证无渲染）。
  - AC-F10-2：在 close 调用失败的注入场景 → UI 不阻塞、不报错弹窗，仅日志记录。
  - AC-F10-3：在窗口关闭/重载的场景 → 活跃会话被有序 close（或标记待恢复），无僵尸进程残留。

#### F-11 模型切换 【A+ · S】
- **协议/依赖**：`session/setModel`（modelSelectionSchema）+ `session/create.model`｜S+V+U
- **UI 交互**：入口=顶栏模型下拉（列出运行时可用模型，含当前项勾选）；切换后消息流插入系统行"模型已切换为 X"；错误态=切换失败回滚下拉显示并 toast。
- **实现拆解**：host 桥 setModel（v4/legacy 路径待 Q2）；store 记录当前模型；create 时携带默认模型设置。
- **验收标准**：
  - AC-F11-1：在会话空闲状态下切换模型 → 下拉即时更新且消息流出现系统行，下一轮回复可佐证新模型生效。
  - AC-F11-2：在切换请求失败的注入场景 → 下拉回滚为原模型并显示错误。
  - AC-F11-3：在 turn 进行中切换模型 → 排队至下一轮生效或入口禁用（实现取其一，tooltip 说明）。
  - AC-F11-4：在设置默认模型的场景 → 新建会话的 create 参数携带该默认值。

#### F-12 思考深度 【A+ · S】
- **协议/依赖**：`session/setThoughtLevel` + `create/resume.thoughtLevel`｜S+V+U
- **UI 交互**：入口=顶栏思考深度选择（低/中/高，与 @zcode/ui 同源选项）；切换即时生效；推理折叠块的信息密度随档位变化。
- **实现拆解**：与 F-11 同层封装；档位持久到会话元数据。
- **验收标准**：
  - AC-F12-1：在低档位下提问复杂问题 → 推理块明显少于高档位同一问题。
  - AC-F12-2：在切换深度后 resume 会话 → 档位保持（会话元数据持久）。
  - AC-F12-3：在 setThoughtLevel 失败的注入场景 → UI 回滚并提示，会话可继续。

#### F-13 会话模式 【A+ · S】
- **协议/依赖**：`session/setMode`（zcodeSessionModeSchema，值域 [待核实 Q5]）+ `create/resume.mode`｜S+V+U
- **UI 交互**：入口=顶栏模式选择；若值域含计划模式则显示"计划/执行"二态切换；切换生效插入系统行。
- **实现拆解**：同 F-11/12 封装；值域核实后动态渲染选项。
- **验收标准**：
  - AC-F13-1：在会话中切换模式 → 消息流系统行确认且下一轮行为对应模式。
  - AC-F13-2：在 create 时选择模式 → 会话以该模式创建。
  - AC-F13-3：在模式值仅含非计划档的 CLI 上 → 选择器只显示实际支持项（不出现无效选项）。

#### F-14 子代理面板 【A+ · M】
- **协议/依赖**：`session/subagents`（revision/childSessionIds/running[running|waiting|blocked]/ended[success|failed|cancelled|lost]+nextCursor）｜S+V+U
- **UI 交互**：turn 内派生子代理时时间线出现子代理卡（名称+状态徽标实时流转）；点击卡片打开抽屉：running 列表（状态徽标）+ ended 列表（分页"加载更多"，nextCursor）；无子代理时不显示任何入口。
- **实现拆解**：按 revision 增量刷新（host 桥拉取+store diff）；@zcode/ui 列表/徽标组件。
- **验收标准**：
  - AC-F14-1：在 Agent 派生 3 个子代理的任务中 → 时间线出现 3 张卡且状态从 running 流转到 ended。
  - AC-F14-2：在子代理 blocked 状态下 → 徽标显示 blocked 并有说明 tooltip。
  - AC-F14-3：在 ended 超过一页的场景 → "加载更多"按 nextCursor 追加，无重复项。
  - AC-F14-4：在无子代理的纯对话会话 → 面板/卡片不出现。
  - AC-F14-5：在子代理会话终止（lost）的场景 → 卡片显示丢失态而非永远转圈。

#### F-15 运行时偏好协商 【B · S】
- **协议/依赖**：`session/requestRuntimePreferences`、`subagents/readRuntimeConfig`｜S+V
- **UI 交互**：无独立 UI；宿主侧应答通道（CLI 请求 → 插件按策略应答）。
- **实现拆解**：桥层注册请求处理器；默认策略常量表。
- **验收标准**：
  - AC-F15-1：在 CLI 发起运行时偏好请求的状态下 → 插件在超时窗口内按默认策略应答，CLI 侧不悬挂。
  - AC-F15-2：在处理器抛异常的注入场景 → 返回结构化失败而非无响应。

#### F-16 会话调试通道 【✕】
- **协议/依赖**：`session/debug`｜不做。原因：运维诊断通道，编辑器用户不可达；调试需求由开发者工具面板（F-59..61）与 CLI 覆盖。

### 2.2 历史导入

#### F-17 Claude Code 历史导入 【A+ · M】
- **协议/依赖**：`session/create.importedHistory`（`source:"claudeCode"`：title/createdAt/updatedAt/messages[]，schema 行 1086-1125）｜S+V+P
- **UI 交互**：入口=命令面板 `ZCodium: 导入 Claude Code 会话` + 会话列表空态"从 Claude Code 导入"；向导三步（QuickPick 串联）：① 选项目（`~/.claude/projects/` 下列目录）② 选会话（标题/时间/条数预览）③ 导入并自动打开新会话；onboarding 联动=检测到 `~/.claude` 时首次引导提示"检测到 Claude Code 历史，可一键导入"；错误态=文件损坏/超大（attachmentMaxBytes 上限）→ 列出问题文件并支持"跳过并导入其余"。
- **实现拆解**：插件侧 jsonl 解析器（映射 `zcodeSessionImportMessageSchema`，字段规范待 Q4）在 extension host 执行（非 UI 线程），大文件流式逐行解析；host 层组装 create 调用；解析结果缓存条数预览。
- **验收标准**：
  - AC-F17-1：在存在真实 Claude Code jsonl 历史的状态下完成导入 → 新会话打开、历史可回放、可直接继续对话。
  - AC-F17-2：在选择会话步骤 → 预览条数与实际导入消息数一致（±0）。
  - AC-F17-3：在选中文件含损坏行的场景 → 损坏行被跳过并提示"N 行无法解析"，其余正常导入。
  - AC-F17-4：在导入完成后的文件系统检查 → 原 jsonl 未被修改或删除。
  - AC-F17-5：在 `~/.claude` 目录不存在的状态下打开入口 → 显示"未检测到 Claude Code 历史"，不报错。
  - AC-F17-6：在导入超大文件触发协议上限的场景 → 明确提示上限与跳过选项，不静默截断。

#### F-18 分享上下文导入 【B · M】
- **协议/依赖**：`importedHistory`（`source:"sharedContext"`：title/markdown/provenance{shareId, sha256 校验, installedArtifacts}）｜S+V+U
- **UI 交互**：入口=命令面板 `ZCodium: 导入分享上下文`；粘贴分享链接/ID → 预览标题与 artifacts 清单 → 导入；校验失败显示"上下文校验不通过"。
- **实现拆解**：sha256（markdownSha256/artifactSetSha256/projectionSha256）前置校验；artifacts 落盘到 workspace 相对路径。
- **验收标准**：
  - AC-F18-1：在持有合法 shareId 的状态下导入 → 新会话建立且 markdown 上下文与 artifacts 就位。
  - AC-F18-2：在 sha 不匹配的注入场景 → 拒绝导入并提示校验失败原因。
  - AC-F18-3：在 artifacts 目标路径已存在同名文件的场景 → 冲突提示（覆盖/跳过）而非静默覆盖。

### 2.3 会话配置参数

#### F-19 工作区绑定/多根 folder 【A · S】
- **协议/依赖**：`session/create.workspace`（zcodeWorkspaceRefSchema）｜S+V+P
- **UI 交互**：多根工作区顶栏显示 folder 徽标，点击弹 QuickPick（列出全部 folder + "新建到…"）；单根工作区不显示；会话列表项标注归属 folder；**设计决策：每 folder 独立会话**（拒绝单会话换 folder，防上下文污染）。
- **实现拆解**：vscode.workspace.workspaceFolders 枚举；会话元数据持久 folder 归属；列表按 folder 分组排序。
- **验收标准**：
  - AC-F19-1：在双 folder 工作区为 folderA 建会话后下发文件修改任务 → Agent 仅操作 folderA 内文件。
  - AC-F19-2：在单根工作区状态下 → 顶栏无 folder 选择器（无冗余 UI）。
  - AC-F19-3：在 folderA 会话中切换到 folderB → 进入 folderB 最近会话（或弹"新建/选择"），不共用会话。
  - AC-F19-4：在工作区移除某 folder 后 → 其归属会话标注"folder 已移除"并禁止新建任务（可查看历史）。

#### F-20 附加目录 【A+ · S】
- **协议/依赖**：`additionalDirectories`（create/resume，max 256）｜S+V+P
- **UI 交互**：设置 `zcodium.context.additionalDirectories`（VS Code settings UI，目录选择器逐个添加）；>256 时设置项标红报错。
- **实现拆解**：settings 读取 → create/resume 透传；路径展开（~ 与变量）。
- **验收标准**：
  - AC-F20-1：在配置 1 个工作区外目录后新建会话 → Agent 可读取该目录内文件。
  - AC-F20-2：在移除该目录后新建的会话 → 参数不再携带（旧会话不受影响）。
  - AC-F20-3：在配置 257 个目录的边界场景 → 保存被拒并提示上限 256。
  - AC-F20-4：在配置含不存在路径的场景 → 保存时警告但不阻断（运行时由 Agent 侧报错）。

#### F-21 父/子任务会话 【B · M】
- **协议/依赖**：`session/create.parentSessionId`｜S+V
- **UI 交互**：会话详情显示父会话链接（点击跳转）；子代理卡提供"提升为独立会话"动作（联动 F-14）。
- **实现拆解**：创建时带 parentSessionId；列表渲染层级缩进/前缀。
- **验收标准**：
  - AC-F21-1：在以 parentSessionId 创建会话后 → 列表中显示父子层级关系。
  - AC-F21-2：在移除父会话的场景 → 子会话保留且链接降级为纯文本。
  - AC-F21-3：在从子代理卡提升会话后 → 新会话继承子代理上下文并可独立对话。

#### F-22 持久化开关 【B · S】
- **协议/依赖**：`session/create.persistence`（zcodeSessionPersistenceSchema）｜S+V
- **UI 交互**：会话级设置开关（会话菜单"持久化"勾选）。
- **实现拆解**：create 时透传；默认值取设置 `zcodium.session.persistence`。
- **验收标准**：
  - AC-F22-1：在关闭持久化的会话中对话并重启 CLI 后 → `session/list` 不再返回该会话。
  - AC-F22-2：在开启持久化的对照组会话 → 重启后正常出现在列表。

#### F-23 标题自动生成 【A+ · S】
- **协议/依赖**：`session/create.titleGenerationEnabled`｜S+V
- **UI 交互**：设置 `zcodium.session.titleGeneration`（默认开）；关闭后列表标题回退为首条用户消息截断摘要。
- **实现拆解**：create 透传；列表渲染优先取会话 title 字段。
- **验收标准**：
  - AC-F23-1：在默认开启状态下新建会话并完成首轮 → 列表项自动出现生成的标题。
  - AC-F23-2：在关闭开关后新建的会话 → 永不生成标题，显示首条消息摘要。
  - AC-F23-3：在切换开关后 → 已有标题保留不回写。

#### F-24 MCP 配置注入 【A · M】
- **协议/依赖**：`session/create\|resume.mcpServers`（zcodeProtocolMcpServerSchema：stdio/http）｜S+V+P
- **UI 交互**：设置页 `zcodium.mcp.servers`（JSON 编辑器 + 表单二态：command/args/env/url/headers 字段表单）；保存时 schema 校验，失败标红字段禁保存；保存成功后横幅"配置将在新会话生效"；env 密钥字段（命名含 token/secret/key）掩码显示。
- **实现拆解**：settings（工作区级）存储；create/resume 透传；**协议局限（UI 明示）**：无 `mcp/add\|remove` 方法，运行中动态增删不可行，改动需重建会话生效。
- **验收标准**：
  - AC-F24-1：在配置合法 stdio MCP（command 可执行）后新建会话 → F-39 状态条显示该服务器已连接。
  - AC-F24-2：在缺少必填字段（stdio 缺 command）的场景 → 保存被拒且字段标红提示。
  - AC-F24-3：在修改配置后的当前会话中查看 → MCP 面不变（旧配置），新建会话使用新配置。
  - AC-F24-4：在 env 配置含 `API_TOKEN` 字段的场景 → UI 显示 `••••`，点显需二次确认。
  - AC-F24-5：在 headers 配置非法 JSON 的场景 → 保存被拒并定位到错误行。

#### F-25 工具 allow/denylist 【A · M】
- **协议/依赖**：`toolAllowlist`/`toolDenylist`（create+resume；与 CLI `--disallowed-tools` 归一化同语义：`Tool`、`Tool(args)`、`web_search`→`WebSearch`）｜S+V+P
- **UI 交互**：设置 `zcodium.permissions.allowlist/denylist`（数组编辑器，每行一条规则，附格式提示）；P0-8 审批卡新增"记住此选择（写入 allowlist）"勾选（勾选后点允许=写 settings+确认提示）；denylist 规则被触发时 UI 显示"工具 X 已被 denylist 拒绝"。
- **实现拆解**：归一化函数（大小写/空格/web_search 映射）与 CLI 行为对齐（vitest 用例共享）；create 与 resume **均携带**（协议注释：resume 不带会绕过约束）。
- **验收标准**：
  - AC-F25-1：在 allowlist 配置 `Bash(git status*)` 后触发该命令 → 不弹审批直接执行（时间线上显示"自动允许（规则）"）。
  - AC-F25-2：在 denylist 配置 `WebSearch` 后 Agent 尝试调用 → 调用被拒且 UI 展示拒绝原因。
  - AC-F25-3：在崩溃后 resume 场景 → 两列表仍生效（AC-F02-2 复验点）。
  - AC-F25-4：在审批卡勾选"记住此选择"并允许后 → settings 出现对应规则且下一会话生效。
  - AC-F25-5：在输入 `bash (GIT STATUS)` 混合大小写/空格规则 → 归一化为等价规则后匹配。
  - AC-F25-6：在 allow/deny 同一工具冲突的场景 → deny 优先（文档明示）。

#### F-26 灰度门禁透传 【B · S】
- **协议/依赖**：`offPeakToolEnabled`、`dynamicWorkflowEnabled`/`dynamicWorkflowMode`（onDemand/alwaysOn）｜S+V
- **UI 交互**：设置高级区三控件（开关×2 + 模式下拉），默认关闭，注释"由服务端套餐准入校验，本地开关仅为透传"。
- **实现拆解**：create 透传；host 裁决失败的结果映射为功能入口隐藏（联动 F-62）。
- **验收标准**：
  - AC-F26-1：在开启 dynamicWorkflow 后新会话 → 工作流工具簇注册（/workflow 可触发）。
  - AC-F26-2：在 host 裁决拒绝（无套餐）的注入场景 → 对应功能入口隐藏且设置页提示原因。
  - AC-F26-3：在 onDemand 模式下 → 工具推迟到首次显式触发才注册（行为验证）。

### 2.4 Workspace 偏好

#### F-27 自定义系统提示词 【A · S】
- **协议/依赖**：`workspace/updateSystemPrompt`（空串=恢复内置默认）｜S+V+U
- **UI 交互**：入口=workspace 设置页（侧栏齿轮 →"自定义指令"）；多行文本框+字数统计+"恢复默认"按钮；保存即写穿协议方法生效；CLAUDE.md 类规则文件自动读取待 Q3（若有→增加"从文件同步"按钮）。
- **实现拆解**：host 桥封装 workspace 级方法；store 按 workspaceUri 缓存当前值。
- **验收标准**：
  - AC-F27-1：在设置指令"每次回复末尾追加 [OK]"后发起新 turn → 回复末尾含 [OK]。
  - AC-F27-2：在点击恢复默认后的新 turn → 行为还原（无 [OK]）。
  - AC-F27-3：在双 workspace 分别设置不同指令 → 各自生效互不串扰。
  - AC-F27-4：在设置含 5000 字长文本的场景 → 保存成功（协议无长度上限则透传，UI 仅提示长度）。

#### F-28 分段系统提示词 【A+ · M】
- **协议/依赖**：`workspace/updateSystemSegments`（空对象=全部恢复继承）｜S+V+U
- **UI 交互**：分段编辑器（预设/项目/用户三层，各段独立启停开关+文本域）；"全部恢复继承"按钮。
- **实现拆解**：与 F-27 同层；段结构按 schema 键值映射。
- **验收标准**：
  - AC-F28-1：在仅禁用"项目"段后新 turn → 该段指令失效、其余段仍生效（构造可验证指令）。
  - AC-F28-2：在全部恢复继承后 → 行为与未设置时一致。
  - AC-F28-3：在单段超长文本场景 → 保存成功且仅该段生效变化。

#### F-29 回复语言偏好 【A+ · S】
- **协议/依赖**：`workspace/updateLanguagePreference`（空串=跟随用户消息）｜S+V
- **UI 交互**：设置下拉（English/中文/日本語/跟随用户消息…）；保存即生效。
- **实现拆解**：同 F-27 封装；默认值=空。
- **验收标准**：
  - AC-F29-1：在偏好设为 English 后用中文提问 → 回复为英文。
  - AC-F29-2：在偏好恢复"跟随用户消息"后 → 恢复混答行为。
  - AC-F29-3：在偏好切换后新会话 → 设置保持（workspace 级持久）。

#### F-30 交互偏好 【B · S】
- **协议/依赖**：`workspace/updateInteractionPreferences`｜S+V
- **UI 交互**：设置页交互选项组（按 schema 字段动态渲染）。
- **实现拆解**：通用 workspace 偏好表单组件（F-30/31/32/33/34 共用）。
- **验收标准**：
  - AC-F30-1：在修改任一交互选项后重启插件 → 值保持（写穿 CLI 持久）。
  - AC-F30-2：在老 CLI method-not-found 场景 → 该设置组隐藏（静默降级模式）。

#### F-31 模型 IO 偏好 【B · S】
- **协议/依赖**：`workspace/updateModelIoPreferences`｜S+V
- **UI 交互**：设置页 IO 选项组（同 F-30 模式）。
- **实现拆解**：同 F-30 组件。
- **验收标准**：
  - AC-F31-1：在修改 IO 选项后 → 读回一致且新 turn 生效。
  - AC-F31-2：在非法值注入场景 → 表单校验拦截。

#### F-32 删除保护 【A+ · S】
- **协议/依赖**：`workspace/updateDeleteProtectionPreferences`（deleteProtectionEnabled + batchDeleteApprovalThreshold 1..10000）｜S+V
- **UI 交互**：设置开关+阈值数字输入（1-10000 越界校验）；老 CLI method-not-found → 设置组自动隐藏（协议既定静默降级模式）。
- **实现拆解**：同 workspace 偏好组件；能力探测联动 F-62。
- **验收标准**：
  - AC-F32-1：在开启保护且阈值为 5 的状态下让 Agent 批量删除 6 个文件 → 触发审批卡列出文件清单。
  - AC-F32-2：在删除数量 ≤ 阈值的场景 → 不触发批量删除审批（走常规流程）。
  - AC-F32-3：在阈值输入 0 或 10001 的场景 → 表单拦截。
  - AC-F32-4：在不支持该方法的旧 CLI 上 → 设置组不渲染（无报错）。

#### F-33 Off-Peak 工具策略 【B · S】
- **协议/依赖**：`workspace/updateOffPeakToolPolicy`｜S+V
- **UI 交互**：策略设置组（联动 F-26/F-52）；"随 agent 就绪同步"语义在帮助文案说明。
- **实现拆解**：workspace 偏好组件；与 create.offPeakToolEnabled 联动。
- **验收标准**：
  - AC-F33-1：在写入策略后新建会话 → 工具面按策略装配（行为验证）。
  - AC-F33-2：在不支持该方法的 CLI 上 → 设置组隐藏。

#### F-34 动态工作流策略 【B · S】
- **协议/依赖**：`workspace/updateDynamicWorkflowPolicy`｜S+V
- **UI 交互**：策略设置组（联动 F-26/F-48）。
- **实现拆解**：同 F-33。
- **验收标准**：
  - AC-F34-1：在写入策略后 → 新会话工作流门禁按策略生效。
  - AC-F34-2：在不支持的 CLI 上 → 隐藏。

#### F-35 hooks 信任授权 【B · S】
- **协议/依赖**：`workspace/hooks/trustGrant`｜S+V+U
- **UI 交互**：项目首次声明 hooks 时弹信任对话框（列出 hook 名称+内容摘要+风险提示）；信任/拒绝；拒绝记忆在 workspace 级（设置可重置）。
- **实现拆解**：监听 hook 声明事件 → 弹窗 → 应答 trustGrant。
- **验收标准**：
  - AC-F35-1：在信任授权后 → hooks 正常执行（触发一次可观测 hook 验证）。
  - AC-F35-2：在拒绝后同一 workspace 再次加载 → 不再弹窗且 hooks 不执行。
  - AC-F35-3：在设置中重置信任后 → 下次重新弹窗。

**F-36 workspace/readPresentation 【✕】** — host 内部投影读路径，非插件命令面。
**F-37 workspace/generateText(+cancel) 【✕】** — services 内部消费（commit message 等），v4 收敛中，非插件命令面。

### 2.5 MCP

#### F-38 MCP 配置注入 【A · =F-24 协议通道】
- **协议/依赖**：`session/create\|resume.mcpServers`｜S+V+P
- **UI 交互**：与 F-24 同一配置面；本项为协议通道验收（参数确实下发并被运行时消费）。
- **实现拆解**：F-24 settings → host 桥组装 mcpServers 数组 → create/resume 携带。
- **验收标准**：
  - AC-F38-1：在配置 2 个 MCP 后新建会话 → 抓包/日志确认 create.params.mcpServers 含 2 项且字段符合 zcodeProtocolMcpServerSchema。
  - AC-F38-2：在 resume 场景 → resume.params.mcpServers 同样携带（非仅 create）。
  - AC-F38-3：在未配置 MCP 的状态下 → 参数字段缺席（不发空数组，符合 .optional() 语义）。

#### F-39 MCP 状态列表 【A · S】
- **协议/依赖**：`mcp/list`（mode: connect/status；params.mcpServers 可传候选列表做预检）｜S+V+U
- **UI 交互**：入口=会话头部 MCP 状态条（● N connected / 失败数 / 工具计数 / 刷新按钮）；点击展开明细列表（服务器名/传输类型/状态/工具数/错误摘要）；设置页"测试此配置"按钮（预检，不建会话）；未配置 MCP 时状态条整体隐藏。
- **实现拆解**：状态拉取（mcp/list）+ 手动刷新 + 事件辅助（mcpTelemetry，B 档 F-61）；预检走候选 mcpServers 参数。
- **验收标准**：
  - AC-F39-1：在已配 2 个可用 MCP 的会话中 → 状态条显示"2 connected"且明细各含工具计数。
  - AC-F39-2：在 kill 一个 MCP 子进程后点刷新 → 该项显示失败并附 stderr 摘要，其余不受影响。
  - AC-F39-3：在设置页点击"测试此配置" → 不创建会话即返回每项连接结果（成功/失败+原因）。
  - AC-F39-4：在未配置任何 MCP 的状态下 → 状态条不渲染（不显示"0 connected"占位）。
  - AC-F39-5：在 mcp/list 调用超时的场景 → 状态条显示"状态未知"+重试按钮，不阻塞对话。

#### F-40 MCP 资源读取 【B · S】
- **协议/依赖**：`mcp/readResource`｜S+V+U
- **UI 交互**：Agent 引用 MCP 资源时消息内资源卡"查看"→ 详情面板（内容渲染+来源服务器标注）；资源不存在时错误提示。
- **实现拆解**：资源卡组件 + readResource 拉取渲染（文本/JSON 高亮）。
- **验收标准**：
  - AC-F40-1：在点击有效资源卡后 → 面板展示资源内容与来源。
  - AC-F40-2：在资源已被删除的场景 → "资源不存在"错误态+重试。

#### F-41 MCP Apps 富交互 【B · L】
- **协议/依赖**：`mcpUi*` 15 方法（uiOpenInstance/close/validate/sampling+cancelSampling/callTool+cancelCall/uiReadResource/listResources/listResourceTemplates/subscribeResource/unsubscribeResource/registerAppTools/unregisterAppTools/claimAppToolCall/resolveAppToolCall）｜S+V+U
- **UI 交互**：Agent 调用 MCP App → Webview 打开 App 实例面板（生命周期：打开/交互/关闭）；sampling 请求弹授权卡（查看请求内容→批准/拒绝/取消）；App 工具调用走信箱认领/回传（认领后超时未回传自动失败并提示）。
- **实现拆解**：Webview 内承载 MCP UI 实例（沙箱/CSP 评估是前置，见 Q1）；信箱模式对接 v4 live 增量；App 工具注册表与会话生命周期绑定。
- **验收标准**：
  - AC-F41-1：在 Agent 打开 MCP App 的场景 → 实例面板打开、可交互、关闭后资源释放（无悬挂定时器）。
  - AC-F41-2：在收到 sampling 请求的场景 → 授权卡展示完整请求；批准后结果回传 Agent；取消后 Agent 收到取消。
  - AC-F41-3：在 app tool call 认领后不回传的场景 → 超时自动失败并通知 Agent（无死等）。
  - AC-F41-4：在会话关闭时存在活跃实例 → 实例被强制关闭并清理注册表。

#### F-42 Official MCP 认证 【B · S】
- **协议/依赖**：`interaction/requestOfficialMcpAuthHeaders`｜S+V+P
- **UI 交互**：官方 MCP 服务需要认证时弹请求卡（说明+登录引导链接+token 粘贴框）；取消=取消应答。
- **实现拆解**：交互请求处理器（同 F-55/57 模式）；头信息加密存会话期。
- **验收标准**：
  - AC-F42-1：在提供有效认证头后 → MCP 连接成功。
  - AC-F42-2：在点击取消的场景 → Agent 收到取消结果，连接失败提示可重试。
  - AC-F42-3：在 token 粘贴含前后空白的场景 → 自动 trim。

### 2.6 插件/技能生态

#### F-43 插件浏览 【B · M】
- **协议/依赖**：`plugins/list`、`plugins/overview`、`plugins/referenceCatalog(+WithCategory)`、`plugins/listUiSurfaces`｜S+V+U
- **UI 交互**：独立面板"ZCodium 插件"（Activity Bar 次级视图或命令面板打开）：三页签=已安装/可用/目录（分类过滤）；条目卡片=名称/版本/描述/启停状态徽标；UI surfaces 列表可点击定位对应面板。
- **实现拆解**：host 桥批量拉取+store 缓存；@zcode/ui 列表/页签组件。
- **验收标准**：
  - AC-F43-1：在三页签间切换 → 数据一致（同一插件三处状态相同）。
  - AC-F43-2：在目录页选择分类 → 过滤即时生效且计数正确。
  - AC-F43-3：在 list 调用失败的场景 → 页签显示错误态+重试，不白屏。

#### F-44 插件生命周期 【B · M】
- **协议/依赖**：`plugins/install\|uninstall\|update\|restoreBuiltin\|cancelOperation` + 事件 `plugins/operationProgress`｜S+V+U
- **UI 交互**：安装/更新按钮 → 进度条（百分比+阶段文案）+ 取消按钮；卸载 → 确认框（含"保留数据"选项，对齐 CLI `--keep-data`）；内置插件 → "恢复"按钮。
- **实现拆解**：operationProgress 事件驱动进度；操作队列（同时仅一个安装操作）。
- **验收标准**：
  - AC-F44-1：在安装过程中 → 进度条实时推进，完成后列表自动刷新出现新条目。
  - AC-F44-2：在点取消的场景 → 操作中止、状态回滚为未安装、无半装残留。
  - AC-F44-3：在卸载勾选"保留数据"后重装 → 原配置/数据仍在。
  - AC-F44-4：在并发触发两个安装的场景 → 第二个提示"已有操作进行中"。

#### F-45 插件市场 【B · S】
- **协议/依赖**：`plugins/marketplace/add\|remove\|update`｜S+V+U
- **UI 交互**：市场源管理页：列表（URL+状态）+ 添加输入框 + 移除/更新按钮；无效 URL 添加报错不入库。
- **实现拆解**：简单 CRUD 面板复用 host 桥。
- **验收标准**：
  - AC-F45-1：在添加合法市场源后 → 目录页出现该源条目。
  - AC-F45-2：在添加非 URL 文本的场景 → 校验报错且列表不变。
  - AC-F45-3：在移除市场源后 → 其条目从目录消失（已装插件不受影响）。

#### F-46 插件配置 【B · M】
- **协议/依赖**：`plugins/configure\|resetConfig\|validate\|describe\|setEnabled\|plugins/resolveSuggestedReference`｜S+V+U
- **UI 交互**：插件详情页：describe 结果驱动的配置表单（字段类型动态渲染）→ 保存（configure）→ validate 结果徽标（通过/错误列表）；启用开关（setEnabled）；resetConfig 需确认。
- **实现拆解**：describe schema → 表单生成器；校验结果映射到字段级错误。
- **验收标准**：
  - AC-F46-1：在 describe 返回含必填字段的 schema 后 → 表单渲染对应控件且未填时 validate 报错定位字段。
  - AC-F46-2：在保存合法配置后 validate → 通过徽标显示。
  - AC-F46-3：在 setEnabled 关闭后 → 该插件提供的工具从 Agent 工具面消失（行为验证）。
  - AC-F46-4：在 resetConfig 确认后 → 表单恢复默认值。

#### F-47 技能目录 【B · S】
- **协议/依赖**：`skills/referenceCatalog` + `plugins/resolveSuggestedReference`｜S+V+U
- **UI 交互**：技能浏览/搜索面板（搜索框+列表）；条目"插入引用"→ 输入框写入引用标记（对标 CC skills 调用）。
- **实现拆解**：目录拉取+本地过滤；resolveSuggestedReference 生成插入文本。
- **验收标准**：
  - AC-F47-1：在搜索框输入关键词后 → 列表即时过滤。
  - AC-F47-2：在点击"插入引用"后 → 输入框出现正确引用标记且发送后 Agent 感知该技能。
  - AC-F47-3：在目录为空的工作区 → 面板空态"当前工作区无可用技能"。

### 2.7 工作流

#### F-48 工作流管理 【B · M】
- **协议/依赖**：`workflows/list\|get\|updateMeta\|delete\|move`（项目档/全局档）｜S+V+U
- **UI 交互**：工作流库面板：列表（归属档标：项目/全局）、查看（get 详情）、重命名/改描述（updateMeta）、删除（确认）、跨档移动（move，同名冲突提示）；命令面板 `ZCodium: 打开工作流库`。
- **实现拆解**：host 桥 CRUD 封装；冲突检测前置。
- **验收标准**：
  - AC-F48-1：在两档均有工作流时打开库 → 分组展示且档标正确。
  - AC-F48-2：在 move 到已存在同名目标档的场景 → 冲突提示（覆盖需二次确认/取消）。
  - AC-F48-3：在删除确认后 → 列表即时移除且 get 不再返回。
  - AC-F48-4：在 updateMeta 修改标题后 → 列表与详情同步更新。

#### F-49 工作流保存 【B · S】
- **协议/依赖**：`workflows/save`、`workflows/forRun`｜S+V+U
- **UI 交互**：turn 完成卡"保存为工作流"按钮（命名输入+档位选择）；已保存的 run 显示"已保存"态（forRun 判定）而非重复保存按钮。
- **实现拆解**：按 runId 从 journal 取脚本落盘（协议注释语义）。
- **验收标准**：
  - AC-F49-1：在完成卡点击保存并命名后 → 工作流库出现该条目。
  - AC-F49-2：在同一 run 的完成卡再次查看 → 显示"已保存"而非保存按钮。
  - AC-F49-3：在保存重名工作流的场景 → 提示已存在（覆盖需确认）。

#### F-50 工作流运行记录 【B · S】
- **协议/依赖**：`workflows/runs`｜S+V+U
- **UI 交互**：工作流详情"运行历史"页签：时间/状态/时长列表；点击可跳转对应会话记录。
- **实现拆解**：runs 拉取+分页。
- **验收标准**：
  - AC-F50-1：在执行过 3 次的工作流详情 → 历史含 3 条且状态正确。
  - AC-F50-2：在点击某条记录后 → 跳转到对应会话的消息位置。

### 2.8 自动化/闲时任务

#### F-51 定时任务 【B · M】
- **协议/依赖**：`automation/create\|list\|update\|delete\|checkTaskBinding`｜S+V+U
- **UI 交互**：定时任务面板：任务列表（cron/提示词摘要/绑定会话/上次运行状态）+ 新建表单（cron 输入带下次运行时间预览 + 提示词 + 绑定会话选择）；checkTaskBinding 用于绑定校验；删除确认。
- **实现拆解**：CRUD 封装 + cron 校验（本地预览 + 服务端为准）。
- **验收标准**：
  - AC-F51-1：在创建每分钟任务后 → 到点触发且列表状态更新为运行中→完成。
  - AC-F51-2：在绑定会话被删除后的场景 → checkTaskBinding 校验失败且列表项显示"绑定失效"徽标。
  - AC-F51-3：在输入非法 cron 的场景 → 表单拦截并显示解析错误。
  - AC-F51-4：在删除确认后 → 任务不再触发。

#### F-52 闲时任务 【B · M】
- **协议/依赖**：`offPeak/create\|list` + `create.offPeakToolEnabled`｜S+V+U
- **UI 交互**：闲时任务入口（任务面板页签）：创建表单（提示词+是否启用 offPeak 工具面）+ 队列列表（状态）。
- **实现拆解**：与 F-26/F-33 策略联动；未开工具面时的能力提示。
- **验收标准**：
  - AC-F52-1：在创建闲时任务后 → 出现在队列且状态随执行流转。
  - AC-F52-2：在未开 offPeakToolEnabled 的场景创建 → 提示"工具面受限，部分操作将不可用"。
  - AC-F52-3：在空闲时段实际执行 → 行为与普通会话一致且结果可查看。

### 2.9 Provider/账户

#### F-53 账户/端点配置 【B · M】
- **协议/依赖**：`provider/updateAccountConfig`、`provider/refreshRegistry`｜S+V+P
- **UI 交互**：账户配置页：供应商/端点 URL/凭据（掩码）表单 + "刷新模型注册表"按钮；保存后 F-11 模型下拉自动更新；无效配置保存报错。
- **实现拆解**：表单 → updateAccountConfig；refreshRegistry 后重拉模型列表。
- **验收标准**：
  - AC-F53-1：在配置新端点并刷新注册表后 → F-11 下拉出现新模型。
  - AC-F53-2：在端点 URL 非法的场景 → 保存拦截。
  - AC-F53-3：在凭据字段渲染 → 掩码显示。

#### F-54 模型连通性测试 【B · S】
- **协议/依赖**：`provider/testModelConnectivity`｜S+V
- **UI 交互**：配置页每条模型配置旁"测试连接"按钮 → 结果徽标（成功+延迟 ms / 失败+错误摘要）。
- **实现拆解**：单模型测试封装；结果不缓存。
- **验收标准**：
  - AC-F54-1：在可用模型上测试 → 成功徽标+延迟值。
  - AC-F54-2：在错误凭据上测试 → 失败徽标+可读错误（如 401）。
  - AC-F54-3：在测试进行中重复点击 → 禁用防重。

#### F-55 Provider 运行时头 【B · S】
- **协议/依赖**：`interaction/requestProviderRuntimeHeaders`｜S+V+P
- **UI 交互**：代理网关需要认证头时弹请求卡（说明来源+键值输入）；取消=取消应答。
- **实现拆解**：交互请求处理器（与 F-42/57 同框架）。
- **验收标准**：
  - AC-F55-1：在提供头后 → 后续 provider 请求携带该头成功。
  - AC-F55-2：在取消的场景 → Agent 侧得到取消，不悬挂。
  - AC-F55-3：在头的 value 含敏感串的场景 → UI 输入态掩码可选。

### 2.10 交互（Agent → 宿主）

#### F-56 权限审批 【A · S（回归）】
- **协议/依赖**：`interaction/requestPermission`（基线 P0-7/8）｜S+V+U
- **UI 交互**：迁移 @zcode/ui 同源审批卡：diff 审批卡（文件/摘要/[打开 Diff]/应用/拒绝）+ 命令审批卡（命令全文/允许一次/本次会话允许/拒绝+"记住"联动 F-25）；非阻塞内联卡+状态栏角标 ⚠N；危险命令（rm/系统路径写入）升级 VS Code 警告对话框；超时未应答 → 会话恢复后重新呈现。
- **实现拆解**：IPlatformService 路由 diff 到 VS Code 原生 diff 编辑器（标题`[待审批] file.ts`）；审批状态机回归用例沿用基线。
- **验收标准**：
  - AC-F56-1：在新 UI 上重放 P0 全部审批场景（单文件 diff/多文件聚合/命令/拒绝后对话继续） → 行为与基线等价。
  - AC-F56-2:在审批等待中用户切换会话 → 请求保持 pending，切回后仍可应答。
  - AC-F56-3：在 turn 结束仍有未应答请求的场景 → 标记待处理，resume 后重新呈现。
  - AC-F56-4：在危险命令场景 → 升级为模态警告框（vs 信息卡）。
  - AC-F56-5：在 shim 无法路由原生 diff 的场景 → Webview 内嵌展示 diff 而非报错。

#### F-57 反向提问表单 【A+ · M】
- **协议/依赖**：`interaction/requestUserInput`｜S+V+U
- **UI 交互**：Agent 反向提问以 @zcode/ui ElicitationDialog 内联表单呈现（文本框/单选/多选/确认）；提交后 turn 继续；关闭表单=取消应答；表单出现时状态栏角标提示。
- **实现拆解**：交互请求框架（F-42/55 共用）+ ElicitationDialog 装配；字段 schema → 控件映射。
- **验收标准**：
  - AC-F57-1：在 Agent 发起含单选+文本的提问后 → 表单渲染正确、提交后 Agent 收到答案并继续 turn。
  - AC-F57-2：在直接关闭表单的场景 → 取消应答送达，turn 以取消收场不悬挂。
  - AC-F57-3：在必填项为空时提交 → 提交禁用/校验提示。
  - AC-F57-4：在提问等待中发生进程崩溃 → 恢复后该请求呈现为待处理（或按协议语义标记取消，实现定）。

#### F-58 browser-use 宿主执行器 【C · L】
- **协议/依赖**：`interaction/browserList`、`interaction/browserExecute`（协议反向请求已存在）；CLI 旗标 `--browser-use`/`--browser-executable`（启动配置面）；app-server 模式配置注入通道 [待架构师核实]｜S+V+P
- **UI 交互**：设置 `zcodium.browser.executablePath/mode(headless|headed)`；Agent 请求浏览器操作时 → 权限提示卡（显示目标 URL 与操作）→ 执行；状态栏显示浏览器进程活跃标识。
- **实现拆解**：BrowserExecutor 组件（launch/attach Chrome via CDP ws、指令路由、页面生命周期、崩溃回收）；仅插件层工作（协议面无需新增，详见 §3.1）。
- **验收标准**：
  - AC-F58-1：在启用 browser-use 的会话中让 Agent 打开网页截图 → 操作成功且结果回传（需 §3.1 立项后验收）。
  - AC-F58-2：在浏览器进程崩溃的场景 → executor 回收并提示 Agent 浏览器不可用。
  - AC-F58-3：在用户拒绝浏览器权限的场景 → Agent 收到拒绝并改用替代方案。

### 2.11 进程/资源观测

#### F-59 子进程列表 【B · S】
- **协议/依赖**：`process/childProcesses`｜S+V
- **UI 交互**：开发者面板（命令面板 `ZCodium: 打开开发者面板`）"进程"页签：MCP 子进程 pid/归属会话/命令行摘要；会话关闭后条目消失。
- **实现拆解**：拉取+刷新按钮；只读视图。
- **验收标准**：
  - AC-F59-1：在配置 2 个 MCP 的会话中打开面板 → 2 条子进程记录且归属正确。
  - AC-F59-2：在关闭该会话后刷新 → 对应条目消失。

#### F-60 网络观测 【B · M】
- **协议/依赖**：`process/networkCapture`（开关）、事件 `process/networkRequests`｜S+V
- **UI 交互**：开发者面板"网络"页签：采样开关+请求列表（方法/URL/状态/耗时，最新在上）；关闭采样停止采集并清空实时流。
- **实现拆解**：事件订阅+环形缓冲（防内存膨胀，上限 N 条）。
- **验收标准**：
  - AC-F60-1：在开启采样后发生模型调用 → 请求实时出现在列表。
  - AC-F60-2：在关闭采样的场景 → 新请求不再出现。
  - AC-F60-3：在超过缓冲上限（如 500 条）后 → 旧条目淘汰，内存不无限增长。

#### F-61 资源采样 【B · M】
- **协议/依赖**：事件 `process/resourceSample`、`process/mcpTelemetry`、`process/toolExecResource`｜S+V
- **UI 交互**：开发者面板"遥测"页签：CPU/内存迷你曲线+MCP 遥测表格；面板关闭即停采样（事件退订）。
- **实现拆解**：事件驱动采样缓冲；@zcode/ui 图表组件（或轻量 sparkline）。
- **验收标准**：
  - AC-F61-1：在面板打开期间 → 曲线按采样间隔刷新。
  - AC-F61-2：在面板关闭后 → 事件退订（注入采样验证无 UI 更新）。
  - AC-F61-3：在采样数据缺失（旧 CLI）场景 → 页签显示"当前 CLI 不支持遥测"。

### 2.12 运行时/用量

#### F-62 特性探测（横切） 【A · S】
- **协议/依赖**：`runtime/capabilities`｜S+V
- **UI 交互**：无独立 UI；驱动所有功能入口显隐；被降级功能的位置显示"当前 CLI 版本不支持"一次性说明（设置页可查看完整能力矩阵）。
- **实现拆解**：启动握手后拉取并缓存 globalState；能力集变化 → 广播刷新 UI；探测失败按最低能力集（P0 集合）降级。
- **验收标准**：
  - AC-F62-1：在旧 CLI（缺某方法）上启动 → 对应功能入口全部隐藏且设置页标注原因。
  - AC-F62-2：在 capabilities 调用失败的注入场景 → 按最低集降级，核心对话/审批仍可用。
  - AC-F62-3：在 CLI 升级后重启 → 能力集刷新，入口恢复。

#### F-63 computer-use/operation-event 【✕】— CUA 会话场景（电脑操作代理），编辑器边缘场景。
#### F-64 bot/channel/reply + topic/resource 【✕】— IM 机器人通道/话题资源，与编辑器无关。
#### F-65 startup/storageState 【✕】— host 启动内部存储状态，非插件命令面。

#### F-66 Token 用量展示 【A · S】
- **协议/依赖**：`turn.completed` 自带 `usage`+`cacheStats`（schema 行 1596-1602）；累计优先 v4 conversation/usage [待核实方法名]，缺省本地累加｜S+V+U
- **UI 交互**：每轮 turn 尾部用量行（输入/输出/缓存命中，默认折叠，点击展开）；会话头部 Σ 入口 → 明细弹层（各轮列表+合计）；缺 usage 的旧事件不渲染该行。
- **实现拆解**：turn 完成事件解析 → store 累加；格式化（token 数/缓存率%）。
- **验收标准**：
  - AC-F66-1：在每轮 turn 完成后 → 用量行出现且数值与事件字段一致。
  - AC-F66-2：在展开明细后 → 各轮列表合计=Σ 入口数值。
  - AC-F66-3：在旧事件缺 usage 字段的场景 → 不渲染用量行、不显示 NaN。
  - AC-F66-4：在 cacheStats 存在的场景 → 缓存命中率正确计算显示。

### 2.13 插件侧编辑器集成

#### F-67 @ 引用补全 【A · M】
- **协议/依赖**：协议无索引方法；VS Code workspace 文件索引；注入经 v4 sendText attachments/标记文本（格式由架构师定）｜P
- **UI 交互**：输入框输入 `@` → 文件补全列表（模糊匹配，限工作区文件，显示相对路径）；编辑器有选区时输入框上方出现"附带选中代码（文件名 Lx-Ly）"chip（×可移除，可多个不同文件）；@symbol 本期降级（Q3：若 LSP 零成本接入再升级，入口预留不渲染）。
- **实现拆解**：composer 补全列表（视 @zcode/ui composer 能力选内联列表或 QuickPick）；选区监听（activeTextEditor 变化）；引用载荷组装（截断上限+提示）。
- **验收标准**：
  - AC-F67-1：在输入 `@re` 后 → 匹配文件（如 readme.md）出现在补全列表，回车插入引用 chip。
  - AC-F67-2：在带引用 chip 的消息发送后 → Agent 回复内容证明读取了该文件。
  - AC-F67-3：在编辑器选中 3-10 行后 → chip 显示"文件名 L3-L10"，点 × 移除。
  - AC-F67-4：在选中 >400 行的场景 → chip 提示"内容过大将截断"并按上限截断。
  - AC-F67-5：在工作区无文件的场景 → 补全列表空态"未找到匹配文件"。

#### F-68 诊断一键发送 【A · S】
- **协议/依赖**：纯插件侧（协议无诊断注入方法；`zcodePluginDiagnosticSchema` 为插件包诊断，无关）｜P
- **UI 交互**：入口=输入框工具按钮"发送当前文件诊断"+命令面板 `ZCodium: 发送当前文件诊断`；两种范围（仅错误/错误+警告，按钮长按或次级菜单选择）；无诊断时按钮禁用+tooltip"当前文件无诊断"；注入内容=结构化清单（文件/行/列/severity/消息/相关代码行）。
- **实现拆解**：`vscode.languages.getDiagnostics(activeEditor.uri)` → 格式化模板 → 填充输入框（可编辑后发送）。
- **验收标准**：
  - AC-F68-1：在当前文件含 2 错误 1 警告的状态下选择"仅错误" → 注入消息含 2 条结构化诊断。
  - AC-F68-2：在无任何诊断的文件上 → 按钮禁用且 tooltip 说明。
  - AC-F68-3：在诊断注入后发送 → Agent 回复定位到对应行并给出修复建议。
  - AC-F68-4：在诊断超过 20 条的场景 → 合并为一条消息（TOP 20+汇总行），不刷屏。

#### F-69 崩溃自动重建 【A · M】
- **协议/依赖**：基线自动重启（退避）+ `session/resume`（沿用 mcpServers/allowlist/denylist/thoughtLevel）｜S+V+U
- **UI 交互**：崩溃 → 状态栏图标转红+横幅"Agent 已重启，正在恢复会话…"（旋转指示）→ 成功横幅"会话已恢复"（3s 自动消退）；resume 失败 → 横幅错误+双动作按钮"新建会话/从历史进入"；崩溃时进行中的 turn 标记"已中断"。
- **实现拆解**：重启编排（基线）→ 元数据恢复（globalState）→ resume → 回放（F-04）→ 事件重订阅；退避上限后停止重试转手动。
- **验收标准**：
  - AC-F69-1：在会话进行中 kill Agent 进程 → 自动重启且自动回到原会话（消息回放完整）。
  - AC-F69-2：在恢复完成后的审批/工具行为 → allowlist/MCP 约束与崩溃前一致。
  - AC-F69-3：在 resume 失败的注入场景 → 降级双动作按钮，UI 可操作不卡死。
  - AC-F69-4：在崩溃时 turn 进行中的场景 → 该 turn 显示"已中断"且可重新发起。
  - AC-F69-5：在连续崩溃 5 次的场景 → 停止自动重试，显示手动"重启 Agent"按钮。

#### F-70 引导与文档 【A · S】
- **协议/依赖**：无协议依赖｜P
- **UI 交互**：README 全量重写（安装/CLI 探测/功能总览=本期全部入口清单/FAQ/与桌面端和 CLI 的关系/故障排查）；首次打开侧边栏 onboarding 卡片（3 步上手，可跳过，globalState 记忆）；检测到 `~/.claude` 时 onboarding 追加"导入 Claude Code 历史"提示（联动 F-17）；CLI 缺失引导沿用基线。
- **实现拆解**：webview 空态组件+globalState 标志；README 维护在插件仓库。
- **验收标准**：
  - AC-F70-1：在全新安装状态下首次打开 → onboarding 卡片出现且 3 步文案正确。
  - AC-F70-2：在点击跳过后重开窗口 → onboarding 不再出现。
  - AC-F70-3：在存在 `~/.claude` 目录的机器上 → onboarding 含导入提示且可直达 F-17 向导。
  - AC-F70-4：在按 README 操作的新用户路径 → 15 分钟内完成首次对话→审批闭环（人工验收）。

#### F-71 diff/命令审批流迁移 【A · M】
- **协议/依赖**：基线 P0-7/8 → @zcode/ui 同源组件装配｜S+V+U
- **UI 交互**：diff=VS Code 原生 diff 编辑器（IPlatformService 路由，标题`[待审批] file.ts`）+ Webview 聚合变更清单卡（逐文件/一键全部审批）；命令=审批卡全文展示；降级=shim 不可路由时 Webview 内嵌 diff 视图。
- **实现拆解**：审批状态机回归（基线 vitest 用例迁移）；@zcode/ui 审批组件与桥层适配。
- **验收标准**：
  - AC-F71-1：在新 UI 重放 P0-7 全场景（单文件/多文件/全部应用/拒绝） → 等价行为。
  - AC-F71-2：在新 UI 重放 P0-8 全场景（允许一次/本次会话/拒绝） → 等价行为。
  - AC-F71-3：在多文件变更聚合卡点击"全部应用" → 逐文件应答且进度可见。
  - AC-F71-4：在 diff 打开状态下用户关闭 diff 编辑器 → 审批卡仍在 Webview 可应答。

#### F-72 检查点/回滚（对标 CC rewind） 【C · L】
- **协议/依赖**：协议词已根删（session/rewind/rewindCascade/previewFileRewind/applyFileRewind）；runtime 内部 `file-rewind.ts`/`workspace-checkpoints.ts`/`rewind-message.ts` 未暴露；事件 `message.removed`/`part.removed` 已存在可复用｜S+V
- **UI 交互（立项后）**：消息右键"回滚到此处"→ 预览面板（受影响文件+增删统计+diff）→ 确认后（强制审批）执行 → 会话回退到该消息点+文件恢复；级联回滚=会话状态一并回退。
- **实现拆解（立项后）**：依赖 §3.2 上游协议面重建；插件侧=预览面板+审批+回滚后 UI 状态重建。
- **验收标准**（立项后生效）：
  - AC-F72-1：在 Agent 已修改 2 文件后执行回滚到修改前检查点 → 磁盘文件恢复且会话消息回退。
  - AC-F72-2：在回滚确认前 → 必经审批卡（不可绕过）。
  - AC-F72-3：在部分文件选择回滚（fileScope）后 → 仅所选文件恢复。

#### F-73 Steering 任务中途转向 【C · M】
- **协议/依赖**：`session/steer` 词已根删（连同 prompt/enhance 全簇）；runtime 内部 `steering.ts`/`turn-guide-drain.ts` 未暴露｜S+V
- **UI 交互（立项后）**：turn 进行中输入框 placeholder 变为"插话（将在当前任务生效）"；发送即 steer（非新 turn）；插话以醒目样式插入消息流并标注"已注入当前任务"。
- **实现拆解（立项后）**：依赖 §3.3 上游命令面；插件侧=输入框模式切换+插入样式。
- **验收标准**（立项后生效）：
  - AC-F73-1：在 turn 进行中插话"改用 async 方案" → 当前 turn 的后续执行体现转向（无需停止重启）。
  - AC-F73-2：在 turn 空闲状态下发送 → 走普通新 turn（模式自动判定）。
  - AC-F73-3：在 compact 与 steer 并发的注入场景 → 无竞态崩溃（上游 drain 语义保证，冒烟验证）。

## 3. C 档立项草案（供用户决策）

### 3.1 F-58 browser-use 宿主执行器（C · L）
- **现状**：协议反向请求 `interaction/browserList`（列出可用浏览器）与 `interaction/browserExecute`（执行 CDP 指令）**已存在**；缺的是插件宿主侧 CDP executor（桌面端由 main 进程实现，插件侧无对应实现）。CLI 旗标 `--browser-use`/`--browser-executable` 仅覆盖 CLI 直跑形态。
- **需上游改动**：协议面**无需新增方法**；需确认 app-server 模式下 browser-use 配置的注入通道（环境变量/启动参数/workspace 偏好，待架构师核实）。
- **插件侧工作**：BrowserExecutor 组件（launch/attach Chrome via CDP ws、指令路由、页面生命周期、崩溃回收）；设置 `zcodium.browser.executablePath/mode`；VS Code 内权限提示与执行沙箱。
- **改动波及面**：仅插件层（P），不动 shared/services。
- **风险**：extension host 内管理浏览器进程的稳定性；无头/有头模式差异；企业代理环境。
- **工作量**：L（executor 本体 ~L + 配置/UX ~S）。
- **决策建议**：因协议面已备齐且不动上游，可考虑降档为"插件侧 B 档"单独评估排期。

### 3.2 F-72 检查点/回滚（C · L）
- **现状**：runtime 已有 checkpoint 持久化与文件级 rewind 实现（`workspace-checkpoints.ts`/`workspace-checkpoint-persistence.ts`/`file-rewind.ts`/`rewind-message.ts`/`stable-fork-boundary.ts`），但协议命令词被连根删除（session/rewind、rewindCascade、previewFileRewind、applyFileRewind，词表注释明示"承重类型已迁/死词已删"），插件无从调用。
- **上游协议方法建议**（v4 命令面，供架构师评审）：
  - `session/checkpoints/list`：params `{sessionId, cursor?}` → result `{checkpoints:[{id, turnId, createdAt, summary}], nextCursor?}`
  - `session/checkpoints/preview`：params `{sessionId, checkpointId}` → result `{affectedFiles:[{path, adds, dels}], diffRef}`
  - `session/checkpoints/apply`：params `{sessionId, checkpointId, fileScope[]}` → result `{appliedFiles[]}`（**强制**走 `interaction/requestPermission` 审批）
  - `session/checkpoints/cascade`（可选）：会话状态回退到 checkpoint 对应消息点
- **改动波及面**：shared（schema+方法表+event 复用 message.removed/part.removed）→ CLI server-operations（重新暴露 op，复用 runtime 实现）→ services 客户端 → 插件 UI（回滚菜单+预览面板+审批+回滚后状态重建）。
- **风险**：回滚与会话持久化/用量统计的一致性；审批不可绕过需在服务端强制；fork 边界（stable-fork-boundary）语义需一并明确。
- **工作量**：上游 M+L，插件 M。

### 3.3 F-73 Steering（C · M）
- **现状**：runtime 有 steering 与 turn-guide-drain 实现（`steering.ts`、`turn-guide-drain.ts`、`turn-loop-state.ts`），`session/steer` 协议词已删（连同 prompt/enhance 全簇）。
- **上游协议方法建议**（两案供架构师二选一）：
  - 方案 A：独立命令 `session/steer`：params `{sessionId, text, mode:"append-guide"}` → result `{accepted}`
  - 方案 B（最小面）：v4 sendText 增加可选旗标 `steer: true`，复用主链
- **插件侧工作**：turn 进行中输入框切换"插话"模式（placeholder/发送语义变化）；插话消息醒目样式+“已注入当前任务”标注。
- **改动波及面**：方案 A=shared+CLI turn-loop+插件；方案 B=shared+插件为主。services 视选型。
- **风险**：与 compact/工具执行中状态的竞态（runtime 已有 drain 机制，需暴露其语义与约束）。
- **工作量**：上游 M，插件 S+M。

## 4. Augment / Claude Code 对标清单（27 项）

| # | 对标功能 | ZCodium 对应 | 判定 |
|---|---|---|---|
| X-01 | 对话式任务下发 | F-01/F-05 | ✅ 已有 |
| X-02 | 流式回复+推理折叠 | 基线 P0-5 | ✅ 已有 |
| X-03 | diff review 审批 | F-56/F-71 | ✅ 已有 |
| X-04 | 终端命令审批 | F-56 | ✅ 已有 |
| X-05 | 权限 allowlist | F-25 | ✅ 插件侧可实现 |
| X-06 | CLAUDE.md 项目规则 | F-27/F-28（文件自动读取待 Q3） | ✅ 插件侧可实现 |
| X-07 | @ 引用 | F-67 | ✅ 插件侧可实现（@symbol 降级） |
| X-08 | 诊断修复 | F-68 | ✅ 插件侧可实现 |
| X-09 | 子代理可视化 | F-14 | ✅ 已有 |
| X-10 | 自定义命令/skills | F-47/F-48 | ✅ 协议现成（B） |
| X-11 | MCP 支持 | F-24/38/39（A）+F-40/41/42（B） | ✅ 已有 |
| X-12 | 历史恢复/切换 | F-02/03/04 | ✅ 已有 |
| X-13 | 历史导入（迁移） | F-17 | ✅ ZCodium 原生优势 |
| X-14 | /compact | F-07 | ✅ 已有 |
| X-15 | 模型/思考深度选择 | F-11/F-12 | ✅ 已有 |
| X-16 | 检查点/回滚 | F-72 → §3.2 | ⚠ 需上游扩展 |
| X-17 | Steering | F-73 → §3.3 | ⚠ 需上游扩展 |
| X-18 | browser-use | F-58 → §3.1 | ⚠ 插件重工程（协议已备） |
| X-19 | 计划模式 | F-13 [mode 值域待核实 Q5] | ⚠ 待核实 |
| X-20 | 后台任务 | F-06、F-51/52 | ✅ 已有 |
| X-21 | 图片/附件消息 | attachments 面 + v4 attachmentRef [待核实 Q5] | ⚠ 待核实 |
| X-22 | Token/成本展示 | F-66 | ✅ 已有 |
| X-23 | 自定义端点/供应商 | F-53/F-54 | ✅ 协议现成（B） |
| X-24 | 代码库索引（Augment） | — | ✕ 用户排除 |
| X-25 | inline 补全（Augment） | — | ✕ 用户排除 |
| X-26 | Augment Memories | — | ✕ 无协议对应 |
| X-27 | Augment Next Edit | — | ✕ 随补全排除 |

## 5. 用户故事（14 条）

1-12：会话管理／多根工作区／allowlist／@引用／诊断／崩溃重建／用量／MCP／Claude Code 迁移／项目记忆／初学者上手／与桌面端同源 UI（同 prd-p1.md §4）。
13：作为重度用户，我想在编辑器内管理 zcodium 插件、技能与工作流，以便不切桌面端完成扩展管理（B 档 F-43..F-50）。
14：作为团队管理员，我想配置定时/闲时任务并查看运行记录，以便 Agent 非工作时段自动干活（B 档 F-51/F-52）。

## 6. DoD

**本期（A/A+ 34 项 = F-01..F-07、F-09..F-14、F-17、F-19/20/23/24/25、F-27/28/29/32、F-38/39、F-56/57、F-62、F-66..F-71）**：
1. **架构**：types.ts 删除无残留；policy requires 登记通过；桥层消息全量 @zcode/shared schema 校验；@zcode/ui 沙箱硬依赖清单+shim 方案文档交付。
2. **端到端**：多根会话→审批→切换/移除；崩溃自动重建（约束沿用）；allowlist/denylist 生效；@引用+选区+诊断发送上下文正确；MCP 配置→状态→预检→局限提示；模型/模式/深度切换；compact；Claude Code jsonl 导入可续聊；自定义指令/语言生效；每轮用量展示；P0-1..P0-10 新 UI 全量回归。
3. **范围红线**：inline 补全与代码库索引不做；C/✕ 档不排期（C 档待 §3 决议）；B 档"随范围决议启用"。
4. **质量**：vitest 覆盖桥层校验/会话状态机/resume 重建/jsonl 解析/allowlist 归一化；§2 全部 AC-Fxx-n 可 1:1 转测试用例；capabilities 降级 UI。

**B 档（30 项）/ C 档（3 项）**：§2 各项 AC 已就绪，随用户范围决议启用后纳入对应版本 DoD。

## 7. 待确认问题（≤6）

1. **打包与依赖边界**：四包（shared/services/client/ui）进 extension host 与 Webview bundle 的策略、.vsix 体积、@zcode/client 取用边界、@zcode/ui 沙箱硬依赖清单与 shim 方案（F-56/71/41 前置）。
2. **v4 vs legacy 方法面**：setModel/setMode/goal/cancelBackgroundTask/usage/fork 的 v4 收敛形态与契约位置（定 F-06/08/09/11/13/66 调用路径）。
3. **符号索引与规则文件**：运行时是否有 LSP/符号索引（定 @symbol 升降级）；是否自动读取 CLAUDE.md 类项目规则文件（定 F-27"从文件同步"）。
4. **会话真删除与导入规范**：CLI 会话删除运维入口（定 F-03 删除语义）；CC jsonl → zcodeSessionImportMessageSchema 字段映射规范（定 F-17 解析器规格）。
5. **mode 值域与附件面**：zcodeSessionModeSchema 取值（定 X-19 计划模式）；v4 attachmentRef 上传/寄存命令面（定 X-21 图片消息）。
6. **范围决议**：B 档 30 项是否按类别整块提前（如生态管理 F-43..F-50 先行）；C 档 3 项是否立项（§3 草案评审，F-58 可考虑降档为插件侧 B 档）。





