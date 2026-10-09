# ZCode 中继 —— VPS 上一键 Docker 部署指南

用 Docker 在中继 VPS 上部署 ZCode 手机远控中继（`relay.mjs`，路线 A）。
中继只做逐字节转发，不理解 ZCode 协议；开启 E2EE 后它甚至看不到会话内容。

> 架构与完整设计依据：`docs/spec/vps-relay-bridge.md`；进阶用法（构建部署、
> 裸 Node + systemd、反代细节、本机部署）见同目录 `README.md`。

---

## 1. 环境要求

| 项 | 最低要求 | 说明 |
| --- | --- | --- |
| VPS | 1 核 / 512MB 内存 / 5GB 磁盘 | 纯字节转发，几乎不耗资源 |
| 系统 | Linux x86_64 / arm64 | Ubuntu 22.04+、Debian 12+、AlmaLinux 9+ 等主流发行版均可 |
| 网络 | 公网 IP；出站可达 ghcr.io | 国内 VPS 拉 GHCR 慢或失败时，见 §7.4 离线安装 |
| 软件 | Docker 24+ 与 Compose v2 插件 | 下面一键脚本会自动装；也可手动装，见 §1.1 |
| 防火墙 | 放行 TCP 3180（默认端口） | **云厂商安全组 + 宿主机防火墙都要放** |

### 1.1 手动安装 Docker 与 Compose（脚本自动装时可跳过）

```bash
# 官方一键脚本（同时装好 docker-ce、docker CLI、docker-compose-plugin）
curl -fsSL https://get.docker.com | sudo bash
sudo systemctl enable --now docker

# 验证
docker --version                 # ≥ 24
docker compose version           # ≥ v2.20（注意是 "docker compose"，带空格）

# 可选：免 sudo 使用 docker（重新登录后生效）
sudo usermod -aG docker "$USER"
```

> 不想用官方脚本？Debian/Ubuntu 也可以 `sudo apt-get install -y docker.io docker-compose-plugin`，
> 但版本较旧，推荐上面的方式。

---

## 2. 一键部署（推荐）

### 2.1 获取并执行脚本

```bash
# 下载
curl -fsSL -o install.sh \
  https://raw.githubusercontent.com/jonntd/ZCodium/feat/native-patcher-parity/deploy/vps-relay/install.sh

# 先看一眼再跑（好习惯——它会以 root 装 Docker）
less install.sh

# 执行（默认：纯 IP / 无域名，端口 3180，镜像 latest）
sudo bash install.sh
```

脚本会依次完成：安装 Docker（若缺）→ 生成 `/opt/zcode-relay/.env`（两个密钥现场用
`openssl rand -base64 32` 生成，权限 600）→ 写入 `docker-compose.yml` → 拉取镜像 →
启动容器 → 健康检查 → 打印手机配对链接与桌面侧接线参数。

**常用变体：**

```bash
# 有域名（端口只绑 127.0.0.1，由宿主机 Caddy/nginx 终结 TLS，见 §6）
sudo VARIANT=tls bash install.sh

# 钉死版本（生产推荐，见 §5 tag 说明）
sudo RELAY_VERSION=3.14.12 bash install.sh

# 换端口
sudo PORT=9443 bash install.sh

# 只生成配置不启动（先检查再手动起）
sudo DRY_RUN=1 bash install.sh

# 换安装目录
sudo ZCODE_RELAY_DIR=/srv/zcode-relay bash install.sh
```

### 2.2 脚本做了什么（与生成的 docker-compose.yml 完全一致）

以下就是脚本写入 `/opt/zcode-relay/docker-compose.yml` 的完整内容，想手动部署照抄即可：

```yaml
services:
  relay:
    # 不写 tag 就是 :latest（每次发布都推，含预发布 ⇒ 可能指向 audit 产物）。
    # 生产建议钉死具体版本，避免意外跟着 latest 走。
    image: ghcr.io/jonntd/zcode-relay:${RELAY_VERSION:-latest}
    restart: unless-stopped
    ports:
      - "3180:3180"            # tls 变体这里改成 "127.0.0.1:3180:3180"
    environment:
      # :? 语法让 compose 在变量缺失时直接报错退出，避免用空密钥起服务。
      RELAY_TOKEN: ${RELAY_TOKEN:?RELAY_TOKEN 未设置，请检查 .env}
      HOST_SECRET: ${HOST_SECRET:?HOST_SECRET 未设置，请检查 .env}
      PORT: "3180"
      WEB_ROOT: /app/web
    security_opt:
      - no-new-privileges:true
    deploy:
      resources:
        limits:
          cpus: "0.50"
          memory: 256M
```

同目录的 `.env`：

