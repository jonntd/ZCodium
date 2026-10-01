# ZCode VPS 中继（vps-relay）

把手机浏览器桥接到**本机桌面正在运行的 ZCode Host** 的单文件中继。

- 手机侧**零改动**（直接用现有 web bundle）
- ZCode 侧**零改动**（协议、Host 都不动）
- 中继**不理解 ZCode 协议**：两端用同一套帧格式，所以它只做逐字节转发

架构与完整设计依据见仓库内 `docs/spec/vps-relay-bridge.md`。

## 两个 relay，选一个

| 文件 | 路线 | 说明 |
| --- | --- | --- |
| `relay.mjs` | **A（推荐先用）** | 纯字节转发。配合 ZCodium 现有 web bundle，桌面侧需 `remoteRelayClient`（已实现）。**已完整验证** |
| `relay-official.mjs` | **B（进阶）** | 实现官方远控的 JSON 信封协议（注册/鉴权/配对/心跳）。**仅控制面**，可配合官方 App（`ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL`）。数据面未实现 |

**两者是独立技术栈，不能混搭**（帧格式不同，详见 spec §14.5）。
下面的部署说明默认指 `relay.mjs`（路线 A）。

---

## 1. 它到底做什么

```text
手机浏览器 ──wss /ws──► relay ──wss /host──► 桌面 Main ──MessagePort──► 窗口 Host ──► Agent
（零改动）              （本目录）           （需一次接线）        （零改动）      （零改动）
```

`relay` 只做五件事：

1. 静态托管 web bundle（手机打开的就是它）
2. 回答 `/api/server-info`（工作区信息由桌面上报）
3. 回答 `/healthz`（容器健康检查用，只回 `{ok:true}`）
4. 把一条手机 WS 与一条桌面 WS 配对，之后**逐字节双向转发**
5. 缓冲配对前 host 发出的帧（含 RPC 层 `Initialize` 握手帧），配对时回放——
   否则手机侧 RPC 客户端永远等不到初始化，页面静默白屏（spec §12.3.1）

---

## 2. 部署

### 2.1 需要的东西

| 项 | 说明 |
| --- | --- |
| 一台有公网 IP 的 VPS | 1 核 512MB 足够（纯转发，几乎不耗 CPU） |
| Node.js 20+ | 或直接用 Docker |
| 一个域名 + HTTPS | 手机浏览器要求 `wss://`，**必须**有 TLS |
| web bundle | 仓库内 `packages/web/dist`（构建：`pnpm --filter @zcode/web build`） |

### 2.2 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `RELAY_TOKEN` | ✅ | **手机配对码**。手机打开 `https://<域名>/?token=<它>` 一次即可 |
| `HOST_SECRET` | ✅ | **桌面共享密钥**。桌面用它连 `/host`，也用它调 `/api/host-report` |
| `PORT` | | 监听端口，默认 `3180` |
| `WEB_ROOT` | | web bundle 目录，默认 `./web` |
| `HOST_WAIT_GRACE_MS` | | host 暂时缺位时手机端的等待宽限，默认 `5000` |
| `HEARTBEAT_INTERVAL_MS` | | 向 host/client 两侧 ping 的间隔，默认 `30000` |
| `IDLE_TIMEOUT_MS` | | 一侧多久无任何活动即按僵尸连接关闭，默认 `60000` |

两个密钥都必须足够长（建议 `openssl rand -base64 32` 生成），**且不要写进日志**。

### 2.3 方式一：Docker Compose（推荐）

本目录已经备好全部部署物，直接照做即可：

```bash
# 1) 在 VPS 上准备目录
mkdir -p /opt/zcode-relay/web
cd /opt/zcode-relay

# 2) 拷入部署物（relay.mjs / Dockerfile / docker-compose.yml / Caddyfile / .env.example）
scp <本机>:<repo>/deploy/vps-relay/* .

# 3) 拷入 web bundle
scp -r <本机>:<repo>/packages/web/dist/* web/

# 4) 生成密钥
cp .env.example .env
sed -i "s/^RELAY_TOKEN=.*/RELAY_TOKEN=$(openssl rand -base64 32)/" .env
sed -i "s/^HOST_SECRET=.*/HOST_SECRET=$(openssl rand -base64 32)/" .env

# 5) 起服务（只监听 127.0.0.1，公网流量经 Caddy）
docker compose up -d

# 6) 健康检查
curl -s http://127.0.0.1:3180/healthz
```

> `web/` 是只读 bind mount，所以**换前端产物不需要重建镜像**：替换 `web/` 内容后
> `docker compose restart` 即可。

