# 自定义系统提示词（UI 修改 / 还原）

## 背景与目标

Agent 发给模型的 system prompt 由 `apps/zcode-cli/packages/core/src/context/builder.ts` 的
`ContextBuilder.build()` 拼装（CLI prefix → stable 身份段 → 动态 system 段 → skills/meta_user）。
运行时已有整段替换钩子 `AgentRuntimeConfig.systemPrompt`（builder 的 `customSystemPrompt`），
但主链路（CLI argv / env / 设置 / 会话参数）均无人填充，仅工作流子 runtime 与子代理使用。

目标：在桌面设置页提供「系统提示词」编辑能力——自定义（覆盖内置默认）与还原（回到内置默认），
App 级生效（所有 workspace 的现有与新建会话）。

## 语义决策

- **整段替换**：沿用 builder 现有契约（`builder.ts:108-173`）——非空 custom prompt 替换 stable
  身份段并**跳过全部动态 system 段**（desktop 上下文、Dynamic Behavior、Session Guidance、
  Memory、Env Info、Output Style、Context Management、Git）。这是 runtime 早已固化的
  "用户自定义提示词"语义，本功能只把它接到主链路，不新增第三种叠加模式。
- **还原 = 清空**：`customSystemPrompt` 为空串/缺席即使用内置默认，无独立"默认值快照"。
- **作用域**：App 全局（`~/.zcodium/v2/setting.json`），跨 workspace 一致；子代理
  （`subagentContext`）与工作流 actor（`workflowActor`）身份不受影响——前者走独立 builder，
  后者由 `script-workflow-child-runtime.ts:93` 在 workflowActor 在场时强制剥离继承的
  systemPrompt（互斥保护已存在）。
- **上限**：200 000 字符（schema 层拒绝超长；真实约束仍是模型上下文预算）。

## 数据流与状态所有者

持久 owner：host 进程 settingService（`~/.zcodium/v2/setting.json` 的
`customSystemPrompt` 字段）。CLI 进程只持有两份派生值：进程级缓存
`appRuntimePreferences.customSystemPrompt`（热更通道写入）与会话 runtimeConfig.systemPrompt。

```
UI 设置页 SystemPromptSection
  │ useSettings().update({ customSystemPrompt })
  ▼
host settingService.update ──写 setting.json（唯一持久 owner）
  │
  ├─ zcodeAgentService.syncAppRuntimePreferences（本 Host 全部活动 CLI client）
  │    └─ 协议 workspace/updateSystemPrompt { systemPrompt }
  │         ├─ CLI：appRuntimePreferences.customSystemPrompt ← 归一化值（进程缓存）
  │         └─ 遍历活动 session：app.updateSystemPrompt(v)
  │              ├─ runtimeConfig.systemPrompt = v      （面向未来 runtime：workflow child 继承）
  │              └─ runtime.updateConfig({ systemPrompt })
  │                   ├─ 空闲：rebuildContextPrefix（立即生效）
  │                   └─ 回合中：仅写 config，下一 model step 的
  │                        rebuildContextPrefix（turn.ts:216）自然生效
  ├─ botsService.syncAppRuntimePreferences（远端 bridge 透传同一结构）
  └─ 广播 APP_RUNTIME_PREFERENCES_CHANGED（payload 携带 customSystemPrompt，
     其他窗口 Root.tsx 收到后重放 sync，多窗口一致）

新建会话（含 App 冷启动后首个会话）：
  createRecord → resolveSessionStartupPreferences
    ├─ kind=host：反向请求 session/requestRuntimePreferences →
    │    host resolveSessionRuntimePreferences 每次现读 settingService →
    │    result.customSystemPrompt → runtimeConfig.systemPrompt
    │    （与 deleteProtection 相同的冷启动安全路径，不依赖进程缓存）
    └─ kind=inherit：parent record.customSystemPrompt（创建时固化，同 deleteProtection 模式）
```

## 接口

### 协议（packages/shared/src/zcode-protocol/index.ts）

- 新方法常量：`workspaceUpdateSystemPrompt: "workspace/updateSystemPrompt"`。
- params：`{ workspace, systemPrompt: string(max 200_000) }`，**空串 = 还原默认**（显式可传递，
  避免"缺字段"与"清空"混淆；RPC 会丢弃 undefined）。
