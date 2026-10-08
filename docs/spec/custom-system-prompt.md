# 自定义系统提示词（分段编辑，UI v2）

## 背景与目标

Agent 发给模型的 system prompt 由 `apps/zcode-cli/packages/core/src/context/builder.ts` 的
`ContextBuilder.build()` 拼装（CLI prefix → stable 身份段 → 动态 system 段 → skills/meta_user）。
v1（整段替换钩子 `customSystemPrompt`）只能把身份段整体换掉并跳过全部动态段，粒度太粗。

目标：设置页提供**分段编辑**——三张常用段落卡（CLI 前缀 / Agent 身份 / 桌面上下文），
每段独立选择 继承 / 覆盖 / 追加 / 清空 四种模式；另设「主身份 / 工作流子代理」两个作用域
标签页；提供「全部恢复继承」「全部改为自定义（以内置原文为起点）」两个批量动作。
保存后从下次请求生效（同一会话继续对话即可，空闲会话立即重建前缀，回合中会话下一回合生效）。

## 语义决策

- **分段组合，不再整段跳过**：分段配置只改写被编辑的段；未暴露的动态段
  （Dynamic Behavior、Session Guidance、Memory、Env Info、Output Style、Context Management、
  Git）照常构建。与 v1「整段替换 + 跳过全部动态段」是两条并存的路径，见下方优先级。
- **四种模式**（每段独立）：
  - `inherit`（继承）：使用内置原文——落盘形态为**条目缺席**，不是显式值。
  - `override`（覆盖）：用户文本整体替换该段内置原文。
  - `append`（追加）：内置原文 + `\n\n` + 用户文本。
  - `clear`（清空）：该段不再进入 system prompt。
- **作用域两个**：
  - `main`（主身份）：普通会话 builder 路径，三段都可编辑。
  - `workflowSubagent`（工作流子代理）：`workflowActor` builder 路径（dwf actor）。只有
    「Agent 身份」有意义——子代理没有 CLI 前缀与桌面上下文。`inherit` 时 persona 原样；
    `override` **整段替换**该身份段（连同脚本写的 persona 与 `# Working inside a workflow`
    契约一起换掉，界面必须给出这条警告）；`append` 在 persona 之后追加；`clear` 不构建身份段。
    与 `customSystemPrompt` 的互斥保护不同：分段是**为与 persona 组合而设计**的，不抛错。
  - ⚠ 该段的内置原文是**参数化**的（开场句插角色名、之后插 persona），没有可作起点的静态
    全文；继承态回显与「以内置原文为起点」只能用**无 persona 的静态形态**
    （`BUILTIN_SYSTEM_PROMPT_WORKFLOW_ACTOR_IDENTITY`），并在页签说明里讲清「真实内容还会
    多出脚本写的 persona」。因此「全部改为自定义」**只作用于主身份三段**——拿静态模板去覆盖
    这一页签会静默删掉 persona 与工作流契约，直接破坏子代理的 submit_result/escalate 契约。
  - legacy Workflow 子会话（无 workflowActor）：继承父 runtime 配置走 main 路径，与主会话一致。
- **优先级**：旧整段字段 `customSystemPrompt` 非空时**整体压过**分段配置（v1 语义原样保留，
  避免两套替换叠加出未定义行为）。UI 迁移保证两字段不会同时非空（见兼容）。
- **条件注入保留**：桌面上下文的内置注入门（`presentationSurface === "zcode_desktop"` 且非
  workflowActor）不变；分段模式只决定门开后该段的内容（含 `clear` 时不构建）。
- **prompt 缓存**：三段内置原文均为静态模板（`cacheHint: "stable"`）；覆盖/追加后的内容
  同样按 stable 处理，section 的 name/source 保持不变（contextUsage 分段视图稳定）。
- **上限**：单段文本 200 000 字符（schema 层拒绝；归一化会剥离空文本的 override/append 条目，
  空文本 override 等价于「什么都没写」，不允许它伪装成清空）。
