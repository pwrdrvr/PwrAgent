$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$out = Join-Path $root ".local/remote-window-windows"
if (Test-Path -LiteralPath "C:/PwrLab") {
  if (Test-Path -LiteralPath "C:/PwrLab/locks/interactive-e2e/owner.json") {
    throw "An interactive E2E owner exists; leave its desktop untouched."
  }
  $task = Get-ScheduledTask -TaskName "PwrLab-Interactive-E2E" -ErrorAction Stop
  if ($task.State -ne "Ready") { throw "Interactive E2E task is not Ready; do not run fixture." }
}
& (Join-Path $PSScriptRoot "build.ps1")
& (Join-Path $out "window-probe.exe") (Join-Path $out "capture")
if ($LASTEXITCODE -eq 3) {
  Write-Output "Blocked: reconnect/unlock the authorized test desktop yourself, keep it active, then rerun. No session was changed."
}
exit $LASTEXITCODE
