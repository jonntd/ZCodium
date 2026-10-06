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
6. **`connectViaWebSocket` 的 resolve 语义**（2026-09-30 提出，**已解决**）：
   原先 WS `open` 即 resolve，close-before-ready 之后的 4002 会被静默吞掉（§12.3.1 刷新白屏）。
   现已改为**等 ChannelClient 收到 `Initialize` 才算交付**，close/超时一律 reject，由
   `bootstrapWebApp` 渲染「Web 启动失败 + Retry」错误页。契约、前置不变式与验收见
   `docs/spec/web-bootstrap-delivery-point.md`；改动后必须重建 web dist。

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

## 12.10 阶段 0 的验证状态（含一条环境限制）

### 已完成的验证

| 层次 | 手段 | 结果 |
| --- | --- | --- |
| relay HTTP 面 | 9 项 curl | ✅ 全通过（静态/SPA fallback/配对 302+cookie/两处 401/host-report 更新 server-info） |
| relay WS 转发 | 两个模拟端 | ✅ 5/5（含 512 KiB 大帧逐字节一致、`host` 断开 → `code 4002`） |
| **Main ↔ Host 接缝** | `packages/desktop/tests/remote-relay-client.test.mjs` | ✅ **3/3** |
| **relay 集成（真实进程）** | `packages/desktop/tests/vps-relay-forward.test.mjs` | ✅ **2/2** |
| 类型 / lint / 架构 | `tsc -b`（main+host）/ `oxlint` / `architecture:check --changed` | ✅ 零新增错误、0 warning、0 违规 |
| desktop 全量回归 | `pnpm --filter @zcode/desktop test` | ✅ **73/73** |

**接缝测试覆盖的内容**（这是原先唯一未验证的一环）：

1. 桌面拨出并连上 relay 的 `/host`
2. 经**独立 HTTP** 上报工作区（不污染数据面帧流）
3. `AttachServicePort` 的 `clientMode` 与 `scope` **精确匹配**，且 `port2` 被转移给 Host
4. ★ **WS → Host 转码**：relay 发一个 `SocketProtocol` 帧，Host 侧收到的是**裸 `Uint8Array`**，
   且**逐字节一致**（13 字节帧头已剥掉）
5. ★ **Host → WS 转码**：Host 侧发裸 payload，relay 侧收到的是**合法的 `SocketProtocol` 帧**，
   逐字节一致（帧头已加上）
6. 重连**复用同一 `attachmentId`**（Host registry 靠它做原子替换）
7. 无可用窗口时进入退避重试，且**日志带原因**
8. 工作区晚于 WS 连接就绪时会**补报**（心跳兜底，不算失败）

**relay 集成测试覆盖的内容**（真实拉起 `deploy/vps-relay/relay.mjs` 子进程）：

1. host 先连、手机后开：配对前 host 帧被**回放**（`Initialize` 缓冲，spec §12.3.1）
2. host 不在线时手机侧收到明确 `close code 4002`，不静默卡死

> 第 4/5 条正是 §12.1 强调的「两侧帧格式不同、必须由两个协议实例各自成帧」。
> 测试用**真实的** `remoteRelayClient`（不是复刻逻辑），因此它证明的是产品代码本身。

### ⚠ 环境限制：Electron 无法在本沙箱内启动

尝试用 `pnpm dev:desktop` 做真端到端时失败，原因**不在代码**：

```text
sandbox initialization failed: Operation not permitted
GPU process exited unexpectedly: exit_code=6
FATAL:content/browser/gpu/gpu_data_manager_impl_private.cc:417] GPU process isn't usable. Goodbye.
```

Chromium 的沙箱在 WorkBuddy 沙箱内无法初始化。**但日志证明桌面侧代码已正确执行**：

```text
[main] [remote-relay] 已启用，目标 ws://127.0.0.1:3180
[main] 中继将在 1000ms 后重连（尚无可用窗口）
```

（第二条是首次 `connect()` 时窗口尚未创建 —— 因为 GPU 崩了窗口没建出来。
这两条日志也促使我把重连日志从「中继断开」改成带原因，否则会误导排查方向。）

**⇒ 真端到端必须在沙箱外运行**（用户自己在终端执行 §12.5 阶段 0 的三步）。

### 两个顺带修掉的问题

1. **重连日志缺原因**：原先一律打「中继断开」，而启动早期窗口未就绪也会走到该分支。
   已改为 `中继将在 <delay>ms 后重连（<原因>）`。
2. **模块依赖 electron 导致无法单测**：`MessageChannelMain` 是值导入，纯 Node 里导入本模块会失败。
   已改为**注入** `createChannel`（与 `desktopRemoteSessions.ts` 的
   `options.createMessageChannel` 同一惯例），模块现在完全不依赖 electron，
   由 `main/index.ts` 传入 `() => new MessageChannelMain()`。

### 运行接缝测试

```bash
cd packages/desktop
node --import tsx --test tests/remote-relay-client.test.mjs
```

（该文件已被 `pnpm --filter @zcode/desktop test` 的 `tests/*.test.mjs` glob 覆盖。）

---

## 13. 官方 `/remote/v4` 云 relay 的真实实现（逆向官方 asar 得到）

用户指出了官方实现的关键性质（**全出站 + 云转发，桌面不起任何服务**），
并在官方 asar（`/Applications/ZCode.app/Contents/Resources/app.asar`，3.14.4）里逐条得到验证。
本节记录**已核实的实现细节**，用于与 §3/§9 的自建方案对照。

### 13.1 实现本体

模块日志前缀 `[web-remote-control]`，含 `external relay device connecting` 等日志。

```js
// 连接：relay URL 上带 mid 查询参数 + X-Device-ID 头
let t = new URL(this.options.relayWsUrl);
t.searchParams.set("mid", this.options.deviceMid);
let r = new ll(t.toString(), {
  perMessageDeflate: true,
  headers: { "X-Device-ID": this.options.deviceMid },
});
r.on("open", () => {
  if (this.activeAuth.mode === "register") {
    this.setState("registering");
    this.send({ type: "device_register_init", ... });
  }
});
```

### 13.2 relay 地址怎么来 —— **和 API 同源**

```js
a = new URL(endpointOrigin);
i = `${a.protocol === "https:" ? "wss:" : "ws:"}//${a.host}`;
c = MA(appVersion) ? "v4" : "v3";
return {
  origin: endpointOrigin,
  apiBaseUrl: `${origin}/api/v1`,
  remoteUrl: `${origin}/remote/${c}`,   // ← 链接里的 /remote/v4
  relayWsUrl: `${i}/ws`,                // ← relay 就在 <origin>/ws
  ...
};
```

⇒ **官方 relay 就是 `wss://<endpointOrigin>/ws`**，与 API 同域同端口、不同路径。
这也解释了我早前「`/remote/v4` 路由不在源码」的观察：它由 endpointOrigin + 版本号**推导**，
不是硬编码路由。

### 13.3 relay 应用层协议（5 种消息）

从 asar 提取到的 `type` 字面量：

| 消息 | 作用 |
| --- | --- |
| `auth_init` | 设备与云端开始互相认证 |
| `auth_response` | 认证响应（配合持久化的 `deviceSid` + `passHash`） |
| `device_register_init` | 把设备注册成一个待配对房间 |
| `pair_status_query` | 查询配对状态（对应 `lastPairStatusAckAt`） |
| `warning` | 服务端下行告警 |

⇒ **官方 relay 不是哑管道**：配对、鉴权、房间路由都在 relay 侧完成。

### 13.4 认证与配对模型

- 持久化凭据：`authStorageProvider.load()` → `{ deviceSid, passHash }`
- 注册后进入 **"QR-ready"** 状态；超时文案：
  `"External relay device did not reach QR-ready state before timeout."`
- 上报设备元信息 `meta: { platform, version, name }`，`name` = hostname
  ⇒ 对应链接里的 `name=macmini.local`
- 存在 `createQrUrl` —— 二维码/链接生成
- 连接状态机 `connecting` → `registering` →（QR-ready），含
  `connectAttempt` / `socketGeneration` / `connectStartedAt` 与重连定时器

### 13.5 链接参数与实现的对应（交叉验证）

| 参数 | 官方实现中的来源 | 此前的独立验证 |
| --- | --- | --- |
| `mid` | `options.deviceMid`（同时进查询参数与 `X-Device-ID`） | 与 `~/.zcode/v2/telemetry-state.json` 的 `deviceMid` **逐位一致** ✅ |
| `name` | `meta.name` = hostname | 与本机 `hostname` 一致 ✅ |
| `t` | 签发时间戳 | 解码为 2026-09-30 12:55:15 ✅ |
| `hash` | 服务端签名（防伪造） | 实测 **32 字节 base64** —— 与 HMAC-SHA256 长度吻合，**支持「签名」读法** ✅ |
| `sid` | 云端签发的配对房间号 | `d_` 前缀 + 16 字节 ✅ |
| `app_version` | `meta.version` | 与 ZCode.app 版本一致 ✅ |

