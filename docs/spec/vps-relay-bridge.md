# Spec: VPS 中继桥接到桌面 Host（VPS relay bridge）

本 spec 定义「用一台公网 VPS 做中继，让手机浏览器接管**本机桌面正在运行的 Host**」的最小实现路径。
目标是最小改动：**手机侧零改动、Host 侧零改动、协议零改动**，只在桌面 Main 新增一个出站中继客户端，
在 VPS 上跑一个不依赖本仓库的极简转发器。

> 前置事实（已实测）：桌面与 web 共享同一份 `~/.zcode` 数据（任务索引 + 会话历史），
> 且桌面 Host 已经为「手机 attachment」预留了 `scope: { kind: "local" }` 的挂载点
> （`packages/desktop/src/host/index.ts:2663-2666` 注释：
> 「刷新/手机 attachment 复用同一 Host，等待现有准备，不启动第二个执行者」）。
> 本 spec 补的是**传输**这一段，不是会话运行时。

## 1. 先排除两条看似可行、实际不可用的捷径

### 1.1 不能复用 `/ws/host`

`packages/server/src/http.ts:338-345` 的 `/ws/host` 看起来是「host 连进来」的入口，
但它暴露的是 **server 自己的 `services`**：

```ts
const upgradeTrustedHostWebSocket = upgradeWebSocket(() => ({
  onOpen(_event, ws) {
    setupChannelServer(ws.raw as WebSocket, services, "desktop-continuous");
  },
}));
```

`services` 是该 server 进程里 `createLocalServices()` 的产物，**不是桌面的 Host**。
`trusted-host-relay` 角色只解锁 `IProviderProvisioningTargetService`（跨 Environment 凭据，
见同文件 `:106-117`），并不改变服务的归属。该入口是「桌面连进远端 server」的方向
（配合 SSH/WSL 远端 workspace 部署），与「手机连回本地桌面」相反。

### 1.2 不能复用 `attachRemoteWorkspaceSessionHost`

`packages/desktop/src/main/desktopRemoteSessions.ts:770-830` 要求
`routesBySessionId` 里存在一个 **remote logical session**，且强制
`workspaceKey === descriptor.workspaceIdentity`（`kind: "remote"` 语义）。
它是给 SSH/WSL 远端 workspace 用的，**本地 workspace 桥接不该走它**，否则必然撞
`REMOTE_SESSION_MISSING` / `REMOTE_WORKSPACE_IDENTITY_MISMATCH`。

正确做法：在 Main 里**直接**向窗口 Host 投递 `AttachServicePort`，`scope` 用 `{ kind: "local" }`。

## 2. 架构

```text
手机浏览器 ──wss──► VPS relay ──wss──► 桌面 Main ──MessagePort──► 窗口 Host ──stdio──► Agent
（零改动）        （新写 ~100 行）    （新写 ~120 行）        （零改动）          （零改动）
                   纯字节转发          帧格式转码桥
```

- **手机侧零改动**：`packages/web/src/main.tsx:271-280` 的 `resolveDefaultWsOrigin()` 由
  `window.location` 推导 wsUrl，手机打开 `https://<vps>/` 时自然得到 `wss://<vps>/ws`。
  VPS 只要在 `/ws` 上等它即可。
- **VPS 侧纯字节转发**：手机↔VPS↔桌面 三段里，前两段都是同一套 `SocketProtocol` 帧格式，
  所以 relay **不需要理解协议**，按 room 配对后逐字节 `send` 即可。
- **桌面 Main 是唯一的转码点**（见 §4.2）。

## 3. 改动清单

| 位置 | 类型 | 规模 | 说明 |
| --- | --- | --- | --- |
| VPS `relay.mjs` | 新增（仓库外） | ~100 行 | `/host` + `/ws` 配对转发、静态服务、`/api/server-info` |
| `packages/desktop/src/main/remoteRelayClient.ts` | 新增 | ~120 行 | 出站连接、转码桥、attach、重连 |
| `packages/desktop/src/main/index.ts` | 修改 | ~10 行 | 按 env 开关启动 relayClient，并注入 `getWindowHost` |
| `packages/desktop/src/main/desktopRemoteSessions.ts` | 修改 | ~3 行 | 把私有 `getWindowHost` 作为依赖暴露（或让 relayClient 复用该闭包） |
| `packages/web/**` | **不动** | 0 | |
| `packages/desktop/src/host/**` | **不动** | 0 | |
| `packages/shared`（协议） | **不动** | 0 | |

无需新增协议字段、无需新表、无需改 Host attach 注册表。

## 4. 实现

### 4.1 VPS relay 要点

1. `wss://<vps>/host` —— 桌面拨入。**必须强鉴权**（`Authorization: Bearer <共享密钥>`，
   密钥由 env 注入）。带上 `?room=<id>` 或由服务端分配。
2. `wss://<vps>/ws` —— 手机接入。需要一次性配对码（可由桌面连上后经 `/host` 通道下发，
   或 VPS 生成后由用户手输/扫码）。
3. 两侧齐了就把帧**原样互相 `send`**；任一侧断开则关闭另一侧。
4. `GET /` 静态服务 `packages/web/dist`。
5. `GET /api/server-info` —— 手机端 `resolveWebBootstrap()`（`main.tsx:286-304`）会 fetch 它拿
   `workspaces[0].path`。VPS 应在桌面连上后缓存桌面上报的 workspace 并返回，
   否则手机端拿不到初始工作区。
6. TLS 用 caddy/nginx 终结，`/ws` 与 `/host` 反代到 relay。

