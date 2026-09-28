# zcode-plugin

Official ZCode plugin packages for the open-source ZCode build.

[中文说明](README.zh-CN.md)

The open-source release ships only a subset of the bundled plugins. This
repository provides the full official plugin set — including the Computer Use
runtime — so an open-source installation can reach feature parity with the
official product.

## Contents

| Plugin | Description |
| --- | --- |
| `computer-use` | Desktop automation: the agent drives mouse, keyboard, and UI elements. Ships with the Windows helper runtime under `runtimes/cua-helper`. |
| `documents` | DOCX document generation skill |
| `spreadsheets` | XLSX spreadsheet generation skill |
| `presentations` | PPTX presentation generation skill |
| `pdf` | PDF generation skill |
| `image-search` | Official image search MCP server |
| `android-emulator` | Android development workflow and emulator automation |
| `ios-simulator` | iOS development workflow and simulator automation |
| `plugin-creator` | Plugin authoring and local marketplace debugging tools |
| `skill-creator` | Skill creation and iteration tools |
| `zcode-guide` | ZCode usage guide and diagnostics |
| `restore-legacy-sessions` | ACP legacy session migration |

Layout:

```
plugins/               one directory per plugin package (.zcode-plugin/plugin.json)
runtimes/cua-helper/   Computer Use helper runtime (windows-helper.js + ax_native.node)
runtimes/zcode-cua/    Computer Use runtime package (broker client/server, helper lifecycle)
tools/                 packaged-app runtime enabler used by the installers
marketplace.json       standard ZCode plugin marketplace manifest
install.ps1            Windows seed installer
install.sh             macOS / source-checkout seed installer
```

## Quick start — seed install (recommended)

ZCode discovers bundled plugins from the `packages` directory next to the
application entrypoint (`resources/glm/zcode.cjs`) and seeds them into the
built-in official marketplace (`zcode-plugins-official`) at startup. The
installer scripts copy the plugins into exactly that layout.

### Installed app on Windows

```powershell
git clone https://github.com/luxi233/zcode-plugin
cd zcode-plugin
.\install.ps1                 # auto-detects the install directory
# or: .\install.ps1 -InstallDir D:\Apps\ZCode
```

The script:

