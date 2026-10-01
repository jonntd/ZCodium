# Spec: Web 端 bootstrap 的交付点（何时算「连上了」）

本 spec 定义 Web 客户端从「打开页面」到「可以渲染 App」的判定点。它是一份**行为契约**，
涉及 `packages/client` 与 `packages/web` 两个模块，直接影响直连 `zcode --web`、云 relay
（`?remote=`）与自建 VPS relay 三条路径。

## 1. 问题

`connectViaWebSocket` 曾在 WS `open` 就 resolve。但 `open` 只证明传输握手完成：
`ChannelClient` 在收到服务端 `Initialize` 帧之前**不发出任何请求**（`whenInitialized()` 门控），
在此期间断开时它只会 reject 排队中的请求。于是调用方拿到的是一个「已死通道」，页面渲染
Root 空壳（白屏）、既没有错误提示也没有重试入口。

实测（VPS relay，`/private/tmp/zcode-relay/relay.log`）：手机刷新会连坐关闭桌面 host 连接，
新页面的 WS 若落在 host 缺位窗口内会被 relay 以 4002 关闭；旧实现的 resolve-on-open
使这次关闭不可见 → 空白页；再刷一次（host 已回来）又正常 → 「刷一次空白、再刷一次出界面」。

## 2. 规则

**唯一所有者**：`connectViaWebSocket`（`packages/client/src/websocket.ts`）。
它是 Web 端唯一的连接入口（全仓库仅 `packages/web/src/main.tsx` 一个调用点）。

| 事件 | 结果 |
| --- | --- |
| 收到服务端 `Initialize` 帧（`ChannelClient.onDidInitialize`） | ✅ resolve，交出 `IServiceAccessor` |
| WS `error` | ❌ reject（连接失败） |
| WS `close` 且尚未交付（含 relay 的 4002 `host-offline`/4003） | ❌ reject，reason 保留在错误消息里 |
| `initializeTimeoutMs`（默认 20s）内始终没有 `Initialize` | ❌ reject，并**主动 `close()`** socket |

失败由调用方处理：`packages/web/src/main.tsx` 的 `bootstrapWebApp` 捕获后渲染
「Web 启动失败 + Retry」错误页（`renderWebBootstrapError`），不再有静默白屏。
交付之后才断开时，只触发 `onClose`，**不撤销**已交付的结果。

**超时的定位**：它不是用来掩盖同步问题，而是兜住「socket 一直开着但通道始终不初始化」
这一种无终点等待；正常失败路径由 close 事件给出（relay 宽限到期会明确 4002）。
超时上限可被 `initializeTimeoutMs` 覆盖（测试用短值）。

## 2.1 失败后的**有界**自动重试

交付点变严之后，「桌面刚重启 / relay 宽限到期」会明确抛错。这类**瞬时**失败整页重连一次
通常就能成功，所以 `bootstrapWebApp` 在连接阶段包一层 `connectWithBoundedRetry`
（`packages/web/src/bootstrapRetry.ts`）：

| 规则 | 值 / 行为 |
| --- | --- |
| 上限 | `WEB_BOOTSTRAP_MAX_ATTEMPTS = 2`（首次 + 1 次自动重试） |
| 退避 | 1s 起、按 `×2` 递增（上限提高时 1s / 2s / 4s；当前只有一次退避） |
| 超出上限 | 抛出**最后一次**错误，保留真实 reason，交给错误页展示 |
| 成功 | 立即返回，不产生多余等待 |
| 明确不做 | 无限重连：真实离线必须尽快落到错误页，而不是永远转圈 |

**为什么不是更大上限**：单次失败的等待里已经包含 relay 的 `HOST_WAIT_GRACE_MS`（默认 5s），
3 次尝试意味着最坏 ~17s 才给用户反馈；1 次重试（最坏 ~11s）换掉的正是「桌面重启」这种最常见的瞬时窗口。

## 2.2 交付**之后**断线（Root 已渲染）

交付成功后传输断开时，页面**不自动刷新、也不卸载界面**，只在独立挂载点
`#zcode-web-connection-lost-notice`（不挂在 React `root` 上）叠加一条提示：

