# PwrGit brand asset

`pwrgit-app-icon.png` is the official PwrGit application icon, taken from the
sister PwrSuite repository:

- Repository: <https://github.com/pwrdrvr/PwrGit>
- Source: `apps/desktop/build/icon.png` — the full-bleed master PwrGit's own
  build documents as its Windows/Linux source. Downsampled to 256px, which is
  the only transformation applied.
- Usage: the New Thread PwrGit connection prompt, and the OAuth callback page
  the browser lands on after PwrGit's authorization screen

To refresh it, point the sync script at a PwrGit checkout:

```bash
pnpm --filter @pwragent/desktop sync:brand-icon -- --app pwrgit --repo ~/src/PwrGit
```

`--repo` defaults to a `PwrGit` checkout beside this one. The script refuses a
source that is not full-bleed and re-measures what it wrote, so a refresh
either produces a usable asset or fails saying why.

Do not redraw, recolor, crop, pad, or inline the mark in PwrAgent. The
downsample above is mechanical and reproducible from PwrGit at any time, which
is what keeps this a copy of another product's trademark artwork rather than a
PwrAgent rendition of it.

## Not the `.icns`, and not `icon-macos.png`

PwrGit builds its macOS icon from an Icon Composer package (`build/icon.icon`),
and `actool` derives a legacy `.icns` from it at package time. Every member of
that `.icns` — and `build/icon-macos.png` beside it — is padded to Apple's
824-in-1024 template, because macOS draws app icons inside a safe area.

A mark taken from one of those covers 80% of its canvas, so it paints at 80% of
any full-bleed mark beside it. Both surfaces above draw exactly that pairing,
and both once carried CSS to scale this asset back up. Re-sourcing from
`build/icon.png` is what removed them. `apps/desktop/scripts/pwrsuite-brand-icons.test.mjs`
measures this asset against both surfaces and fails if a margin returns — fix
that by re-running the script above, not by compensating in a stylesheet.
