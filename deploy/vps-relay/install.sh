#!/usr/bin/env bash
#
# ZCode VPS 中继 —— 一键部署 / 更新 / 卸载（Docker + 已发布 GHCR 镜像）。
#
# 用法：
#   bash install.sh                 # 首次部署（默认 VARIANT=no-tls，纯 IP / 无域名）
#   bash install.sh update          # 拉取新镜像并重启
#   bash install.sh remove          # 停止并删除容器（.env 保留，密钥不丢）
#   bash install.sh remove --purge  # 连 .env 一起删（彻底清除）
#
# 可用环境变量（都有默认值，一般不用设）：
#   ZCODE_RELAY_DIR=/opt/zcode-relay   安装目录（.env 与 compose 所在）
#   RELAY_VERSION=latest               镜像 tag；生产建议钉死版本号，
#                                      如 RELAY_VERSION=3.14.12（注意：不带 v 前缀）
#   VARIANT=no-tls|tls                 no-tls=端口直接对外（纯 IP）；tls=只绑回环、
#                                      由宿主机 Caddy/nginx 终结 TLS（需已有域名）
#   PORT=3180                          对外端口
#   DRY_RUN=1                          只生成 .env 与 compose 文件，不 pull 不启动
#
# 详细文档：deploy/vps-relay/DEPLOY-DOCKER.md
#
set -euo pipefail

IMAGE="ghcr.io/jonntd/zcode-relay"
INSTALL_DIR="${ZCODE_RELAY_DIR:-/opt/zcode-relay}"
RELAY_VERSION="${RELAY_VERSION:-latest}"
VARIANT="${VARIANT:-no-tls}"
PORT="${PORT:-3180}"
ACTION="${1:-install}"

log()  { printf '\033[1;32m[install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[install]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[install] ✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$VARIANT" = "no-tls" ] || [ "$VARIANT" = "tls" ] || die "VARIANT 只能是 no-tls 或 tls（当前：$VARIANT）"

# ---------- 0) root / sudo ----------
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "需要 root 权限（或安装 sudo）"
  SUDO="sudo"
fi

# ---------- 1) Docker 与 Compose 插件 ----------
ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    log "未检测到 Docker，用官方脚本安装…"
    curl -fsSL https://get.docker.com | $SUDO bash
    $SUDO systemctl enable --now docker
  fi
  docker info >/dev/null 2>&1 || die "Docker daemon 未运行：$SUDO systemctl start docker 后重试"
  docker compose version >/dev/null 2>&1 \
    || die "缺少 Compose v2 插件：$SUDO apt-get install -y docker-compose-plugin（或重跑 get.docker.com）"
  log "Docker $(docker --version | awk '{print $3}' | tr -d ,) / Compose $(docker compose version --short) 就绪"
}

# ---------- 2) .env（首次自动生成密钥）----------
ensure_env() {
  if [ -f "$INSTALL_DIR/.env" ]; then
    log ".env 已存在，沿用现有密钥（不覆盖）"
    return
  fi
  command -v openssl >/dev/null 2>&1 || die "缺 openssl（生成密钥用）"
  local token="${RELAY_TOKEN:-}" secret="${HOST_SECRET:-}"
  # 允许调用方直接传 RELAY_TOKEN / HOST_SECRET；否则现场生成
  [ -n "$token" ]  || token=$(openssl rand -base64 32)
  [ -n "$secret" ] || secret=$(openssl rand -base64 32)
  cat > "$INSTALL_DIR/.env" <<ENV
# 由 install.sh 生成于 $(date '+%F %T')。泄露任一密钥都等于交出桌面 Host 的完整服务面。
RELAY_TOKEN=$token
HOST_SECRET=$secret
ENV
  chmod 600 "$INSTALL_DIR/.env"
  log "已生成 .env（权限 600）：RELAY_TOKEN / HOST_SECRET 均为 openssl rand -base64 32"
}

# ---------- 3) compose 文件 ----------
write_compose() {
  local file="$INSTALL_DIR/docker-compose.yml"
  local bind_line="      - \"3180:3180\""
  if [ "$VARIANT" = "tls" ]; then
    # 只绑回环，公网流量必须经宿主机反代（Caddy / nginx）进来
    bind_line='      - "127.0.0.1:3180:3180"'
  fi
  # heredoc 不带引号：$bind_line 由脚本展开；compose 自己的变量写成 \${...} 原样保留。
  # （不用 sed -i 做变体替换 —— BSD 与 GNU 的 -i 语义不同，VPS/macOS 行为不一致。）
  cat > "$file" <<EOF
# ZCode VPS 中继 —— 由 install.sh 生成（VARIANT=${VARIANT}）。
services:
  relay:
    # 不写 tag 就是 :latest（每次发布都推，含预发布 ⇒ 可能指向 audit 产物）。
    # 生产建议钉死具体版本，避免意外跟着 latest 走。
    image: ghcr.io/jonntd/zcode-relay:\${RELAY_VERSION:-latest}
    restart: unless-stopped
    ports:
$bind_line
    environment:
      RELAY_TOKEN: \${RELAY_TOKEN:?RELAY_TOKEN 未设置，请检查 .env}
      HOST_SECRET: \${HOST_SECRET:?HOST_SECRET 未设置，请检查 .env}
      PORT: "3180"
      WEB_ROOT: /app/web
    security_opt:
      - no-new-privileges:true
    deploy:
      resources:
        limits:
          cpus: "0.50"
          memory: 256M
EOF
  if [ "$VARIANT" = "tls" ]; then
    log "VARIANT=tls：端口只绑 127.0.0.1，请在宿主机配 Caddy/nginx 反代并终结 TLS"
  else
    log "VARIANT=no-tls：端口直接对外 0.0.0.0:${PORT}（记得放行防火墙/安全组）"
  fi
}

