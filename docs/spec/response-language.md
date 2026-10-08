# 回复语言偏好（response language）

状态：v1（2026-10-08）。

## 语义

用户可声明「模型回复的首选语言」。**唯一事实源**：`AppSettings.language`（App 全局，
`~/.zcodium/v2/setting.json`）。归一化规则：`trim()` 后**空串 = 跟随用户消息**（内置默认，
不注入任何提示），非空 = 注入 `Preferred response language: <value>`。

- 与分段系统提示词（custom-system-prompt.md）不同：language **没有**「已恢复默认 vs 从未
  使用」的语义分叉要保护——空串与缺席等价，均按「不注入」处理；UI 快照恒携带 string（含
  空串），让清空态能穿越 RPC。
- 值来自固定列表（各语言的本地写法，如「简体中文」），不做自由文本，避免注入任意内容。

## 接口（六节）

### shared

- `protocol.ts` `AppSettings.language?: string`（手写 interface，单独加）。
- `validationAppSettings.ts`：`appSettingsObjectSchema` 与 `appSettingsPatchSchema` **两处**
  加 `language: z.string().max(64).optional()`。
- `app-runtime-preferences.ts` 广播 payload：`language: z.string().max(64).default("")`
  （default 兼容未携带该字段的旧发送方）。
- `zcode-protocol/index.ts`：
  - 新方法 `workspaceUpdateLanguagePreference: "workspace/updateLanguagePreference"`
    （独立方法 = 旧 CLI method-not-found 时 host 静默降级，同删除保护/分段模式）；
  - params `{ workspace, language: z.string().max(64) }`（空串显式可传 = 恢复跟随）；
    result `{ workspace, language, updatedSessionCount }`；
  - `zcodeSessionRuntimePreferencesResultSchema` 加 `language: z.string().max(64).optional()`
    （兼容旧 Host 缺省 = 跟随用户消息）。

### CLI（apps/zcode-cli/packages/bootstrap）

- 新 handler `zcode-protocol/language-preference.ts`：trim → 空白视为 undefined → 写
  `context.appRuntimePreferences.language`（进程缓存，供 inherit 源会话）→ 遍历
  `sessions` 调 `record.app.updateLanguage(v)` 并固化 `record.language`。
- `server.ts` 分发；`server-types.ts` record + appRuntimePreferences 加字段。
- `server-operations.ts` `SessionStartupPreferences.language` 三处接线：inherit 取
  `source.parent.language`、host 分支取 `runtimePreferences.language`、`createRecord` 在
  runtimeConfig 注入 `...(v?.trim() ? { language: v } : {})` 并固化 record。
- `app/types.ts` `updateLanguage?(language: string | undefined): void` + `create-app.ts`
  **双写**：`runtimeConfig.language`（未来会话）+ `getRuntime().updateConfig({ language })`
  （活会话）。

### core（apps/zcode-cli/packages/core）

`AgentRuntimeConfig.language`、`updateConfig`（含 `rebuildContextPrefix`）、
`ContextBuilderConfig.language` 均已存在（本轮接进 prompt：主 Agent `env_info` 与子代理
`<env>` 的 `Preferred response language` 行）——**无需改动**，这正是此前「死配置」修复的
下游。

### Host 服务层（packages/services + desktop）

四处映射点全部补 `language`（缺一处 = 「改了设置、老会话生效、新会话不生效」）：

| 位置                                                                  | 方式                                                                                            |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `zcodeAgent.ts` 偏好类型                                              | `language?: string`                                                                             |
| `zcodeAgentService.ts` `syncAppRuntimePreferences`                    | 非 string 拦截为 undefined；enqueue 仅在字段在快照中（含空串）时发送，method-not-found 静默降级 |
| `node.ts` `resolveSessionRuntimePreferences`                          | 冷启动现读 settingService，非空才携带                                                           |
| `remoteWorkspaceServiceCollection.ts` / `botRemoteWorkspaceBridge.ts` | 冷启动兜底快照同上                                                                              |

### UI（packages/ui）

- `settings/appRuntimePreferences.ts` 快照恒携带 `language: string`（缺省 `""`）；
  `touchesAppRuntimePreferences` 加 `typeof patch.language === "string"`。
- 控件放在**系统提示词分区**底部（`settings/ResponseLanguageField.tsx` 自包含组件 +
  Select 固定列表：「跟随用户消息」+ 各语言本地写法）。
- i18n 三语。

## 兼容与降级

| 场景                                 | 行为                                                            |
| ------------------------------------ | --------------------------------------------------------------- |
| 旧 CLI 收到 updateLanguagePreference | method-not-found，host 静默忽略（语言偏好不生效，其余不受影响） |
| 旧 Host 冷启动（result 无 language） | zod optional → undefined → 跟随用户消息                         |
| 广播对端旧版本                       | payload `default("")` 解析成功，语义为「跟随用户消息」          |
| 空/空白值                            | 一律归一化为「跟随用户消息」（不注入）                          |

## 验收场景

1. 设置页选「简体中文」保存 → 活会话下一请求 env 段出现
   `Preferred response language: 简体中文`；新会话冷启动同样出现。
2. 改回「跟随用户消息」保存 → 活会话 env 段该行消失（清空态穿越 RPC）。
3. Agent 工具子代理 `<env>` 同样携带该行（与主 Agent 同源）。
4. App 重启后首个会话（冷启动现读路径）生效。
5. 远端 / Bot 任务会话同样生效（四处映射点齐全）。
6. 未设置过语言时，env 段无该行（零打扰）。
