# PwrSnap brand asset

`pwrsnap-app-icon.png` is the official PwrSnap application icon, copied
verbatim from the sister PwrSuite repository:

- Repository: <https://github.com/pwrdrvr/PwrSnap>
- Source: `apps/desktop/build/icon-macos.png` (1024px on Apple's padded
  legacy tile), downscaled to 256px. It was originally the
  `icon.iconset/icon_128x128@2x.png` member of the same rendering; PwrSnap
  no longer hand-builds a `.icns` or an iconset (pwrdrvr/PwrSnap#563).
- Usage: the New Thread PwrSnap connection prompt

To refresh it, take `icon-macos.png` from a current PwrSnap checkout and
resize it (`sips -z 256 256 icon-macos.png --out pwrsnap-app-icon.png`), or
extract `icon_128x128@2x.png` with `iconutil -c iconset` from a packaged
PwrSnap.app's `Contents/Resources/icon.icns`. Do not redraw, recolor, or
inline the mark in PwrAgent.
