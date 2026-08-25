# Viking Relay release automation.
#
# Computes the next version from package.json according to the current state
# and the requested channel:
#   stable -> beta   : x.y.(z+1)-beta.1        (start a new beta series)
#   beta   -> beta   : x.y.z-beta.(n+1)        (next beta in the series)
#   beta   -> stable : x.y.z                   (promote: strip the prerelease)
#   stable-> stable  : x.y.(z+1)               (plain patch bump)
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1 -Channel beta [-Publish] [-VersionOverride 0.5.0]
#
# Publishing requires GH_TOKEN in the environment (GitHub personal access
# token with repo scope for Parlaxz/TorrentHub).
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('beta', 'stable')]
  [string]$Channel,

  [switch]$Publish,

  [string]$VersionOverride = ''
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

function Read-PackageVersion {
  $pkg = Get-Content -LiteralPath (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json
  return $pkg.version
}

function Get-NextVersion {
  param([string]$Current, [string]$Target)

  if ($Current -match '^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$') {
    $maj = [int]$Matches[1]; $min = [int]$Matches[2]; $pat = [int]$Matches[3]; $betaNum = $Matches[4]
  } else {
    throw "Cannot parse current version '$Current' (expected x.y.z[-beta.n])."
  }

  if ($Target -eq 'beta') {
    if ($null -ne $betaNum) { return "$maj.$min.$pat-beta.$([int]$betaNum + 1)" }
    return "$maj.$min.$($pat + 1)-beta.1"
  }
  # Target stable: promote (strip prerelease) or plain patch bump.
  if ($null -ne $betaNum) { return "$maj.$min.$pat" }
  return "$maj.$min.$($pat + 1)"
}

$currentVersion = Read-PackageVersion
if ($VersionOverride -ne '') {
  if ($VersionOverride -notmatch '^\d+\.\d+\.\d+(-beta\.\d+)?$') {
    throw "Invalid -VersionOverride '$VersionOverride' (expected x.y.z or x.y.z-beta.n)."
  }
  $newVersion = $VersionOverride
} else {
  $newVersion = Get-NextVersion -Current $currentVersion -Target $Channel
}

$isPrerelease = $newVersion -match '-beta\.'
Write-Host ""
Write-Host "=== Viking Relay release ==="
Write-Host "Current version : $currentVersion"
Write-Host "New version     : $newVersion ($Channel channel$(if ($isPrerelease) { ', prerelease' } else { '' }))"
Write-Host ""

# 1. Bump package.json (no git tag/commit; we tag explicitly on publish).
npm version --no-git-tag-version $newVersion
if ($LASTEXITCODE -ne 0) { throw "npm version failed." }

# 2. Build + package.
$publishFlag = '--publish never'
$willPublish = $false
if ($Publish) {
  if ([string]::IsNullOrWhiteSpace($env:GH_TOKEN)) {
    Write-Warning "-Publish was requested but GH_TOKEN is not set. Building WITHOUT publishing."
    Write-Warning "Set `$env:GH_TOKEN to a GitHub token with repo scope for Parlaxz/TorrentHub and re-run."
  } else {
    $publishFlag = '--publish always'
    $willPublish = $true
  }
}

Write-Host ""
Write-Host "Packaging (electron-builder --win $publishFlag)..."
npx electron-builder --win $publishFlag
if ($LASTEXITCODE -ne 0) { throw "electron-builder failed." }

$setupName = "Viking-Relay-Setup-$newVersion.exe"
$distDir = Join-Path $repoRoot 'dist'

if ($willPublish) {
  # 3. Tag the release commit state.
  git tag "v$newVersion"
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "git tag v$newVersion failed (tag may already exist). Continuing."
  } else {
    git push origin "v$newVersion"
    if ($LASTEXITCODE -ne 0) { Write-Warning "git push of tag v$newVersion failed; push it manually." }
  }

  Write-Host ""
  Write-Host "=== PUBLISHED ==="
  Write-Host "GitHub release for v$newVersion was created by electron-builder."
  Write-Host "Mark it as a pre-release on GitHub if it is a beta:"
  Write-Host "  https://github.com/Parlaxz/TorrentHub/releases"
} else {
  Write-Host ""
  Write-Host "=== BUILD COMPLETE (not published) ==="
  Write-Host "Upload these files from dist\ to a GitHub release tagged v$newVersion"
  Write-Host "(https://github.com/Parlaxz/TorrentHub/releases/new):"
  Write-Host "  dist\$setupName"
  Write-Host "  dist\$setupName.blockmap"
  Write-Host "  dist\latest.yml"
  Write-Host "  dist\latest.exe.blockmap"
  if ($isPrerelease) {
    Write-Host "  dist\beta.yml          <- REQUIRED for beta-channel clients"
    Write-Host "  dist\beta.exe.blockmap"
  }
  Write-Host ""
  Write-Host "Then re-run with -Publish and GH_TOKEN set to have this done automatically,"
  Write-Host "or attach the files manually and mark the release pre-release (beta only)."
}

Write-Host ""
Write-Host "Summary:"
Write-Host "  version : $newVersion"
Write-Host "  channel : $Channel"
Write-Host "  setup   : $setupName"
Write-Host "  feed    : $(if ($isPrerelease) { 'beta.yml' } else { 'latest.yml' })"
