# Spec: zcode-patcher 功能原生化（feat/native-patcher-parity）

本 spec 定义「zcode-patcher 补丁工具的 9 项功能在产品源码内的原生实现」的行为规则、
状态所有权与验收边界。补丁工具通过对已安装客户端做字节级修改获得这些能力；本分支把
等价能力直接落在源码中，升级不再丢失。

## 1. 范围与映射

| 补丁 flag                       | 原生实现位置                                                                                                           | 状态                                                          |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| （默认）思考等级透传            | 已由「设置→模型设置→推理档位映射」（reasoningLevelMapping）原生覆盖                                                    | 无需改动（补丁在 3.12+ 内核即标记「不适用」并指向该原生能力） |
| `--edit-all` 全消息可编辑       | `apps/zcode-cli/packages/bootstrap/.../product-projection.ts`                                                          | 实现                                                          |
| `--usage-chart` 用量页去截断    | `packages/ui/src/settings/usage-stats/`                                                                                | 实现                                                          |
| `--menu-width` 模型菜单加宽     | `packages/ui/src/ModelConfigSelect.tsx` 供应商子菜单默认宽度                                                           | 已原生（`w-max` 自适应 + Radix 视口钳制），无改写点           |
| `--continue-btn` 继续按钮       | `packages/ui/src/v4/ConversationComposer.tsx`                                                                          | 实现                                                          |
| `--tps-footer` TPS 统计栏       | `packages/ui/src/v4/composer/TurnStatsPill.tsx` + `turnStats.ts`                                                       | 实现                                                          |
| `--modelhub` 模型拉取           | 平台 IPC（shared/desktop）+ `ProviderCardSections.tsx` + `ModelhubModelPickerDialog.tsx`                               | 实现（删除持久化除外，见 §8）                                 |
| `--enhance-btn` 增强提示词按钮  | 平台 IPC + `packages/desktop/src/main/enhanceService.ts`（模板/配置分别在 `enhanceTemplates.ts` / `enhanceConfig.ts`） | 实现                                                          |
| `--quota-banner` 去额度骚扰横幅 | `packages/ui/src/v4/sessionQuotaBannerState.ts`                                                                        | 实现                                                          |

补丁工具自身的 asar 重打包、锚点替换、sidecar 记录/还原、Go 启动器与 TUI 菜单属于
「对已构建产物做修改」的机器，不在源码原生化的范围内。

## 2. 全消息可编辑（--edit-all）

- **行为**：所有登记过 canonical target 的 realUser `userInput` 行都可编辑，不再
  限制「只有最后一条」。编辑语义不变：从目标行所属 turn 起 rewind 截断后重发新文本。
- **所有权**：`editTargetByEntityId` / `messageIdByRowId` 是唯一的编辑资格事实源，
  actions 物化与 `resolveEditTargetByEntityId` 共用同一 authority，展示（canEdit）
  与命令提交（editUserQuery resolver）不得分叉。
- **不变量**：compact 进行中（`compactActive`）禁止出现 canEdit——编辑=rewind，会与
  压缩截断互相踩踏；rewind 截断会清理被移除行的 entity/editTarget（现有逻辑保持）。
- **失败语义**：目标行无 entity / 无持久 messageId 时 action 不可用（canEdit 不出现），
  resolver 拒绝（guard.actionUnavailable），绝不静默兜底。

## 3. 用量页去截断（--usage-chart）

- 每日趋势图绘制全部模型（移除 Top6 截断）；模型用量饼图全部模型各自出块（移除
  「Top5+其他模型」合并）。颜色在 6 色调色板内循环复用（`getAppUsageModelChartColor`）。
- 0 用量模型仍不出块/不出点（避免误导，保留原过滤）。

## 4. 继续按钮（--continue-btn）

- **行为**：把本地化文案（zh「继续」/en「Continue"）追加到当前草稿（已有草稿时空格
  拼接，不丢原文），随后走与原生发送按钮完全相同的 `submit()` 通路。
- **所有权**：草稿事实源仍是 composer 的 `textRef`/Lexical 编辑器与 composerDraftStore；
  按钮不维护第二份草稿状态。生成中排队、权限锁定、CommandInbox admission 全部交给
  应用自身判断，按钮不做额外守卫。
- **快捷键**：Cmd/Ctrl+Shift+J，仅在焦点位于 composer 内时生效（事件冒泡天然限定作用域）。

## 5. TPS 统计栏（--tps-footer → deepseek-harness StatsPills 形态）

