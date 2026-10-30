param([switch]$InstallNode)

# Dot-source this script from the environment setup/actions. It exposes
# $pnpmCommand and puts the selected Node and pnpm on PATH for child processes.
$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$nodeVersion = (Get-Content -LiteralPath (Join-Path $repositoryRoot ".nvmrc") -Raw).Trim().TrimStart('v')
if ($InstallNode) {
  nvm install $nodeVersion
  if ($LASTEXITCODE -ne 0) { throw "nvm install failed" }
}
nvm use $nodeVersion
if ($LASTEXITCODE -ne 0) { throw "nvm use failed" }

# nvm-windows can select a version without refreshing the calling shell's PATH.
# Prefer that version's installation over a Node from another PATH entry.
$nodeDirectories = @()
if ($env:NVM_HOME) { $nodeDirectories += Join-Path $env:NVM_HOME "v$nodeVersion" }
if ($env:NVM_SYMLINK) { $nodeDirectories += $env:NVM_SYMLINK }
$nodeOnPath = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
if ($nodeOnPath) { $nodeDirectories += Split-Path -Parent $nodeOnPath.Source }
$nodeDirectory = $nodeDirectories | Where-Object {
  Test-Path -LiteralPath (Join-Path $_ "node.exe") -PathType Leaf
} | Select-Object -First 1
if (!$nodeDirectory) { throw "Node $nodeVersion was not found after nvm use" }
$env:PATH = "$nodeDirectory;$env:PATH"
$actualNodeVersion = & (Join-Path $nodeDirectory "node.exe") --version
if ($LASTEXITCODE -ne 0 -or $actualNodeVersion.Trim() -ne "v$nodeVersion") {
  throw "Expected Node $nodeVersion after nvm use; found $actualNodeVersion"
}

$packageManager = (Get-Content -LiteralPath (Join-Path $repositoryRoot "package.json") -Raw | ConvertFrom-Json).packageManager
if ($packageManager -notmatch '^pnpm@(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+sha\d+\.[0-9a-fA-F]+)?$') {
  throw "Expected an exact pnpm version in package.json packageManager"
}
$pnpmVersion = $Matches.version
# npm is a supported Windows pnpm installer. A worktree-local prefix avoids
# overwriting Corepack shims or another checkout's globally installed version.
$pnpmPrefix = Join-Path $repositoryRoot ".local/toolchains/pnpm/$pnpmVersion"
$env:PATH = "$pnpmPrefix;$env:PATH"

function Find-PinnedPnpm {
  # pnpm 12 can install a native executable; older releases use npm's shim.
  foreach ($name in @("pnpm.exe", "pnpm.cmd")) {
    $candidate = Join-Path $pnpmPrefix $name
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
}

$pnpmCommand = Find-PinnedPnpm
$actualPnpmVersion = if ($pnpmCommand) { & $pnpmCommand --version }
if (!$pnpmCommand -or $LASTEXITCODE -ne 0 -or "$actualPnpmVersion".Trim() -ne $pnpmVersion) {
  $npmCommand = Join-Path $nodeDirectory "npm.cmd"
  if (!(Test-Path -LiteralPath $npmCommand -PathType Leaf)) {
    throw "npm.cmd was not found beside the selected Node $nodeVersion"
  }
  & $npmCommand install --global --prefix $pnpmPrefix "pnpm@$pnpmVersion"
  if ($LASTEXITCODE -ne 0) { throw "npm install of pnpm $pnpmVersion failed" }
  $pnpmCommand = Find-PinnedPnpm
  if (!$pnpmCommand) { throw "pnpm $pnpmVersion executable was not found in $pnpmPrefix" }
  $actualPnpmVersion = & $pnpmCommand --version
  if ($LASTEXITCODE -ne 0 -or "$actualPnpmVersion".Trim() -ne $pnpmVersion) {
    throw "Expected pnpm $pnpmVersion; found $actualPnpmVersion"
  }
}
