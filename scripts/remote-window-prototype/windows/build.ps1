$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "../../..")).Path
$out = Join-Path $root ".local/remote-window-windows"
New-Item -ItemType Directory -Force $out | Out-Null
$vswhere = "${env:ProgramFiles(x86)}/Microsoft Visual Studio/Installer/vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$vs) { throw "Visual C++ Build Tools are required." }
$dev = Join-Path $vs "Common7/Tools/Launch-VsDevShell.ps1"
& $dev -Arch amd64 -HostArch amd64 -SkipAutomaticLocation | Out-Null
$source = Join-Path $PSScriptRoot "window-probe.cpp"
& cl.exe /nologo /std:c++17 /EHsc /W4 /O2 /DUNICODE /D_UNICODE $source "/Fo$out/window-probe.obj" "/Fe$out/window-probe.exe" /link user32.lib gdi32.lib d3d11.lib dxgi.lib windowsapp.lib dwmapi.lib windowscodecs.lib ole32.lib wtsapi32.lib
if ($LASTEXITCODE -ne 0) { throw "Build failed: $LASTEXITCODE" }
Write-Output (Join-Path $out "window-probe.exe")
