# Spec: 提示词增强统一链路(prompt-enhance-unified)

日期:2026-09-28。取代 `patcher-parity.md` §6 的实现方式描述(模板契约继续有效)。

## 1. 背景与决策

增强提示词按钮原为 desktop main 进程旁路实现(preload IPC → main 直读
`~/.zcode/v2` 配置 + 解密凭据 + 渠道评分 + 裸 fetch 渠道 API),Web 端不可用。
2026-09-28 起迁移到与「生成提交消息」(`gitService.generateCommitMessage`)完全相同的
统一执行链路:

- **模型选择:跟随会话模型**。增强不再有独立渠道/模型选择,使用 Host View 的
  `preferredSelection`(即 composer 当前选中模型)。原渠道评分链、
  enhance-config.json 手动渠道、oauth 跨渠道兜底、localStorage 指定(`zcode-enhance-model`)
  全部废弃。
- **旧旁路彻底删除**:desktop main 三个文件、IPC channel、preload bridge、
  `IPlatformService` 可选方法、`window.zcode` 声明同步清理,不留第二条写入路径。
- Web 端按钮**变为可用**(统一服务集合对 web 全量暴露),这是行为改进。

## 2. 调用链与状态所有者

```text
UI ComposerEnhanceButton (packages/ui)
  └─ promptAssistService.enhancePromptDraft({ text, workspacePath, workspaceIdentity? })
      └─ [RPC: ServiceChannels.PromptAssist = "prompt-assist"]
services 层 PromptAssistService (packages/services/src/prompt-assist/)
  └─ PromptEnhanceGenerator(唯一所有者:模板组装、输出校验、短输入直判)
      ├─ currentModelProvider.readCurrentModel()  ← Host View preferredSelection
      └─ textGenerator.generateText(querySource="prompt_enhance")
          └─ zcodeAgentService.generateWorkspaceText → workspace/generateText
              └─ Agent runtime(辅助档位:最低 reasoning 档 + 5000 输出预算)
```

- 状态所有者:无持久状态。composer 草稿仍归 composer 所有,增强只在拿到非空
  改写结果后整体替换一次;服务层无队列、无缓存、无重试状态(重试由统一执行面
  的 adapter 重试预算承担)。
- 单写入路径:草稿替换只有 `onReplaceDraft` 一条;禁止 UI 侧再实现模板/校验逻辑。

## 3. 接口契约

`packages/shared/src/prompt-assist.ts`:

```ts
interface PromptEnhanceDraftRequest {
  workspacePath: string;
  workspaceIdentity?: string;
  text: string;
}
interface PromptEnhanceDraftResult {
  text: string; // 增强后的提示词(或 unchanged 时的原文)
  unchanged?: boolean; // 短输入直判,未调用模型
}
```

`IPromptAssistService.enhancePromptDraft(request): Promise<PromptEnhanceDraftResult>`。

失败语义(与提交消息三分类一致,错误信息经 RPC 传给 UI toast):
`model-unavailable`(未读取到会话模型)/ `request-failed`(模型调用失败,含统一
执行面的失败分类)/ `invalid-output`(标记提取失败或指令回显,不写草稿)。

## 4. 行为规则(延续 §6 契约,实现位置变更)

- **模板契约(逐字迁移,禁止改写)**:系统提示词、user content 模板、
  `### BEGIN/END RESPONSE ###` 标记、`extractMarkedResponse`、
  `ENHANCE_ECHO_PATTERN` 回显检测、`sanitizeEnhancedPrompt` 清洗(围栏/样板语/
  工具脚手架/引号/emoji;**清洗后为空必须回退原文**,不得清空草稿),全部从
  desktop main 原样迁入 `promptEnhanceGenerator.ts`。
- **语言对齐**(2026-10-08 修订):增强结果语言严格跟随用户输入语言——中文进中文出、
  英文进英文出,其余语言同理;代码/路径/标识符/URL 原样保留。取代原"必须使用简体中文"
  约束(移植自腾讯版 WorkBuddy 的增强提示词结构)。
