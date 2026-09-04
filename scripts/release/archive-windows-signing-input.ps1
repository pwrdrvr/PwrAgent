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

# The signing job gets this allowlist instead of a checkout, so every module
# release.mjs imports has to be listed here as well as in the macOS `Archive
# signing input` step. verify-asar-contents.mjs imports asar-entry-paths.mjs;
# release.mjs imports update-channel-files.mjs.
$paths = @(
  "apps/desktop/release-stage",
  "apps/desktop/scripts/release.mjs",
  "apps/desktop/scripts/update-channel-files.mjs",
  "apps/desktop/scripts/verify-asar-contents.mjs",
  "apps/desktop/scripts/asar-entry-paths.mjs",
  "scripts/release/install-trusted-signing.ps1"
)
foreach ($path in $paths) {
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Required Windows signing input is missing: $path"
  }
}

& tar.exe -czf $ArchivePath @paths
if ($LASTEXITCODE -ne 0) {
  throw "Failed to archive Windows signing input (exit code $LASTEXITCODE)."
}
