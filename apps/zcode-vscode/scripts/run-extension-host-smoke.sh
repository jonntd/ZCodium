#!/usr/bin/env bash
# 一键「真机」验收：起一个隔离的 Antigravity/VS Code 实例，用 --extensionTestsPath
# 加载部署产物并跑 scripts/extension-host-smoke.cjs。
#
# 用法：pnpm --filter @zcode/zcode-vscode test:host
# 可选环境变量：
#   ZCODE_IDE_APP      IDE .app 路径（默认 /Applications/Antigravity IDE.app）
#   ZCODE_DEPLOY_DIR   要验收的部署目录（默认 ~/.antigravity-ide/extensions/gode.gode-0.2.0）
#
# 说明：WorkBuddy/终端环境常带 ELECTRON_RUN_AS_NODE=1 与 NODE_OPTIONS shim，会让
# Electron 以 Node 模式启动并拒绝所有 IDE 参数；必须显式清除。桌面环境无 Chromium
# 沙箱权限时加 --no-sandbox。测试跑完 IDE 自动退出，不影响用户当前窗口。

set -euo pipefail
cd "$(dirname "$0")/.."

IDE_APP="${ZCODE_IDE_APP:-/Applications/Antigravity IDE.app}"
ELECTRON="$IDE_APP/Contents/MacOS/Electron"
DEPLOY="${ZCODE_DEPLOY_DIR:-$HOME/.antigravity-ide/extensions/gode.gode-0.2.0}"
TESTS="$PWD/scripts/extension-host-smoke.cjs"

[ -x "$ELECTRON" ] || { echo "[host-smoke] 找不到 IDE: $IDE_APP" >&2; exit 1; }
[ -f "$DEPLOY/package.json" ] && [ -f "$DEPLOY/dist/extension.js" ] || {
  echo "[host-smoke] 部署产物缺失：$DEPLOY（先 pnpm build && ./scripts/deploy.sh）" >&2
  exit 1
}

TMP="$(mktemp -d /tmp/zc-ext-host-smoke.XXXXXX)"
trap 'rm -r "$TMP" 2>/dev/null || true' EXIT
mkdir -p "$TMP/ws" "$TMP/ud" "$TMP/ext"

echo "[host-smoke] 验收部署产物：$DEPLOY"
set +e
OUTPUT="$(env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS ZCODE_DATA_ROOT="$TMP/data" "$ELECTRON" \
  --no-sandbox --disable-gpu \
  --user-data-dir="$TMP/ud" \
  --extensions-dir="$TMP/ext" \
  --extensionDevelopmentPath="$DEPLOY" \
  --extensionTestsPath="$TESTS" \
  --disable-workspace-trust --skip-welcome --skip-release-notes \
  --new-window "$TMP/ws" 2>&1)"
STATUS=$?
set -e

echo "$OUTPUT" | grep -F "[ext-host-smoke]" || true
if [ "$STATUS" -ne 0 ] || ! echo "$OUTPUT" | grep -qF "[ext-host-smoke] PASS"; then
  echo "[host-smoke] FAIL（exit=${STATUS}）；尾部输出：" >&2
  echo "$OUTPUT" | tail -25 >&2
  exit 1
fi
echo "[host-smoke] PASS — 真实扩展宿主验收通过"