- **辅助档位**(runtime 端 `prompt_enhance` 特判,对齐 `git_commit_message`):
  最低公开 reasoning 档位 + 输出预算 min(5000, 模型上限)(覆盖原旁路 4096),
  忽略调用方 `maxOutputTokens`;anthropic 的 `thinking: disabled` 由统一执行面
  的辅助档位语义接管,不再手写请求体。
- **短输入直判**:去空白后不足 6 个码点返回 `{ text, unchanged: true }`,不调用
  模型(2026-09-28 修订:原契约阈值为 2;Web 端实测 2~4 字符输入会让会话模型
  产出"改写说明"类元描述甚至嵌套标记,回显检测必然拦截,用户只看到失败——
  此类输入没有改写价值,直判透传,同时节省辅助调用额度。本条取代
  patcher-parity §6 的 2 字符口径)。
- **invalid-output 单次重试**:标记提取失败或回显检测命中最多重试一次(同模型
  重新生成;2026-09-28 修订:旧旁路靠跨渠道 failover 提供韧性,单模型链路对
  偶发坏输出没有第二次机会)。第二次仍不合规则按 `invalid-output` 抛错,
  绝不把垃圾写进草稿。
- **静默替换**:成功不弹 toast,误增强用编辑器原生 Cmd+Z 撤销;toast 只出现在
  空草稿提示、`unchanged` 提示、失败三种场景。
- **Ctrl+/**:composer 聚焦时触发,与按钮同一 `disabled` 门槛,禁用态不得绕过。
- **UI 不再消费渠道列表**:无下拉菜单、无徽标、无 localStorage。

## 5. 事件顺序(异步边界)

1. UI 点击/Ctrl+/ → 冷却闸(1200ms,防双击)→ 空草稿短路 toast。
2. RPC `enhancePromptDraft` → services 读 git 无关,直接进生成器 → 读
   preferredSelection(空 → `model-unavailable`)→ 组装 prompt →
   `generateWorkspaceText`(runtime 端 60s 超时 + adapter 重试)。
3. 返回文本 → 标记提取 → 回显检测(不合规自动重试一次,仍不合规抛
   `invalid-output`)→ sanitize(空回退原文)→ RPC 响应。
4. UI `unchanged` 分支 toast「无需增强」;成功分支整体替换草稿;失败分支 toast,
   草稿不动。

- 幂等性:同一草稿重复点击由冷却闸去重;重复调用模型无副作用(生成是纯函数)。
- 取消:不提供取消入口(单次 <60s,原旁路同样无取消);窗口关闭/组件卸载后
  返回结果被丢弃,不写草稿。

## 6. 验收场景

1. desktop,任选模型(含第三方 openai-compatible 渠道)→ 输入草稿 → ✨ →
   草稿替换为增强文本;telemetry 记 `workspace_prompt_enhance`。
2. 空草稿 → toast「请先输入需要增强的提示词」;不足 6 字符的草稿(如 `test`)
   → toast「无需增强」,不产生模型调用。
3. Ctrl+/ 与按钮等价;按钮 disabled 时快捷键不生效。
4. 模型输出不守格式/回显 → toast 失败,草稿保持原样。
5. 未选模型(preferredSelection 为空)→ toast 失败。
6. Web 端:按钮渲染且走 WebSocket 服务链路可用。
7. 模型清洗后为空的响应 → 结果回退原文(unchanged 语义之外的 text=原文),草稿
   不被清空。

## 7. 迁移边界

- `patcher-parity.md` §6 中「渠道列表/评分/手动渠道/平台可选方法」相关条目随之
  作废;模板与结果清洗契约继续有效,以本 spec 为准。
- 升级用户若曾用 `zcode-enhance-model` localStorage 指定,迁移后该键被忽略
  (不主动清理,避免误删同域其它键)。