- **内置原文唯一来源**：内置文本常量下沉到
  `packages/shared/src/system-prompt-segments.ts`，core 的 section builder 与 UI（继承态回显、
  「以内置原文为起点」预填）都从 shared 取，杜绝双份漂移。共四份：CLI 前缀 / Agent 身份 /
  桌面上下文（三段静态）+ **工作流子代理身份段**（参数化，见
  `buildBuiltinWorkflowActorIdentityPrompt`；core 的 `buildWorkflowActorIdentitySection`
  只负责加 section 元数据，文本实现也在这份 shared 模块里）。

## 数据流与状态所有者

持久 owner：host 进程 settingService（`~/.zcodium/v2/setting.json` 的 `customSystemSegments`
字段）。CLI 进程只持有两份派生值：进程级缓存 `appRuntimePreferences.customSystemSegments`
（热更通道写入）与会话 `runtimeConfig.customSystemSegments`。

```
UI 设置页 SystemPromptSection（草稿 → 显式保存）
  │ useSettings().update({ customSystemSegments })
  ▼
host settingService.update ──写 setting.json（唯一持久 owner）
  │
  ├─ zcodeAgentService.syncAppRuntimePreferences（本 Host 全部活动 CLI client）
  │    └─ 协议 workspace/updateSystemSegments { segments }
  │         ├─ CLI：appRuntimePreferences.customSystemSegments ← 归一化值（进程缓存）
  │         └─ 遍历活动 session：app.updateSystemSegments(segments)
  │              ├─ runtimeConfig.customSystemSegments = v（workflow child 继承同链）
  │              └─ runtime.updateConfig({ customSystemSegments })
  │                   ├─ 空闲：rebuildContextPrefix（立即生效）
  │                   └─ 回合中：仅写 config，下一 model step 的
  │                        rebuildContextPrefix（turn.ts:216）自然生效
  ├─ botsService.syncAppRuntimePreferences（远端 bridge 透传同一结构）
  └─ 广播 APP_RUNTIME_PREFERENCES_CHANGED（payload 携带 customSystemSegments，
     其他窗口 Root.tsx 收到后重放 sync，多窗口一致）

新建会话（含 App 冷启动后首个会话）：
  createRecord → resolveSessionStartupPreferences
    ├─ kind=host：反向请求 session/requestRuntimePreferences →
    │    host resolveSessionRuntimePreferences 每次现读 settingService →
    │    result.customSystemSegments → runtimeConfig.customSystemSegments
    │    （与 deleteProtection 相同的冷启动安全路径，不依赖进程缓存）
    └─ kind=inherit：parent record.customSystemSegments（创建时固化，同 deleteProtection 模式）
```

### settings → preferences 映射点（四处，缺一不可）

`customSystemPrompt` / `customSystemSegments` 都是「app-global 设置 → CLI 偏好」的字段，
任何一处映射漏掉字段都会造成**冷启动/新建 client 拿不到值**，而热更通道仍正常，
症状是「改了设置、老会话生效、新会话不生效」。四处必须同时携带：

| 位置 | 作用 |
| --- | --- |
| `packages/ui/src/hooks/useSettingService.ts` `update()` | 用户改设置后的热更 + 广播快照 |
| `packages/ui/src/Root.tsx` 初始化 effect | App 启动/设置变化时把完整快照推给 host（缺字段会**覆盖掉** `latestAppRuntimePreferences`，新注册的 CLI client 重放时丢值） |
| `packages/services/src/node.ts` `resolveSessionRuntimePreferences` | 本地 Host 的冷启动现读（`kind=host` 反向请求） |
| `packages/desktop/src/host/remoteWorkspaceServiceCollection.ts` `onDynamicSessionRuntimePreferencesRequest` | desktop-attached remote / 手机远控：**app-global 设置权威仍在 desktop shared Host**，Agent 在远端运行，必须原路返回同一份偏好 |
| `packages/services/src/bots/botRemoteWorkspaceBridge.ts` 的 settings 兜底快照 | Bot 任务在远端 workspace 上运行时的同一份偏好 |

（最后两处是 2026-10-08 补的：此前只有 `deleteProtection` 走通，系统提示词两个字段在
冷启动路径上缺失——热更通道会下发，冷启动会漏，属 v1 遗留缺口。）

