# Bootstrap the PwrAgent Windows port sandbox dev toolchain.
# Run via SSM Run Command (AWS-RunPowerShellScript). Idempotent + re-runnable.
# Installs: Chocolatey, Git (long paths), nvm-windows + Node pinned to .nvmrc,
# pnpm pinned to package.json packageManager, Python (node-gyp), and the
# Visual Studio 2022 C++ build tools workload (required for better-sqlite3).

$ErrorActionPreference = "Continue"
Start-Transcript -Path C:\bootstrap.log -Append | Out-Null
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Keep these in sync with the repo: .nvmrc and root package.json "packageManager".
$NodeVersion = "24.14.1"
$PnpmVersion = "10.33.0"

function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user    = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = ($machine, $user -join ";")
}

Write-Host "=== [1/7] Chocolatey ==="
if (-not (Get-Command choco -ErrorAction SilentlyContinue)) {
  Set-ExecutionPolicy Bypass -Scope Process -Force
  iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
  Update-SessionPath
}

Write-Host "=== [2/7] Enable Windows + Git long paths (deep node_modules) ==="
New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" `
  -Name "LongPathsEnabled" -Value 1 -PropertyType DWord -Force | Out-Null

Write-Host "=== [3/7] Git ==="
choco install git -y --no-progress
Update-SessionPath
git config --system core.longpaths true

Write-Host "=== [4/7] nvm-windows + Node $NodeVersion ==="
choco install nvm -y --no-progress
# nvm-windows sets NVM_HOME/NVM_SYMLINK at Machine scope, but this already-
# running process tree (and the SSM Agent that spawned it) won't inherit them.
# Load them explicitly so nvm can find its root + settings.txt; otherwise
# `nvm install/use` fails with "open \settings.txt: cannot find the file".
$env:NVM_HOME    = [Environment]::GetEnvironmentVariable("NVM_HOME", "Machine")
$env:NVM_SYMLINK = [Environment]::GetEnvironmentVariable("NVM_SYMLINK", "Machine")
if (-not $env:NVM_HOME)    { $env:NVM_HOME    = "C:\ProgramData\nvm" }
if (-not $env:NVM_SYMLINK) { $env:NVM_SYMLINK = "C:\Program Files\nodejs" }
$nvmSettings = Join-Path $env:NVM_HOME "settings.txt"
if (-not (Test-Path $nvmSettings)) {
  Set-Content -Path $nvmSettings -Value "root: $env:NVM_HOME`r`npath: $env:NVM_SYMLINK"
}
$nvm = Join-Path $env:NVM_HOME "nvm.exe"
& $nvm install $NodeVersion
& $nvm use $NodeVersion
Update-SessionPath
$env:Path = "$env:NVM_SYMLINK;$env:Path"

Write-Host "=== [5/7] pnpm $PnpmVersion via corepack ==="
$corepack = Join-Path $env:NVM_SYMLINK "corepack.cmd"
if (Test-Path $corepack) {
  & $corepack enable
  & $corepack prepare "pnpm@$PnpmVersion" --activate
}

Write-Host "=== [6/7] Python (node-gyp) ==="
choco install python -y --no-progress
Update-SessionPath

Write-Host "=== [7/7] Visual Studio 2022 C++ Build Tools (better-sqlite3) ==="
# This is the long one (~several GB). 3010 = success-with-reboot-required.
choco install visualstudio2022-workload-vctools -y --no-progress --ignore-package-exit-codes

Write-Host ""
Write-Host "=== Versions ==="
Update-SessionPath
try { Write-Host ("node:   " + (& "C:\Program Files\nodejs\node.exe" -v)) } catch { Write-Host "node: NOT FOUND" }
try { Write-Host ("pnpm:   " + (& "C:\Program Files\nodejs\pnpm.cmd" -v)) } catch { Write-Host "pnpm: NOT FOUND" }
try { Write-Host ("git:    " + (git --version)) } catch { Write-Host "git: NOT FOUND" }
try { Write-Host ("python: " + (python --version 2>&1)) } catch { Write-Host "python: NOT FOUND" }
Write-Host "=== bootstrap complete ==="
Stop-Transcript | Out-Null