### 2.3.1 附带的文件

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 只装 relay + `ws@8`；非 root 运行；自带 healthcheck |
| `docker-compose.yml` | 端口绑 `127.0.0.1`、只读挂载 `web/`、CPU/内存上限、`no-new-privileges` |
| `Caddyfile` | 自动 HTTPS + 反代；**自动处理 WebSocket 升级**，无需手写 Upgrade 头 |
| `.env.example` | 两个密钥的模板与安全提示 |
| `.dockerignore` | 排除 `.env` 与 `web/`，避免 secrets 进镜像层 |

### 2.4 方式二：裸 Node + systemd

```bash
# /etc/systemd/system/zcode-relay.service
[Unit]
Description=ZCode VPS Relay
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/zcode-relay
EnvironmentFile=/opt/zcode-relay/.env
Environment=PORT=3180
Environment=WEB_ROOT=/opt/zcode-relay/web
ExecStart=/usr/bin/node /opt/zcode-relay/relay.mjs
Restart=on-failure
RestartSec=3
User=zcode-relay
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now zcode-relay
```

### 2.5 HTTPS 反代（必须）

手机浏览器只在 `https://` 页面上才允许 `wss://`，所以**必须**有 TLS。

本目录的 `Caddyfile` 可以直接用：

```bash
sudo cp Caddyfile /etc/caddy/Caddyfile   # 先把第一行的域名改成你自己的
sudo systemctl reload caddy
```

Caddy 会自动签发/续期证书，**并自动处理 WebSocket 升级**，不需要手写 `Upgrade` 头。

> **nginx 用户注意**：需要显式转发 `Upgrade` / `Connection` 头，并把 `proxy_read_timeout`
> 调到 300s 以上——本中继是长连接，nginx 默认的 60s 会周期性掐断。

---

## 3. 桌面侧接线

中继起来后，桌面还需要一次接线（约 25 行，见 `docs/spec/vps-relay-bridge.md` §12）。
接线已完成，桌面支持两种配置方式（**env 优先**）：

### 方式 A：配置文件（推荐 —— 正常打开 App 即生效，无需终端 env）

写 `~/.zcode/v2/remote-relay.json`：

```json
{
  "url": "wss://relay.example.com",
  "hostSecret": "<与 VPS 上 HOST_SECRET 相同>",
  "publicUrl": "https://relay.example.com",
  "pairingToken": "<VPS 上 RELAY_TOKEN>",
  "autoStart": true
}
```

| 字段 | 必填 | 作用 |
|---|---|---|
| `url` | ✅ | 中继主机端点（本机验证可用 `ws://127.0.0.1:3180`） |
| `hostSecret` | ✅ | 与 VPS `HOST_SECRET` 一致 |
| `publicUrl` | — | 浏览器侧公开源（拼分享链接用）；缺省由 `url` 推导（wss→https） |
| `pairingToken` | — | VPS 的 `RELAY_TOKEN`（拼分享链接用） |
| `workspace` | — | 覆盖上报的工作区路径；缺省跟随窗口当前工作区 |
| `windowId` | — | 钉住借出 Host 的窗口 id；缺省跟随聚焦窗口 |
| `autoStart` | — | App 启动即连接（缺省 true） |

删掉这个文件即完全停用中继（行为与改动前一致）。
也可以在 App 内通过 IPC（`zcode:remote-relay-set-config`）写入，或直接在「设置 → 远程访问」卡片里编辑后「保存并应用」。

### 方式 B：环境变量

```bash
ZCODE_REMOTE_RELAY_URL=wss://relay.example.com \
ZCODE_REMOTE_RELAY_HOST_SECRET=<与 VPS 上 HOST_SECRET 相同> \
  <启动 ZCode>
```

| 变量 | 作用 |
|---|---|
| `ZCODE_REMOTE_RELAY_WINDOW=<windowId>` | 钉住指定窗口借出 Host；缺省跟随聚焦窗口 |
| `ZCODE_REMOTE_RELAY_WORKSPACE=<绝对路径>` | **直接指定上报的工作区路径**，无需在 App 界面里打开任何工作区（App 只需在跑，不需要交互） |

**两者都没配时中继功能完全不启用**，行为与改动前一致。

---

## 4. 使用

1. 桌面 ZCode：**设置 → 远程访问**（设置页「数据和统计」分组）。
   卡片里直接填中继地址 / 主机密钥 / 公开地址 / 配对码，**「保存并应用」立即生效**，无需重启；
   连接状态实时显示，「手机访问链接」一键复制——等价于官方的远程控制链接。
   （配置同样落在 `~/.zcode/v2/remote-relay.json`，两种方式互通。）