### 13.6 ⭐ 官方 App 支持指向自建 relay（对项目有直接价值）

```js
IP = process.env.ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL?.trim(),
EP = process.env.ZCODE_WEB_REMOTE_CONTROL_URL?.trim();
relayWsUrl: ic({ endpointOrigin, overrideUrl: IP }),
remoteUrl:  EP || mV.remoteUrl,
```

| 环境变量 | 作用 |
| --- | --- |
| `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` | **覆盖 relay 地址** |
| `ZCODE_WEB_REMOTE_CONTROL_URL` | 覆盖 `/remote/v4` 页面地址 |

ZCodium 是同一代码库的 fork：**`packages/web/src/env.d.ts:17` 已声明
`VITE_ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 但源码零引用**（上游残留）；
`packages/shared/src/officialPlatformPolicy.ts:190` 也已把 `/api/v1/remote-control` 登记进白名单。

⇒ **存在两条自建路线**：

| | 路线 A（本 spec 已实现） | 路线 B（贴官方） |
| --- | --- | --- |
| relay | 自建，**纯字节转发** | 自建，**实现官方 5 种消息的协议** |
| 桌面侧 | 新增出站桥（复用 `AttachServicePort`） | 复用官方 Main 的出站桥 |
| 手机侧 | 现有 web bundle（VPS 托管） | **官方 SPA** 或 ZCodium web bundle |
| 配对 | `RELAY_TOKEN` cookie | `sid` 房间 + `hash` 签名 + `t` 时效 |
| 多房间 / 多设备 | ❌ 单 host 单 client | ✅ |
| 能否复用官方 App | ❌ | ✅（`ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`） |
| 工作量 | ~290 行（**已完成**） | 需复刻 4 种消息的完整语义，量级大得多 |

**结论**：若目标只是自己用，路线 A 已足够（且已独立验证）。
若希望复用官方 App 的远控 UI、或支持多设备/多链接共存，路线 B 价值更高——
协议消息名与 env 覆盖点都已明确，可行性可进一步挖。

---

## 14. 路线 B 的完整协议（已还原）与成本重估

> 来源：桌面侧从官方 asar 逆向（`[web-remote-control]` 模块 + `createNodeWebRemoteControlRelayAuthProvider`），
> 手机侧从社区 fork `jchanghong023/zcode-mobile` 的 `packages/web/src/remote-v4/`（1315 行）。
> **本节不记录任何凭据值。**

### 14.1 控制面：8 种消息（已全部确认）

```text
桌面 → relay   {type:"device_register_init", device_mid, pass_hash, meta, client_ts}
relay → 桌面   {type:"device_register_ack", device_sid}
双方 → relay   {type:"auth_init", role:"device"|"terminal", device_sid, meta, client_ts}
relay → 对端   {type:"auth_challenge", nonce}
双方 → relay   {type:"auth_response", device_sid, proof, client_ts}
relay → 对端   {type:"auth_ack", pair_status}
桌面 → relay   {type:"pair_status_query", device_sid, client_ts}   // 心跳
relay → 对端   {type:"pair_status_ack", pair_status}
relay → 对端   {type:"error", code, message}
```

- **`pair_status` 取值**：至少 `"waiting"` 与 `"matched"`（`matched` = 配对成功）
- **心跳**：`pair_status_query` 每 `heartbeatIntervalMs ?? 10_000` 带 jitter 发送，
  并有 `armHeartbeatAckWatchdog()` 期待 ack；连续 stale 会触发恢复
- **状态机**：`idle → connecting → authenticating → registering → paired → waiting_terminal → error`
- 角色区分：桌面 `role:"device"`，手机 `role:"terminal"`

### 14.2 鉴权算法（完全可复现，仅 3 行）

```js
createPassword: () => randomBytes(24).toString("base64url")          // 设备口令
createPassHash: (pw) => sha256(pw).digest("base64")                   // 注册时上传
calculateProof: (key, nonce, role, sid) =>
  HMAC_SHA256(key, `${nonce}|${role}|${sid}`).digest("base64url")     // challenge-response
