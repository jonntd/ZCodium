# zcode-plugin

Official ZCode plugin packages for the open-source ZCode build.

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
3. Sets the user environment variable `ZCODE_CUA_DEV_MODE=1`, which relaxes the
   helper's launcher signature check for unsigned open-source builds
   (skip with `-SkipDevMode`)

Fully quit and restart ZCode. The plugins appear under the built-in official
marketplace; the "Computer Use / 电脑控制" toggle shows up in Settings.

### Installed app on macOS

```bash
./install.sh                    # auto-detects /Applications/ZCode.app
# or: ./install.sh /path/to/ZCode.app
```

The bundled helper runtime targets Windows; on macOS only the plugin packages
are seeded.

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

## License

Plugin packages are MIT licensed as declared in their manifests. Installer
scripts and repository glue are provided under the same terms.