2. 手机浏览器打开 `https://relay.example.com/?token=<RELAY_TOKEN>`
3. 中继下发 cookie 并跳转（**只摘掉 `token`，其它参数保留**），之后正常使用
4. 手机上看到的就是**桌面那个 Host 的服务面**：任务列表、会话历史、终端、文件、Git

> **可选：无人值守自动恢复**。配对链接再加 `&autoReconnect=1`（即
> `https://relay.example.com/?token=<RELAY_TOKEN>&autoReconnect=1`）再加进主屏，
> 手机锁屏 / 切网导致连接断开时会**自动整页重载**恢复，不必点「重连」。
> 代价是重载会丢弃未发送的输入与未决弹窗，因此**默认关闭**；同一标签 10s 内只自动重载一次，
> 被其它页面顶替（多标签）时永不自动重载。契约见
> `docs/spec/web-bootstrap-delivery-point.md` §2.4。

---

## 5. 排障

| 现象 | 原因与处理 |
| --- | --- |
| 打开 `/?token=…` 返回 401 | `RELAY_TOKEN` 不匹配。重新从 `.env` 取值 |
| 页面能开，但一直「桌面离线」（close code 4002） | 桌面没连上 `/host`。检查桌面的 `ZCODE_REMOTE_RELAY_URL` / `HOST_SECRET`，以及 VPS 防火墙 |
| 桌面连不上 `/host` 返回 401 | `HOST_SECRET` 不匹配 |
| 页面 HTML/静态资源都 200，但**整页空白、无任何报错** | 旧版 relay 把 host 在手机配对前发出的 `Initialize` 握手帧丢掉了，手机 RPC 客户端永远不初始化。升级到带帧缓冲的 `relay.mjs` 并重启（spec §12.3.1；relay 日志应出现 `replayed buffered host frames`） |
| 手机上任务列表是空的 | 桌面还没调 `/api/host-report`（通常是窗口工作区还没就绪）。看中继日志有没有 `host report updated` |
| 连接频繁断开 | 反代的空闲超时太短。中继客户端每 30s 发 ping，但 nginx 默认 `proxy_read_timeout 60s` 仍可能掐断长空闲；调到 300s 以上 |
| `backpressure on …` 告警 | 某一侧消费不过来（通常是弱网手机）。属提示性日志，不影响正确性 |

中继日志前缀统一是 `[relay <ISO 时间>]`，关键事件：
`host connected` / `client connected` / `paired host↔client` / `host report updated` / `host disconnected`。

---

## 6. 安全须知（务必读）

- **`/host` 端点的鉴权强度 = 你整台机器的安全边界。** 一旦有人能连上 `/host`，
  就等于拿到了你桌面 Host 的完整服务面（终端、文件、Git），**等价于 RCE**。
  所以：`HOST_SECRET` 要足够长、只走 TLS、不落日志。
- `/ws`（手机侧）用 `RELAY_TOKEN`，它会在 URL 里出现一次（`?token=`）。
  中继在设置 cookie 后**立即 302 跳转到干净 URL**，避免 token 留在浏览器历史和 Referer 里。
- 当前实现**不做端到端加密**：TLS 在 VPS 上终结，所以**中继能看到明文流量**。
  如果你不完全信任这台 VPS，需要加 E2EE（见 spec §12.5 阶段 2）。
- 建议再加：仅允许一个 host 连接（已实现：新 host 会顶掉旧的）、配对码轮换、失败限速。

---

## 7. 本机先验证（不碰 VPS）

`relay.mjs` 也接受 `ws://`，所以可以完全在本机跑通再上云：

```bash
cd /path/to/ZCodium
# 两个密钥都用随机值；桌面设置页「远程访问」里会自动生成配对码，把同一个值填到 RELAY_TOKEN 即可
RELAY_TOKEN="$(openssl rand -base64 24)" HOST_SECRET="$(openssl rand -base64 24)" \
WEB_ROOT=packages/web/dist PORT=3180 \
  node deploy/vps-relay/relay.mjs
```

桌面用 `ZCODE_REMOTE_RELAY_URL=ws://127.0.0.1:3180` 启动，
设置页 →「远程访问」→「手机访问链接」里复制链接（形如
`http://127.0.0.1:3180/?token=<自动生成的配对码>&autoReconnect=1`）。
**注意**：配对码由桌面自动生成并写进 `~/.zcode/v2/remote-relay.json`，
中继侧的 `RELAY_TOKEN` 必须与它一致——直接用上面命令里 `openssl` 生成的值即可，
或改成设置页里显示的值后重启 relay。

这样能验证全部代码路径，且零外部依赖。