### 4.2 桌面 Main `remoteRelayClient.ts` 骨架

关键约束：`SocketProtocol.send()` 会写 **13 字节帧头**（`packages/rpc/src/protocol.ts:207`
`HEADER_SIZE = 13`；`:236-256` `writeProtocolMessage`），而 Host 侧 MessagePort 收发的
是**裸 payload**（`MessagePortProtocol.send()` 就是 `port.postMessage(buffer.buffer)`，
同文件 `:383-385`）。**两侧帧格式不同，所以不能纯字节管道，必须经 `SocketProtocol` 解帧。**

```ts
import { SocketProtocol, VSBuffer, type ISocket, Emitter } from "@zcode/rpc";
import { BrowserWindow, createMessageChannel } from "electron";
import { randomUUID } from "node:crypto";

// 与 packages/server/src/http.ts:44 同构（该函数是 server 包私有，需在此复制 ~20 行）
function wrapWebSocket(ws: WebSocket): ISocket { /* onData/onClose/onEnd + ws.on("message") */ }

export function connectRelay(opts: { url: string; token: string; windowId: number }) {
  const ws = new WebSocket(`${opts.url}/host`, {
    headers: { authorization: `Bearer ${opts.token}` },
  });
  const wsProto = new SocketProtocol(wrapWebSocket(ws)); // WS 侧：负责加/去 13B 帧头

  const { port1, port2 } = createMessageChannel();

  // 转码桥：wsProto 出来的已是裸 payload，直接投给 Host 侧端口
  wsProto.onMessage((buf) => port1.postMessage(buf.buffer));
  port1.on("message", (e) => wsProto.send(VSBuffer.wrap(new Uint8Array(e.data as ArrayBuffer))));

  const win = BrowserWindow.fromId(opts.windowId);
  getWindowHost(win).postMessage(
    {
      type: HostMessageTypes.AttachServicePort,
      requestId: randomUUID(),
      attachmentId: randomUUID(),
      clientMode: "web-remote-replayable", // 必须与手机侧档位一致
      scope: { kind: "local" },            // 只需这一个字段
    },
    [port2],
  );
}
```

- **`getWindowHost` 目前不可直接复用**：它是
  `packages/desktop/src/main/desktopRemoteSessions.ts:146` 的**闭包内私有函数**，依赖注入的
  `options.windowHostProcessMap`，并且顺带调用 `ensureHostListener(child, webContentsId)`
  完成 host→main 的监听接线：

  ```ts
  function getWindowHost(win: BrowserWindow): ElectronUtilityProcess {
    const child = options.windowHostProcessMap.get(win.webContents.id);
    if (!child || child.pid == null) throw new Error(`未找到窗口 Local Host, windowId=${win.webContents.id}`);
    ensureHostListener(child, win.webContents.id);
    return child;
  }
  ```

  因此两个选择（**推荐后者**）：
  1. 把 relayClient 的接线写进 `createDesktopRemoteSessions(options)` 内部，直接复用闭包；
  2. 从 `main/index.ts` 把 `getWindowHost` 作为依赖注入给 relayClient —— 保持 relayClient 是
     独立模块，且**复用了既有的 `ensureHostListener` 接线**（自己重写会漏掉监听注册）。
- 断线重连：`ws.onclose` 后指数退避重连，并重新走一遍 attach（旧的 `attachmentId` 走
  `DetachServicePort` 释放，避免 Host 侧残留半清 record）。
- 可选：加心跳（`ws.ping`）与 `--host` 侧超时。

### 4.3 为什么不需要 `MessagePortProtocol`

`MessagePortProtocol` 的实现等价于「`postMessage(buffer.buffer)` + 只接受 `Uint8Array`」
（`protocol.ts:369-385`），且额外带 `connection-flow-v1` 控制帧。
Main 侧直接用裸 `postMessage` 即可；**若 Host 侧依赖 flow control 语义，则应改用
`MessagePortProtocol` 包装 port1**，两者都只需 ~3 行差异，实现时以 Host 侧是否发控制帧为准。

## 5. 关键约束与坑

1. **`clientMode` 必须为 `"web-remote-replayable"`。**
   `packages/shared/src/zcode-protocol-v4/transport.ts:55-64` 的 `superRefine` 强制
   `clientMode ↔ deliveryProfile` 匹配；手机侧走 replayable 档，填错会在握手期直接失败。
2. **`scope` 是 `.strict()` 的**：`packages/shared/src/validation.ts:176-186`
   `z.object({ kind: z.literal("local") }).strict()` —— **不能多塞 `workspacePath` 等字段**，
   多塞会校验失败。这是 local 比 remote 简单的地方（remote 才需要
   `remoteSessionId` / `workspacePath` / `workspaceIdentity` 三元全等）。
3. **Host 未 ready 时会自动挂起**：`packages/desktop/src/host/index.ts:2663-2670` 的
   `pendingStartupAttachments` 会等到 `phase === "ready"` 再 attach。**不要自己重试或等待**。
4. **`/api/server-info` 必须能应答**（见 §4.1 第 5 条），否则手机端
   `resolveWebBootstrap()` 拿不到 `initialWorkspaceAbsPath`。
5. **安全**（最重要）：`/host` 端点若鉴权不严，**任何知道 VPS 地址的人都能接管你的桌面**——
   等价于 RCE（Host 暴露的是完整服务面，含终端、文件、Git）。必须：
   - `/host` 用强共享密钥 + TLS；
   - `/ws`（手机）用一次性、短时效的配对码；
   - 配对码与密钥都不落日志；
   - 建议再加「仅允许一个 host 连接」与「配对码消费即失效」。