builder 侧组合（`ContextBuilderConfig.customSystemSegments`，core）：

```
build()
  ├─ customSystemPrompt 非空（v1 整段替换）→ 分段配置整体忽略，走 v1 路径（现行为不变）
  ├─ workflowActor 在场
  │    └─ workflowSubagent.identity：inherit→persona / override→用户文本 /
  │       append→persona+"\n\n"+文本 / clear→不构建（其余段照 workflowActor 既有契约）
  └─ 普通路径
       ├─ cliPrefix：按模式组合（clear 则不构建；其余段不受影响）
       ├─ identity：按模式组合（内置基座跟随 activeOutputStyle 的当下内容）
       ├─ desktop：既有注入门内按模式组合
       └─ 全部动态段照常构建（与 v1 的「跳过」不同，这是分段语义的核心差异）
```

## 接口

### shared（packages/shared/src/system-prompt-segments.ts，新文件）

- `SYSTEM_PROMPT_SEGMENT_IDS = ["cliPrefix", "identity", "desktop"]`。
- 段条目 schema：`{ mode: "override" | "append" | "clear", text: string().max(200_000) }`
  ——`inherit` 不落盘（缺席即继承）；`clear` 不需要 text。
- `customSystemSegmentsSchema`：`{ main?: SegmentMap, workflowSubagent?: SegmentMap }`，
  `SegmentMap = Record<SegmentId, SegmentEntry>`。空对象 = 全部继承 = 默认。
- `normalizeCustomSystemSegments()`：剥离 `text` 为空白的 override/append 条目、丢弃未知段 id、
  clear 条目去 text；全空返回 `{}`。保存链路（UI 提交、CLI handler）统一走它。
- `BUILTIN_SYSTEM_PROMPT_SEGMENT_TEXTS`：三段内置原文常量（identity 为无 outputStyle 基座，
  与 `buildIdentityPrompt(undefined)` 逐字一致；desktop 为静态模板全文）。
- `buildBuiltinWorkflowActorIdentityPrompt({ name?, persona? })` +
  `BUILTIN_SYSTEM_PROMPT_WORKFLOW_ACTOR_IDENTITY`：工作流子代理身份段的**唯一实现**
  （core 的 section builder 直接调它）；后者是无 persona 的静态形态，供 UI 回显/预填。
- `BUILTIN_SYSTEM_PROMPT_SURFACE_SEGMENT_TEXTS`：作用域 × 段 → 内置原文（UI 的唯一取数入口；
  `workflowSubagent` 只映射 `identity`）。
- `countCustomizedSystemSegments()`：两作用域非继承条目计数（UI「已改写 N 段」徽标）。
- `SYSTEM_PROMPT_SEGMENT_TEXT_MAX_LENGTH`：单段上限常量（UI 侧 `MAX_SYSTEM_PROMPT_SEGMENT_LENGTH`
  由它派生，不各写一份）。

### 协议（packages/shared/src/zcode-protocol/index.ts）

- 新方法常量：`workspaceUpdateSystemSegments: "workspace/updateSystemSegments"`。
- params：`{ workspace, segments: customSystemSegmentsSchema }`——**空对象 = 全部恢复继承**
  （显式可传递；归一化在 handler 内做）。
- result：`{ workspace, segments, updatedSessionCount }`（回显归一化后的值）。
- `zcodeSessionRuntimePreferencesResultSchema` 增加可选 `customSystemSegments`：
  旧 Host 缺省 = 使用默认；与 deleteProtection 相同的版本偏移策略（Host/CLI 同包分发）。

### 设置（packages/shared/src/validationAppSettings.ts）

- `appSettingsObjectSchema` 与 `appSettingsPatchSchema` 增加
  `customSystemSegments: customSystemSegmentsSchema.optional()`（必须进存储 schema，
  否则写盘被 strip、开关回弹）。
- 广播 payload（app-runtime-preferences.ts）：`customSystemSegments` optional——多窗口
  广播双方同版本分发，无需 default 兜底。

### CLI

