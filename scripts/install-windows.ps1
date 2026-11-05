<#
.SYNOPSIS
  Point one or more DSH profiles at this checkout of dsh-superagent and build the bundle.

.DESCRIPTION
  Unlike the upstream deployment guide, this script never touches a profile you do not name:
  every profile is opt-in through -Profile. It refuses a DSH CLI older than 0.2 (0.1.x has no
  `--profile` and no `dsh plugin`), verifies the build produced lib/, and links the dependency
  through `dsh plugin add` rather than rewriting package.json by hand.

.PARAMETER Profile
  One or more DSH profile names to link. Required.

.PARAMETER Dsh
  Path to a DSH 0.2+ entry point. Default: the first `dsh` on PATH that is 0.2 or newer.

.PARAMETER SkipDeps
  Do not install dependencies; only build and link.

.PARAMETER SkipBuild
  Do not rebuild lib/; only update the profile links.

.PARAMETER DryRun
  Print the planned actions without writing anything.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 -Profile superagent -DryRun
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string[]] $Profile,
    [string] $Dsh = '',
    [switch] $SkipDeps,
    [switch] $SkipBuild,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'

function Write-Step { param([string] $Message) Write-Host "==> $Message" -ForegroundColor Cyan }
function Write-Sub  { param([string] $Message) Write-Host "    $Message" }
function Write-Ok   { param([string] $Message) Write-Host "    $Message" -ForegroundColor Green }
function Write-Note { param([string] $Message) Write-Host "    $Message" -ForegroundColor Yellow }

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'package.json'))) { throw "Not a dsh-superagent checkout (no package.json next to scripts/): $root" }
$linkValue = 'link:' + ($root -replace '\\', '/')

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$profilesDir = Join-Path $dshHome 'profiles'
if (-not (Test-Path $profilesDir)) { throw "No DSH profiles directory: $profilesDir" }
foreach ($name in $Profile) {
    if ($name -notmatch '^[A-Za-z0-9_][A-Za-z0-9_.-]*$') { throw "Not a DSH profile name: $name" }
    if (-not (Test-Path (Join-Path $profilesDir $name))) { throw "No such DSH profile: $name (looked in $profilesDir)" }
}

Write-Step "Checkout: $root"
if ($DryRun) { Write-Note 'DRY RUN: nothing will be written' }

# --- 0. toolchain -----------------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'node is not on PATH; install Node.js 22 or 24+.' }
$nodeVersion = (& node -v).TrimStart('v')
$nodeMajor = [int] ($nodeVersion -split '\.')[0]
if ($nodeMajor -lt 22) { throw "Node.js $nodeVersion is too old; this package needs Node.js 22 or 24+." }
Write-Sub "node $nodeVersion"

function Get-DshVersion {
    param([string] $Path)
    try {
        $text = (& $Path --version 2>&1 | Out-String)
        if ($text -match '(\d+)\.(\d+)\.(\d+)') { return [int]$matches[1], [int]$matches[2], [int]$matches[3] }
    } catch { }
    return $null
}

