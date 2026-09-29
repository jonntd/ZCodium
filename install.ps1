#Requires -Version 5.1
<#
.SYNOPSIS
  Seeds the official ZCode plugin set into an open-source ZCode installation.

.DESCRIPTION
  ZCode discovers bundled plugins from the "packages" directory next to the
  application entrypoint (resources/glm/zcode.cjs). This script copies the
  plugin packages into that layout.

  Note: ZCodium builds carry the full Computer Use runtime and the helper
  runtime inside the app itself — no post-install patching needed
  (docs/spec/cua-runtime-builtin.md).

.PARAMETER InstallDir
  Root of the installed ZCode app (the folder containing resources\glm\zcode.cjs).
  Auto-detected from common install locations when omitted.

.PARAMETER RepoDir
  Alternatively, a local ZCode source checkout. Plugins are copied into its
  top-level "packages" directory, which the development bootstrap scans.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -InstallDir D:\Apps\ZCode
  .\install.ps1 -RepoDir D:\src\ZCode
#>
param(
  [string]$InstallDir,
  [string]$RepoDir
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginsDir = Join-Path $scriptRoot 'plugins'

if (-not (Test-Path $pluginsDir)) {
  Write-Error "plugins directory not found next to install.ps1: $pluginsDir"
}

function Copy-PluginPackages([string]$targetPackages) {
  New-Item -ItemType Directory -Force -Path $targetPackages | Out-Null
  $copied = @()
  Get-ChildItem $pluginsDir -Directory | ForEach-Object {
    $dest = Join-Path $targetPackages $_.Name
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Copy-Item $_.FullName $dest -Recurse
    $copied += $_.Name
  }
  return $copied
}

if ($RepoDir) {
  if (-not (Test-Path $RepoDir)) { Write-Error "RepoDir not found: $RepoDir" }
  $target = Join-Path $RepoDir 'packages'
  $copied = Copy-PluginPackages $target
  Write-Host "Seeded $($copied.Count) plugins into $target" -ForegroundColor Green
  Write-Host ""
  Write-Host "For the Computer Use helper runtime in a source checkout, set:"
  Write-Host "  ZCODE_CUA_DEV_ROOT=<repo>\runtimes\cua-helper"
  Write-Host "  ZCODE_CUA_DEV_MODE=1"
  exit 0
}

$candidates = @(
  $InstallDir,
  "$env:LOCALAPPDATA\Programs\ZCode",
  "$env:ProgramFiles\ZCode",
  "${env:ProgramFiles(x86)}\ZCode",
  'D:\ZCode', 'C:\ZCode', 'E:\ZCode'
) | Where-Object { $_ }

$install = $null
foreach ($candidate in $candidates) {
  if (Test-Path (Join-Path $candidate 'resources\glm\zcode.cjs')) {
    $install = $candidate
    break
  }
}
if (-not $install) {
  Write-Error "Could not locate a ZCode installation. Pass -InstallDir pointing at the folder that contains resources\glm\zcode.cjs."
}
Write-Host "ZCode installation: $install"

$packagesTarget = Join-Path $install 'resources\glm\packages'
$copied = Copy-PluginPackages $packagesTarget
Write-Host "Seeded $($copied.Count) plugins into $packagesTarget" -ForegroundColor Green

# Enable the Computer Use plugin for new sessions. Official builds keep it
# opt-in (the always-on builtin set does not include it), so a seeded install
# needs an explicit enable entry in the CLI config — merged, never replaced.
$cliConfig = Join-Path $HOME '.zcode\cli\config.json'
try {
  $cfg = [ordered]@{}
  if (Test-Path $cliConfig) {
    # Strip a possible BOM: the app's JSON.parse does not tolerate it, and a
    # BOM'd file would be reported invalid and ignored entirely. Compare the
    # first char directly — string.StartsWith uses culture-aware comparison
    # that treats U+FEFF as invisible and returns true for ANY string.
    $raw = Get-Content $cliConfig -Raw
    if ($raw.Length -gt 0 -and $raw[0] -eq [char]0xFEFF) { $raw = $raw.Substring(1) }
    $existing = $raw | ConvertFrom-Json
    if ($existing) {
      foreach ($prop in $existing.PSObject.Properties) { $cfg[$prop.Name] = $prop.Value }
    }
  }
  $pluginMap = [ordered]@{}
  if ($cfg['plugins'] -is [pscustomobject]) {
    foreach ($prop in $cfg['plugins'].PSObject.Properties) { $pluginMap[$prop.Name] = $prop.Value }
  }
  $enabled = [ordered]@{}
  if ($pluginMap['enabledPlugins'] -is [pscustomobject]) {
    foreach ($prop in $pluginMap['enabledPlugins'].PSObject.Properties) { $enabled[$prop.Name] = $prop.Value }
  }
  $enabled['computer-use@zcode-plugins-official'] = $true
  $pluginMap['enabledPlugins'] = $enabled
  $cfg['plugins'] = $pluginMap
  New-Item -ItemType Directory -Force -Path (Split-Path $cliConfig) | Out-Null
  # Write UTF-8 without BOM on every PowerShell version: Set-Content -Encoding
  # UTF8 emits a BOM under Windows PowerShell 5.1, which the app's strict
  # JSON.parse would reject (the whole config would then be ignored).
  $json = $cfg | ConvertTo-Json -Depth 10
  [System.IO.File]::WriteAllText($cliConfig, $json, [System.Text.UTF8Encoding]::new($false))
  Write-Host "Enabled computer-use@zcode-plugins-official in $cliConfig" -ForegroundColor Green
} catch {
  Write-Warning "Could not enable the computer-use plugin in ${cliConfig}: $_"
}

Write-Host ""
Write-Host "Done. Fully quit and restart ZCode; the plugins will appear under the" -ForegroundColor Cyan
Write-Host "built-in official marketplace (zcode-plugins-official), and the" -ForegroundColor Cyan
Write-Host "'Computer Use' toggle will be available in Settings." -ForegroundColor Cyan