- result：`{ workspace, systemPrompt, updatedSessionCount }`（回显归一化后的值，空串即默认）。
- `zcodeSessionRuntimePreferencesResultSchema` 增加可选 `customSystemPrompt: string`：
  旧 Host 缺省 = 使用默认；与 deleteProtection 相同的版本偏移策略（Host/CLI 同包分发）。

### 设置（packages/shared/src/validationAppSettings.ts）

- `appSettingsObjectSchema` 与 `appSettingsPatchSchema` 增加
  `customSystemPrompt: z.string().max(200_000).optional()`（空串=默认；必须进存储 schema，
  否则写盘被 strip、开关回弹）。
- 广播 payload（app-runtime-preferences.ts）：`customSystemPrompt: z.string().max(200_000).default("")`，
  保持 strict 兼容旧发送方。

### CLI

- handler：`bootstrap/src/zcode-protocol/system-prompt-preferences.ts`（仿
  delete-protection-preferences.ts）：parse → 归一化（trim，空→undefined）写进程缓存 →
  遍历 `record.app.updateSystemPrompt(v)`。
- `ZCodeApp.updateSystemPrompt?(systemPrompt: string | undefined)`：create-app 双写
  runtimeConfig + `runtime.updateConfig`（同 `updateDeleteProtection` 注释所述的双写原因）。
- `core` `updateConfig` 的 Pick 增加 `"systemPrompt"`：写入 config；空闲时
  `rebuildContextPrefix`，回合中交给下一 model step（与 outputStyle/language 一致）。
- `createRecord`：runtimeConfig 注入 `systemPrompt`（startupPreferences.customSystemPrompt
  非空时），并把归一化值固化到 `ZCodeProtocolSessionRecord.customSystemPrompt` 供 inherit。

### Host 服务

- `ZCodeAgentAppRuntimePreferences.customSystemPrompt?: string`（空串/缺席=默认）。
- `syncAppRuntimePreferences` 归一化：非 string 或 trim 后为空 → undefined（不向 CLI 发送）。
- `enqueueInteractionPreferenceSync`：字段为 string 时发送 `workspace/updateSystemPrompt`，
  method-not-found 静默降级（旧 CLI 保持默认提示词）。
- `node.ts` `resolveSessionRuntimePreferences`：settings.customSystemPrompt trim 非空才携带。

### UI（packages/ui）

- `settings/SystemPromptSection.tsx`：自包含组件（`useSettings` + `useZCodeIntl`），
  在 SettingsPage general 分支以 `<ServiceProvider services={localHostServices}>` 包裹渲染
  （系统提示词是本机全局事实，远程 workspace 激活时不得读远端 Host）。
  - Textarea 草稿；「保存」提交 trim 后的值（空串=还原）；「恢复默认」提交空串。
  - 状态徽标：默认 / 自定义；描述文案明确"整段替换、动态段落一并跳过"。
  - `update()` 分支：patch 含 `customSystemPrompt` 字符串时并入 App 偏好同步与广播。

## 兼容与降级

| 场景                                            | 行为                                                              |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| 旧 CLI（无 workspace/updateSystemPrompt 方法）  | method-not-found 静默降级，保持默认提示词                         |
| 旧 Host（session runtime preferences 无字段）   | CLI 按 undefined 处理，使用默认提示词                             |
| 广播旧发送方（payload 无字段）                  | schema default("") 补齐，解析不失败                               |
| workflow child 同时拿到 persona 与 systemPrompt | 既有互斥保护：继承链已剥离（script-workflow-child-runtime.ts:93） |

## 验收场景

1. 默认状态：设置页显示「默认」徽标；会话 system prompt 为内置拼装（contextUsage 分段可见）。
2. 自定义：输入文本保存 → 活动会话空闲时前缀重建，`sections` 出现 `custom_system_prompt`、
   动态段消失；新建会话同样生效；setting.json 落盘。
3. 还原：点击恢复默认 → 活动会话与新建会话回到内置拼装；setting.json 字段清空。
4. 冷启动继承：保存自定义后重启 App，直接新建会话即生效（反向请求路径，不依赖进程缓存）。
5. 多窗口：A 窗口保存，B 窗口设置页徽标与文本同步（广播）。
6. 回合中修改：运行中会话不中断当前回合，下一回合生效。
7. 越界：>200 000 字符被 schema 拒绝（UI 提交前同样拦截）。