6. **出站连接**：桌面是**主动拨出**到 VPS，所以 NAT / 无公网 IP 都没问题（这是选这个方案的主要理由）。
7. **多窗口**：`getWindowHost(win)` 需要选定窗口。桌面可能开多窗口，需明确「attach 到哪个窗口」
   （建议：跟随当前 focused window，或由用户在设置里指定）。
8. **`wrapWebSocket` 是 `packages/server/src/http.ts:44` 的私有函数**。两个选择：
   - 复制到 desktop（约 20 行）——与 `packages/server/src/remote/stdio-socket.ts:8`
     注释所述「follows the same pattern」的既有做法一致；
   - 或把它提升为 `@zcode/server` 的公开导出——这会产生一条新的跨模块边，
     按 `architecture-policy.yaml` 需要先登记契约。
   建议先用复制，避免在 legacy 模块上新增跨模块依赖。

## 6. 验收场景

1. **基本桥接**：桌面开启 relay，手机打开 `https://<vps>/` → 看到**桌面当前 workspace 的**
   任务列表与会话历史（不是 VPS 的）；发送提示词 → 桌面 Host 里出现同一个会话的推进。
2. **复用而非新起**：`ps` 检查桌面侧**没有新增 Agent 进程**（复用的是桌面已有 Agent）。
3. **数据一致**：手机侧发的消息出现在桌面 App 的同一会话里（共享 `db.sqlite`）。
4. **断线重连**：手机切网络 / 锁屏后再打开 → 会话恢复（replayable 档的 snapshot + gap repair），
   不需要重开任务。
5. **桌面退出**：关闭桌面 App → VPS `/host` 断开 → 手机侧明确提示「桌面离线」，不静默卡死。
6. **鉴权**：不带 `Authorization` 访问 `/host` → 拒绝；用已消费的配对码访问 `/ws` → 拒绝。
7. **回归**：桌面原有功能不受影响（无 relay 配置时不启动任何连接）；
   `pnpm typecheck` 与 `pnpm lint` 通过。

## 7. 未决问题

1. **配对码从哪来**：官方用的是「桌面向官方平台申请 → 拿到 sid/hash → 拼链接」。
   自建可以更简单（VPS 生成短码，用户手输），但若要复用社区 fork
   （`jchanghong023/zcode-mobile` 的 `packages/web/src/remote-v4/`）的客户端解析逻辑，
   就得沿用 `sid/hash/t` 契约。**这两条路的客户端改动量差别很大**，需先定。
2. **是否复用 `@zcode/rpc` Layer 6 的 `WebSocketRemoteConnection` / `ISocketFactory` /
   `RemoteSocketFactoryService`**（`packages/rpc/src/index.ts` 已导出）。若可用，桌面侧可省掉
   自写 `wrapWebSocket`；需先确认它的 `RemoteAuthorityResolver` 语义是否适配「中继」而非「直连」。
3. **`connection-flow-v1` 控制帧**是否必须（见 §4.3）。需要实测 Host 侧是否依赖 flow control。
4. **多窗口选谁**（§5.7）。
5. **`/api/server-info` 之外的其它 `/api`**：手机端还可能有别的同源 REST 调用，
   需要按 `packages/web/src` 的实际 fetch 点逐个确认是否需要 VPS 代理。

## 8. P2P（WebRTC）作为可选增强的可行性评估

用户问「能不能用 `liguobao/ds-harness-remote` 的 P2P 方式」。结论：**技术上可行，
但不建议作为第一步；而且真正该先要的是 E2EE，不是 P2P。**

### 8.1 先分清两件被混在一起的事

| | 解决什么 | 与 P2P 的关系 |
| --- | --- | --- |
| **E2EE**（Noise 握手 + 对称加密） | VPS 看不到你的代码 / 终端内容 | **独立**。relay 之上加一层即可，不需要 P2P |
| **P2P**（WebRTC DataChannel） | 不经过 VPS 中转（延迟、带宽） | 传输层替换 |

DSH 自己也是分开做的：`packages/crypto`（E2EE）与 `packages/webrtc`（P2P）是两个包。

### 8.2 DSH 的真实设计：relay 是硬保底，P2P 是可选增强

`packages/plugin/src/client-runtime.ts:230`：

```ts
preferredTransports: this.config.forceRelay ? ['relay'] : ['lan', 'p2p', 'turn', 'relay']
```

同文件 `:799-839`：当 `forceRelay` 为真**或 RTC factory 加载失败**时，attempts 直接退化为 relay。
`packages/plugin/src/werift-rtc.ts:5-8` 注释也写明两个 RTC 后端都是 **lazy load**，
「so DSH startup remains unaffected when WebRTC is unused or `forceRelay` is enabled」。

Node 侧 RTC 后端有两个（`packages/plugin/package.json`）：
- `@roamhq/wrtc@0.10.0` —— native libwebrtc binding，**放在 `optionalDependencies`**，优先使用
- `werift` —— 纯 TS 兜底，**通过 `await import('werift')` 动态加载**（`werift-rtc.ts:151`），
  **不在任何 package.json 里声明**

⇒ **P2P 是「有就用、没有就算了」的增强，不是链路成立的前提。** 这一点直接决定了成本判断。

### 8.3 成本对比

| 方案 | 增量改动 | VPS 能否读明文 | 新增依赖 | 复杂度 |
| --- | --- | --- | --- | --- |
| relay-only（§3） | ~220 行 | ❌ 能 | 无 | 低 |
| relay + E2EE | +~200 行 | ✅ 不能 | `@lukeburns/clatterjs` + `@noble/{ciphers,curves,hashes}` | 中 |
| + P2P | **+~1500–2000 行** | ✅ 不能 | 再加 `@roamhq/wrtc`（native）或 `werift` | 高 |