1. Copies every plugin into `<install>\resources\glm\packages\`
2. Copies the Computer Use helper runtime into `<install>\resources\tools\cua-helper\`
3. Runs `tools/patch-cua-runtime.cjs` through the app's own bundled Node
   (`ELECTRON_RUN_AS_NODE=1 ZCode.exe`): it detects whether this build shipped
   the Computer Use runtime as inert stubs and, if so, wires the packaged code
   to the full runtime under `resources\tools\zcode-cua\`. The app must be
   fully closed for this step; if it is running the installer prints the exact
   command to re-run later. Safe to re-run — already-patched installs are
   skipped and `app.asar` is backed up first.
4. Sets the user environment variable `ZCODE_CUA_DEV_MODE=1`, which relaxes the
   helper's launcher signature check for unsigned open-source builds
   (skip with `-SkipDevMode`)

Fully quit and restart ZCode. The plugins appear under the built-in official
marketplace; the "Computer Use / 电脑控制" toggle shows up in Settings.

### Installed app on macOS

```bash
git clone https://github.com/luxi233/zcode-plugin
cd zcode-plugin
./install.sh                    # auto-detects /Applications/ZCode.app
# or: ./install.sh /path/to/ZCode.app
```

The script:

1. Copies every plugin into `<app>/Contents/Resources/glm/packages/`
2. Stages the Computer Use runtime into `<app>/Contents/Resources/tools/zcode-cua/`
3. Installs the signed **ZCode Computer Use.app** helper into
   `<app>/Contents/Resources/cua-helper/` — fetched from the official release
   CDN for the installed app's version and CPU architecture (arm64 and x64 are
   both supported); skipped when the app already bundles it
4. Runs `tools/patch-cua-runtime.cjs` (with a system `node` when available,
   otherwise via `ELECTRON_RUN_AS_NODE=1 <app>/Contents/MacOS/ZCode`) to wire
   packaged stub modules to the full runtime — same semantic detection as on
   Windows
5. Re-signs the app bundle (see "App signature" below)
6. Sets `ZCODE_CUA_DEV_MODE=1` via `launchctl` (plus a LaunchAgent so it
   survives relogin), which relaxes the helper's launcher signature check for
   unsigned open-source builds

macOS-specific notes:

- **Privacy permissions**: on first use macOS prompts for *Accessibility* and
  *Screen Recording* for "ZCode Computer Use" — approve in
  System Settings → Privacy & Security. The helper re-launches itself to
  request them (`--request-accessibility`).
- **App signature**: writing into `Contents/` invalidates the app bundle's
  signature. On recent macOS a managed app whose signature is broken *or*
  ad-hoc is reported as damaged and refuses to launch, so the installer
  re-signs the outer bundle with a real identity — a Developer ID certificate
  when one exists in the keychain, otherwise a self-signed "ZCode Local Code
  Signing" certificate it creates for you. Nested components (frameworks,
  helper apps) keep their original signatures, and quarantine is stripped so
  the bundle is never re-assessed by Gatekeeper. On first launch macOS may
  still show an "unverified developer" prompt — approve once via
  right-click → Open or System Settings → Privacy & Security.
- **Write protection**: an app bundle that macOS has registered as managed
  (for example one placed by the built-in updater) rejects writes into
  `Contents/`. The installer probes for this and tells you to re-copy the app
  when it hits it.
- **Updates**: ZCode's built-in updater replaces the whole app bundle, which
  wipes the seeded plugins, runtime, helper and re-signing — re-run
  `install.sh` after every update.
- Fully quit and restart ZCode afterwards; logging out/in once makes the
  launchd environment reliable.

### Source checkout (development)

```bash
./install.sh --repo /path/to/ZCode    # seeds <repo>/packages/
```

For the Computer Use helper runtime in a source checkout, additionally set:

```
ZCODE_CUA_DEV_ROOT=<this-repo>/runtimes/cua-helper
ZCODE_CUA_DEV_MODE=1
```

## Alternative — plugin marketplace

This repository is also a standard ZCode plugin marketplace and can be added
directly:

```bash
zcode plugins marketplace add luxi233/zcode-plugin
zcode plugins install documents@zcode-plugins
```

Note: plugins installed this way carry the `@zcode-plugins` id. The Settings
"Computer Use" toggle and the default-enabled flags are bound to the built-in
official marketplace id (`zcode-plugins-official`), which only filesystem
seeding can populate — use the seed install above for full parity.

## Compatibility

| Environment | Plugins | Computer Use |
| --- | --- | --- |
| Windows x64, ZCode 3.14.x | ✅ | ✅ verified end-to-end |
| Windows x64, other versions | ✅ | ⚠️ likely — the patcher detects stub chunks by signature, not filename, but the helper's IPC contract may drift between releases |
| Windows ARM64 | ✅ | ❌ `ax_native.node` is x64-only |
| macOS arm64 / x64 | ✅ | ✅ verified on-device (3.14.3, arm64); x64 untested but same path |
| Remote / WSL workspaces | ✅ | ❌ by design — Computer Use is only injected into local desktop sessions |

Notes:

- The helper runtime declares `electronVersion: 41.0.3` in its manifest; the
  patcher warns when the installed app's Electron ABI differs.
- **After any ZCode update**, re-run `install.ps1` — updates overwrite
  `resources\`. The script is idempotent.
- The patcher always keeps a rollback copy at
  `resources\app.asar.zcode-plugin.bak`.

## License

Plugin packages are MIT licensed as declared in their manifests. Installer
scripts and repository glue are provided under the same terms.
