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
# macOS: the script additionally enables the Computer Use runtime — it stages
# runtimes/zcode-cua into the app, patches packaged stub modules, and installs
# the signed "ZCode Computer Use" helper app into the app's
# Contents/Resources/cua-helper directory (fetched from the official release
# CDN matching the installed app version and CPU architecture when the app
# does not already bundle it).

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
# macOS: enable the packaged Computer Use runtime
# ---------------------------------------------------------------------------

if [[ "$(uname -s)" == "Darwin" ]]; then
  CONTENTS="$(dirname "$APP_ROOT")"
  APP_DIR="$(dirname "$CONTENTS")"

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

  APP_VERSION="$(defaults read "$CONTENTS/Info" CFBundleShortVersionString 2>/dev/null || true)"
  MAC_ARCH="$(uname -m)"
  case "$MAC_ARCH" in
    arm64)  ZIP_ARCH="arm64" ;;
    x86_64) ZIP_ARCH="x64" ;;
    *) echo "WARNING: unsupported macOS arch $MAC_ARCH" >&2; ZIP_ARCH="" ;;
  esac
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

if [[ "$(uname -s)" == "Darwin" ]]; then
  # 1. stage the CUA runtime next to app.asar
  mkdir -p "$APP_ROOT/tools"
  rm -rf "$APP_ROOT/tools/zcode-cua"
  cp -R "$SCRIPT_DIR/runtimes/zcode-cua" "$APP_ROOT/tools/zcode-cua"
  echo "Staged Computer Use runtime into $APP_ROOT/tools/zcode-cua"

  # 2. install the signed helper app into the app's bundled-helper location
  HELPER_DIR="$APP_ROOT/cua-helper"
  HELPER_APP="$HELPER_DIR/ZCode Computer Use.app"
  if [[ -d "$HELPER_APP" ]]; then
    echo "Computer Use helper already bundled at $HELPER_APP"
  elif [[ -n "$APP_VERSION" && -n "$ZIP_ARCH" ]]; then
    ZIP_URL="$CDN_BASE/$APP_VERSION/macos-$ZIP_ARCH/ZCode-$APP_VERSION-mac-$ZIP_ARCH.zip"
    TMP_D="$(mktemp -d)"
    echo "Fetching Computer Use helper ($APP_VERSION, $ZIP_ARCH)..."
    if curl -fSL --retry 2 -o "$TMP_D/zcode-mac.zip" "$ZIP_URL"; then
      unzip -q "$TMP_D/zcode-mac.zip" 'ZCode.app/Contents/Resources/cua-helper/*' -d "$TMP_D/x"
      mkdir -p "$HELPER_DIR"
      rm -rf "$HELPER_APP"
      ditto "$TMP_D/x/ZCode.app/Contents/Resources/cua-helper/ZCode Computer Use.app" "$HELPER_APP"
      xattr -dr com.apple.quarantine "$HELPER_APP" 2>/dev/null || true
      if codesign --verify --deep --strict "$HELPER_APP" 2>/dev/null; then
        echo "Helper signature verified."
      else
        echo "WARNING: helper signature verification failed; launch may be blocked by Gatekeeper." >&2
      fi
      echo "Installed helper: $HELPER_APP"
    else
      echo "WARNING: could not download $ZIP_URL" >&2
      echo "Install the helper manually into $HELPER_DIR (see README)." >&2
    fi
    rm -rf "$TMP_D"
  fi

  # 2b. Patch the helper's embedded local-development trust flag, then re-sign
  # it adhoc. The stock helper verifies that (a) the process that launched it
  # and (b) every broker client + its parent chain satisfy an Apple-anchored
  # ZCode signing requirement — which a seeded install can never satisfy
  # because seeding breaks the app's resource seal and thus invalidates the
  # code signature of every process exec'd from it. The helper ships the
  # escape hatches (--allow-unsigned-launcher-local-dev, same-uid broker
  # clients) but compiles their gate `allowUnsignedLauncherLocalDev` to false
  # in release builds. We flip that embedded literal in place — the SEA blob
  # is plain JS — then re-sign adhoc since the byte edit voids the signature.
  # TCC permissions (Accessibility / Screen Recording) will prompt once more
  # under the adhoc identity.
  patch_helper_local_dev() {
    local app="$1"
    local bin="$app/Contents/MacOS/ZCode Computer Use"
    [[ -f "$bin" ]] || return 1
    python3 - "$bin" <<'PY'
import sys
path = sys.argv[1]
data = open(path, "rb").read()
old = b"var allowUnsignedLauncherLocalDev = false;"
new = b"var allowUnsignedLauncherLocalDev = true ;"
idx = data.find(old)
if idx < 0:
    if b"var allowUnsignedLauncherLocalDev = true ;" in data:
        print("helper already patched"); sys.exit(0)
    print("helper patch pattern not found", file=sys.stderr); sys.exit(1)
data = data[:idx] + new + data[idx + len(old):]
open(path, "wb").write(data)
print("patched helper local-dev flag")
PY
  }

  if [[ -d "$HELPER_APP" ]]; then
    if patch_helper_local_dev "$HELPER_APP"; then
      codesign --force --deep --sign - "$HELPER_APP" >/dev/null 2>&1 \
        && echo "Re-signed helper adhoc (TCC will prompt once under the new identity)." \
        || echo "WARNING: helper adhoc re-sign failed." >&2
      # Seed the install roots the runtime resolves for the dev/stable
      # variants so ensureStandaloneHelperLaunched finds the patched helper.
      CU_ROOT="$HOME/.zcode/computer-use"
      mkdir -p "$CU_ROOT/dev"
      rm -rf "$CU_ROOT/dev/ZCode Computer Use Dev.app"
      ditto "$HELPER_APP" "$CU_ROOT/dev/ZCode Computer Use Dev.app"
      rm -rf "$CU_ROOT/dev/ZCode Computer Use.app"
      ditto "$HELPER_APP" "$CU_ROOT/dev/ZCode Computer Use.app"
      rm -rf "$CU_ROOT/ZCode Computer Use.app"
      ditto "$HELPER_APP" "$CU_ROOT/ZCode Computer Use.app"
      echo "Seeded patched helper into $CU_ROOT"
    else
      echo "WARNING: could not patch $HELPER_APP for local-dev trust." >&2
      echo "Computer Use helper will refuse the unsigned launcher; see README." >&2
    fi
  else
    echo "WARNING: helper app missing at $HELPER_APP" >&2
  fi

  # 3. patch the packaged app (stub modules + node-repl-host bridge)
  # A plain node install avoids the app binary entirely; the Electron binary
  # is the fallback for machines without node.
  ZCODE_BIN="$(find "$CONTENTS/MacOS" -maxdepth 1 -type f -perm +111 2>/dev/null | head -1)"
  if command -v node >/dev/null 2>&1; then
    node "$SCRIPT_DIR/tools/patch-cua-runtime.cjs" --install-dir "$CONTENTS" \
      || echo "WARNING: runtime patch reported an issue (see above)." >&2
  elif [[ -n "$ZCODE_BIN" ]]; then
    ELECTRON_RUN_AS_NODE=1 "$ZCODE_BIN" "$SCRIPT_DIR/tools/patch-cua-runtime.cjs" --install-dir "$CONTENTS" \
      || echo "WARNING: runtime patch reported an issue (see above)." >&2
  else
    echo "WARNING: ZCode binary not found under $CONTENTS/MacOS; run this manually:" >&2
    echo "  ELECTRON_RUN_AS_NODE=1 \"$CONTENTS/MacOS/ZCode\" \"$SCRIPT_DIR/tools/patch-cua-runtime.cjs\" --install-dir \"$CONTENTS\"" >&2
  fi

  # 4. Do NOT re-sign the bundle. Writing under Contents/ invalidates the
  # resource seal — `codesign --verify` reports a mismatch — but the original
  # signature is left intact and, with quarantine stripped above,
  # LaunchServices opens the bundle normally. Re-signing (adhoc or self-signed)
  # only makes things worse: Gatekeeper flags the managed app as damaged.
  # The helper's launcher/peer signature checks are instead relaxed by
  # patching the helper itself (step 2b).
  if ! codesign --verify "$APP_DIR" >/dev/null 2>&1; then
    echo "NOTE: app resource seal no longer matches (expected after seeding);"
    echo "the original code signature is intentionally kept."
  fi

  # 5. local-dev environment for the unsigned-helper trust path (GUI apps
  #    read env from launchd, not from the shell profile):
  #    - ZCODE_CUA_DEV_MODE: runtime resolves the dev install variant
  #    - ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL: installer accepts the adhoc helper
  #    - ZCODE_CUA_HELPER_BUNDLE_ID: expected bundle id stays the stock id
  #    - ZCODE_CUA_PACKAGE_ENTRY: node-repl bridge resolves the staged runtime
  #      directly (the path is baked in since it must be absolute)
  CUA_ENTRY="$APP_ROOT/tools/zcode-cua/index.js"
  launchctl setenv ZCODE_CUA_DEV_MODE 1 2>/dev/null || true
  launchctl setenv ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL 1 2>/dev/null || true
  launchctl setenv ZCODE_CUA_HELPER_BUNDLE_ID "dev.zcode.cua-helper" 2>/dev/null || true
  launchctl setenv ZCODE_CUA_PACKAGE_ENTRY "$CUA_ENTRY" 2>/dev/null || true
  AGENT_PLIST="$HOME/Library/LaunchAgents/com.zcode.cua-env.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$AGENT_PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.zcode.cua-env</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string><string>-c</string>
    <string>launchctl setenv ZCODE_CUA_DEV_MODE 1; launchctl setenv ZCODE_CUA_HELPER_ALLOW_UNSIGNED_LOCAL 1; launchctl setenv ZCODE_CUA_HELPER_BUNDLE_ID dev.zcode.cua-helper; launchctl setenv ZCODE_CUA_PACKAGE_ENTRY '$CUA_ENTRY'</string>
  </array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
  launchctl load "$AGENT_PLIST" 2>/dev/null || true
  echo "Installed LaunchAgent to persist the Computer Use env across logins."

  # The bridge also searches <plugin-cache>/tools/zcode-cua — provide a
  # durable symlink there as a fallback for caches that predate the env.
  mkdir -p "$HOME/.zcode/cli/plugins/cache/tools"
  ln -sfn "$APP_ROOT/tools/zcode-cua" "$HOME/.zcode/cli/plugins/cache/tools/zcode-cua" 2>/dev/null || true

  echo ""
  echo "macOS notes:"
  echo "  - Fully quit and restart ZCode (or log out/in once for the env to apply)."
  echo "  - On first Computer Use run, macOS asks for Accessibility and Screen"
  echo "    Recording permission for 'ZCode Computer Use' — approve in System"
  echo "    Settings > Privacy & Security."
  echo "  - The app keeps its original signature (resource seal mismatched by"
  echo "    design); the helper is patched + adhoc-signed for local-dev trust,"
  echo "    so TCC will ask for Accessibility/Screen Recording once under the"
  echo "    new helper identity."
  echo "  - ZCode updates replace the whole app bundle; re-run this installer"
  echo "    after each update."
fi

echo ""
echo "Done. Fully quit and restart ZCode; the plugins will appear under the"
echo "built-in official marketplace (zcode-plugins-official)."
