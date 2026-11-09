#!/usr/bin/env bash
# 部署 ZCodium 扩展到本地 IDE 扩展目录（整体同步，杜绝"只拷 main.js 漏 chunk"的半部署）。
#
# 用法：pnpm --filter @zcode/zcode-vscode deploy[:ide]
#   - 校验 dist 产物存在且 webview 依赖闭包完整；
#   - rsync --delete 整体同步 dist（含 webview/）与 package.json 到目标扩展目录；
#   - 同步后复跑依赖闭包校验，任一 import 缺失即失败退出。
#
# 目标目录（按扩展 ID 动态解析，可用 ZCODE_DEPLOY_DIR 覆盖）：
#   ~/.antigravity-ide/extensions/<publisher>.<name>-<version>
#   ~/.vscode/extensions/<publisher>.<name>-<version>
# 同名多目录时跳过 .obsolete 标记的（IDE 已判定废弃，部署了也不会被加载）。

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
EXT_ID=$(node -p "const p = require('./package.json'); p.publisher + '.' + p.name")
SRC_DIST="$PWD/dist"

# .obsolete 里的废弃标记（IDE 判定不再加载的扩展目录）。
obsolete_entries() {
  [ -f "$1/.obsolete" ] && node -e "console.log(Object.keys(require('$1/.obsolete')).join('\n'))" 2>/dev/null || true
}

if [ ! -f "$SRC_DIST/extension.js" ] || [ ! -f "$SRC_DIST/webview/main.js" ]; then
  echo "[deploy] dist 产物缺失，请先构建：pnpm --filter @zcode/zcode-vscode build" >&2
  exit 1
fi

# 闭包校验：从 main.js 出发，BFS 所有相对 import 的 js，必须全部存在于 dist/webview。
# worker chunk（workers/*.js）不被 import（运行时经 Worker URL 引用），作为额外种子
# 纳入校验——worker 404 会让代码块高亮渲染永久挂起（WorkerPoolManager 无降级）。
check_closure() {
  node - "$1" <<'NODE'
const fs = require("fs"), path = require("path");
const root = process.argv[2];
const seen = new Set(), missing = [];
const queue = [
  "main.js",
  "workers/diffs.worker.js",
  "workers/workspaceFileSearchFilter.worker.js",
];
while (queue.length) {
  const f = queue.pop();
  if (seen.has(f)) continue;
  seen.add(f);
  const p = path.join(root, f);
  if (!fs.existsSync(p)) { missing.push(f); continue; }
  const src = fs.readFileSync(p, "utf8");
  const dir = path.posix.dirname(f);
  for (const dep of new Set(src.match(/(?:\.\/|\.\.\/)[A-Za-z0-9._-]+\.js/g) || [])) {
    const name = path.posix.normalize(path.posix.join(dir, dep));
    if (!seen.has(name)) queue.push(name);
  }
}
if (missing.length) {
  console.error(`[deploy] webview 依赖闭包不完整，缺 ${missing.length} 个：`, missing.slice(0, 10));
  process.exit(1);
}
console.log(`[deploy] webview 依赖闭包完整（${seen.size} 个文件，含 worker chunk）`);
NODE
}

check_closure "$SRC_DIST/webview"

if [ -n "${ZCODE_DEPLOY_DIR:-}" ]; then
  DEST="$ZCODE_DEPLOY_DIR"
else
  DEST=""
  for base in "$HOME/.antigravity-ide/extensions" "$HOME/.vscode/extensions"; do
    [ -d "$base" ] || continue
    obsolete=$(obsolete_entries "$base")
    # 按修改时间倒序遍历同 ID 扩展目录（扩展改名迁移时取最新注册面）。
    while IFS= read -r cand; do
      [ -d "$cand" ] || continue
      # 跳过被 .obsolete 标记的目录：部署进去 IDE 也不会加载，纯属无效功。
      rel=$(basename "$cand")
      if printf '%s\n' "$obsolete" | grep -qxF "$rel"; then
        echo "[deploy] 跳过已废弃标记目录：$cand"
        continue
      fi
      DEST="$cand"
      break
    done < <(ls -dt "$base/$EXT_ID-"* 2>/dev/null)
    [ -n "$DEST" ] && break
  done
  if [ -z "$DEST" ]; then
    echo "[deploy] 未找到目标扩展目录（$EXT_ID-$VERSION），可用 ZCODE_DEPLOY_DIR 指定" >&2
    exit 1
  fi
fi

echo "[deploy] 同步 $SRC_DIST -> $DEST"
mkdir -p "$DEST/dist"
rsync -a --delete "$SRC_DIST/" "$DEST/dist/"
rsync -a "$PWD/package.json" "$DEST/package.json"
# manifest 引用的静态资产：media/（活动栏图标等，缺了图标不渲染）、cli-bundle（CLI 本地产物）。
for asset in media cli-bundle; do
  [ -d "$PWD/$asset" ] && rsync -a --delete "$PWD/$asset/" "$DEST/$asset/"
done
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

# IDE 内核 agent 侧栏自动展开根断（幂等）：IDE 更新会覆盖内核 bundle，部署后重打。
#
# 失败**绝不能吞**（2026-11-08 审核修复）：旧版是 `... || true`，补丁在内核升级后必然
# 失配退出 1，而部署仍打印"完成"。结果是最关键的修复静默失效、"侧栏又自己弹出来"
# 无声复发，且没有任何告警——这正是最难排查的一类问题。
set +e
node scripts/disable-ide-agent-sidebar.mjs
patch_rc=$?
set -e
if [ "$patch_rc" -ne 0 ]; then
  cat >&2 <<'WARN'

╔══════════════════════════════════════════════════════════════════════════╗
║ ⚠  内核补丁未应用：IDE 自动展开 agent 侧栏的根断已失效                    ║
║                                                                          ║
║  扩展产物已同步完成，但内核 bundle 片段与脚本不匹配（多为 IDE 升级所致）。║
║  症状：对话页签获得焦点时 agent 侧栏重新自动弹出。                        ║
║                                                                          ║
║  下一步：                                                                 ║
║    node apps/zcode-vscode/scripts/disable-ide-agent-sidebar.mjs --status  ║
║  按输出更新脚本里的 ORIGINAL/PATCHED 片段后重跑部署。                     ║
╚══════════════════════════════════════════════════════════════════════════╝
WARN
  exit "$patch_rc"
fi