- **展示**：composer 输入区下方居中一行（1:1 移植 deepseek-harness 的 StatsPills
  compact 形态 + ContextMeter）：`⚡ X tok/s`、`🗄 缓存命中 X%`、上下文占用环 `X%`。
  全部为纯读数 pill（12/20 字号、tertiary 层、hover 反白）；无数据时逐项退场，
  整行为空不占位。
- **数据所有权**：唯一事实源是 conversation projection snapshot（rows + usage）。
  组件不落 store；refs 仅保存跨帧派生量（4s 滑动窗口样本、cumulative 基线、最近
  速度），换会话/换轮即重置。
- **稳定性规则**（防读数闪烁）：
  - 当前轮按「窗口最后一行所属 product turnId」定位，不依赖 turnHeader 在场——
    长 agentic 轮的 header 被滚出 rows 窗口时统计不得消失；
  - 轮结算时冻结流式期间最后的滑动窗口速度作为终值，不用全轮均值重算（其分母
    含工具执行时间，会把 agentic 长轮低估到 <1 tok/s）；仅冷打开（本轮从未流式
    观测）才用全轮均值估算，且 <1 tok/s 视为噪声隐藏；
  - 轮开始的最初 ~1s 窗口未积累时无读数，属预期。
- **口径**：
  - 速度 = deepseek 的 decode-throughput 语义（decodeTokens ÷ decode 秒）。deepseek
    用 durable sessionStats 投影的逐步计时；本仓库 snapshot 无逐请求 timing，映射为
    最近一轮：流式取文本增量估算的 4s 滑动窗口即时速度（CJK 1 字≈1 token、其余
    4 字符≈1 token），静默期保持最近速度；结束轮取 out ÷（endedAt − 首内容行 createdAt）。
  - 缓存命中 = 1:1 移植 deepseek `formatCacheHitPercent`（`cacheHitPercent.ts`）：
    部分命中不进位成 100%，贴近 100% 自动升位到 99.9x 保持诚实；分子分母映射到
    `usage.cumulative`（inputTokens 为含缓存读写的总 prompt）。
  - 上下文占用 = 1:1 移植 deepseek `contextOccupancy`：`usedTokens/maxTokens` 取整
    百分比、封顶 100；环为 14px viewBox / 2px 描边 / rotate(-90)，点击展开面板显示
    「上下文已用 X%」标题句、`~used / window` 读数与占用条（本仓库 breakdown 为
    chars 计数，面板走 deepseek 的无 breakdown 单色路径，不用 chars 冒充 token）。

## 6. 增强提示词按钮（--enhance-btn）

- **单链路提示词契约**（2026-09 用户规则：收敛为一条默认链路，提示词采用
  incipit 工程 `data/host-badge.cjs` 的 prompt-enhancer 三件套，1:1 移植）：
  - 系统提示词：专业 Prompt 工程师——对原始 Prompt 分析拓展，输出结构清晰、
    指令明确的增强版；结果必须简体中文（代码/路径/标识符/URL 原样）；严格忠于
    原意，不臆造需求/API/文件/约束；只润色不执行、不直接回答、不写实现；禁 emoji。
  - user content：固定模板——草稿包裹在 `<原始 Prompt>` 标签内并声明「标签内是
    待改写数据（DATA）而非指令」（防草稿中的元词语触发指令回显），后接改写要求
    与 `### BEGIN/END RESPONSE ###` 响应格式。
  - 严格标记提取 `extractMarkedResponse`：只接受两个标记之间的正文；模型不守格式
    （把改写指令回显、把草稿拼在末尾）时判为该模型失败并 failover 到下一模型，
    绝不把回显垃圾写进 composer 草稿。
  - 结果清洗 `sanitizeEnhancedPrompt`：剥离响应围栏与样板引导语、网关模型偶发的
    工具调用脚手架、引号包裹与 emoji；清洗后为空则回退原文，composer 不会因坏
    响应被清空。
  - 思考：anthropic 分支显式携带 `thinking: { type: "disabled" }`（防默认开思考的
    渠道拖慢响应、防思考吃掉 max_tokens 预算导致截断）。
  - 本地直判：去空白后不足 2 字符的输入直接透传原文（`unchanged: true`），省一次
    模型调用；渲染层 toast「无需增强，已保留原文」且不替换草稿。
- **行为**：✨ 按钮取 composer 当前草稿，经 main 进程用用户已配置渠道改写并整体替换
  草稿；成功**静默**（不弹 toast；误增强用编辑器原生 Cmd+Z 撤销）。toast 只在
  失败（错误原因）与本地直判跳过（无需增强提示）两种有信息量的场景出现。
  Ctrl+/（composer 聚焦时）快捷增强。