```ini
RELAY_TOKEN=<openssl rand -base64 32 生成的手机配对码>
HOST_SECRET=<openssl rand -base64 32 生成的桌面密钥>
```

> 手动部署（不用脚本）时，把上面两个文件放到同一目录，然后：
> `sudo docker compose pull && sudo docker compose up -d`

---

## 3. 环境变量与端口说明

### 3.1 必填

| 变量 | 存放处 | 说明 |
| --- | --- | --- |
| `RELAY_TOKEN` | `.env` | **手机配对码**。手机打开 `http://<IP>:3180/?token=<它>` 完成配对；轮换它可让所有旧链接 / 旧 cookie 全部失效 |
| `HOST_SECRET` | `.env` | **桌面共享密钥**。桌面 App 用它连中继的 `/host`。⚠ 它的强度 = 整台机器的安全边界——能连上 `/host` 的人等于拿到了你桌面 Host 的完整服务面（终端、文件、Git），**等价于 RCE** |

两个密钥都必须足够长（`openssl rand -base64 32`），不要写进日志、不要提交进版本库。

### 3.2 可选（中继运行参数，默认值已合理）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3180` | 中继监听端口（compose 里同时是容器内外端口） |
| `WEB_ROOT` | `/app/web` | 手机页静态资源目录（镜像内已烘焙，不用动） |
| `HOST_WAIT_GRACE_MS` | `5000` | host 暂时缺位时手机端的等待宽限 |
| `HEARTBEAT_INTERVAL_MS` | `30000` | 向 host/client 两侧 ping 的间隔 |
| `IDLE_TIMEOUT_MS` | `60000` | 一侧多久无活动即按僵尸连接关闭 |

需要覆盖可选参数时，在 compose 的 `environment:` 里加对应行即可。

### 3.3 端口一览

| 端口 | 方向 | 用途 |
| --- | --- | --- |
| **3180/tcp** | 入 | 中继主端口：手机页面 + `/ws` + 桌面 `/host` + `/healthz`（同一端口） |
| 80 / 443 | 入 | 仅 `tls` 变体：宿主机 Caddy（自动 HTTPS）或 nginx 反代用 |
| — | 出 | 容器出站拉镜像（ghcr.io）；运行期无出站依赖 |

### 3.4 镜像 tag（`RELAY_VERSION`）怎么选

| tag | 说明 |
| --- | --- |
| `latest` | **每次发布都推（含预发布）**，永远指向最新构建。⚠ 预发布期间它可能指向 audit 产物，生产建议钉死版本号 |
| `<版本>` | 如 `3.14.12`、`3.14.12-audit.20261009`。**注意不带 `v` 前缀**——CI 推送用的就是 `${TAG#v}` |
| `<12位sha>` | 如 `cfdf8e6abc12`，精确对应某个提交 |
| 离线 | 每次发布同时把 `zcode-relay-<版本>.tar.gz` 附到 GitHub Release，`docker load -i <它>` 即可（见 §7.4） |

镜像地址：`ghcr.io/jonntd/zcode-relay`（仓库公开 ⇒ **拉取不需要 docker login**）。
镜像内已烘焙手机页 web bundle，**「镜像 tag = 手机页版本」**，桌面更新后中继不会漂移。

---

## 4. 部署后验证

### 4.1 容器与服务健康（VPS 上）

```bash
cd /opt/zcode-relay
sudo docker compose ps          # STATUS 应为 Up (healthy)
curl -s http://127.0.0.1:3180/healthz   # → {"ok":true}
```

### 4.2 公网可达性（VPS 上）

```bash
PUB_IP=$(curl -s -4 ifconfig.me)
curl -s http://$PUB_IP:3180/healthz     # → {"ok":true}；不通 = 安全组/防火墙没放行
```

### 4.3 配对鉴权（VPS 上）

```bash
TOKEN=$(grep '^RELAY_TOKEN=' /opt/zcode-relay/.env | cut -d= -f2-)

# 正确配对码 → 期望 302，响应头有 set-cookie: zcode_lite_token=…
curl -s -i --get --data-urlencode "token=$TOKEN" http://127.0.0.1:3180/ | head -5

# 错误配对码 → 期望 401（fail-closed）
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3180/?token=wrong"
```

### 4.4 手机端到端

手机浏览器打开脚本末尾打印的链接（或 `http://<公网IP>:3180/?token=<RELAY_TOKEN>`），
出现配对页即成功。加 `&autoReconnect=1` 可在锁屏/切网后自动恢复（会丢弃未发送的输入）。

### 4.5 桌面侧接线（关键一步，漏了会一直「桌面离线」）

ZCode 桌面 App → 工作区头部**「移动端远程控制」**弹层 →「浏览器直连」→「高级设置」：