P2P 的增量主要在：
- 信令通道（VPS 上多一个端点或复用现有 WS）
- ICE / STUN（+ TURN 兜底，TURN 本身又是服务器带宽）
- **Node 侧 RTC 适配**：DSH 为这件事写了
  `packages/plugin/src/werift-rtc.ts`（617 行）+ `native-rtc-helper.ts`（620 行）
  = **1237 行只是后端适配**；其上还有 `packages/webrtc`（3367 行）的协商/分块/背压状态机
- 协商与降级状态机（LAN → P2P → TURN → relay）

### 8.4 ZCodium 场景下 P2P 的收益偏低

- ZCodium 的通道是 **RPC + 文本流 + 终端输出**，带宽小、延迟不敏感。P2P 省的带宽基本可忽略。
- `@roamhq/wrtc` 是 **native addon**：在 Electron 里需要 `electron-rebuild` 并匹配 ABI，
  对打包分发是实打实的负担（DSH 自己都把它设为 optional）。
- 反向收益（更低延迟、更少 VPS 流量）在「控制类通道」上很难感知。

**反例**：如果将来要做**大文件传输 / 媒体流 / 屏幕共享**，P2P 的收益会立刻显现——
那时再引入才划算。DSH 做 P2P 正是因为它的客户端含文件传输与 `xterm` 终端
（`apps/android` 带 `react-native-webrtc`）。

### 8.5 若确实要做，可复用的具体资产（MIT）

| 资产 | 规模 | 可复用度 |
| --- | --- | --- |
| `packages/crypto/src/noise.ts` | 159 行 | **高** —— `Noise_IK_25519_ChaChaPoly_SHA256`，依赖仅 `@lukeburns/clatterjs` + `@noble/*`；建议无论做不做 P2P 都先搬这个 |
| `packages/webrtc/src/rtc-adapter.ts` | ~11 KB | **高** —— 环境无关的窄接口（`RtcPeerConnection` 等），让浏览器原生与 Node 后端都能接 |
| `packages/webrtc/src/adaptive-transport.ts` | ~20 KB | 中 —— 协商状态机，作为设计参考 |
| `packages/webrtc/src/rtc-data-channel.ts` | ~34 KB | 中 —— 分块 + 背压，参考 |
| `packages/plugin/src/werift-rtc.ts` | 617 行 | 中 —— Node 侧适配，需按 ZCodium 的 `ISocket` 语义改写 |

**注意**：DSH 的 `RemoteTransport` 接口（`send(Uint8Array)` / `onMessage(cb)` / `getStats()`）
与 ZCodium 的 `ISocket`（`onData` / `write` / `drain`）语义接近但不同，
搬运时需要一层适配，不是直接 drop-in。

### 8.6 建议的推进顺序

1. **relay-only 先跑通**（§3，~220 行）——先证明链路成立。
2. **紧接着加 E2EE**（搬 `noise.ts` + 握手编排）——这是性价比最高的一步，
   解决「VPS 是信任点」这个真实问题。
3. **P2P 推迟到出现明确的延迟/带宽痛点时**，且**必须保留 relay 兜底**
   （照 DSH 的 `forceRelay` 设计：RTC 加载失败或协商失败都要能自动回落）。

## 9. 用 Cloudflare Workers 替代 VPS（用户提出的方向，推荐）

用户提出「用 Cloudflare Workers，就不用 VPS 了」。**这个方向成立，而且优于 §3 的 VPS 方案。**
关键洞察：**一个 Durable Object 可以完整替代 §4.1 的 `relay.mjs`** —— 因为那个 relay 的职责
就是「配对两条 WebSocket 然后互相转发帧」，而这正是 DO 的本职。

### 9.1 结论：Workers 做 relay 就够了，P2P 是多余的一层

- Workers **不能**做 TURN（运行时无 UDP），所以 P2P 打不通时**没有兜底**。
- Workers **能**做 WebSocket relay（TCP/443，任何网络环境都通）。
- ⇒ 既然兜底注定是 WS relay，而 WS relay 本身就能跑通全链路，
  那 P2P 的收益只剩「省 Worker 调用次数」。**先做 Workers relay，P2P 留作后续优化。**

### 9.2 桌面侧代码完全不变

无论对端是 VPS、Workers 还是 P2P 直连，**桌面都必须主动拨出**（NAT 后的机器无法被直接连）。
§4.2 的 `relayClient`（~120 行）**一字不改**，只把 `opts.url` 从 VPS 换成
`wss://<worker>.<account>.workers.dev/host`。

### 9.3 官方限额（已查证，2026-09-30）

来源：`developers.cloudflare.com/durable-objects/platform/limits/`（更新于 2026-06-01）与
`developers.cloudflare.com/workers/platform/limits/`。

| 项 | 值 | 对本方案的影响 |
| --- | --- | --- |
| DO WebSocket 消息大小 | **32 MiB**（接收侧） | ✅ ZCodium 帧远小于此（continuous 档 `streamOutputCapBytes = 262144`，即 256 KiB） |
| DO 是否免费计划可用 | **可用**（**仅 SQLite 后端**） | ✅ 纯转发不用存储，无影响 |
| DO wall time | **无硬上限**（WS / 请求在飞就保持活跃） | ✅ 长连接无问题 |
| DO CPU / 调用 | 默认 30s，可配到 5 min | ✅ 转发是纯 I/O，几乎不耗 CPU |
| DO 单对象吞吐 | 软上限 1000 req/s | ✅ 单会话绰绰有余 |
| Workers 免费 CPU | **10 ms / 调用** | ✅ 够用 |
| **Workers 免费请求** | **100,000 / 天**（UTC 午夜重置，超出返回 Error 1027） | ⚠ **真正的风险，见 §9.4** |
| 同时出站连接 / 请求 | 6 | ✅ 够用 |