| 事件 | 提示 | 动作 |
| --- | --- | --- |
| close code **4004**（被其他页面顶替） | 「此页面已被其他窗口接管」 | **无按钮** |
| 其它 close（4002 `host-offline` / 4003 / 1006 / 1000 …） | 「与桌面的连接已断开」+ reason/code | 「重连」按钮 → `location.reload()` |

两条设计依据：

1. **不自动刷新**：自动刷新会丢未提交草稿；多标签下两个页面还会互相顶替形成刷新拉锯。
2. **4004 不给重连按钮**：`resolveConnectionLostNoticePolicy`
   （`packages/web/src/connectionLostNotice.ts`）把这条规则钉成可单测的纯函数——漏掉它就会退化成刷新拉锯。
3. 用户点「重连」= 整页重载 = 新 attachment = `replayable` 快照恢复，这是**已验证**的恢复路径；
   提示按元素 id 去重，只挂载一次；断线期间的服务调用失败仍由既有 UI 错误提示呈现。

**未做（独立议题）**：传输级自动重连（保持同一 `services` 实例）需要 RPC 层支持替换 protocol，
还要定义 UI 在换 attachment 后如何重新拉快照；在两者定清之前，一键重连是唯一不会造成状态错配的路径。

## 2.3 为什么交付后断线**不**做自动重载 / 自动重连（决策记录）

**需求**：手机锁屏 / 后台 / 切网后回到页面，希望不点任何按钮就恢复。

**结论：现在不做。** 任何"自动恢复"都必须换一条新 attachment（见 §1 的交付点语义），
而换 attachment 只能靠整页重载，会丢弃**仅存在于渲染器内存**的状态：

| 状态 | 所有者 | 重载后 |
| --- | --- | --- |
| 未发送的输入 | composer 组件内部 state（`packages/ui/src/components/ai-elements/prompt-input.tsx`） | 丢失 |
| elicitation 表单草稿 | `zcodeSessionStore.elicitationFormDraftsByRequestId` | 丢失 |
| 待审批 / 待确认交互、pending optimistic overlay | 渲染器内存 store | 丢失 |

**证据（为什么这不是"顺手加个兜底"）**：`packages/ui/src/lib/chatComposerDraftStorage.ts`
的文件注释写明「composer 草稿的内存态与持久化写入已随旧 ChatView/composer 删除，
**v4 composer 不做本地持久化**」，即草稿持久化是**被刻意移除**的；会话 store 中也没有
`persist()`。所以自动重载等于把这个刻意保留在内存里的状态**静默**丢掉 —— 不能作为默认行为。
当前实现（非破坏性横幅 + 一键重连）保证用户先看到断线、再自己决定何时丢。

若确实要免点击恢复，只有两条路，都超出"改入口"的范围：

| 路径 | 内容 | 成本 / 阻塞点 |
| --- | --- | --- |
| **A 传输级 resume（不重载）** | `ChannelClient` 支持替换 protocol 并 reset 到未初始化；relay 向每个新 client 回放已缓存的 `Initialize`（现有缓冲规则的延伸）；UI 在重新 `Initialize` 后重拉 snapshot | 要先在 `packages/rpc` 定义"替换 protocol"的接口与**在途请求 reject 语义**；更要回答"换 attachment 后谁触发快照重拉"。官方实现在这里引入了一整套信封协议（`bootstrap-request/response`、`workspace-bridge-open/ready`、`rpc-frame-ack` + `recoveryId`，见 `vps-relay-bridge.md` §14.3），说明这不是补丁量级 |
| **B 先持久化再自动重载** | 恢复 composer + elicitation 草稿持久化，然后（可选：仅页面隐藏时）自动重载 | 与刻意移除的持久化决策冲突，需先定草稿生命周期 / 配额 / 跨设备语义 |

**决策**：A / B 都要先定接口与产品语义，属独立 spec（见 §2.4）；默认行为保持 §2.2。

## 2.4 免点击恢复：显式 opt-in 的自动重连

