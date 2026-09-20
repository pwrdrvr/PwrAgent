[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# A default pnpm deploy leaves .pnpm/node_modules as a workspace-link view.
# Git for Windows' tar follows those directory junctions, which can re-enter
# apps/desktop/release-stage indefinitely. The release script uses a hoisted
# stage for Windows so this virtual-root directory must not be present.
$workspaceLinkRoot = "apps/desktop/release-stage/node_modules/.pnpm/node_modules"
if (Test-Path -LiteralPath $workspaceLinkRoot) {
  throw "Windows release-stage must not contain $workspaceLinkRoot; archive only the hoisted signing input."
}

# Validate local module imports before archiving the explicit platform allowlist.
$paths = @(node --experimental-vm-modules scripts/release/check-signing-input.mjs windows)
if ($LASTEXITCODE -ne 0) {
  throw "Windows signing input contract failed."
}
foreach ($path in $paths) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Required Windows signing input is missing: $path"
  }
}

$archiveDirectory = Split-Path -Parent $ArchivePath
$materializedRoot = Join-Path $archiveDirectory "pwragent-windows-signing-input-$([guid]::NewGuid().ToString('N'))"
try {
  node --experimental-vm-modules scripts/release/materialize-signing-input.mjs windows $materializedRoot
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to materialize Windows signing input (exit code $LASTEXITCODE)."
  }

  Push-Location $materializedRoot
  try {
    & tar.exe -czf $ArchivePath @paths
    if ($LASTEXITCODE -ne 0) {
      throw "Failed to archive Windows signing input (exit code $LASTEXITCODE)."
    }
  } finally {
    Pop-Location
  }

  node --experimental-vm-modules scripts/release/verify-signing-input-archive.mjs windows $ArchivePath
  if ($LASTEXITCODE -ne 0) {
    throw "Windows signing input archive validation failed (exit code $LASTEXITCODE)."
  }
} finally {
  if (Test-Path -LiteralPath $materializedRoot) {
    Remove-Item -LiteralPath $materializedRoot -Recurse -Force
  }
}