- handler：`bootstrap/src/zcode-protocol/system-prompt-preferences.ts` 增加
  `updateSystemSegmentsPreferences`（仿同文件 v1 handler）：parse → `normalizeCustomSystemSegments`
  → 写进程缓存 → 遍历 `record.app.updateSystemSegments(v)`；全空对象时从缓存删除字段。
- `ZCodeApp.updateSystemSegments?(segments)`（app/types.ts + create-app.ts）：create-app 双写
  runtimeConfig + `runtime.updateConfig`（同 `updateSystemPrompt` 注释所述的双写原因）。
- `core` `updateConfig` 的 Pick 增加 `"customSystemSegments"`；`runtime/methods/context.ts`
  的 contextConfig 映射加 `customSystemSegments: this.config.customSystemSegments`。
- `createRecord`（server-operations.ts）：runtimeConfig 注入 `customSystemSegments`
  （startupPreferences 携带时），并把归一化值固化到 record 供 inherit。
- legacy Workflow 子会话经 `inheritedConfig` 自动继承分段配置；dwf actor 继承后由
  `workflowSubagent` 作用域生效（`script-workflow-child-runtime.ts` 现有的 systemPrompt 剥离
  只针对 v1 整段字段，分段配置是有意要传下去的）。

### Host 服务

- `ZCodeAgentAppRuntimeSegments`（zcodeAgent.ts）：`customSystemSegments?:` 归一化对象。
  与 `customSystemPrompt` 的空串语义不同：**缺席 = 从未使用**（不同步，避免给旧 CLI 增加
  必败往返）；`{}` = 已全部恢复继承（仍同步，让新建 CLI client 拿到清空态）。
- `syncAppRuntimePreferences`：schema 校验通过才透传，否则 undefined。
- `enqueueInteractionPreferenceSync`：字段在快照中（含 `{}`）时发送
  `workspace/updateSystemSegments`，method-not-found 静默降级（旧 CLI 保持默认提示词）。
- `node.ts` `resolveSessionRuntimePreferences`：settings.customSystemSegments 归一化后非空
  才携带（`{}` 无需下发）。

### UI（packages/ui）

- `settings/SystemPromptSection.tsx` 重写为分段编辑器（自包含组件，SettingsPage 侧仍以
  `<ServiceProvider services={localHostServices}>` 包裹——系统提示词是本机全局事实，远程
  workspace 激活时不得读远端 Host）：
  - 顶部：说明文案 + 「已改写 N 段」徽标（两作用域合计，按**已保存值**计数）。
  - 批量动作：「全部恢复继承」立即提交 `{}`（并清空 v1 旧字段）；「主身份全部改为自定义
    （以内置原文为起点）」把**主身份三段**置为 override 草稿、预填内置原文，保留另一页签的
    草稿，等待显式保存（工作流子代理身份段是参数化段，没有静态起点，不参与）。
  - Tabs（radix `Tabs`）：主身份（三张卡）/ 工作流子代理（仅 Agent 身份卡；页签说明里讲清
    「继承 = 运行时在开场句之后插入脚本写的 persona」与「覆盖会连同 persona 与工作流契约一起
    替换，需要保留 persona 请用追加」）。
  - 段卡片：标题 + 标签（系统消息；桌面上下文追加「条件注入」）+ 副标题（稳定段（进
    prompt 缓存））+ 模式切换（继承/覆盖/追加/清空）+ 文本域。继承态只读回显**该作用域**的
    内置原文（取自 `BUILTIN_SYSTEM_PROMPT_SURFACE_SEGMENT_TEXTS`，不是所有页签共用三段文本）；
    覆盖/追加编辑用户文本（追加只保存增量部分，不混排内置原文）；清空不显示文本域。
  - 「保存」提交两作用域草稿（`normalizeCustomSystemSegments` 后）；dirty = 草稿与已保存
    归一化值不等；单段超限禁止保存。
  - 草稿是 UI 局部状态（未提交不落盘），已保存事实源始终是 settings 快照；跨窗口广播
    与 settings 异步加载遵循「未开始编辑跟随刷新、编辑中保留草稿」的既有策略。
  - 纯决策逻辑抽在 `settings/systemPromptDraft.ts`（归一化接线 + 迁移 + dirty/计数），
    `packages/ui/test/systemPromptDraft.test.ts` 钉规则。