if ($Dsh) {
    if (-not (Test-Path $Dsh)) { throw "The DSH entry point does not exist: $Dsh" }
    $dsh = $Dsh
} else {
    $found = @(Get-Command dsh -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
    $dsh = $null
    foreach ($candidate in $found) {
        $v = Get-DshVersion $candidate
        if ($v -and ($v[0] -gt 0 -or $v[1] -ge 2)) { $dsh = $candidate; break }
        if ($v) { Write-Note "skipping $candidate: dsh $($v -join '.') is older than 0.2" }
    }
    if (-not $dsh) { throw 'No dsh 0.2 or newer on PATH; pass -Dsh <path to the DSH entry point>.' }
}
$dshVersion = Get-DshVersion $dsh
if (-not $dshVersion -or $dshVersion[0] -lt 0 -or ($dshVersion[0] -eq 0 -and $dshVersion[1] -lt 2)) {
    throw "dsh at $dsh is older than 0.2 (got $($dshVersion -join '.')); pass -Dsh <path to the DSH entry point>."
}
Write-Sub "dsh $($dshVersion -join '.') ($dsh)"

# --- 1. dependencies --------------------------------------------------------
$nodeModules = Join-Path $root 'node_modules'
if ($SkipDeps) {
    Write-Step 'Dependencies: skipped (-SkipDeps)'
} elseif (Test-Path (Join-Path $nodeModules 'tsdown')) {
    Write-Step 'Dependencies: already installed'
} else {
    Write-Step 'Install dependencies'
    $pkgJson = Get-Content (Join-Path $root 'package.json') -Raw | ConvertFrom-Json
    $pinnedPnpm = if ($pkgJson.packageManager -match '^pnpm@(.+)$') { $matches[1] } else { $null }
    $corepack = Get-Command corepack -ErrorAction SilentlyContinue
    $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($DryRun) {
        $plan = if ($corepack -and $pinnedPnpm) { "corepack pnpm@$pinnedPnpm install --frozen-lockfile" }
                elseif ($pnpm) { 'pnpm install --frozen-lockfile' }
                else { 'npm install --no-package-lock' }
        Write-Note "$plan (skipped)"
    } else {
        $installed = $false
        if ($corepack -and $pinnedPnpm) {
            Write-Sub "corepack pnpm@$pinnedPnpm install --frozen-lockfile ..."
            Push-Location $root
            try { & corepack "pnpm@$pinnedPnpm" install --frozen-lockfile } finally { Pop-Location }
            $installed = ($LASTEXITCODE -eq 0)
        }
        if (-not $installed -and $pnpm) {
            Write-Sub 'pnpm install --frozen-lockfile ...'
            $env:npm_config_manage_package_manager_versions = 'false'
            try {
                Push-Location $root
                try { & pnpm install --frozen-lockfile } finally { Pop-Location }
            } finally {
                Remove-Item Env:npm_config_manage_package_manager_versions -ErrorAction SilentlyContinue
            }
            $installed = ($LASTEXITCODE -eq 0)
        }
        if (-not $installed) {
            Write-Sub 'npm install --no-package-lock ...'
            Push-Location $root
            try { & npm install --no-package-lock --no-audit --no-fund } finally { Pop-Location }
            $installed = ($LASTEXITCODE -eq 0)
        }
        if (-not $installed) { throw 'Dependency install failed; check registry access and retry.' }
        Write-Ok 'dependencies installed'
    }
}

# --- 2. build ---------------------------------------------------------------
if ($SkipBuild) {
    Write-Step 'Build: skipped (-SkipBuild)'
} else {
    Write-Step 'Build bundle (lib/)'
    if ($DryRun) {
        Write-Note 'npm run build (skipped)'
    } else {
        Push-Location $root
        try { & npm run build } finally { Pop-Location }
        if ($LASTEXITCODE -ne 0) { throw "build failed (exit $LASTEXITCODE)" }
        if (-not (Test-Path (Join-Path $root 'lib\index.js'))) { throw 'Build finished but lib/index.js is missing.' }
        Write-Ok 'lib/ rebuilt'
    }
}

# --- 3. link the named profiles --------------------------------------------
foreach ($name in ($Profile | Sort-Object -Unique)) {
    Write-Step "Profile $name"
    $pkgPath = Join-Path (Join-Path $profilesDir $name) 'package.json'
    $current = $null
    if (Test-Path $pkgPath) {
        try {
            $obj = Get-Content $pkgPath -Raw | ConvertFrom-Json
            if ($obj.dependencies) { $current = $obj.dependencies.'dsh-superagent' }
        } catch { Write-Note "could not parse $pkgPath; leaving it to dsh plugin" }
    }
    Write-Sub "current dependency: $(if ($current) { $current } else { '(none)' })"
    if ($current -eq $linkValue) { Write-Ok 'already points at this checkout'; continue }

    if ($DryRun) {
        if ($current) { Write-Note "would run: dsh plugin --profile $name remove dsh-superagent" }
        Write-Note "would run: dsh plugin --profile $name add `"$linkValue`""
        continue
    }

    if ($current) {
        & $dsh plugin --profile $name remove dsh-superagent 2>&1 | ForEach-Object { Write-Sub $_ }
        if ($LASTEXITCODE -ne 0) { throw "dsh plugin --profile $name remove failed (exit $LASTEXITCODE)" }
    }
    & $dsh plugin --profile $name add $linkValue 2>&1 | ForEach-Object { Write-Sub $_ }
    if ($LASTEXITCODE -ne 0) { throw "dsh plugin --profile $name add failed (exit $LASTEXITCODE)" }
    Write-Ok 'linked'
}

# --- 4. what next -----------------------------------------------------------
Write-Step 'Done'
Write-Note 'Restart the DSH host that serves those profiles so it reloads lib/:'
Write-Sub  '  desktop app: quit it from the tray and start it again'
Write-Sub  '  superagent service: scripts\dsh-superagent.cmd restart --profile superagent'
exit 0