```

| 端 | HMAC key | role | sid |
| --- | --- | --- | --- |
| 桌面（device） | 持久化的 `passHash` | `"device"` | `deviceSid` |
| 手机（terminal） | **链接里的 `hash` 参数** | `"terminal"` | 链接里的 `sid` |

⇒ **`hash` 的双重身份**：它既是链接的防伪造签名（§13.5），
**同时也是手机端做 challenge-response 的 HMAC 密钥**。这解释了为什么它是 32 字节。

- 凭据落盘：`deviceSid` 存在设置的 `webRemoteControlExternalRelayDevice`；
  `passHash` 存在 credentialService 的 key `web-remote-control:external-relay:pass_hash`
- 官方**刻意不打印完整凭据**：`safeAuthLogFields()` 只输出 `hasDeviceSid` 与
  `deviceSidSuffix`（后 6 位）。**自建实现必须照做。**

### 14.3 ⚠ 数据面是**独立的 JSON 信封协议**，不是裸 `SocketProtocol`

这是路线 B 成本的关键。官方远控的数据面：

```js
{type:"data", payload:{ zcode_type:"bootstrap-request",  requestId }}
{type:"data", payload:{ zcode_type:"bootstrap-response", requestId, ... }}
{type:"data", payload:{ zcode_type:"workspace-bridge-open", ... }}
{type:"data", payload:{ zcode_type:"workspace-bridge-ready", bridge }}
{type:"data", payload:{ zcode_type:"rpc-frame", ... }}
{type:"data", payload:{ zcode_type:"rpc-frame-ack", ... }}
```

- 有 `bootstrap-request` → `bootstrap-response` 的**首轮握手**
- 有 `workspace-bridge-open` → `workspace-bridge-ready` 的**工作区桥建立**
- `rpc-frame` / `rpc-frame-ack` 自带 **ack 与 `replayUnacknowledged()` 重放**
- 桌面包里还有 `bridgeSessionId` / `bridgeGeneration` / `recoveryId` 的恢复语义
  （`createWebRemoteControlManager` 内）

⇒ **官方远控的传输层与桌面内部的 `SocketProtocol`（MessagePort / 13B 帧头）
完全是两套东西**，中间需要一层翻译。

### 14.4 成本重估（推翻 §13.6 的乐观估计）

| 部分 | 难度 | 说明 |
| --- | --- | --- |
| relay 控制面 | **中** | 8 种消息 + 房间路由；鉴权只有 3 行 crypto，不难 |
| relay 数据面 | **小** | `type:"data"` 的信封转发 + `seq` |
| **桌面侧数据面适配** | **大** | 要把 Host 的 `SocketProtocol`/MessagePort 世界翻译成 JSON 信封 + bootstrap + workspace-bridge + ack/replay + recoveryId |
| 手机侧 | **中** | 必须用**官方 SPA**；或移植 fork 的 `remote-v4/`（1315 行，含 `connection.ts` 356 / `frame.ts` 346 / `MobileRemoteApp.tsx` 413） |

**关键结论**：路线 B 的成本**不在 relay**（那部分不难），而在
**两端的数据面适配**——因为官方远控跑的是一套独立的 JSON 信封协议。

⇒ **反过来也解释了路线 A 为什么只要 ~290 行**：它**复用了同一套 `SocketProtocol`**，
把整个信封层绕过去了（中继只搬字节，Host 直接对端）。

### 14.5 A 与 B 不能混搭

| 组合 | 可行？ |
| --- | --- |
| A 的 relay（字节管道）+ ZCodium 现有 web bundle | ✅ **已实现并验证** |
| A 的 relay + 官方 SPA | ❌ 官方 SPA 说 JSON 信封，A 的管道只搬 `SocketProtocol` 帧 |
| B 的 relay + 官方 App / 官方 SPA | ✅（但需完整实现 §14.1–14.3） |
| B 的 relay + ZCodium 现有 web bundle | ❌ 同上，帧格式不同 |

⇒ **两条路线是两套独立技术栈，必须整体选一条。**

### 14.6 建议

| 你的目标 | 选 |
| --- | --- |
| 自己远程用，尽快可用 | **A**（已完成，只差端到端验证） |
| 想复用官方 App 当客户端 | **B**（`ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL` 已确认可用） |
| 要多设备 / 多链接 / 链接时效与撤销 | **B** |
| 要最小维护面 | **A**（290 行 vs 需复刻一整套信封协议） |

**如果选 B**，最省力的切入点是**先只做控制面**（§14.1 + §14.2），
用官方 App 验证到 `pair_status:"matched"`——这一步能证明 relay 侧协议正确，
且不涉及最贵的数据面适配。数据面（§14.3）留作第二阶段。

### 14.7 ✅ 控制面已实现并验证（13/13 通过）

实现：`deploy/vps-relay/relay-official.mjs`（仅控制面：注册 / 鉴权 / 配对 / 心跳 / `data` 信封转发）。

验证方式：写了一个**模拟客户端**（同时扮演官方 device 与 terminal），
用 §14.2 的算法自行计算 proof —— 若协议还原有误，鉴权必然失败。

| # | 用例 | 结果 |
| --- | --- | --- |
| 1 | `device_register_init` → `device_register_ack` 返回 `device_sid` | ✅ |
| 2 | `auth_init(device)` → `auth_challenge` 带 `nonce` | ✅ |
| 3 | device 用 `passHash` 算 proof → `auth_ack`（`waiting`） | ✅ |
| 4 | 链接含 `sid/hash/t/mid/name/app_version`，且 `sid === device_sid` | ✅ |
| 5 | terminal 用**链接里的 `hash`** 算 proof → `auth_ack` | ✅ |
| 6 | 配对成功 → device 收到 `pair_status:"matched"` | ✅ |
| 7 | `pair_status_query` → `pair_status_ack` | ✅ |
| 8 | `data` 信封 device → terminal 原样转发 | ✅ |
| 9 | `data` 信封 terminal → device 原样转发 | ✅ |
| 10 | 错误 proof → `error(auth_failed)` | ✅ |
| 11 | 同房间第二个 terminal（首个仍在线）→ `error(terminal_busy)` | ✅ |
| 12 | 未绑定房间就发 `data` → `error(sid_invalid)` | ✅ |
| 13 | 未知 `device_sid` → `error(sid_invalid)` | ✅ |

**⇒ §14.1 / §14.2 的协议还原被证实正确。** 剩下的只有 §14.3 的数据面适配。

#### 实现中发现的语义细节（测试时暴露出来的）

1. **单 terminal 是「同时在线」语义，不是「曾经连过」**：第一个 terminal 断开后，
   第二个可以正常接入。测试第一版误以为是一次性占用。
2. **`auth_ack` 与 `pair_status_ack` 会重复投递**：鉴权成功后服务端先回 `auth_ack`，
   再广播一次 `pair_status_ack`；两端状态相同时 `broadcastPairStatus` 仍会推一条。
   官方客户端把两者放在同一个 `case` 里处理（`case "auth_ack": case "pair_status_ack":`），
   所以这是**设计内**的冗余，不是 bug。但**客户端实现必须把队列里的旧 `pair_status` 排掉**，
   否则会读到过期的 `waiting`。
3. **自建时踩到并修掉的一个真 bug**：`socket.__room = room` 若写在准入检查**之前**，
   被 `terminal_busy` 拒绝的连接也会绑定房间；它断开时会在 close 里改动房间状态并
   **广播一条假的 `pair_status:"matched"`**。修法：绑定必须放在所有准入检查之后。
   （这是读日志发现的，不是靠类型检查。）

#### 仍未验证的部分

- **`auth_challenge` 的 `nonce` 长度/来源**：本实现用 32 字节随机，官方未从 asar 中确认具体长度。
  只要两端都按「原样回传 nonce 参与 HMAC」处理，长度不影响互通。
- **数据面**（`bootstrap-*` / `workspace-bridge-*` / `rpc-frame-ack`）：未实现、未验证。
- **与官方 App 的真实互通**：未做（需要重启用户的桌面 App 并设置
  `ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`）。这是把「协议正确」升级为「与官方互通」的最后一环。

### 14.8 桌面侧 device 控制面客户端（路线 B 第二阶段·第一步）

§14.7 用「双端模拟」证明了 relay 侧协议正确；本节把 **device 角色**落到 fork 桌面，
作为后续数据面适配（§14.3）与官方手机端互通的地基。**仍是独立技术栈（§14.5）**，
与路线 A 的 `remoteRelayClient` 不共享连接、配置与凭据。

#### 配置与凭据

- 配置文件 `~/.zcodium/v2/remote-official-relay.json`（env `ZCODE_OFFICIAL_RELAY_WS_URL` 优先）：

  ```json
  { "enabled": true, "url": "wss://relay.example.com", "deviceMid": "…", "devicePassword": "…" }
  ```

- `deviceMid`（16B base64url，WS 升级时以 `?mid=` 标识 device 角色）与
  `devicePassword`（24B base64url，官方 `createPassword` 语义）**首次自动生成并持久化**；
  `passHash = sha256(password).digest("base64")` 现算不落盘（可从 password 推导，少存一份）。
- 文件不存在 / `enabled` 非 true / 无 `url` ⇒ 模块完全不实例化（默认关闭，行为与改动前一致）。
- 官方把 `deviceSid` 持久化到设置、`passHash` 存 credentialService（§14.2）；
  本实现 room 为 relay 内存态，`device_register_init` 每次连接都会生成**新的 `device_sid`**，
  因此 `deviceSid` 只作展示/观测，**不得**作为跨重启的身份恢复依据。

#### 状态机与事件顺序（以 wire 顺序为准，relay 强制此序）

```text
idle → connecting → registering（device_register_init → ack 得 device_sid）
     → authenticating（auth_init → auth_challenge → auth_response(proof) → auth_ack）
     → paired（waiting_terminal：等 terminal 接入）→ matched
```

- 鉴权成功后 relay 会先回 `auth_ack` 再广播一条同状态的 `pair_status_ack`（§14.7 细节 2），
  客户端必须容忍重复投递并以**最新**一条 `pair_status` 为准。
- **心跳**：`pair_status_query` 每 10s ± jitter；期待 `pair_status_ack`，
  连续两个周期未收到 ⇒ 判定死链，主动断开走重连（不能用超时掩盖同步问题）。
- **重连**：断开/超时/`error(auth_failed)` ⇒ 指数退避重连；重连即重新注册
  （新 `device_sid`，旧房间由 relay 心跳 watchdog 回收）。window 未就绪不阻塞本模块
  ——控制面不依赖窗口，数据面才依赖（第二阶段再接 window Host）。
- **`data` 信封**：本阶段收到一律 debug 日志 + 丢弃（数据面未实现；
  静默吞掉会掩盖协议演进，必须留下痕迹）。

#### 链接获取（自建扩展：端点鉴权）

- 配对就绪后 device 经 **HTTP** `GET /api/remote-control/link?sid=<device_sid>` 取配对链接，
  头 `Authorization: Bearer <proof>`，`proof = calculateProof(passHash, "link", "device", sid)`
  （复用 §14.2 算法，nonce 固定为字面量 `"link"`）。**这是自建扩展**——§14.1 的 8 种
  消息是官方确认面，链接端点是 relay 自身的 HTTP 面；原实现无鉴权（§14.7 前 relay 代码
  注释已自我标注「生产必须加」），现升级为**强制**校验：缺头/错 proof ⇒ 401。
- 链接形状（relay 生成，§13.5/§14.1）：`?sid=&hash=&t=&mid=&name=&app_version=`，
  其中 `hash` 是 **terminal 的 HMAC key**（双重身份，§14.2）。relay 不打印 `hash` 全值。

#### 日志（对齐官方 safeAuthLogFields 语义）

只允许出现 `hasDeviceSid` / `deviceSidSuffix`（后 6 位）；
`passHash`、`proof`、完整 `device_sid`、链接 `hash` 一律不打。
沿用中文文案 + `logger` 注入（与路线 A 客户端一致）。

#### 验收

| # | 场景 | 期望 |
| --- | --- | --- |
| 1 | 真 relay-official + 真 device 客户端 + 模拟 terminal（链接 hash 算 proof） | 双端收到 `pair_status:"matched"` |
| 2 | 链接端点无 / 错 proof | 401，且不回任何链接内容 |
| 3 | 链接端点正确 proof | 200，link 含 `sid`/`hash` 且 `sid === device_sid` |
| 4 | `data` 信封双向 | relay 原样转发（回归 §14.7 #8/#9） |
| 5 | 错误 proof / 同房间第二 terminal / 未知 sid | `error(auth_failed)` / `terminal_busy` / `sid_invalid`（回归 #10–#13） |
| 6 | device 断线重连 | 新 `device_sid`，重新鉴权，terminal 重新接入后再次 matched |
| 7 | 配置文件缺失 | 模块不启动，无任何网络行为 |

套件入库 `deploy/vps-relay/relay-official.test.mjs`（`node --test`，spawn 真实 relay +
真实 device 客户端），取代 §14.7 的一次性双端模拟。

### 14.9 数据面信封契约（官方 asar 还原）与桌面适配器设计

> 来源：官方 app.asar 主进程 chunk 的只读逆向（`routePayload` / `createWorkspaceBridge` /
> `routeRpcTransportPayload` / frame codec 类，函数注册名一一对照）。本节不记录任何凭据值。

#### 信封分派表（device 收到 `type:"data"` 后按 `payload.zcode_type` 路由）

| `zcode_type`（phone→device） | 响应（device→phone） |
| --- | --- |
| `bootstrap-request {requestId}` | `bootstrap-response {requestId, success:true, result:{windowControlSessionId, desktopAppVersion, workspaces, tasks, initialViewState, mobileViewState}}` |
| `workspace-list-request {requestId}` | `workspace-list-response {requestId, success:true, result:{workspaces, tasks, activeWorkspaceKey, activeTaskId}}` |
| `platform-request {requestId, method, …}` | `platform-response {requestId, method, success:true, result}` 或 `{success:false, error}` |
| `mobile-view-state-update {viewState, deviceInfo}` | 无响应（device 记忆 viewState） |
| `workspace-bridge-open {requestId, bridgeSessionId, bridgeGeneration?, recoveryId?, workspaceKey, taskId?}` | `workspace-bridge-ready {requestId, bridgeSessionId, bridgeGeneration?, recoveryId?, bridge}` 或 `workspace-bridge-error {…, reason, error}` |
| `workspace-reconnect-request {requestId, workspaceKey}` | `workspace-reconnect-response {requestId, workspaceKey, success, error?}` |
| `rpc-frame` / `rpc-frame-ack` | **raw transport**（见下），不进 routePayload |
| `telemetry-report {event}` / `mobile-diagnostic` | 转发渲染层 / 仅日志 |

`workspaceKey` = 工作区身份 key（与 `workspaceIdentity?.trim() || workspacePath` 同语义）。
device 侧 bridge 对象：`{bridgeSessionId, bridgeGeneration, recoveryId, hostEntryId,
attachmentId, kind, workspaceKey, workspacePath, workspaceIdentity, remoteSessionId,
initialTaskId, readyAnnounced, degraded}`；open 处理 = `attachWorkspaceHost(windowId,
{workspacePath, workspaceIdentity, remoteSessionId, initialTaskId, kind}) → {entryId,
attachmentId, port}`——**与路线 A 共用同一 window Host attachment 机制**，port 桥
`MessagePortProtocol ↔ rpc-frame codec`，ready 回包后才 `readyAnnounced=true` 并
`flushPendingFrames()`。

#### rpc-frame 帧协议（zod strict schema，官方常量）

```text
rpc-frame      { zcode_type:"rpc-frame", bridgeSessionId, bridgeGeneration?, recoveryId?,
                 seq, messageSeq, fragmentIndex(0..63), fragmentCount(1..64),
                 messageBytes(≤16MiB, ≥fragmentCount),
                 checksum:{algorithm:"crc32", value:/^[0-9a-f]{8}$/}, data(canonical base64) }
