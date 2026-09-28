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
# Note: the bundled Computer Use helper runtime in this repository targets
# Windows. On macOS only the plugin packages are seeded.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGINS_DIR="$SCRIPT_DIR/plugins"

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
seed_packages "$APP_ROOT/glm/packages"
echo ""
echo "Done. Fully quit and restart ZCode; the plugins will appear under the"
echo "built-in official marketplace (zcode-plugins-official)."
