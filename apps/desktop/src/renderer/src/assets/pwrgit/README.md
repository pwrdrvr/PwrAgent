# PwrGit brand asset

`pwrgit-app-icon.png` is the official PwrGit application icon, copied
verbatim from the sister PwrSuite repository:

- Repository: <https://github.com/pwrdrvr/PwrGit>
- Source: the `icon_128x128@2x.png` (256px) member of the legacy `.icns` that
  electron-builder's `actool` derives from PwrGit's `apps/desktop/build/icon.icon`
  at package time. It was originally the same member of PwrGit's hand-built
  `icon.iconset/`, which pwrdrvr/PwrGit#196 removed.
- Usage: the New Thread PwrGit connection prompt, and the OAuth callback page
  the browser lands on after PwrGit's authorization screen

To refresh it, take `Contents/Resources/icon.icns` from a packaged PwrGit.app
(or compile PwrGit's `build/icon.icon` the way its `branding-assets.test.ts`
does), run `iconutil -c iconset` on it, and copy `icon_128x128@2x.png` here
unchanged. Do not resample, redraw, recolor, or inline the mark in PwrAgent.

The plate in this copy covers 206 of its 256px — Apple's legacy 824-in-1024
template — where every mark it is drawn beside is full-bleed: PwrSnap's on the
New Thread card, PwrAgent's own on the callback page. Each surface compensates
in CSS rather than in the file, so the marks paint at the same size:

- `.mcp-connection__icon--inset-plate` in `styles/app.css` (the card)
- `.app-mark--inset-plate` in `src/main/mcp-connections/local-mcp-connection-service.ts`
  (the callback page, whose CSS is a template literal in the main process)

A refreshed copy with a different margin fails
`apps/desktop/scripts/pwrsuite-brand-icons.test.mjs`, which measures the asset
against both rules; correct the ratios there rather than editing the asset.
