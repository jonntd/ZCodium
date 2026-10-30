#!/bin/bash
# ZCodium dev CPU 看门狗
#
# 背景（2026-10-22 实锤）：dev 主进程事件循环可能被 JS 热循环烧死（定时器/日志全饿死、
# 进程活着吃满一核），叠加多次重启 dev 残留的孤儿 tsup/vite watcher，整机卡死只能重启。
# 本看门狗常驻后：dev 相关进程持续高 CPU ⇒ 先 sample 留下热循环栈（事后定罪的证据），
# 再发 macOS 通知，最后（默认开启）kill -9 元凶——保住整机，不用重启。
#
# 用法：
#   scripts/dev-cpu-watchdog.sh             # 单次检查（由 launchd 每 30s 调用一次）
#   scripts/dev-cpu-watchdog.sh install     # 安装 launchd 用户代理（登录后常驻）
#   scripts/dev-cpu-watchdog.sh uninstall   # 卸载
#   CPU_FIRE_KILL=0 scripts/dev-cpu-watchdog.sh install   # 安装为「只留证不杀」模式
#
# 证据与日志：
#   ~/.zcodium/logs/cpu-watchdog.log        全部判断过程
#   ~/.zcodium/logs/cpu-fire-<时间>-<pid>.txt   热循环调用栈（sample 3s）
#
# 判定规则：
#   - CPU 第一名 ≥ THRESHOLD% 且命令行命中 ZCodium dev 特征 ⇒ 计数；
#     同一 pid 连续 SUSTAIN 次（≈1 分钟）命中才动手（瞬时编译峰值不误杀）。
#   - 非 dev 进程高 CPU 只记一行日志（限流），不动手。

set -u
LOG="$HOME/.zcodium/logs/cpu-watchdog.log"
FIRE_DIR="$HOME/.zcodium/logs"
STATE="/tmp/zcodium-cpu-watchdog.state"
THRESHOLD=80
SUSTAIN=2
# PS_BIN 可注入（测试用假 ps）；默认系统 ps
PS_BIN="${PS_BIN:-/bin/ps}"
SAMPLE_BIN="${SAMPLE_BIN:-/usr/bin/sample}"

mkdir -p "$FIRE_DIR"
log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

notify() {
  # 通知失败静默（整机高负载时 osascript 可能很慢，放后台）
  ( /usr/bin/osascript -e "display notification \"$2\" with title \"ZCodium dev 看门狗\" subtitle \"$1\"" ) >/dev/null 2>&1 &
}

is_dev_process() {
  # $1 = 完整命令行；只对 ZCodium dev 链动手，绝不碰系统/其它应用进程
  case "$1" in
    *ZCodium*|*zcode-runtime*|*dev-desktop*|*"ZCode Dev"*) return 0 ;;
    */ZCodium/*|*tsup*|*build-desktop-agent-cli*) return 0 ;;
    *) return 1 ;;
  esac
}

fire() {
  local pid="$1" comm="$2" pcpu="$3"
  local ts out
  ts=$(date '+%Y%m%d-%H%M%S')
  out="$FIRE_DIR/cpu-fire-$ts-$pid.txt"
  # 1) 留证：3 秒采样，热循环栈就在里面（判忙闲看叶子系统调用，JIT 符号名不可信）
  "$SAMPLE_BIN" "$pid" 3 -mayDie -file "$out" >/dev/null 2>&1 \
    || log "sample 失败（进程可能已退出）pid=$pid"
  log "🔥 命中：pid=$pid cpu=${pcpu}% comm=$comm 证据=$out"
  notify "pid $pid (${pcpu}%)" "持续高 CPU，已留证$( [ "${CPU_FIRE_KILL:-1}" = "1" ] && echo "，即将终止进程" )"
  if [ "${CPU_FIRE_KILL:-1}" = "1" ]; then
    if kill -9 "$pid" 2>/dev/null; then
      log "已 kill -9 pid=$pid"
    else
      log "kill -9 pid=$pid 失败（权限或已退出）"
    fi
  fi
  rm -f "$STATE"
}

check() {
  # CPU 第一名（ps -r 按 CPU 降序；空输出 = ps 不可用，静默退出）
  local line pcpu pid comm
  line=$("$PS_BIN" -Ao pcpu=,pid=,command= -r 2>/dev/null | /usr/bin/awk 'NR==1{pcpu=$1; pid=$2; $1=""; $2=""; sub(/^ +/,""); print pcpu"\t"pid"\t"$0}')
  [ -z "$line" ] && exit 0
  pcpu=${line%%$'\t'*}
  local rest=${line#*$'\t'}
  pid=${rest%%$'\t'*}
  comm=${rest#*$'\t'}
  # 自己不入榜处理：awk 拼接后 comm 为空则退出
  [ -z "$pid" ] || [ -z "$comm" ] && exit 0
  # 浮点比较（macOS 无 bc 时用 awk）
  if ! /usr/bin/awk -v v="$pcpu" -v t="$THRESHOLD" 'BEGIN{exit !(v>=t)}'; then
    rm -f "$STATE"; exit 0
  fi
  # 非 dev 高 CPU：只留痕，限流（同 pid 10 分钟内只记一次）
  if ! is_dev_process "$comm"; then
    local last
    last=$(cat "$STATE.nondev" 2>/dev/null || true)
    if [ "$last" != "$pid" ]; then
      log "观察：非 dev 进程高 CPU pid=$pid cpu=${pcpu}% comm=${comm:0:120}（不动手）"
      echo "$pid" > "$STATE.nondev"
    fi
    exit 0
  fi
  # dev 进程：连续计数
  local prev prev_pid count
  read -r prev_pid count <<< "$(cat "$STATE" 2>/dev/null || echo "0 0")"
  if [ "$prev_pid" = "$pid" ]; then
    count=$((count + 1))
  else
    prev_pid=$pid; count=1
  fi
  echo "$prev_pid $count" > "$STATE"
  log "计数 pid=$pid cpu=${pcpu}% comm=${comm:0:120} ($count/$SUSTAIN)"
  if [ "$count" -ge "$SUSTAIN" ]; then
    fire "$pid" "$comm" "$pcpu"
  fi
  exit 0
}

PLIST_LABEL="dev.zcodium.cpu-watchdog"
PLIST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

do_install() {
  local kill_env="${CPU_FIRE_KILL:-1}"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$PLIST_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$PWD/scripts/dev-cpu-watchdog.sh</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>CPU_FIRE_KILL</key><string>$kill_env</string>
  </dict>
  <key>StartInterval</key><integer>30</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardErrorPath</key><string>$HOME/.zcodium/logs/cpu-watchdog.launchd.err</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null
  if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
    :
  else
    launchctl load "$PLIST"   # 老系统回退
  fi
  echo "✅ 已安装并启动：$PLIST"
  echo "   模式：$([ "$kill_env" = "1" ] && echo "留证 + 自动 kill" || echo "只留证不杀")"
  echo "   日志：$LOG"
}

do_uninstall() {
  launchctl bootout "gui/$(id -u)/$PLIST_LABEL" 2>/dev/null
  launchctl unload "$PLIST" 2>/dev/null
  rm -f "$PLIST"
  echo "✅ 已卸载 $PLIST_LABEL"
}

case "${1:-check}" in
  check)     check ;;
  install)   do_install ;;
  uninstall) do_uninstall ;;
  *) echo "用法: $0 [check|install|uninstall]"; exit 1 ;;
esac