rpc-frame-ack  { zcode_type:"rpc-frame-ack", bridgeSessionId, bridgeGeneration?, recoveryId?,
                 ackMessageSeq }
```

- 上限：`maxFrameBytes` 1MiB（单帧）、`maxMessageBytes` 16MiB（单逻辑消息）、
  `maxFragments` 64、物理信封 ≈ base64 膨胀（4×⌈n/3⌉）。
- **seq** = 物理帧序号（gap 检测 → `bridge-degraded`），**messageSeq** = 逻辑消息
  序号（ack 的对象）；`messageBytes` = 整条逻辑消息的长度；checksum 按 crc32
  （标准多项式，8 位小写 hex）对**分片解码后字节**计算。
- **ack 语义**：每条收到的 messageSeq 都要 ack（重复投递 → 重复 ack，幂等）；
  发送侧维护未 ack 队列，`replayUnacknowledged()` 在重连 send-ready 时重放。
- **流控**：codec 的 saturated/drained 事件转成 host 侧 `connection-flow-v1` 帧
  （`sendFlowState`）；degraded 后停止发送（`readyAnnounced && !degraded` 门控）。
- `bridge-degraded {bridgeSessionId, …, reason:"rpc-transport-fault"|"rpc-frame-gap"|
  "buffer-overflow"|"buffer-timeout", seq?, expectedSeq?, droppedCount?}`（device→phone）。

#### 桌面适配器（本仓库实现）

- `remoteOfficialDeviceClient` 扩展 `onData(payload)` 回调与 `sendData(payload)`：
  data 信封的**唯一入口/出口**，控制面状态机不感知数据面。
- `remoteOfficialDataPlane`：routePayload 分派 + frame codec + host attachment 桥。
  依赖注入 `resolveBridgeTarget`（复用路线 A 的窗口/Host 解析）与 `createChannel`
  （MessageChannelMain），attachmentId 形如 `official-bridge-<uuid>`（稳定 id =
  原子替换语义，与路线 A 一致）。
- bootstrap result 的 fork 语义：`workspaces` 取当前窗口工作区（identity key 用
  统一构造工具），`tasks` 返回空数组（fork 不做任务列表下发），`windowControlSessionId`
  = deviceSid。platform-request 未支持的方法回 `{success:false, error}`（不假装支持）。
- **验证边界**：本阶段用**同 codec 模拟 terminal** 验证自洽（bootstrap → bridge →
  rpc-frame 往返 + ack/replay）；与官方手机端的真互通需官方 SPA/真机，是下一步。

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
| `relay.mjs` | `deploy/vps-relay/relay.mjs`（新增，VPS 侧） | 静态托管 + `/api/server-info` + `/ws`↔`/host` 配对与逐字节转发 + 配对前 host 帧的有界缓冲回放（§12.3.1） | ~140 行 |
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
                         └─ relay 先回放配对前的 host 帧缓冲（见 §12.3.1）
                             └─ 此后 relay 逐字节双向转发
                                 └─ 手机 UI 看到的是【桌面 Host 的服务面】：
                                    任务列表、会话历史、终端、文件、Git
```

### 12.3.1 Initialize 握手帧与配对时序（必须缓冲，否则手机白屏）

RPC 层的启动顺序是**非对称的**：`ChannelServer`（Host 侧）构造时立即发出 `Initialize`
帧（`packages/rpc/src/channelServer.ts`，`deferInit=false`），而 `ChannelClient`
（手机侧）必须**先收到 `Initialize` 才会发出任何请求**（`whenInitialized()` 门控）。

relay attachment 走的是 `deferInit=false` 路径（Host 日志
`creating ChannelServer (deferInit=false)`），于是存在一个无法靠桌面侧消除的时序竞争：

```text
桌面连上 relay → attach → Host 构造 ChannelServer → 立即发 Initialize
                    ↓
        此刻手机多半还没打开页面 → relay 无可转发对象 → 帧被丢弃
                    ↓
手机稍后配对 → ChannelClient 停在 Uninitialized → 永远等 Initialize
        ⇒ 一个 RPC 都不发、无任何报错 ⇒ 渲染空 RootShell（白屏）
```

正常使用顺序恰恰就是「桌面先在线、手机后打开」，所以**必须在 relay 侧修复**：

| 规则 | 说明 |
| --- | --- |
| 缓冲 | host 在**无手机配对期间**发出的帧进入有界缓冲（32 帧 / 1 MiB，超限丢最旧） |
| 回放 | 手机配对成功时**先回放缓冲**，再挂活转发；Initialize 对新 ChannelClient 恰是所需语义 |
| 清空 | host 断开/被顶替时清空缓冲（旧连接的帧不再有意义，新 attach 会重发 Initialize） |
| 宽限等待 | 手机连上 `/ws` 时若 host 暂时缺位，**等待 `HOST_WAIT_GRACE_MS`（默认 5s，env 可调）**而不是立刻 4002；期间 host 回来即正常配对并回放 Initialize |
| 只配 OPEN 的 host | `tryPair()` 必须校验 `hostSocket.readyState === OPEN`。host 已发出 close、但 close 握手尚未走完（CLOSING）期间，手机连接要进入宽限等待，**不得**配给这个垂死连接（否则新页面会被连坐 4002 秒杀，见下节「残留竞态 3」） |
| 宽限到期重判 | 宽限定时器到期时**重新判断 host 是否已就绪**：就绪则补配对，确实仍无 host 才回 4002。否则「host 已回来但配对被跳过」会让客户端既不被服务也不被拒绝，形成新的静默白屏 |
| host 顶替摘监听 | 新 host 拨入时，先 `pipe().dispose()` **摘掉旧 pair 的全部监听**（不关任何 socket）再与新 host 配对：旧 host 稍后的 close 不得连坐关掉正被新 host 服务的手机端。注意与「手机端顶替」不对称——那条路径必须让 host 换代（连坐保持不变），新页面才有属于它的 Initialize |
| 快速补位 | 桌面收到 close **4003**（手机离线连坐，属预期事件）时以固定 100ms 立即重连，**不走指数退避**——退避留给真实故障（网络/密钥/服务不可用，4001/4002/1006 等） |
| 不改协议 | 仍然逐字节搬运，relay 不解析帧内容；未知 id 的旧广播帧被 ChannelClient 静默忽略（`handlers.get(id)?.()`），回放无害 |

