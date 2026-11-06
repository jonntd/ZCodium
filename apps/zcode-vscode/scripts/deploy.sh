#!/usr/bin/env bash
# 部署 ZCodium 扩展到本地 IDE 扩展目录（整体同步，杜绝"只拷 main.js 漏 chunk"的半部署）。
#
# 用法：pnpm --filter @zcode/zcode-vscode deploy[:ide]
#   - 校验 dist 产物存在且 webview 依赖闭包完整；
#   - rsync --delete 整体同步 dist（含 webview/）与 package.json 到目标扩展目录；
#   - 同步后复跑依赖闭包校验，任一 import 缺失即失败退出。
#
# 目标目录（按存在性自动选择，可用 ZCODE_DEPLOY_DIR 覆盖）：
#   ~/.antigravity-ide/extensions/zcodium.zcode-vscode-<version>
#   ~/.vscode/extensions/zcodium.zcode-vscode-<version>

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
SRC_DIST="$PWD/dist"

if [ ! -f "$SRC_DIST/extension.js" ] || [ ! -f "$SRC_DIST/webview/main.js" ]; then
  echo "[deploy] dist 产物缺失，请先构建：pnpm --filter @zcode/zcode-vscode build" >&2
  exit 1
fi

# 闭包校验：从 main.js 出发，BFS 所有相对 import 的 js，必须全部存在于 dist/webview。
check_closure() {
  node - "$1" <<'NODE'
const fs = require("fs"), path = require("path");
const root = process.argv[2];
const seen = new Set(), queue = ["main.js"], missing = [];
while (queue.length) {
  const f = queue.pop();
  if (seen.has(f)) continue;
  seen.add(f);
  const p = path.join(root, f);
  if (!fs.existsSync(p)) { missing.push(f); continue; }
  const src = fs.readFileSync(p, "utf8");
  for (const dep of new Set(src.match(/\.\/[A-Za-z0-9._-]+\.js/g) || [])) {
    const name = dep.slice(2);
    if (!seen.has(name)) queue.push(name);
  }
}
if (missing.length) {
  console.error(`[deploy] webview 依赖闭包不完整，缺 ${missing.length} 个：`, missing.slice(0, 10));
  process.exit(1);
}
console.log(`[deploy] webview 依赖闭包完整（${seen.size} 个文件）`);
NODE
}

check_closure "$SRC_DIST/webview"

if [ -n "${ZCODE_DEPLOY_DIR:-}" ]; then
  DEST="$ZCODE_DEPLOY_DIR"
else
  DEST=""
  for base in "$HOME/.antigravity-ide/extensions" "$HOME/.vscode/extensions"; do
    if [ -d "$base" ]; then
      cand="$base/zcodium.zcode-vscode-$VERSION"
      [ -d "$cand" ] && DEST="$cand" && break
    fi
  done
  if [ -z "$DEST" ]; then
    echo "[deploy] 未找到目标扩展目录（zcodium.zcode-vscode-$VERSION），可用 ZCODE_DEPLOY_DIR 指定" >&2
    exit 1
  fi
fi

echo "[deploy] 同步 $SRC_DIST -> $DEST"
mkdir -p "$DEST/dist"
rsync -a --delete "$SRC_DIST/" "$DEST/dist/"
rsync -a "$PWD/package.json" "$DEST/package.json"
# .vsixmanifest 存在时同步（IDE 版本识别用）。
[ -f "$PWD/.vsixmanifest" ] && rsync -a "$PWD/.vsixmanifest" "$DEST/.vsixmanifest" || true

# 复跑闭包校验（部署面）。
check_closure "$DEST/dist/webview"

# 关键产物哈希一致性。
for f in dist/extension.js dist/webview/main.js package.json; do
  a=$(md5 -q "$PWD/$f" 2>/dev/null || true)
  b=$(md5 -q "$DEST/$f" 2>/dev/null || true)
  if [ "$a" != "$b" ]; then
    echo "[deploy] 哈希不一致：$f" >&2
    exit 1
  fi
done
echo "[deploy] 完成：$DEST"
echo "[deploy] 提示：如 IDE 正在运行，请 Reload Window（或重启 IDE）加载新产物。"