### 9.4 ⚠ 唯一的真实风险：免费额度可能不够

- 手机走 `replayable` 档，`flushWindowMs = 150`（`packages/shared/src/zcode-protocol-v4/core.ts:51`）
  ⇒ 流式输出时约 **6.7 帧/秒**。
- 一小时连续输出 ≈ 24k 帧。**若每个 WS 消息都计入 request，则 100k/天 只能撑约 4 小时活跃流式。**
- **但**：DO 的 WebSocket **计费口径**（消息是否计入 request、是否单独计 duration）
  在官方 limits 页**未说明**（该页只讲限制不讲计费）。
  **⇒ 这一点必须实测确认，不应凭猜测定方案。**

**缓解手段**（不改协议，只调参数）：
- 把 replayable 档的 `flushWindowMs` 从 150 调到 500–1000 ms —— 人眼几乎无感，能降 3–6 倍调用量；
- 或对 relay 做「合并转发」：在 Worker 侧把短时间窗口内的多个小帧合并成一个大帧再转发
  （需要协议层支持帧合并，成本高于改 `flushWindowMs`，不优先）。

### 9.5 Workers 相对 VPS 的额外优势

- 免费、自带 TLS 与全球边缘，**不用管证书和反代**；
- 配对码可以直接放在 **DO 存储或 Workers KV**，比自建更省事；
- 无需维护一台机器、无按流量计费的带宽成本。

### 9.6 更新后的落地顺序

1. **Workers DO 做 relay**（替代 VPS）：Worker 侧 ~80 行 + 桌面侧 ~120 行（不变）
2. **加 E2EE**（搬 `noise.ts` + 握手，~200 行）—— **这次比 §8.6 更必要**，
   因为 Cloudflare 同样是第三方，TLS 在 CF 边缘终结
3. 若免费额度确实不够，再考虑 P2P 省调用次数

## 10. 「直接用 P2P 有什么不好」——逐条回答

用户直接问「直接用 p2p 有什么不好的么」。下面区分**真问题**与**被误解的点**。

### 10.1 最根本的问题：P2P 会把「免 VPS」这个初衷打破

- **4G/5G 移动网络普遍采用对称型 NAT（Symmetric NAT）**，这是行业共识而非个例；
  对称 NAT 下打洞通常失败，**必须由 TURN 中继兜底**。
- **TURN 需要 UDP 中继服务器，而 Cloudflare Workers 运行时没有 UDP。**
  ⇒ 要么自建 `coturn`（**回到需要 VPS**），要么用 Cloudflare Calls/Realtime
  （另一套付费产品）。
- 若兜底改用 WS relay（TCP）——**那正是 §3/§9 推荐的方案本身**，
  P2P 就沦为「加在它上面的、可能失败的额外一层」。

**⇒ 这是反对 P2P 的决定性理由**：想用 Workers 省掉 VPS，但 P2P 失败时的兜底又把你推回
「需要一个 UDP 服务器」。两条路互相抵消。

### 10.2 桌面侧 Node WebRTC 是真实的工程与打包负担

- Electron 的 Main / Host 是 **Node**，没有原生 `RTCPeerConnection`。
- `@roamhq/wrtc` 是 **native addon** ⇒ 需要 `electron-rebuild` 匹配 ABI，
  三平台各一套预编译产物，**升级 Electron 就要重编**。
- `werift` 是纯 TS 免编译，但 ICE / DTLS / 候选对全部要自己接，且依赖树不小。
- 量级参照：DSH 为此写了 **1237 行**（`werift-rtc.ts` 617 + `native-rtc-helper.ts` 620），
  其上还有 `packages/webrtc` **3367 行**。

### 10.3 建立更慢

| | 建立耗时 |
| --- | --- |
| P2P | ICE 候选收集 + 交换 + 连通性检测 + DTLS 握手 → 通常 **1–3 秒** |
| WS relay | 一次 TCP/TLS 握手 → **< 500 ms** |

对「打开就发指令」的交互，P2P 反而更慢。

### 10.4 移动端更易断，且重连成本高

- 手机切 WiFi↔4G、锁屏、信号抖动 → **ICE 连接失效，需要完整重新协商**（又是 1–3 秒）。
- WS 断线只需重连一条 TCP。
- ZCodium 的 `replayable` 档本就是为「断线 + 快照恢复」设计的，**配 WS 天然契合**。

### 10.5 其他

- **更耗电**：WebRTC 在手机上需保持 ICE/DTLS 活性，比空闲 WS 明显耗电。
- **更难调试**：P2P 的典型故障是「时通时不通」「单向不通」，排查成本远高于 WS relay
  （WS 的每一帧都在自己的服务器上，抓包/日志一目了然）。

### 10.6 被误解的点（这些不是 P2P 的问题）

- ❌ **「P2P 就不用服务器了」**：**信令仍然需要服务器**。P2P 只把数据面变直连，控制面还在。
  用 Workers DO 做信令可行且免费，所以这条不算坏——但要清楚**不是「零服务器」**。