### 刷新白屏（第二个时序竞争，与上表同源）

单配对 + 连坐设计意味着**每次手机刷新都会杀掉 host 连接**（旧 WS 断 → pipe shutdown →
host 关闭），桌面重连前存在空窗。修复前空窗 ≈ 1.1s（1s 退避 + 建连），新页面的 WS 撞进
空窗会被 relay 以 4002 秒踢；而当时的 `connectViaWebSocket`
（`packages/client/src/websocket.ts`）在 WS `open` 即 resolve（`settled = true`，之后到达的
4002 只走 no-op `onClose`），bootstrap 误判成功 → 渲染空 RootShell 白屏、无任何报错。

修复 = 上表两条：**快速补位**把空窗压到 ~0.1s，刷新撞窗概率趋近于零；**宽限等待**兜住
仍撞窗的连接——host 回来后照样收到回放的 Initialize，无需页面重试。

残留缺口（**已修**，2026-09-30）：宽限到期仍回 4002 时，页面曾因 resolve-on-open 语义白屏
而非错误提示页。现在 `connectViaWebSocket` 以「收到服务端 `Initialize`」为交付点，
close/超时都 reject，`bootstrapWebApp` 渲染「Web 启动失败 + Retry」错误页
（契约见 `docs/spec/web-bootstrap-delivery-point.md`）。
⚠ 这是 **web bundle 侧**的改动：relay 托管的 `packages/web/dist` 必须重新构建后才生效。

反面结论（为什么不走别的路）：桌面侧延迟 attach 需要 relay 新增「client 已配对」控制信令，
deferInit + `ready()` 触发需要新增 Main→Host 协议消息——都扩大协议面；缓冲是唯一
**桌面、Host、协议零改动**的修复。

#### 残留竞态 3（已修）：与「正在关闭」的 host 配对，新页面被连坐秒杀

`pipe()` 的连坐是**异步**的：手机端 WS 关闭后 relay 立即对 host 调 `close(4003)`，但 host
侧的 `close` 事件要等 close 握手完成（WAN 上一个 RTT，本机 ~1ms）。这段窗口里 `hostSocket`
仍是那个 **CLOSING** 的 socket：

```text
手机刷新（连坐路径）:
t0  旧 client close → clearPair() → pipe shutdown(4003) 关闭 host（已发出 close 帧）
    └─ hostSocket 仍指向旧 socket，readyState = CLOSING（等对端回 close 帧：WAN 一个 RTT）
t1  新页面 /ws 到达
    └─ 修复前 tryPair() 只判断「hostSocket 是否存在」⇒ 与新 client 建 pipe
t2  旧 host 的 close 事件到达 → 新 pipe 的 a.on("close") → shutdown(4002, host-offline)
    ⇒ 刚连上的新页面被连坐关闭
    ⇒ web 端 `connectViaWebSocket` 已在 open 时 resolve ⇒ 空壳白屏且不重试
```

⇒ 规则见 §12.3.1 表的「只配 OPEN 的 host」与「宽限到期重判」两行。两条规则都不改协议、
不改桌面侧，只在 relay 的配对准入上收紧。

#### 运维不变式：改 `relay.mjs` / 桌面 Main 必须重启对应进程

本次现象（`http://127.0.0.1:3180/` 刷新一次空白、再刷一次出界面）的实测放大器就是**进程在跑旧代码**：

| 进程 | 启动时间 | 源码/产物时间 | 后果 |
| --- | --- | --- | --- |
| relay | 23:12:09 | `relay.mjs` 23:40:10 | 宽限等待逻辑未加载 ⇒ 缺位窗口内到达的手机连接被立刻 4002 |
| 桌面 Main | 22:35:59 | `remoteRelayClient.ts` / `out/main/index.js` 23:40:42 | 快速补位未加载，4003 后仍按 1s 退避重连（tsup watch 只重建 bundle，Electron 主进程不重载） |

日志特征：62 次 `client connected` 中 30 次在**同毫秒**被断开，且从未出现
`host offline; holding client for up to …`。⇒ relay 与桌面 Main 的改动都**必须重启进程**才生效；
排查任何「源码已修但现象不变」时先比对进程启动时间与文件 mtime。

#### 验收场景

| 场景 | 期望 | 测试 |
| --- | --- | --- |
| 桌面先在线、手机后开 | 回放缓冲的 Initialize，之后双向转发 | `vps-relay-forward.test.mjs` 用例 1 |
| 刷新撞进 host 缺位窗口 | 宽限内等待，host 回来即配对并收到 Initialize | 用例 2 |
| host 真离线 | 宽限到期回明确 4002，不静默卡死 | 用例 3 |
| 新页面到达时 host 正在关闭（CLOSING） | **不**与新页面配对、不秒杀；host 回来后正常配对服务 | 用例 4 |
| host 在旧连接未断开时拨入（顶替） | 手机端存活并继续被新 host 服务（双向转发成立）；旧 host 关闭无副作用 | 用例 5 |
| relay 配对重定向 | 只摘 `token`，保留 `autoReconnect` 等参数 | 用例 6 |
| 一侧不回 pong（僵尸连接） | 超过 `IDLE_TIMEOUT_MS` 被关闭并记日志；会自动回 pong 的健康连接不被误关 | 用例 7 |


### 断开与恢复

| 事件 | 行为 |
| --- | --- |
| 桌面 WS 断开 | relay 以明确 close code 关闭手机侧 → 手机 UI 提示「桌面离线」，不静默卡死 |
| 桌面重连 | 复用**稳定 attachmentId** 重新 attach（`windowHostAttachmentRegistry` 对同一 id 原子替换前一个，无需显式 DetachServicePort） |
| 手机断网/锁屏 | 重连 `/ws` → 重新配对 → 回放最新一轮 host 帧缓冲（含新 attach 的 Initialize）→ 走 `replayable` 档的 snapshot + gap repair（协议已支持，无需新代码） |
| 心跳与空闲回收 | relay 每 `HEARTBEAT_INTERVAL_MS`（默认 30s）ping **两侧**；一侧超过 `IDLE_TIMEOUT_MS`（默认 60s）没有任何活动（消息/ping/pong）即视为僵尸连接（手机被回收、桌面卡死、网络半开）并关闭：host 用 4003（桌面侧快速补位 100ms），client 用 4000。两端都按 RFC 自动回 pong，所以「空闲但健康」的连接不会被误关（`vps-relay-forward.test.mjs` 用例 7） |

## 12.4 关键接口契约

### relay 的端点

| 端点 | 方向 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| `GET /` + 静态 | 手机 → relay | 无 | 托管 `packages/web/dist`；SPA fallback **仅限无扩展名路径**，带扩展名的缺失资产回 404（兜底成 index.html 会把 HTML 当 JS 发回 → 模块解析失败白屏，实测踩过） |
| `GET /api/server-info` | 手机 → relay | cookie **或** `?token=` 查询参数（双通道，见下方「token 双通道」） | 返回桌面通过 `/api/host-report` 上报的 `ServerRemoteInfo` 形状。**fail-closed**：未配对（无/错 cookie）返回 401，工作区路径与主机标签不向匿名探测暴露。web 端 `resolveWebBootstrap()`（`packages/web/src/main.tsx`）对非 200 **优雅降级**——只少拿 `initialWorkspaceAbsPath` 提示，不 fail bootstrap，因此加门禁不改变正常配对流程（同源 fetch 默认携带 cookie） |
| `POST /api/host-report` | 桌面 → relay | `HOST_SECRET` | 上报 `{ workspacePath, workspaceIdentity, hostLabel }` |
| `GET /ws`（upgrade） | 手机 → relay | cookie **或** `?token=` 查询参数（双通道） | 与当前 host 配对，**逐字节转发** |
| `GET /host`（upgrade） | 桌面 → relay | `HOST_SECRET` | 注册为**唯一** host：已有连接时以 4001 `host-replaced` 顶替（`onHostOpen`） |

#### token 双通道（2026-10-05，实测踩出来的）