- `useSettingService.update()` 分支：patch 含 `customSystemSegments` 时并入 App 偏好同步
  与广播；偏好快照始终携带当前生效值（含 `{}`），防止无关开关的同步用缺字段快照覆盖。
  快照构造收敛在 `settings/appRuntimePreferences.ts`（`buildAppRuntimePreferenceSnapshot` /
  `touchesAppRuntimePreferences`），与 `Root.tsx` 的两处初始化同步共用同一实现。

## 兼容与降级

| 场景                                            | 行为                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------ |
| 旧 CLI（无 workspace/updateSystemSegments）     | method-not-found 静默降级，保持默认提示词                                |
| 旧 Host（session runtime preferences 无字段）   | CLI 按 undefined 处理，使用默认提示词                                    |
| v1 遗留数据（customSystemPrompt 非空）          | UI 首次渲染一次性迁移为 `main.identity` override 并清空旧字段（幂等）     |
| 两字段同在（理论上仅手工改 setting.json）       | builder 优先 v1 整段替换，分段忽略                                       |
| workflow child 同时拿到 persona 与 v1 systemPrompt | 既有互斥保护不变（script-workflow-child-runtime.ts 剥离 + builder 抛错） |

## 验收场景

1. 默认状态：全部段为「继承」，卡片只读回显内置原文，徽标「已改写 0 段」；会话 system
   prompt 为内置拼装（contextUsage 分段可见）。
2. 单段覆盖：CLI 前缀改「覆盖」并输入文本保存 → 活动会话空闲时前缀重建，该段内容替换、
   其余段（含动态段）不变；新建会话同样生效；setting.json 落盘。
3. 追加：Agent 身份「追加」→ 生效文本 = 内置原文 + 空行 + 追加文本；contextUsage 中
   identity 段字符数增加。
4. 清空：桌面上下文「清空」→ desktop surface 会话不再出现该段；其他段不受影响。
5. 全部恢复继承：一键后徽标回「已改写 0 段」，所有会话回到内置拼装；新建 CLI client
   同步到清空态（`{}` 仍随偏好快照下发）。
6. 全部改为自定义：**主身份**三卡切「覆盖」并预填内置原文，工作流子代理页签的草稿不变，
   未保存前 settings 不变（草稿可见）。
7. 工作流子代理：页签继承态回显的是**子代理身份模板**（含 `# Working inside a workflow`
   契约，不是交互式身份）；「追加」文本保存 → dwf actor 身份段 = 开场句 + persona +
   追加文本；「覆盖」保存 → 整段被用户文本替换（persona 与契约一并消失，页签说明已警告）；
   主身份三段对其不生效；v1 systemPrompt 互斥保护不回归。
8. 条件注入：桌面上下文「继承」时仅 zcode_desktop surface 注入；「覆盖」后同样只在该
   surface 注入（门不因分段改变）。
9. 冷启动继承：保存后重启 App，直接新建会话即生效（反向请求路径，不依赖进程缓存）；
   desktop-attached remote / 手机远控 / 远端 Bot 任务的新会话同样生效（三处
   `resolveSessionRuntimePreferences` 都携带字段）。
10. 多窗口：A 窗口保存，B 窗口徽标与卡片同步（广播）。
11. 回合中修改：运行中会话不中断当前回合，下一回合生效。
12. 迁移：v1 保存过整段自定义 → 打开设置页后 setting.json 的旧字段清空、
    `main.identity` 出现 override 条目，生效文本不变（动态段恢复内置注入属预期语义变化）。
13. 越界：单段 >200 000 字符被 schema 拒绝（UI 提交前同样拦截）。
14. 偏好快照完整性：任意设置项变更（含与本功能无关的开关）后，host 侧
    `latestAppRuntimePreferences` 仍带着系统提示词两个字段；此后新注册的 CLI client
    重放快照不会丢值。
