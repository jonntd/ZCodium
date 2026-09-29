#!/usr/bin/env bash
# Seeds the official ZCode plugin set into an open-source ZCode installation.
#
# ZCode discovers bundled plugins from the "packages" directory next to the
# application entrypoint (resources/glm/zcode.cjs). This script copies the
# plugin packages into that layout.
#
# Usage:
#   ./install.sh [path-to-ZCode.app-or-install-dir]
#   ./install.sh --repo /path/to/zcode-source-checkout
#
# Note: ZCodium builds carry the full Computer Use runtime (real @zcode/zcode-cua
# inlined at build time) and the signed "ZCode Computer Use" helper inside the
# app bundle — no post-install patching needed (docs/spec/cua-runtime-builtin.md).
# The legacy stub-patching installer flow was retired on 2026-09-29.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGINS_DIR="$SCRIPT_DIR/plugins"
CDN_BASE="https://cdn-zcode.z.ai/zcode/electron/releases"

seed_packages() {
  local target="$1"
  mkdir -p "$target"
  local count=0
  for dir in "$PLUGINS_DIR"/*/; do
    local name
    name="$(basename "$dir")"
    rm -rf "$target/$name"
    cp -R "$dir" "$target/$name"
    count=$((count + 1))
  done
  echo "Seeded $count plugins into $target"
}

if [[ "${1:-}" == "--repo" ]]; then
  [[ -n "${2:-}" ]] || { echo "usage: $0 --repo <zcode-source-dir>" >&2; exit 1; }
  seed_packages "$2/packages"
  echo ""
  echo "For the Computer Use helper runtime in a source checkout, set:"
  echo "  ZCODE_CUA_DEV_ROOT=$SCRIPT_DIR/runtimes/cua-helper"
  echo "  ZCODE_CUA_DEV_MODE=1"
  exit 0
fi

INSTALL="${1:-}"
CANDIDATES=(
  "$INSTALL"
  "/Applications/ZCode.app"
  "$HOME/Applications/ZCode.app"
  "/Applications/ZCode.app/Contents/Resources"
)

APP_ROOT=""
for c in "${CANDIDATES[@]}"; do
  [[ -n "$c" ]] || continue
  if [[ -f "$c/Contents/Resources/glm/zcode.cjs" ]]; then
    APP_ROOT="$c/Contents/Resources"
    break
  fi
  if [[ -f "$c/resources/glm/zcode.cjs" ]]; then
    APP_ROOT="$c/resources"
    break
  fi
  if [[ -f "$c/glm/zcode.cjs" ]]; then
    APP_ROOT="$c"
    break
  fi
done

if [[ -z "$APP_ROOT" ]]; then
  echo "Could not locate a ZCode installation." >&2
  echo "Usage: $0 <path-to-ZCode.app-or-install-dir>" >&2
  exit 1
fi

echo "ZCode resources: $APP_ROOT"

# ---------------------------------------------------------------------------
# macOS: the app bundle is write-protected once macOS registers a launched
# app bundle; probe writability and strip quarantine before seeding.
# ---------------------------------------------------------------------------

if [[ "$(uname -s)" == "Darwin" ]]; then
  APP_DIR="$(dirname "$(dirname "$APP_ROOT")")"

  # Once macOS registers a launched app bundle, writes into it require App
  # Management permission. Detect that state early with a real write probe
  # before any file copies.
  if ! ( touch "$APP_ROOT/.zcode-install-probe" 2>/dev/null ); then
    echo "ERROR: $APP_DIR is write-protected by macOS (App Management)." >&2
    echo "Delete the app and copy a fresh ZCode.app into place, or grant App" >&2
    echo "Management permission to this terminal, then re-run the installer." >&2
    exit 1
  fi
  rm -f "$APP_ROOT/.zcode-install-probe"

  # Adding files under Contents/ invalidates the code signature seal. For a
  # quarantined bundle Gatekeeper then reports the app as damaged — and also
  # blocks the ELECTRON_RUN_AS_NODE invocation below. Stripping quarantine up
  # front keeps the bundle runnable while it carries a broken seal (the
  # original signature is intentionally kept; see below).
  xattr -dr com.apple.quarantine "$APP_DIR" 2>/dev/null || true
fi

seed_packages "$APP_ROOT/glm/packages"

# Enable the Computer Use plugin for new sessions. Official builds keep it
# opt-in (the always-on builtin set does not include it), so a seeded install
# needs an explicit enable entry in the CLI config — merged, never replaced.
CLI_CONFIG="$HOME/.zcode/cli/config.json"
if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = {};
    const plugins = cfg.plugins && typeof cfg.plugins === "object" && !Array.isArray(cfg.plugins)
      ? cfg.plugins : (cfg.plugins = {});
    const enabled = plugins.enabledPlugins && typeof plugins.enabledPlugins === "object" && !Array.isArray(plugins.enabledPlugins)
      ? plugins.enabledPlugins : (plugins.enabledPlugins = {});
    enabled["computer-use@zcode-plugins-official"] = true;
    fs.mkdirSync(require("path").dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
  ' "$CLI_CONFIG" \
    && echo "Enabled computer-use@zcode-plugins-official in $CLI_CONFIG" \
    || echo "WARNING: could not enable the computer-use plugin in $CLI_CONFIG" >&2
else
  echo "NOTE: enable 'Computer Use' once in ZCode's plugin settings, or add" >&2
  echo "  \"plugins\": {\"enabledPlugins\": {\"computer-use@zcode-plugins-official\": true}}" >&2
  echo "  to $CLI_CONFIG" >&2
fi

echo ""
echo "Done. Fully quit and restart ZCode; the plugins will appear under the"
echo "built-in official marketplace (zcode-plugins-official)."
