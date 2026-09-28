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
  # front keeps the bundle runnable while it carries a broken seal; the
  # bundle is re-signed afterwards.
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

  # 4. the resource seal is invalid now; re-sign the outer bundle so the
  # signature is valid again. An ad-hoc (-) signature makes Gatekeeper report
  # the managed app as damaged, so a real signing identity is required — a
  # Developer ID certificate if one exists, otherwise a local self-signed
  # code-signing certificate created in the login keychain. Nested components
  # (helpers, frameworks, the Computer Use helper app) keep their original
  # signatures.
  if ! codesign --verify "$APP_DIR" >/dev/null 2>&1; then
    SIGN_ID="$(security find-identity -v -p codesigning 2>/dev/null \
      | sed -n 's/.*"\(Developer ID Application[^"]*\)".*/\1/p' | head -1)"
    if [[ -z "$SIGN_ID" ]]; then
      SIGN_ID="ZCode Local Code Signing"
      if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "$SIGN_ID"; then
        CERT_D="$(mktemp -d)"
        CERT_PW="zcode-local-sign"
        if openssl req -x509 -newkey rsa:2048 -keyout "$CERT_D/key.pem" \
            -out "$CERT_D/cert.pem" -days 3650 -nodes \
            -subj "/CN=$SIGN_ID" \
            -addext "keyUsage=critical,digitalSignature" \
            -addext "extendedKeyUsage=critical,codeSigning" \
            -addext "basicConstraints=critical,CA:FALSE" 2>/dev/null \
          && openssl pkcs12 -export -legacy -out "$CERT_D/id.p12" \
            -inkey "$CERT_D/key.pem" -in "$CERT_D/cert.pem" \
            -passout "pass:$CERT_PW" 2>/dev/null \
          && security import "$CERT_D/id.p12" -P "$CERT_PW" \
            -T /usr/bin/codesign >/dev/null 2>&1; then
          security add-trusted-cert -r trustRoot -p codeSign \
            -k "$HOME/Library/Keychains/login.keychain-db" \
            "$CERT_D/cert.pem" >/dev/null 2>&1 || true
          echo "Created a local code-signing identity for the modified bundle."
        fi
        rm -rf "$CERT_D"
      fi
      security find-identity -v -p codesigning 2>/dev/null | grep -q "$SIGN_ID" \
        || SIGN_ID=""
    fi

    if [[ -n "$SIGN_ID" ]]; then
      if codesign --force --sign "$SIGN_ID" "$APP_DIR" >/dev/null 2>&1; then
        echo "Re-signed the app bundle ($SIGN_ID)."
      else
        echo "WARNING: re-sign with '$SIGN_ID' failed." >&2
      fi
    else
      echo "WARNING: no usable code-signing identity; trying ad-hoc signature." >&2
      echo "Gatekeeper may still report the app as damaged — if so, create a" >&2
      echo "code-signing certificate in Keychain Access and re-sign manually." >&2
      codesign --force --sign - "$APP_DIR" >/dev/null 2>&1 || true
    fi
  fi

  # 4. dev-mode environment for unsigned open-source builds (GUI apps read env
  #    from launchd, not from the shell profile)
  launchctl setenv ZCODE_CUA_DEV_MODE 1 2>/dev/null || true
  AGENT_PLIST="$HOME/Library/LaunchAgents/com.zcode.cua-env.plist"
  if [[ ! -f "$AGENT_PLIST" ]]; then
    mkdir -p "$HOME/Library/LaunchAgents"
    cat > "$AGENT_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.zcode.cua-env</string>
  <key>ProgramArguments</key>
  <array><string>/bin/launchctl</string><string>setenv</string><string>ZCODE_CUA_DEV_MODE</string><string>1</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
    launchctl load "$AGENT_PLIST" 2>/dev/null || true
    echo "Installed LaunchAgent to persist ZCODE_CUA_DEV_MODE across logins."
  fi

  echo ""
  echo "macOS notes:"
  echo "  - Fully quit and restart ZCode (or log out/in once for the env to apply)."
  echo "  - On first Computer Use run, macOS asks for Accessibility and Screen"
  echo "    Recording permission for 'ZCode Computer Use' — approve in System"
  echo "    Settings > Privacy & Security."
  echo "  - The bundle is re-signed with a local identity; if macOS still shows"
  echo "    an 'unverified developer' prompt on first launch, approve it once in"
  echo "    System Settings > Privacy & Security."
  echo "  - ZCode updates replace the whole app bundle; re-run this installer"
  echo "    after each update."
fi

echo ""
echo "Done. Fully quit and restart ZCode; the plugins will appear under the"
echo "built-in official marketplace (zcode-plugins-official)."
