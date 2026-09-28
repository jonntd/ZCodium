#Requires -Version 5.1
<#
.SYNOPSIS
  Seeds the official ZCode plugin set into an open-source ZCode installation.

.DESCRIPTION
  ZCode discovers bundled plugins from the "packages" directory next to the
  application entrypoint (resources/glm/zcode.cjs). This script copies the
  plugin packages into that layout and places the Computer Use helper runtime
  under resources/tools/cua-helper, matching the layout the app expects.

.PARAMETER InstallDir
  Root of the installed ZCode app (the folder containing resources\glm\zcode.cjs).
  Auto-detected from common install locations when omitted.

.PARAMETER RepoDir
  Alternatively, a local ZCode source checkout. Plugins are copied into its
  top-level "packages" directory, which the development bootstrap scans.

.PARAMETER SkipDevMode
  Do not set the ZCODE_CUA_DEV_MODE=1 user environment variable. The variable
  relaxes the helper's launcher signature check, which unsigned open-source
  builds need for Computer Use.

.EXAMPLE
  .\install.ps1
  .\install.ps1 -InstallDir D:\Apps\ZCode
  .\install.ps1 -RepoDir D:\src\ZCode
#>
param(
  [string]$InstallDir,
  [string]$RepoDir,
  [switch]$SkipDevMode
)

$ErrorActionPreference = 'Stop'
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginsDir = Join-Path $scriptRoot 'plugins'
$runtimeDir = Join-Path $scriptRoot 'runtimes\cua-helper'

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
  Write-Host "  ZCODE_CUA_DEV_ROOT=$runtimeDir"
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

if (Test-Path $runtimeDir) {
  $toolsTarget = Join-Path $install 'resources\tools'
  New-Item -ItemType Directory -Force -Path $toolsTarget | Out-Null
  $runtimeTarget = Join-Path $toolsTarget 'cua-helper'
  if (Test-Path $runtimeTarget) { Remove-Item $runtimeTarget -Recurse -Force }
  Copy-Item $runtimeDir $runtimeTarget -Recurse
  Write-Host "Installed Computer Use helper runtime -> $runtimeTarget" -ForegroundColor Green
}

# --- Enable the Computer Use runtime inside the packaged app ---------------
# Some builds ship the @zcode/zcode-cua surface as inert stubs. The patcher
# detects those stubs inside app.asar and the seeded node-repl-host bundle
# and rewires them to the full runtime under resources/tools/zcode-cua.
# It is a no-op on builds that already ship the real implementation.
$patcher = Join-Path $scriptRoot 'tools\patch-cua-runtime.cjs'
if (Test-Path $patcher) {
  $running = Get-Process -Name 'ZCode' -ErrorAction SilentlyContinue
  if ($running) {
    Write-Warning "ZCode is running. The runtime patch was skipped; fully quit ZCode (including the tray icon) and re-run install.ps1, or run:"
    Write-Warning "  `$env:ELECTRON_RUN_AS_NODE=1; & '$install\ZCode.exe' '$patcher' --install-dir '$install' --repo-dir '$scriptRoot'"
  } else {
    $nodeCmd = $null
    $nodeArgs = @()
    $zcodeExe = Join-Path $install 'ZCode.exe'
    if (Test-Path $zcodeExe) {
      $nodeCmd = $zcodeExe
      $env:ELECTRON_RUN_AS_NODE = '1'
    } elseif (Get-Command node -ErrorAction SilentlyContinue) {
      $nodeCmd = 'node'
    }
    if ($nodeCmd) {
      Write-Host "Enabling packaged Computer Use runtime..." -ForegroundColor Cyan
      $hadRunAsNode = Test-Path Env:\ELECTRON_RUN_AS_NODE
      $prevRunAsNode = $env:ELECTRON_RUN_AS_NODE
      try {
        $env:ELECTRON_RUN_AS_NODE = '1'
        & $nodeCmd $patcher --install-dir $install --repo-dir $scriptRoot
      } finally {
        if ($hadRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $prevRunAsNode }
        else { Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue }
      }
      if ($LASTEXITCODE -ne 0) {
        Write-Warning "Runtime patch reported an error (see above). Plugins are still installed."
      }
    } else {
      Write-Warning "No Node runtime found to run the packaged-runtime patch. Install Node.js or re-run later."
    }
  }
}

if (-not $SkipDevMode) {
  [Environment]::SetEnvironmentVariable('ZCODE_CUA_DEV_MODE', '1', 'User')
  $env:ZCODE_CUA_DEV_MODE = '1'
  Write-Host "Set user environment variable ZCODE_CUA_DEV_MODE=1" -ForegroundColor Green
}

Write-Host ""
Write-Host "Done. Fully quit and restart ZCode; the plugins will appear under the" -ForegroundColor Cyan
Write-Host "built-in official marketplace (zcode-plugins-official), and the" -ForegroundColor Cyan
Write-Host "'Computer Use' toggle will be available in Settings." -ForegroundColor Cyan