配对凭据接受两条等价通道：`zcode_lite_token` cookie（既有流程）**或** `/ws`、`/api/server-info`
请求上的 `?token=` 查询参数。原因：实测发现 Electron 内置浏览器（webview 分区）里 302 的
`Set-Cookie` 可能不落地（分区 cookie 为空），页面只能带着**无 cookie** 的 WS 撞 401，表现为
空白/启动失败。`RELAY_TOKEN` 本来就是 relay 自己签发的凭据（经 `?token=` 明文到达 relay，
TLS 终结点可见），放进 `/ws` 查询参数没有新增暴露面；web bundle 从页面 URL 读到 token 就附加
到 wsUrl 与 server-info 请求（302 摘掉 token 的正常流程仍走 cookie）。两通道都走常量时间比较；
E2EE 的 `#k=` 仍在 fragment 里，不进任何请求。

### 环境变量

**relay（VPS）**：`PORT`、`RELAY_TOKEN`（手机配对码）、`HOST_SECRET`（桌面密钥）、`WEB_ROOT`、
`HOST_WAIT_GRACE_MS`（host 缺位时手机等待宽限，默认 5000，见 §12.3.1）、
`HEARTBEAT_INTERVAL_MS`（心跳间隔，默认 30000）、`IDLE_TIMEOUT_MS`（空闲回收阈值，默认 60000）
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
| relay 被未授权访问 | `/host` 用强 `HOST_SECRET` + TLS；`/ws` 与 `/api/server-info` 用 `RELAY_TOKEN` cookie 门禁。**当前实现是静态 token + 30 天 cookie**（spec §5.5 的「一次性短时效」是强化方向，尚未实现）；轮换 = 设置页清空配对码重新生成并同步 relay 的 `RELAY_TOKEN` | 停掉 relay 进程 |
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
13. **握手时序**（§12.3.1）：桌面先连、手机后开的正常顺序下，手机配对后必须能完成
    RPC 初始化（收到回放的 Initialize）并渲染出工作区 UI，而不是白屏；
    桌面重连/手机刷新任意顺序组合均成立。

## 15. 官方 UI 触发链路逆向（为什么官方不需要任何配置）

用户视角：打开 App → UI 里点「远程访问」→ 直接拿到移动端链接。逆向确认的实现：

### 15.1 关键 API（Main 进程 `[web-remote-control]` 模块导出面）

```js
{
  authorizeStart(windowId, workspace),        // → 一次性令牌 {token, expiresAt, windowId, workspaceKey}
  startAuthorized(windowId, workspace, {token}), // 校验令牌（单次有效）→ start()
  start(windowId, {workspacePath, remoteSessionId}),
  resetPairing(windowId, {reason:"leaked-qr"}),  // 链接泄漏 → 清除持久化身份并重新注册
  getStatus(windowId),                        // → {status:"idle"|...} 供 UI 轮询
  createQrUrl(windowId, workspace, theme),    // → 拼链接，hash 用 passHash + 新 timestamp 现算
}
```

### 15.2 流程

1. **身份自举（仅首次）**：Main 生成 `password=randomBytes(24).base64url`、`passHash=sha256(password)`，
   连**内置云 relay**（`wss://<账户端点>/ws`）发 `device_register_init` → 得 `device_sid`，
   `{deviceSid, passHash}` 持久化到 authStorage。
2. **UI 触发**：renderer 先 `authorizeStart` 拿**一次性令牌**（绑定 windowId + workspaceKey，过期作废），
   再 `startAuthorized` 换取真正启动 —— 防渲染进程静默启动/重复启动。
3. **链接生成**：`createQrUrl` 用持久化的 `passHash` + **新鲜的 `timestamp`** 现算 `hash` 参数，
   拼 `https://<origin>/remote/v4?sid=&hash=&t=&mid=&name=&app_version=&theme=` → UI 展示二维码/链接。
4. **状态回传**：`mapTransportState` 把传输层状态映射为 UI 状态；失败带
   `{result:"failure", pairKind:"reconnect"|"initial", errorCategory:"relay"}`。
5. **吊销**：`resetPairing("leaked-qr")` 重新生成身份 ⇒ 所有旧链接立即失效。
6. **门控**：`featureGate.assertEnabled()`（构建/服务端开关），`getStatus` 在未启用时返回
   `idle + unsupported-action`。

### 15.3 官方「零配置」的三个来源

| 来源 | 说明 |
|---|---|
| relay 端点**内置** | 从账户端点推导 `wss://<origin>/ws`，无需用户填 |
| 身份**自动生成并持久化** | 首次注册后永久复用，无需用户输入 |
| 链接**按需现算** | 每次点击都生成新 `t`/`hash`，无需预配置 |

⇒ 我们要复刻这个 UX，差的不是协议（§14 已还原），是 **Main 侧 IPC 面板 + 渲染层入口**。

### 15.4 映射到 ZCodium 的实现清单

| 官方组件 | ZCodium 对应 | 工作量 |
|---|---|---|
| authorizeStart/startAuthorized 一次性令牌 | 新增 IPC handlers（~60 行） | 小 |
| start/stop/getStatus | `remoteRelayClient` 已有 start/stop/state，补 IPC 暴露（~40 行） | 小 |
| 内置端点 | 自建 relay 地址 → **配置文件** `~/.zcodium/v2/remote-relay.json`（或 UI 输入一次） | 小 |
| createQrUrl（sid/hash/t 签名链接） | 简化版：`https://<vps>/?token=RELAY_TOKEN&autoReconnect=1`（relay 已实现 cookie 配对，并保留非 token 参数）；后续可升级为签名链接 | 小 |
| resetPairing | 清空设置页的「配对码」并保存 → 下一次读取自动重新生成（`remoteRelayControlIpc.ensurePairingToken`），再把新值填到 relay 的 `RELAY_TOKEN` | — |
| **配对码来源** | **自动生成**：配置文件缺失 `pairingToken` 时由 Main 生成 24 字节 base64url 并落盘（避免出现 `devtoken` 这类全局弱口令）。UI 里可直接看到/复制 | 小 |
| **公开地址** | 与中继地址**通常是同一主机的不同协议**（桌面 WS 拨出 / 手机 HTTP 访问），因此缺省由中继地址推导：`deriveRemoteRelayPublicUrl`（`@zcode/shared`，`ws→http` / `wss→https`，主进程与 UI 共用同一实现）。设置页默认只显示「中继地址」，仅当同源推导不成立（反向代理、端口映射、内网拨入）时才打开「公开地址与中继地址不同」覆盖项 | 小 |
| **UI 入口** | 设置页「远程访问」：状态 + 启停 + 链接/复制；其余配置收进默认折叠的「高级设置」（中继地址/密钥/公开地址/配对码/工作区/自启动） | 中 |

⇒ 总量 ~300 行，其中唯一的新东西是渲染层 UI；协议、relay、桌面客户端全部已就绪。

### 15.5 ⚠ 已知坑：`remoteRelaySetConfig` 是**单个请求对象**

`IPlatformService.remoteRelaySetConfig(request: RemoteRelaySetConfigRequest)` 的契约是
**一个** `{ config, apply }` 对象。preload 曾把它写成 `(config, apply?)` 并再次包一层，
渲染层透传整个请求时 `config` 就变成了信封本身 —— 一次「保存并应用」把
`{ config: {...}, apply: true }` 写进了 `~/.zcodium/v2/remote-relay.json`，
App 重启后读不到 `url`、中继客户端根本不会启动（表现为「莫名掉线且设置页全空」）。

修复（三层，缺一不可）：

| 层 | 做法 |
| --- | --- |
| preload | 签名改回 `(request: RemoteRelaySetConfigRequest)`，原样透传 |
| Main 校验 | 白名单字段校验（`packages/desktop/src/main/remoteRelayConfigPayload.ts`）：出现未知字段（尤其嵌套 `config`）**直接报错**，让这类签名错误在写入前失败，而不是静默写坏配置 |
| 读取兜底 | `readConfigFile` 识别历史信封形状 → 还原成扁平配置并立刻修回文件（日志一条 warn） |

回归测试：`packages/desktop/tests/remote-relay-config-payload.test.mjs`（信封 payload 必被拒 + 坏文件可还原）。
⇒ 分享链接默认带 `autoReconnect=1`（手机断线自动整页重载恢复）；默认行为仍是「只提示 + 一键重连」，
开关语义见 `docs/spec/web-bootstrap-delivery-point.md` §2.4。

---

# 16. E2EE（阶段 2 首选项）：中继不可读的加密面

> 实现 §12.5 阶段 2 的第一条。目标：**VPS 中继看不到任何明文**——代码、终端输出、会话内容。
> relay 保持哑管道零改动；加密发生在两端（桌面 Main ↔ 手机 web bundle）。

## 16.1 威胁模型与一个关键事实