| 字段 | 值（纯 IP 部署） |
| --- | --- |
| 连接协议 | **明文 ws://** |
| 中继地址 | `<公网IP>:3180` |
| 公开地址 | 留空（手机访问地址由中继地址推导） |
| 主机密钥 | `.env` 里的 `HOST_SECRET` |
| 配对码 | `.env` 里的 `RELAY_TOKEN` |

填完点**「保存并应用」**。等价的手工方式——写 `~/.zcodium/v2/remote-relay.json`：

```json
{
  "url": "ws://<公网IP>:3180",
  "hostSecret": "<HOST_SECRET>",
  "pairingToken": "<RELAY_TOKEN>",
  "publicUrl": "",
  "slots": 3,
  "autoStart": true
}
```

> ⚠ `slots` 等**启动时才读**的字段，改完配置要在弹层点一次**「停止 → 启动」**（或重启 App）才生效。
> 保存成功后，桌面日志应出现 `[main] 已连上中继 ws://<IP>:3180`；VPS 上
> `sudo docker logs zcode-relay-relay-1` 应出现 `host connected`。

---

## 5. 更新与卸载

### 5.1 更新

```bash
cd /opt/zcode-relay
sudo docker compose pull && sudo docker compose up -d    # 跟最新（含预发布）

# 或直接用脚本（重新指定版本）
sudo RELAY_VERSION=3.14.12 bash install.sh update

# 回滚：把 RELAY_VERSION 换成旧版本号再跑一次 update 即可（镜像多版本共存于 GHCR）
sudo RELAY_VERSION=3.14.11 bash install.sh update
```

> `restart: unless-stopped` + VPS 重启后 Docker 会自动拉起容器，平时无需干预。

### 5.2 卸载

```bash
# 停止并删除容器（保留 .env 与 compose 文件，密钥不丢）
sudo bash install.sh remove

# 彻底清除（连 .env 一起删）
sudo bash install.sh remove --purge

# 清理镜像与安装目录
sudo docker rmi ghcr.io/jonntd/zcode-relay:latest
sudo rm -rf /opt/zcode-relay
```

> 卸载后桌面侧把 `~/.zcodium/v2/remote-relay.json` 删掉（或在高级设置里停用），
> App 即完全回到无中继状态。**要吊销所有旧链接**，删除 `.env` 前先换一组新密钥重新部署，
> 或确保旧链接所在的浏览器 cookie 已过期。

---

## 6. 有域名时：上 TLS（强烈建议）

纯 IP 明文 `http` 能用（内容仍受端到端加密保护），但丢两样东西：
**页面完整性**（bundle 可被链路上的主动中间人替换，而它读得到 `#k=` 加密密钥）和
**insecure origin 的浏览器能力**（`crypto.subtle` / `randomUUID` / `clipboard` 不可用）。
有域名就上 TLS：

```bash
# 1) 一键部署时选 tls 变体（端口只绑 127.0.0.1）
sudo VARIANT=tls bash install.sh

# 2) 装 Caddy 并反代（自动签发证书，自动处理 WebSocket 升级，无需手写 Upgrade 头）
sudo apt-get install -y caddy
sudo tee /etc/caddy/Caddyfile <<'CADDY'
relay.example.com {
    reverse_proxy 127.0.0.1:3180
}
CADDY
sudo systemctl reload caddy
```

桌面侧此时填：连接协议 **TLS wss://**、中继地址 `relay.example.com:443`、公开地址留空。
手机链接变成 `https://relay.example.com/?token=<RELAY_TOKEN>`。

> nginx 用户的反代必须显式转发 `Upgrade` / `Connection` 头，并把 `proxy_read_timeout`
> 调到 **300s 以上**（中继是长连接，默认 60s 会周期性掐断）。详见同目录 `README.md` §2.5。

---

## 7. 常见启动失败排查

先看日志：`sudo docker logs --tail 100 zcode-relay-relay-1`（容器名可用 `sudo docker ps` 确认）。

### 7.1 起不来 / 启动报错

| 现象 | 原因与处理 |
| --- | --- |
| `RELAY_TOKEN 未设置，请检查 .env` | compose 没读到 `.env`：确认它与 `docker-compose.yml` 同目录，且变量名/等号两侧无空格 |
| `pull access denied` / `manifest unknown` | `RELAY_VERSION` 写错。**tag 不带 `v` 前缀**——`v3.14.12` 是错的，应为 `3.14.12`；可用 `latest` 先验证 |
| `port is already allocated` | 3180 被占：`sudo ss -ltnp \| grep 3180` 找出占用者，改用 `PORT=其他端口`（并同步改 compose 的 ports 映射），或停掉占用进程 |
| `permission denied … /var/run/docker.sock` | 当前用户不在 docker 组：`sudo usermod -aG docker $USER` 后重新登录，或继续用 `sudo` |
| `Cannot connect to the Docker daemon` | daemon 没跑：`sudo systemctl enable --now docker` |
| 健康检查一直不过 | `sudo docker logs` 看应用日志；常见是 `.env` 里密钥值带了引号或换行 |