- ❌ **「P2P 更安全」**：安全靠 **E2EE**，不靠 P2P。而且信令仍经 CF，
  所以「TLS 在 CF 边缘终结」这个问题 **P2P 解决不了**；只有 E2EE 能解决。
- ⚠ **「局域网内 P2P 快」**：是真的，但**本来就不需要 P2P** ——
  同局域网直接 `zcode --web --host 0.0.0.0` + 手机连局域网 IP，**零代码**。

### 10.7 P2P 真正的好处，以及为什么这里不成立

| 好处 | 在本场景成立吗 |
| --- | --- |
| 延迟更低（少一跳） | ❌ 通道是 RPC + 文本流，不敏感；且建立更慢（§10.3） |
| 不经第三方读流量 | ⚠ 真好处，但 **E2EE 就能拿到，成本低约 10 倍** |
| 省服务器带宽 | ❌ Workers 免费额度下差异只在 request 计数（§9.4） |
| 局域网直连质量好 | ❌ 局域网场景有更简单的解法（§10.6） |

### 10.8 结论与「什么情况下应改口推荐 P2P」

- P2P 的「不好」**不是性能**，而是：**① 移动网络下大概率退化成 TURN，而 TURN 恰是
  Workers 做不了的 ⇒ 免 VPS 的初衷落空；② 桌面侧 Node WebRTC 的工程与打包负担是 10 倍量级；
  ③ 建立慢、移动端易断、耗电、难调试。**
- 它唯一不可替代的好处（不经第三方读流量）**用 E2EE 就能拿到**。
- **改口条件**：若明确需要传**大文件 / 媒体流 / 屏幕共享**，TURN 的成本才值得付。
  这也正是 DSH 做 P2P 的原因（它的客户端含文件传输与 `xterm`）。

## 11. 参照 RustDesk 的实现方式

用户问「rustdesk 怎么个实现方式」。它的架构与本 spec 的推荐方向**同构**，值得作为设计参照，
但**不能搬代码**。

### 11.1 架构（已核实，来源：rustdesk.com/docs/en/self-host/）

两个独立可执行文件：

| 组件 | 职责 | 端口 |
| --- | --- | --- |
| **`hbbs`** | ID（rendezvous / 信令）服务器 | TCP `21115`、`21116`、`21118`（WebSocket）；UDP `21116` |
| **`hbbr`** | 中继（relay）服务器 | TCP `21117`、`21119`（WebSocket） |

连接流程（官方原文）：

1. 客户端只要在跑，就**持续 ping `hbbs`**，让 ID 服务器知道它当前的 IP:port；
2. A 连 B 时，A 向 `hbbs` 请求与 B 通信；
3. `hbbs` 用 **hole punching** 尝试让 A、B 直连；
4. **打洞失败才走 `hbbr` 中继**。官方原话：「In the majority of cases, hole punching is
   successful, and the relay server is never used.」
5. `21118` / `21119` 是**专供 Web 客户端**的 WebSocket 端口，官方建议**用反向代理套 HTTPS**。

### 11.2 与 ZCodium 方案的对照 —— 印证了 §9 的结论

| RustDesk | 本 spec | 说明 |
| --- | --- | --- |
| `hbbs` 信令 + 心跳 | relay 的 `/host` 配对 + relayClient 重连 | 同构 |
| `hbbr` 中继 | relay 的 `/ws` ↔ `/host` 转发 | 同构 |
| 打洞失败才用中继 | §8.6 的「P2P 留作后续优化，**relay 必须常备**」 | **RustDesk 也是 relay 常备** |
| `21118/21119` WS + 反代 HTTPS | relay 的 `/ws` + TLS 反代 | 同构 |

⇒ **RustDesk 的存在本身印证了 §9/§10 的判断**：连一个成熟的远控产品也是
「信令 + 中继常备 + P2P 只在能打通时用」。

### 11.3 能不能直接拿 RustDesk 当我们的中继？——不能

**① 协议不通用。** `hbbs`/`hbbr` 只懂 RustDesk 自己的协议，那是**为屏幕串流设计**的
（视频编码、输入注入、剪贴板、文件传输），不是通用字节隧道。要拿它承载 ZCodium 的
`SocketProtocol` 通道，得在**两端都实现 RustDesk 的客户端协议** —— 工作量大，且逆着它的设计。

**② 许可证是 AGPL-3.0（已核实）。** ZCodium 是 MIT。**不能把 RustDesk 的代码搬进本仓库** ——
AGPL 的 copyleft 传染，且它带**网络条款**（通过网络提供服务也要开源）。
把 `hbbs`/`hbbr` 当**独立进程**运行不构成链接，但你只能得到 RustDesk 协议，拿不到自己的通道。

⇒ **结论：RustDesk 是好的设计参照，不是可复用的组件。**

### 11.4 值得抄的四个设计点

1. **ID 由公钥派生**（据项目公开设计，未在官方文档逐字核实）：ID 即身份，服务端无法伪造。
   对应到 ZCodium：把「配对码」换成**桌面公钥的短哈希**，配对时校验，
   **天然防中间人**，也省掉「配对码被猜中」这类风险。
2. **客户端持续心跳上报当前 IP:port** —— 这正是 §4.2 `relayClient` 需要做的重连/心跳，
   别省。
3. **打洞失败才回落中继，且中继永远在** —— 印证 relay 不能做成"可选兜底"。
4. **专设 WebSocket 端口给 Web 客户端 + 反代 HTTPS** —— 与本 spec §4.1 完全同构。

### 11.5 对本 spec 的结论

