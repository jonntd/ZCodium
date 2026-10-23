#!/usr/bin/env bash
#
# 在本机跑中继，供「局域网直连」与「经 VPS 转发的外网访问」共用同一个中继。
#
# 两种用法：
#   bash deploy/vps-relay/run-local.sh            # 只跑中继（前台，Ctrl-C 停止）
#   bash deploy/vps-relay/run-local.sh --tunnel   # 中继 + 到 VPS 的反向隧道（推荐）
#
# --tunnel 会：
#   1. 后台启动中继（日志见输出里的路径）
#   2. 在本机与 VPS 之间建一条 SSH 反向隧道：VPS:<TUNNEL_PORT> → 本机 <PORT>
#      断开自动重连；退出脚本时一并收掉中继
#   3. 打印要填进「高级设置 → 公开地址」的外网地址
#
# v6 key-room（spec vps-relay-bridge.md §19）：中继不再需要任何密钥环境变量，
# 房间按密钥按需创建；唯一的密钥（roomKey）在桌面配置里自动生成。
#
# 可覆盖的环境变量：CONFIG、PORT、WEB_ROOT、NODE、VPS_HOST、TUNNEL_PORT
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
config="${CONFIG:-$HOME/.zcodium/v2/remote-relay.json}"
node_bin="${NODE:-node}"
vps_host="${VPS_HOST:-vps}"
tunnel_port="${TUNNEL_PORT:-3181}"

tunnel_enabled=0
for arg in "$@"; do
  case "$arg" in
    --tunnel) tunnel_enabled=1 ;;
    -h | --help)
      sed -n '3,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$arg（可用：--tunnel）" >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$config" ]]; then
  echo "找不到桌面中继配置：$config" >&2
  echo "先在 App 的「移动端远程控制 → 浏览器直连 → 高级设置」里填一次中继地址并保存。" >&2
  exit 1
fi

# 端口沿用配置里 url 的端口（缺省 3180），这样桌面侧不用改就能连上。
# 用 node 读 JSON：与仓库其余部分同一运行时，不引入 python 依赖。
read_url() {
  "$node_bin" -e '
    const fs = require("node:fs");
    const config = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(config.url ?? ""));
  ' "$config"
}

relay_url="$(read_url)"
port="${PORT:-$(printf '%s' "$relay_url" | sed -n 's/.*:\([0-9][0-9]*\)$/\1/p')}"
port="${port:-3180}"

web_root="${WEB_ROOT:-packages/web/dist}"
cd "$repo_root"

if [[ "$tunnel_enabled" != "1" ]]; then
  echo "本机中继启动中（Ctrl-C 停止）："
  echo "  端口      : $port"
  echo "  web bundle: $repo_root/$web_root"
  echo
  echo "手机（同一 WiFi）打开： 桌面「移动端远程控制」弹层里的内网链接"
  echo "外网访问需另配端口映射或隧道（或改用 --tunnel），再把地址填进「高级设置 → 公开地址」。"
  echo
  WEB_ROOT="$web_root" PORT="$port" \
    exec "$node_bin" deploy/vps-relay/relay.mjs
fi

relay_log="${TMPDIR:-/tmp}/zcode-relay-local.log"

WEB_ROOT="$web_root" PORT="$port" \
  "$node_bin" deploy/vps-relay/relay.mjs >"$relay_log" 2>&1 &
relay_pid=$!
# 脚本退出（含 Ctrl-C）时收掉后台中继，避免留下孤儿进程占着端口。
trap 'kill "$relay_pid" 2>/dev/null || true' EXIT INT TERM

sleep 1
if ! kill -0 "$relay_pid" 2>/dev/null; then
  echo "中继启动失败，日志：" >&2
  cat "$relay_log" >&2
  exit 1
fi

echo "本机中继已后台启动（pid $relay_pid，日志 $relay_log）"
echo "反向隧道：$vps_host:$tunnel_port → 本机 127.0.0.1:$port（断线自动重连）"
echo
echo "手机（同一 WiFi）：打开桌面弹层里的「内网」链接"
echo "手机（外网）    ：把 http://<VPS 公网IP>:$tunnel_port 填进「高级设置 → 公开地址」，"
echo "  然后打开弹层里的「外网」链接（含二维码）。"
echo
echo "按 Ctrl-C 停止（会同时收掉中继）。"
echo

while :; do
  ssh -N \
    -o ServerAliveInterval=30 \
    -o ServerAliveCountMax=3 \
    -o ExitOnForwardFailure=yes \
    -R "0.0.0.0:${tunnel_port}:127.0.0.1:${port}" \
    "$vps_host" || true
  echo "隧道断开，5 秒后重连…（Ctrl-C 退出）"
  sleep 5
done