默认的「只提示」对无人值守的手机场景（锁屏/后台回来后希望自己恢复）不够，但整页重载会丢
内存态（§2.3 的证据）。折中是把选择权**显式**交给使用者，而不是替他决定：

| 配置 | 交付后断线（非 4004） | 交付后断线（4004 被顶替） |
| --- | --- | --- |
| 默认（无 `autoReconnect`） | 提示 + 一键重连 | 仅提示（无按钮） |
| 配对链接带 **`autoReconnect=1`** | **自动整页重载**（sessionStorage 限流 10s/标签） | 仅提示（永不自动重载） |

规则要点：

1. **开关来自 URL**：`https://<vps>/?token=…&autoReconnect=1`。因此 relay 的配对重定向
   **只摘 `token`、保留其它参数**（`deploy/vps-relay/relay.mjs`，测试用例 6），否则把带开关的
   链接加进主屏后开关会被重定向吃掉。
2. **限流**：同一标签 10s 内只自动重载一次（`sessionStorage`），桌面长期离线时不会无限刷新；
   限流未放行或拿不到 `sessionStorage`（隐私模式）→ 退回提示 + 手动重连。
3. **4004 永不自动重载**：多标签互相顶替会形成刷新拉锯（策略函数
   `resolveConnectionLostAction` 与 `resolveConnectionLostNoticePolicy` 都在
   `packages/web/src/connectionLostNotice.ts`，均可单测）。
4. 开启该开关即表示接受「恢复可能丢弃未发送输入 / 未决弹窗」；默认关闭保证不静默丢数据。

**仍未做**：§2.3 的 A（传输级 resume）与 B（草稿持久化）两条真正无损的路径——都要先定接口/产品语义。

## 3. 前置不变式：所有服务端路径都会立即发 Initialize

等待 `Initialize` 成立的前提是服务端在 attach 时立刻发送它：

| 服务端路径 | 是否立即发 Initialize |
| --- | --- |
| `zcode --web` 的 `/ws` | ✅ `setupChannelServer` → `new ChannelServer(protocol, "server")`（`deferInit` 默认 false） |
| 云 relay 的 `/ws/remote/:id` | ✅ 同上（`packages/server/src/http.ts`） |
| 自建 VPS relay 的 `/host` → 桌面 Host attachment | ✅ Host 日志 `creating ChannelServer (deferInit=false)`；relay 会缓冲该帧并在配对时回放 |
| `deferInit=true` 的延迟初始化 | ⚠ 代码路径存在（`exposeServicesOnMessagePort` 的第 3 个参数），但**全仓库只有一处调用点且传 `false`**；若将来新增 `true` 的调用，必须先回到本 spec 重新定义交付点 |

## 4. 状态与事件顺序

```text
new WebSocket(url)
  ├─ open        → 建 ChannelClient；交付点仍未达成（页面保持 index.html 的 loading 壳）
  ├─ Initialize  → ✅ resolve → bootstrapWebApp 渲染 Root
  │                 └─ 之后 close：只回调 onClose（不重试、不回滚）
  ├─ close/error → ❌ reject → 错误页 + Retry 按钮
  └─ 超时        → ❌ reject + 主动 close
```

`RemoteServiceAccess` 仍在 `open` 时构造（它只建 channel 代理，不发请求），与本次改动前一致。

## 5. 验收场景