**不改变 §3/§9 的方案**。若采纳 §11.4 第 1 点，则 §9.5 的「配对码放 DO/KV」
应改为「**桌面公钥派生 ID + 配对时校验**」，安全性更好。这一点建议在实现 `relayClient` 前定。

---

# 12. 落地实现方案（最终交付形态）

> §1–§11 是设计依据与选型论证；本节是可执行的落地计划。

## 12.1 整体实现思路

**在 VPS 上放一个「哑转发器」，让桌面主动拨出、把自己的窗口 Host 借给它；手机用现有的
Web bundle 连上转发器。全程不改协议、不改 Host、不改手机。**

三个「不改」是本方案的全部价值所在：

| 不改的东西 | 为什么能做到 |
| --- | --- |
| **协议** | `SocketProtocol` 原样使用。转发器与桌面之间是同一套帧格式 ⇒ 转发器**不需要理解协议**，逐字节转发即可 |
| **Host** | 复用既有 `AttachServicePort` + `scope: { kind: "local" }`。**已核实**：`windowHostAttachmentRegistry` 按 `attachmentId` 索引，**没有 per-scope 单例限制**，渲染器的 base attachment（`base-${randomUUID()}`）与 relay attachment **可并存** |
| **手机** | web bundle 由 VPS 静态托管；`resolveDefaultWsOrigin()`（`packages/web/src/main.tsx:271-280`）由 `window.location` 推导 wsUrl ⇒ 同源命中转发器的 `/ws`。配对直接复用既有 `?token=` → `zcode_lite_token` cookie 流程 |

## 12.2 核心模块与职责

| 模块 | 位置 | 职责 | 规模 |
| --- | --- | --- | --- |
| `relay.mjs` | `deploy/vps-relay/relay.mjs`（新增，VPS 侧） | 静态托管 + `/api/server-info` + `/ws`↔`/host` 配对与逐字节转发 | ~140 行 |
| 部署物 | `deploy/vps-relay/{Dockerfile,docker-compose.yml,Caddyfile,README.md}` | 一键部署 + 自动 TLS + 运维手册 | — |
| `remoteRelayClient` | `packages/desktop/src/main/remoteRelayClient.ts`（新增） | 出站连接、**帧格式转码桥**、attach、心跳与重连 | ~130 行 |
| 接线 | `packages/desktop/src/main/index.ts`（修改） | 读 env、注入依赖、启动 client | ~15 行 |
| 依赖暴露 | `packages/desktop/src/main/desktopRemoteSessions.ts`（修改） | 暴露闭包内私有的 `getWindowHost` | ~3 行 |

**不动**：`packages/web/**`、`packages/desktop/src/host/**`、`packages/shared`（协议）、
`packages/server/**`。

## 12.3 组件协作与事件顺序

### 启动期（桌面侧）

```text
桌面启动
 └─ 窗口 Host 进程 ready（databaseStartup.phase === "ready"）
     └─ Main 读 env；未配置 ZCODE_REMOTE_RELAY_URL → 什么都不做（默认关闭）
         └─ remoteRelayClient.connect()
             ├─ 1. 打开 wss://<vps>/host（Authorization: Bearer <HOST_SECRET>）
             ├─ 2. POST https://<vps>/api/host-report 上报工作区
             │      （独立 HTTP，不复用数据面 WS —— 否则会污染通道协议帧流）
             ├─ 3. new SocketProtocol(wrapWebSocket(ws))          ← WS 侧，负责 13B 帧头
             ├─ 4. createMessageChannel() → port1 / port2
             ├─ 5. 转码桥：
             │      wsProto.onMessage(buf => port1.postMessage(buf.buffer))
             │      port1.on("message", e => wsProto.send(VSBuffer.wrap(new Uint8Array(e.data))))
             └─ 6. getWindowHost(win).postMessage({
                      type: AttachServicePort, requestId, attachmentId,
                      clientMode: "web-remote-replayable",
                      scope: { kind: "local" },          // .strict()：只能有这一个字段
                    }, [port2])
                    └─ Host: windowHostAttachmentRegistry.attach(...)
                       未 ready 时进 pendingStartupAttachments 自动挂起（无需自行重试）
```

### 使用期（手机侧）

```text
手机打开 https://<vps>/?token=<RELAY_TOKEN>
 └─ relay 校验 token → Set-Cookie: zcode_lite_token=...（HttpOnly）
     └─ 加载 web bundle（VPS 静态托管）
         └─ resolveWebBootstrap() fetch /api/server-info
             └─ relay 返回缓存的工作区（来自桌面的 /api/host-report）
                 └─ 连 wss://<vps>/ws（带 cookie）
                     └─ relay 校验 cookie → 与已连接的 host 配对
                         └─ 此后 relay 逐字节双向转发
                             └─ 手机 UI 看到的是【桌面 Host 的服务面】：
                                任务列表、会话历史、终端、文件、Git
```

### 断开与恢复

| 事件 | 行为 |
| --- | --- |
| 桌面 WS 断开 | relay 以明确 close code 关闭手机侧 → 手机 UI 提示「桌面离线」，不静默卡死 |
| 桌面重连 | client 先 `DetachServicePort`（旧 attachmentId）释放旧 attachment → 重新 attach（**新 attachmentId**，避免撞上 §12.2 的 `previous` 处置逻辑） |
| 手机断网/锁屏 | 重连 `/ws` → 走 `replayable` 档的 snapshot + gap repair（协议已支持，无需新代码） |
| 心跳 | client 每 30s 发 WS ping；relay 60s 无活动则关闭该侧 |

## 12.4 关键接口契约

### relay 的端点