# ---------- 动作 ----------
case "$ACTION" in
  install)
    # DRY_RUN 只生成 .env 与 compose 文件，不碰 Docker（可在没有 daemon 的机器上预览配置）
    if [ "${DRY_RUN:-0}" != "1" ]; then
      ensure_docker
    fi
    if [ "${DRY_RUN:-0}" = "1" ]; then
      mkdir -p "$INSTALL_DIR"
    else
      $SUDO mkdir -p "$INSTALL_DIR"
    fi
    [ -w "$INSTALL_DIR" ] || warn "目录不可写，后续步骤将以 $SUDO 执行"
    ensure_env
    write_compose
    if [ "${DRY_RUN:-0}" = "1" ]; then
      log "DRY_RUN=1：只生成了 $INSTALL_DIR/.env 与 docker-compose.yml，未启动"
      exit 0
    fi
    log "拉取镜像 $IMAGE:$RELAY_VERSION …"
    $SUDO sh -c "cd '$INSTALL_DIR' && RELAY_VERSION='$RELAY_VERSION' docker compose pull"
    log "启动容器…"
    $SUDO sh -c "cd '$INSTALL_DIR' && RELAY_VERSION='$RELAY_VERSION' docker compose up -d"
    ;;
  update)
    ensure_docker
    [ -f "$INSTALL_DIR/docker-compose.yml" ] || die "尚未部署：先跑 bash install.sh"
    $SUDO sh -c "cd '$INSTALL_DIR' && RELAY_VERSION='$RELAY_VERSION' docker compose pull"
    $SUDO sh -c "cd '$INSTALL_DIR' && RELAY_VERSION='$RELAY_VERSION' docker compose up -d"
    ;;
  remove)
    [ -f "$INSTALL_DIR/docker-compose.yml" ] || die "未发现部署物：$INSTALL_DIR/docker-compose.yml"
    $SUDO sh -c "cd '$INSTALL_DIR' && docker compose down"
    if [ "${2:-}" = "--purge" ]; then
      $SUDO sh -c "rm -f '$INSTALL_DIR/.env'"
      log "已删除 .env（密钥已清除）"
    else
      log "容器已停止删除；.env 保留（彻底清除请用：bash install.sh remove --purge）"
    fi
    log "镜像如需一并清理：docker rmi $IMAGE:$RELAY_VERSION"
    exit 0
    ;;
  *)
    die "未知动作：$ACTION（可用：install / update / remove）"
    ;;
esac

# ---------- 4) 健康检查 ----------
log "等待服务就绪…"
ok=""
for _ in $(seq 1 15); do
  body=$(curl -s --noproxy '*' --max-time 3 "http://127.0.0.1:$PORT/healthz" 2>/dev/null || true)
  if [ "$body" = '{"ok":true}' ]; then ok=1; break; fi
  sleep 2
done
[ -n "$ok" ] || die "健康检查未通过：$SUDO docker logs --tail 50 zcode-relay-relay-1 查看原因"
log "健康检查通过：http://127.0.0.1:$PORT/healthz → {\"ok\":true}"

# ---------- 5) 收尾提示 ----------
pub_ip="$(curl -s -4 --max-time 5 https://ifconfig.me 2>/dev/null || true)"
token=$(grep '^RELAY_TOKEN=' "$INSTALL_DIR/.env" | cut -d= -f2-)
enc_token=$(printf '%s' "$token" | sed 's|/|%2F|g; s|+|%2B|g; s|=|%3D|g')
{
  echo
  echo "──────────────────────────────────────────────────────────"
  echo "  部署完成"
  echo "  镜像   : $IMAGE:$RELAY_VERSION"
  echo "  目录   : $INSTALL_DIR"
  if [ "$VARIANT" = "tls" ]; then
    echo "  入口   : https://<你的域名>/?token=<RELAY_TOKEN>   （需自行配好反代 TLS）"
  else
    [ -n "$pub_ip" ] && echo "  手机链接: http://$pub_ip:$PORT/?token=$enc_token" \
                     || echo "  手机链接: http://<公网IP>:$PORT/?token=$enc_token"
  fi
  echo "  密钥   : $INSTALL_DIR/.env（RELAY_TOKEN=手机配对码 / HOST_SECRET=桌面密钥）"
  echo
  echo "  桌面侧接线（App「移动端远程控制 → 浏览器直连 → 高级设置」，或直接写"
  echo "  ~/.zcodium/v2/remote-relay.json）："
  if [ "$VARIANT" = "tls" ]; then
    echo '    连接协议 TLS wss:// ；中继地址 <你的域名>:443 ；公开地址留空'
  else
    echo "    连接协议 明文 ws:// ；中继地址 ${pub_ip:-<公网IP>}:$PORT ；公开地址留空"
  fi
  echo "    主机密钥 = .env 里的 HOST_SECRET ；配对码 = .env 里的 RELAY_TOKEN"
  echo
  echo "  更新：bash install.sh update （或 RELAY_VERSION=<新版本> bash install.sh update）"
  echo "  验证：curl -i \"http://${pub_ip:-<公网IP>}:$PORT/?token=$enc_token\"  → 期望 302"
  echo "──────────────────────────────────────────────────────────"
}