| 场景 | 期望 | 测试 |
| --- | --- | --- |
| WS open 之后、Initialize 之前 | promise 仍未 settle | `packages/client/tests/websocket.test.mjs` #1 |
| open 后收到 Initialize | resolve 并交出 accessor | `websocket.test.mjs` #1 |
| open 之后、Initialize 之前被关闭（relay 4002） | reject，错误信息含 reason | `websocket.test.mjs` #2 |
| Initialize 之后被关闭 | onClose 触发一次，已交付结果不变 | `websocket.test.mjs` #3 |
| 始终不 Initialize | 超时 reject 且 socket 被主动关闭 | `websocket.test.mjs` #4 |
| 第 1 次失败、第 2 次成功 | 自动重试一次并交出 accessor，退避 1s | `packages/web/tests/bootstrapRetry.test.mjs` #2 |
| 连续失败 | 恰好尝试 2 次后抛出最后一次错误（不无限重连） | `bootstrapRetry.test.mjs` #3 |
| 提高上限 | 退避指数递增（1s / 2s） | `bootstrapRetry.test.mjs` #4 |
| 交付后被顶替（4004） | 策略为「只提示、不给重连按钮」 | `packages/web/tests/connectionLostNotice.test.mjs` #1 |
| 交付后桌面离线（4002 等） | 策略为「提示 + 重连按钮」 | `connectionLostNotice.test.mjs` #2 |
| 默认配置下任何 close | 一律 `notice`，绝不自动重载 | `connectionLostNotice.test.mjs` #3 |
| `autoReconnect=1` + 4002 | `reload` | `connectionLostNotice.test.mjs` #4 |
| `autoReconnect=1` + 限流未放行 | 退回 `notice`（防刷新循环） | `connectionLostNotice.test.mjs` #5 |
| `autoReconnect=1` + 4004 | 仍为 `notice`（防多标签拉锯） | `connectionLostNotice.test.mjs` #6 |
| relay 配对重定向 | 只摘 `token`，保留 `autoReconnect` | `vps-relay-forward.test.mjs` 用例 6 |
| 交付后真实断线（浏览器） | 提示可见、界面不被卸载、无启动失败页 | 浏览器探针（本机 relay + 假 host） |

运行：`pnpm --filter @zcode/client test` 与 `pnpm --filter @zcode/web test`

## 7. 浏览器支持下限与「卡 logo」自诊断

Web bundle 的下限是 **iOS/Safari 16.4+**。证据（产物扫描）：

| 产物里的东西 | 首次支持 | 后果 |
| --- | --- | --- |
| `class static {}`（入口 chunk） | Safari 16.4 | 低于此版本**解析阶段**失败 → React 永不挂载 |
| CSS `@property` / `color-mix()`（Tailwind v4 输出） | Safari 16.2–16.4 | 样式退化 |
| `??=` / `.at()` / `structuredClone` / `Object.hasOwn` / `findLast` | Safari 15.4 | 更低版本解析过了也会运行时报错 |

低版本浏览器的表现是**永远停在 loading logo**（壳是纯 HTML，没有任何错误可见）。因此
`packages/web/index.html` 内嵌一段 **ES5** 自诊断（必须能在不支持的浏览器里运行）：

| 情况 | 触发方式 | 提示内容 |
| --- | --- | --- |
| 入口脚本网络加载失败 | script 元素 error（捕获阶段） | 「页面未能启动」+ 失败 URL |
| 脚本运行时报错 | `window` error / `unhandledrejection` | 错误信息 |
| 解析失败（浏览器过旧） | 15s 内壳未被 React 替换（超时兜底） | 同一提示 + 平台版本（如「检测到 iOS 15.7：本页需要 iOS 16.4 及以上」） |

**非安全上下文**（`http://<局域网 IP>`，即内网 http 访问）下 `crypto.randomUUID`、`crypto.subtle`、
`navigator.clipboard` 不可用：核心流程可用（已实测渲染成功），但剪贴板/加密相关功能会缺失；
手机长期使用建议走 HTTPS（VPS relay + TLS）。

验收：正常加载 16s 内**不出现**提示；拦截入口 chunk 时出现提示与失败原因（浏览器探针，两条均已实测）。

## 6. 影响面与迁移

- **需要重建 web bundle**：`pnpm --filter @zcode/web build`。relay/容器托管的是
  `packages/web/dist`，不重建则线上仍是旧 bundle（与「改了 relay 不重启」同类陷阱）。
- 已确认无其它调用点：`connectViaWebSocket` 只有 `packages/web/src/main.tsx` 一处使用；
  `connectViaProtocol`（同步、无交付点概念）保持不变，仅抽出同源的
  `createChannelClient` 以避免重复构造。
- 重试只在**连接阶段**：`resolveWebBootstrap()`（`/api/server-info`）自带兜底返回，
  不进重试循环；`Root` 渲染之后的断线按 §2.2 处理（非破坏性提示 + 一键重连）。

