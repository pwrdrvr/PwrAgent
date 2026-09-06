# PwrSnap brand asset

`pwrsnap-app-icon.png` is the official PwrSnap application icon, copied
verbatim from the sister PwrSuite repository:

- Repository: <https://github.com/pwrdrvr/PwrSnap>
- Source: the `icon_128x128@2x.png` (256px) member of the legacy `.icns` that
  electron-builder's `actool` derives from PwrSnap's `apps/desktop/build/icon.icon`
  at package time. It was originally the same member of PwrSnap's hand-built
  `icon.iconset/`, which pwrdrvr/PwrSnap#563 removed.
- Usage: the New Thread PwrSnap connection prompt

To refresh it, take `Contents/Resources/icon.icns` from a packaged PwrSnap.app
(or compile PwrSnap's `build/icon.icon` the way its `app-icon.test.mjs` does),
run `iconutil -c iconset` on it, and copy `icon_128x128@2x.png` here unchanged.
Do not resample, redraw, recolor, or inline the mark in PwrAgent.