- **防**：中继运营方读流量（诚实但好奇）；中继篡改/注入/跨会话重放（主动攻击 → 一律 fail-closed）。
- **不防**：端点被攻破（桌面配置文件、手机本地存储）；链接被转发给第三者（**链接即能力**，与
  `RELAY_TOKEN` 同理）；可用性（中继本来就能断链）。
- **关键事实**：`RELAY_TOKEN` 经 `GET /?token=` 到达中继（TLS 在中继终结，终结点看得到请求行），
  **不能当 E2EE 的 PSK**。E2EE 密钥必须走 **URL fragment**（`#k=`）：浏览器不把 fragment
  发给服务器，中继只看到 `/?token=…`；同源导航不带 fragment 进 Referer。
- fragment 的残余暴露面：地址栏、复制/粘贴与聊天记录、屏幕共享——**把完整链接当凭据对待**（与 token 同级）。

## 16.2 密码学选择

- **`@noble/{hashes,ciphers,curves}`（纯 JS、同步 API）**，不用 WebCrypto subtle。决定性理由：
  `crypto.subtle` 只在 secure context 可用，`http://<局域网IP>:3180`（内网场景，
  `remoteRelayLanAddresses` 的主用例）下为 undefined——用 subtle 会直接打破内网 E2EE。
  同步 API 还免掉了 AEAD 异步加解密的**保序队列**（ISocket.write/onData 是同步契约）。
- x25519 ECDH（**PFS**：channelKey 事后泄露不破解已录流量——链接被贴进聊天是常态）+
  PSK 绑定（无 PSK 的纯 ECDH 会被 MITM 各建一条）+ ChaCha20-Poly1305 + HKDF-SHA256。
- bundle 增量 ~30KB gz（tree-shaken）。

## 16.3 协议（ZRE1，握手 3 类消息 + 数据记录）

握手与 §12.3.1 的 Initialize 缓冲同构：host hello 先发，可被 relay 缓冲回放。

```text
host → phone:  hello  { "ZRE1", role=host,  ephHost(x25519 pub 32B), nonceHost(32B) }
phone → host:  hello  { "ZRE1", role=phone, ephPhone,              noncePhone }
双方:  ecdh = X25519(eph_priv, eph_peer)
       ikm = channelKey(32B) ‖ ecdh(32B)；salt = nonceHost ‖ noncePhone
       k_hostOut / k_phoneOut / k_confirm = HKDF-SHA256(ikm, salt, info="zcode-relay-e2ee v1 <用途>")
host → phone:  confirm { "ZRC1", mac = HMAC(k_confirm, "…confirm v1 host"  ‖ hostHello ‖ phoneHello) }
phone → host:  confirm { "ZRC1", mac = HMAC(k_confirm, "…confirm v1 phone" ‖ hostHello ‖ phoneHello) }
数据:          record { 0xC1, seq(u64 BE), ChaCha20-Poly1305(k_<方向>, ad=type‖seq, pt=一帧 SocketProtocol payload) }
```

- **confirm 校验通过前不处理任何应用帧**；两端各自排队（见 §16.4）。confirm 不匹配 = 对端没有
  channelKey（MITM/错钥）→ fatal。
- **严格 seq**：只接受等于本方向期望值的 seq（TCP 保序之下即重放防护）；跨会话因 eph 密钥更换天然失效。
- 一条 WS 消息 = 一条 record（relay 1:1 转发保消息边界，`maxPayload` 64 MiB 足够）。

## 16.4 实现落点与缓冲语义

| 端 | 位置 | 说明 |
| --- | --- | --- |
| 核心 | `packages/shared/src/remote-relay-e2ee.ts` | 握手状态机 + record 编解码 + 密钥派生，**双端单实现** |
| 桌面 | `remoteRelayClient.ts` E2EE 分支 | `SocketProtocol` 架在虚拟 ISocket 上；host 侧在 secure 前**缓冲 Host 出站帧**（有界 64 条 / 1 MiB，**溢出 fatal**——丢帧会破坏 RPC 流，不能像 relay 缓冲那样丢最旧） |
| 手机 | `packages/client/src/websocket.ts` | `connectViaWebSocket` 增 `e2eeChannelKey` 选项；E2EE fatal → reject → 既有 bootstrap 错误页（fail loud，不白屏） |
| relay | **零改动** | record 对它不透明；缓冲/回放/心跳语义不变（缓冲的是密文） |

不做「探测降级」：旧 dist 的手机不发 hello，若 host 靠超时猜测对端能力就是用超时掩盖同步问题。
E2EE 开启后，host 收到的第一条消息不是合法 hello → 立即断开 + 明确日志（fail-closed）。

#### 适配器接线不变式（web 接缝测试三轮踩出来的，立此为规）

E2EE 适配器的**收包侧**必须是「单一 FIFO 队列 + 泵守卫」，且泵的首次放行必须等所有上层监听
（`SocketProtocol` / `ChannelClient.onDidInitialize` / `hostProtocol` 对接）挂上之后：

1. `RelayE2eeChannel` **构造即发 hello**——同步传输（测试回环）下对端响应立刻回来，而此时
   闭包里的通道变量还是 `null`，直接注册回调会丢帧、握手死锁；
2. 对端 secure 后立即发 record，若早到的 hello/confirm 还在缓冲、record 却被直接处理，
   就违反「confirm 先于 record」的处理序，通道按协议违规 fail-closed；
3. Initialize 可能已同步到达队列——早于 `onDidInitialize` 订阅放行会被 `SocketProtocol` 丢弃，
   ChannelClient 永远等不到初始化。

生产网络 RTT 下这三条通常不触发（队列为空），但**正确性不能依赖 RTT 长度**——回归测试
`packages/client/tests/websocket.test.mjs`（E2EE 两例）与
`packages/desktop/tests/remote-relay-client.test.mjs` 的同步回环就是靠该不变式才能稳定跑通。

## 16.5 配置与开关

- `~/.zcodium/v2/remote-relay.json` 增 `e2ee?: boolean`、`channelKey?: string`（32B base64url，
  与 `hostSecret` 同等敏感）；env `ZCODE_REMOTE_RELAY_E2EE`（`1`/`true`）。
- **默认 false = 现行为逐字节不变**。开启是显式动作：设置页开关或写配置。
- 启用 e2ee 且 `channelKey` 缺失时自动生成并落盘；分享链接追加 `#k=<channelKey>`。
- 轮换：清空 `channelKey` 保存 → 自动重生成，旧链接全部失效。

## 16.6 灰度顺序（两端能力必须同时具备）

1. relay 零改动，无需重新部署。
2. **重新构建并部署 `packages/web/dist`**（E2EE 能力进 bundle）。
3. 设置页开启端到端加密（或 `e2ee: true`）→ 自动生成 channelKey → 分享新链接（带 `#k=`）。
4. 旧链接（无 `#k`）的手机：握手立刻失败并显示错误页（非白屏、非静默），重新复制新链接即可。

## 16.7 验收

| # | 场景 | 期望 |
| --- | --- | --- |
| 1 | 单测（shared）：两个方向握手、双向 record 往返 | 明文逐字节一致 |
| 2 | 单测：篡改 record / 错 channelKey / seq 跳号 / 跨会话重放 | 一律 fatal，不产出明文 |
| 3 | 桌面集成（真实 relay + 真实 `remoteRelayClient` + 模拟手机） | WS 线上**观察不到明文**；握手后应用帧正确到达对端 |
| 3b | web 接缝（假 WS + 真 `RelayE2eeChannel`+`SocketProtocol`+`ChannelServer`） | 带 key：Initialize 经密文到达才交付、线上全是 ZRE1/ZRC1/0xC1 形状；错 key：reject「端到端加密握手失败」 |
| 4 | 错 key 的手机接入 | fatal + 明确日志，不产明文 |
| 5 | 未开启 e2ee / 链接无 `#k` | 行为与现状逐字节一致（回归） |
| 6 | `pnpm typecheck` / `pnpm lint` | 全绿 |

## 16.8 已知边界

- channelKey **先于会话**泄露（粘贴链接到不可信渠道）→ 当前+未来会话可解密；PFS 只保护
  「密钥事后泄露」的情形。缓解：链接当凭据、轮换即作废旧链接。
- 不防 DoS/可用性。

---

# 17. 多槽位（一台 relay 服务多个客户端）

> 单配对版（§12）一台 relay 只有一个 Host 槽位 + 一个客户端槽位：第二个客户端会把第一个
> 顶掉（4004）。多槽位版把 relay 的配对从「单配对」改为「**连接池认领**」，让一台 relay
> 同时服务 N 个客户端（多台手机/多个浏览器 tab）。

## 17.1 为什么不是「广播帧」

