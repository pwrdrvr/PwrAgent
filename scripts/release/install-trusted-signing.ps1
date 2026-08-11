$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$pwsh = Get-Command pwsh.exe -CommandType Application -ErrorAction Stop
Write-Host "Installing TrustedSigning with $($pwsh.Source) (PowerShell $($PSVersionTable.PSVersion))"

try {
  Install-PackageProvider `
    -Name NuGet `
    -MinimumVersion 2.8.5.201 `
    -Force `
    -Scope CurrentUser | Out-Null
} catch {
  Write-Warning "NuGet provider bootstrap failed; Install-Module will verify whether it is needed: $($_.Exception.Message)"
}
Install-Module `
  -Name TrustedSigning `
  -MinimumVersion 0.5.0 `
  -Force `
  -Repository PSGallery `
  -Scope CurrentUser

$module = Get-Module -ListAvailable -Name TrustedSigning |
  Where-Object { $_.Version -ge [version]"0.5.0" } |
  Sort-Object Version -Descending |
  Select-Object -First 1
if ($null -eq $module) {
  throw "TrustedSigning 0.5.0 or newer was not installed for the current user."
}

$probe = @'
$ErrorActionPreference = "Stop"
$command = Get-Command Invoke-TrustedSigning -ErrorAction Stop
if ($command.ModuleName -ne "TrustedSigning") {
  throw "Invoke-TrustedSigning resolved from unexpected module '$($command.ModuleName)'."
}
Write-Host "Fresh pwsh resolved $($command.Name) from $($command.Source)."
'@

& $pwsh.Source -NoProfile -NonInteractive -Command $probe
if ($LASTEXITCODE -ne 0) {
  throw "Fresh pwsh could not resolve Invoke-TrustedSigning (exit code $LASTEXITCODE)."
}