| 端点 | 方向 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET /` + 静态 | 手机 → relay | 无 | 托管 `packages/web/dist` |
| `GET /api/server-info` | 手机 → relay | 无 | 返回桌面通过 `/api/host-report` 上报的 `ServerRemoteInfo` 形状 |
| `POST /api/host-report` | 桌面 → relay | `HOST_SECRET` | 上报 `{ workspacePath, workspaceIdentity, hostLabel }` |
| `GET /ws`（upgrade） | 手机 → relay | `zcode_lite_token` cookie | 与当前 host 配对，**逐字节转发** |
| `GET /host`（upgrade） | 桌面 → relay | `HOST_SECRET` | 注册为**唯一** host（已有连接则拒绝或顶替，需定） |

### 环境变量

**relay（VPS）**：`PORT`、`RELAY_TOKEN`（手机配对码）、`HOST_SECRET`（桌面密钥）、`WEB_ROOT`
**桌面**：`ZCODE_REMOTE_RELAY_URL`（如 `wss://vps.example`）、
`ZCODE_REMOTE_RELAY_HOST_SECRET`、`ZCODE_REMOTE_RELAY_WINDOW`（可选，缺省跟随 focused window）

## 12.5 分阶段实施与验证

### 阶段 0：本机打通（不碰 VPS，能验证全部代码路径）

1. 本机跑 relay：`node relay.mjs`（监听 `127.0.0.1:3180`，`WEB_ROOT=packages/web/dist`）
2. 桌面 env 指向 `ws://127.0.0.1:3180`
3. 浏览器打开 `http://127.0.0.1:3180/?token=…`
4. **验证**：看到**桌面当前工作区**的任务列表与会话历史（而非 relay 自己起的任何东西）；
   发一条提示词 → 桌面 App 里同一会话被推进；`ps` 确认**桌面侧没有新增 Agent 进程**

> 这一步**零外部依赖**，是主要工作量所在。阶段 0 通过即说明设计成立。

### 阶段 1：上 VPS

1. 把 `deploy/vps-relay/` 与 `packages/web/dist` 传到 VPS
2. `docker compose up -d`（或 systemd），Caddy 自动签发 TLS
3. 桌面 env 换成 `wss://<vps>`
4. **验证**：外网手机可用；隧道/域名变更不触发任何 Origin 校验
   （已核实 `packages/server/src/http.ts` 无 Origin/Host 白名单）

### 阶段 2：加固

- **E2EE**（搬 `packages/crypto/src/noise.ts` + 握手编排）——CF/VPS 都属第三方，TLS 在服务端终结
- 「仅允许一个 host」、配对码轮换与限速、失败告警
- 把 `replayable` 档 `flushWindowMs` 按实测带宽调优（当前 150ms）

## 12.6 最终交付成果形式

| 交付物 | 形态 | 使用方式 |
| --- | --- | --- |
| **VPS 侧** | `deploy/vps-relay/` 一个目录 | `docker compose up -d` 或 `systemctl start zcode-relay`；`Caddyfile` 自动 TLS |
| ↳ `relay.mjs` | 单文件 Node 脚本，无构建步骤 | `node relay.mjs` |
| ↳ `README.md` | 运维手册 | 端口、环境变量、配对码生成、排障 |
| **桌面侧** | 仓库内 3 处改动（1 新增 + 2 小改） | 配 env 即启用；**不配 env 等于不存在** |
| **手机侧** | **无交付物** | 直接用浏览器打开 `https://<vps>/?token=…` |
| **文档** | 本文件（§1–§12） | 设计与落地依据 |

## 12.7 需先定的三个决策

1. **relay 落点**：建议新建 `deploy/vps-relay/`（`harness/` 语义是测试基建，不合适）。
2. **配对机制**：第一版用 **token/cookie**（复用既有流程，手机零改动）。
   公钥派生 ID（§11.4）更安全，但**要在手机侧校验就不再是零改动** ⇒ 留到阶段 2。
3. **多窗口**：缺省跟随 focused window；`ZCODE_REMOTE_RELAY_WINDOW` 可显式指定。

## 12.8 风险与回滚

| 风险 | 缓解 | 回滚 |
| --- | --- | --- |
| 桌面侧改动引入回归 | 全部逻辑在 env 开关后 | **不设 env 即等于不存在**，无需回滚代码 |
| relay 被未授权访问 | `/host` 用强 `HOST_SECRET` + TLS；`/ws` 用一次性/短时效 `RELAY_TOKEN` | 停掉 relay 进程 |
| `@zcode/rpc` 的 `SocketProtocol` 语义理解偏差 | 阶段 0 先在本机验证（§12.5） | — |
| `connection-flow-v1` 控制帧是否必需 | 阶段 0 实测；必要时改用 `MessagePortProtocol` 包装 port1（差异约 3 行） | — |
| 多 attachment 影响渲染器 | 已核实 registry 无单例限制；用独立 `attachmentId` | 断开 WS 即自动 `dispose` |

## 12.9 验收清单

沿用 §6 的 7 条，并补充：

8. **默认关闭**：不设 `ZCODE_REMOTE_RELAY_URL` 时，桌面**不建立任何连接**，行为与改动前完全一致。
9. **复用而非新起**：手机侧发指令后，桌面侧**不出现新的 Agent 进程**。
10. **并存不互斥**：relay attachment 与渲染器 base attachment 同时存在，
    桌面本地 UI 功能不受影响（`windowHostAttachmentRegistry.size()` ≥ 2）。
11. **桌面离线有明确提示**：关闭桌面 App → 手机侧提示「桌面离线」，不静默卡死。
12. **回归**：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` 全绿。