Host↔客户端的帧里没有会话身份：两个客户端共用一条 Host 连接时，各自的 RPC 请求号会撞车，
响应无法区分归属，广播回去等于 **A 看到 B 的会话内容**。所以多客户端必须落在
「**每个客户端一条独立的 Host 连接 + 独立 attachment**」上——Host 侧多 attachment 并存是
官方预留的设计（§12.1 已验证 `windowHostAttachmentRegistry` 无单例限制），协议零改动。

## 17.2 契约

| 项 | 契约 |
| --- | --- |
| 槽位标识 | 桌面拨出 `/host?slot=<k>`（k = 0..N-1，缺省 0 = 兼容单槽位旧行为）；非法 slot 拒绝升级 |
| 连接池 | relay 维护 `hostSlots: Map<slotId, {ws, client, pair, buffer}>`；客户端认领空闲槽位，无空闲则进宽限等待（复用 §12.3.1 语义，per client），宽限到期仍无槽位 → 4002（reason `no-free-host`） |
| 配对语义 | 每对（host ws ↔ client ws）沿用既有 pipe：连坐、close code（4002/4003）、dispose 语义完全不变 |
| 槽位顶替 | 同 slotId 的新 Host 连接顶替旧连接（4001 host-replaced）；**已配对的客户端保持存活**并被新 Host 接管（复用 §12.3.1 dispose 语义） |
| 客户端不再互相顶替 | 连接池下新客户端认领**新槽位**而不是顶替旧客户端；僵尸客户端由空闲回收（§12.3.1）按 4000 收走腾出槽位 |
| 缓冲 | 配对前的 Host 帧缓冲**按槽位**独立（各自有界 32 帧/1 MiB，语义同 §12.3.1） |
| E2EE | **每条连接独立握手**（同一 channelKey，会话密钥按连接独立派生，PFS 按连接）；relay 仍零改动哑管道 |
| host-report | 全局一份（同一桌面多槽位上报相同元数据，幂等覆写） |
| 桌面槽位数 | 配置 `slots`（1..8，缺省 1）或 env `ZCODE_REMOTE_RELAY_SLOTS`；每个槽位一条独立连接 + 独立 attachmentId + 独立重连/心跳 |
| 桌面槽位基址 | 配置 `slotBase`（0..91，缺省自动生成并持久化）或 env `ZCODE_REMOTE_RELAY_SLOT_BASE`；实际槽位号 = slotBase + k。**多桌面共用一台 relay 时各桌面的 slotBase 天然错开**（随机 92 取值，两台碰撞概率 ≈1%，冲突时手工覆盖）；单桌面无感 |
| 状态 | `RemoteRelayStatus.slots` = 槽位数；`connected` = 任一槽位已连接 |

## 17.3 兼容性

- 不带 `?slot=` 的旧桌面 = slot 0，单槽位行为与 §12 完全一致（既有集成测试全部保持通过）。
- 客户端（手机/web bundle）**零改动**：`/ws` 不需要知道槽位，认领发生在 relay 内部。

## 17.4 验收

| # | 场景 | 期望 |
| --- | --- | --- |
| 1 | 两个客户端 + 两个 Host 槽位 | 同时配对，帧互不串扰（A 的请求只到 Host1，B 只到 Host2） |
| 2 | 槽位满员后第三个客户端 | 宽限等待 → 4002 `no-free-host`，不静默挂死 |
| 3 | 同 slotId 重连 | 顶替旧连接，**其它槽位不受影响** |
| 4 | 客户端断开 | 连坐关闭其 Host 连接，槽位释放，其它槽位不受影响 |
| 5 | 既有单槽位测试（不带 slot） | 全部保持通过 |

## 18. 官方 UX 对齐：二维码扫码接入 + 时效签名链接

官方远控的链接是「`sid`（房间）+ `hash`（HMAC 签名，兼手机端认证密钥）+ `t`（签发时间）」
的**签名时效凭据**（§13.5），而路线 A 现状是「永久有效的 `?token=` 链接」。
本节把这两项差距补齐：**扫码接入**与**链接时效**。中继保持哑管道（无状态 HMAC 验证），
不引入房间路由。

### 18.1 威胁模型与密钥

- HMAC 密钥 = 桌面 `pairingToken` = 中继 `RELAY_TOKEN`（两端已共享，与 legacy token 同源）。
- 签名链接泄露的暴露窗口 = `e`（过期时刻），**不再是永久**；撤销仍靠轮换 pairingToken。
- `#k=`（E2EE channelKey）继续走 fragment：不进任何请求，中继拿不到（§16.2 不变）。

### 18.2 链接格式与签名算法（对齐官方形状）

```text
<publicUrl>/?s=<sid>&t=<issuedAtSec>&e=<expiresAtSec>&h=<sig>&autoReconnect=1#k=<channelKey>

sid = base64url(randomBytes(16))            // 房间 id（官方 d_ + 16B 同形；预留撤销钩子）
sig = base64url(HMAC_SHA256(pairingToken, `${sid}|${t}|${e}`))   // 32 字节，官方 hash 同量级
```

校验规则（relay，全部常量时间比较）：

1. `h` 与重算值相等；
2. `t` 不得在未来（容差 +300s）——`t` 是**签发时刻**，正常流程就是「生成链接 → 过一会儿
   才扫码/打开」，**不拒绝过去的 t**（曾误写成 `|now-t|≤300s` 导致链接签发 5 分钟后
   永远 401，真浏览器实测抓出后修正）；
3. `now < e`（过期即 401；有效期完全由 `e` 把关）。

### 18.3 派生会话 cookie（服务端强制过期）

配对入口验证通过后，除沿用 legacy cookie 外，下发**派生凭据**：

```text
zcode_lite_token = v1.<e>.<base64url(HMAC_SHA256(RELAY_TOKEN, `cookie|${e}`))>
Max-Age = e - now
```

- `v1.` 前缀区分裸 `RELAY_TOKEN` cookie；`e` 编进值内，**过期由服务端判定**（Max-Age 只是浏览器提示）。
- 无状态：relay 不存会话表，重启不失效（`e` 之前）。

### 18.4 客户端凭据四通道（isClientAuthorized）

| 通道 | 载荷 | 说明 |
| --- | --- | --- |
| legacy cookie | `zcode_lite_token = RELAY_TOKEN` | 现状不变 |
| legacy query | `?token=` | §12.4 双通道，现状不变 |
| 派生 cookie | `v1.<e>.<sig>` | §18.3，过期服务端拒绝 |
| signed query | `?s=&t=&e=&h=` 全参数验证 | §12.4 教训（Set-Cookie 可能不落地）的对等通道 |

配对入口（非 `/api/` 的 GET 带 `?s=&t=&e=&h=`）验证通过 → 302 时**保留** s/t/e/h
（与 token 被摘除相反）：signed 参数就是本次会话凭据，web bundle 要把它们附到
wsUrl / server-info（等价于 token 通道）；过期前留在浏览器历史/Referer 的暴露
窗口有限，这是相对永久 token 的改进。`#k=` fragment 由浏览器在 302 后继承
（RFC 9110 §15.4.4），E2EE 链路不受影响。

### 18.5 桌面侧签名与 IPC

- 新 IPC `RemoteRelayGetShareLink`，请求 `{ ttlSeconds: number | null }`
  （null = 永久 legacy token 链接；正整数 clamp 到 1h..30d），响应
  `{ shareUrl: string | null, expiresAt: number | null }`。
- 签名只发生在 Main（`remoteRelayShareLink.ts`），渲染层不持有 HMAC 逻辑。
- **默认分享链接不变**（永久 token 链接，PWA/书签兼容）；时效链接按次生成。

### 18.6 UI（设置页）

分享链接行新增「二维码」按钮：弹层内选时效（永久 / 1 小时 / 24 小时 / 7 天，默认 24 小时），
实时生成链接 + QR（`qrcode.toDataURL`，与 BotsDialog 同模式）+ 复制。QR 编码完整链接
（含 `#k=`；扫码打开后 fragment 不进请求，302 后浏览器继承）。

### 18.7 兼容性与验收

- legacy token 链接/cookie、E2EE、多槽位行为全部不变；旧链接继续可用。
- 验收：

| # | 场景 | 期望 |
| --- | --- | --- |
| 1 | 打开时效签名链接 | 302 + v1 cookie；页面 bootstrap 成功（含 /ws 升级） |
| 2 | 过期签名链接 / 过期 v1 cookie | 401 fail-closed，不降级放行 |
| 3 | 篡改 h / s / e 任一参数 | 401 |
| 4 | legacy `?token=` 链接 | 行为与现状完全一致（302 + RELAY_TOKEN cookie） |
| 5 | QR 扫码 | 手机浏览器打开即进入桌面会话；E2EE 开启时含 #k= 仍可解密 |