### 7.2 起来了但连不上

| 现象 | 原因与处理 |
| --- | --- |
| 本机 `/healthz` 通，公网不通 | **安全组没放行**（云控制台）或宿主机防火墙（`ufw allow 3180/tcp` / `firewall-cmd --add-port=3180/tcp --permanent && firewall-cmd --reload`）。注意 `tls` 变体只绑 127.0.0.1，公网直连 3180 **本来就不通**，必须走反代 |
| 打开 `/?token=…` 返回 401 | 配对码不匹配：`.env` 的 `RELAY_TOKEN` 与链接里的是否同一个值？URL 里的 `/ + =` 需转义（脚本生成的链接已处理）。轮换过 `RELAY_TOKEN` 的话旧链接全部失效，需重新生成链接 |
| 手机 401 但桌面正常 | 链接里的 token 与 `.env` 不一致；或中继重启后你还在用旧 cookie（重新点一次链接即可） |
| 桌面连不上 `/host` 返回 401 | `HOST_SECRET` 不匹配：桌面「高级设置」里的主机密钥 ≠ `.env` 的值 |
| 桌面连不上、地址栏明明对的 | 连接协议选错：纯 IP 必须「明文 ws://」，选了「TLS wss://」桌面会因裸 IP 无受信证书拒连 |
| 手机页一直「桌面离线」（close code 4002） | 桌面侧没连上：看桌面日志有没有 `已连上中继`；确认 App 侧点了「启动」且 `autoStart`/配置正确 |
| 曾正常，突然 `no-free-host`（4002） | 并发槽位满了：某台设备（常见是 Mac 上 Chrome 标签页）占着连接。在桌面「高级设置」把 `slots` 调大（1–8），**改完要「停止 → 启动」** |
| 页面 HTML 200 但整页空白无报错 | 旧版中继丢了握手帧；升级镜像即可（现镜像自带帧缓冲，日志应有 `replayed buffered host frames`） |
| 「Web 启动失败：端到端加密握手失败」 | 链接 `#k=` 与桌面 `channelKey` 不一致（旧链接/重开过 E2EE）。从桌面重新复制**新链接** |
| 连接频繁断开 | 反代空闲超时太短：中继每 30s 心跳，nginx 需 `proxy_read_timeout 300s` 以上；云 LB 同理 |
| 国内 VPS 拉 ghcr.io 超时 | 见 §7.4 离线安装 |

### 7.3 快速自检清单

```bash
cd /opt/zcode-relay
sudo docker compose ps                     # ① 容器 Up (healthy)
curl -s http://127.0.0.1:3180/healthz      # ② {"ok":true}
curl -s http://$(curl -s -4 ifconfig.me):3180/healthz   # ③ 公网通（=安全组OK）
sudo docker logs --tail 30 zcode-relay-relay-1 | grep -E "host connected|client connected|paired"
#                                           ④ 桌面/手机有没有连上来
```

### 7.4 国内 VPS / 无外网：离线安装

到 GitHub Release 页下载 `zcode-relay-<版本>.tar.gz`（每轮发布都会附上），传到 VPS 后：

```bash
sudo docker load -i zcode-relay-<版本>.tar.gz   # 导入镜像
sudo RELAY_VERSION=<版本> DRY_RUN=1 bash install.sh   # 只生成 .env + compose
cd /opt/zcode-relay && sudo docker compose up -d      # 用本地镜像启动，不会去拉
```

---

## 8. 安全须知（务必读）

- **`/host` 端点的鉴权强度 = 整台机器的安全边界。** `HOST_SECRET` 要足够长、不落日志；
  一旦泄露，任何能连上 `/host` 的人都等于拿到了你桌面 Host 的完整服务面（终端、文件、Git）。
- 配对码会出现在 URL 里一次（`?token=`）。中继设置 cookie 后立即 302 到干净 URL，
  避免它留在浏览器历史和 Referer 里。**撤销所有访问 = 轮换 `RELAY_TOKEN`**（改 `.env` 后 `up -d`）。
- 开启 E2EE（桌面「高级设置」里的端到端加密开关）后**中继只见密文**——VPS 运营方、
  甚至拿到机器的人也看不到会话内容。密钥在分享链接的 `#k=` fragment 里，不经过中继。
  ⚠ E2EE 防「中继读流量」，**不防「链接本身被转发给第三者」——链接即能力**。
- 资源上限（0.5 CPU / 256MB）与 `no-new-privileges` 已在 compose 里内置；容器内非 root 运行。