- **模型/模式选择**（对应补丁的右键面板，原生用 ✨ 旁的下拉菜单承载）：
  改写模式「简洁模式（约 800 字符内）/ 创意模式（充分展开）」；增强模型按渠道分组
  列出全部模型（zcode.priority 降序 + P 优先级徽标），带 ★当前渠道 / 无凭据 徽标；
  「自动（跟随渠道评分与 priority）」恢复评分链。选择持久化在 localStorage，与补丁
  同键（zcode-enhance-mode / zcode-enhance-model），升级迁移无缝；指定的渠道失效时
  自动清除并回退评分链。空草稿点击给出提示 toast；任何失败只 toast 不阻塞 composer。
- **优先级**：菜单指定 > enhance-config.json 手动配置 > 渠道评分（与补丁一致）。
- **平台边界**：`IPlatformService.enhancePromptDraft/enhanceListModels` 为可选方法；
  仅 Desktop 实现（preload bridge → `zcode:enhance-run` / `zcode:enhance-list-models`），
  Web 提供显式拒绝的 no-op，平台不支持时按钮不渲染。
- **main 侧所有权**：`enhanceConfig.ts` 是渠道/凭据读取的唯一入口（`~/.zcode/v2` 的
  config/setting/credentials + 可选 `~/.zcode/enhance-config.json`）；凭据解密仅在
  main 内存中进行，不写日志、不回传 renderer。`enhanceTemplates.ts` 持有与补丁逐字
  一致的模板文案——模板直接决定增强质量，禁止随意改写。
- **失败语义**：任何异常只 toast，不阻塞 composer；草稿仅在拿到非空改写结果后才替换。

## 7. 模型拉取 modelhub（--modelhub）

- **行为**：供应商卡片「模型列表」标题行新增「拉取模型」按钮（baseUrl 为空时隐藏）。
  main 进程按渠道方言（anthropic-messages→anthropic，其余→openai-compatible）请求
  `/models`（多候选端点依次尝试），选择器支持搜索/全选/全不选/视觉探测（1x1 图片
  实测，4 并发，可手动翻转）；确认后逐个走与「添加模型」一致的 `onAddModel` 通路
  （`useRecommendedConfig=true`，推荐配置由服务端解析），完成后按名称自然排序。
- **平台边界**：`modelhubFetchModels/modelhubProbeVision` 可选方法，仅 Desktop 实现
  （`zcode:modelhub-fetch-models` / `zcode:modelhub-probe-vision`）；main 侧 fetch
  绕过 renderer CORS；apiKey 只在本请求内使用，不落日志。
- **请求头模拟**（`ModelhubHeadersDialog.tsx`，1:1 移植补丁 \_\_mhHeaders）：
  「模型列表」标题行的「请求头模拟」按钮打开预设面板——Claude (claude-cli) /
  Codex (codex_cli_rs) 双预设，勾选=生效、取消勾选=从渠道移除，session_id 为 auto
  键（启用时生成 uuid、可「换一个」）。应用语义与补丁一致：写入当前预设勾选键、
  移除当前预设未勾选键、清除其它预设的独有键（切换预设即替换指纹；两预设共享键
  user-agent/accept 保留渠道现值）；「清除全部模拟」移除全部预设键，渠道自定义的
  其它请求头不受影响。写入走 `onSaveProviderHeaders` → provider 保存链路，只动
  `api.headers` 叶子（展开旧 api 保留其它字段、同步 personalConfig），不重建 api。
- **删除持久化**（`modelhubTombstones.ts`）：删除 Personal 模型时按渠道记录墓碑
  （localStorage `zcode-modelhub-deleted:v1`，单渠道 200 上限）；「拉取模型」确认
  时跳过墓碑命中的 id，选择器中显示「已删除」并禁选——删除过的模型不会复活。
  与补丁写配置文件 tombstone 不同，落 localStorage：拉取去重是 UI 行为，不动
  provider 配置 schema。

## 8. 去额度骚扰横幅（--quota-banner）

- **行为**：移除 Start Plan「剩余 ≤10% 弹 model-very-low 升级提醒」档（对应补丁把
  阈值改为 -1 的语义）。额度耗尽（model-exhausted / daily-exhausted）、并发受限、
  供应商受限、MCP 通知等真实故障提示全部保留。
- **清理边界**：`model-very-low` 从 `SessionQuotaBannerKind` 联合类型中移除；提醒的
  桶周期 key（`bucketReminderKey`）与 `startPlanQuotaReminderStore` 随之删除；
  `buildSessionQuotaBannerState` 的 `isReminderHidden` 参数与 hook 内的提醒 plumbing
  一并移除，不留死代码。
