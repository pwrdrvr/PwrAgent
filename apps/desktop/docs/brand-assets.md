# Third-Party Brand Assets

Moved verbatim from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps
a summary and says when to read this document.

## Third-Party Brand Assets

- Vendor-supplied brand assets (logos, marks, icons) live under `src/renderer/src/assets/<vendor>/` as **files from the vendor's official brand kit** — never hand-redrawn, recolored, cropped, or padded. A mechanical, scripted resize of the vendor's own artwork is the one transformation allowed, and only when the asset's `README.md` records it and a script reproduces it; see the PwrSuite sister marks below.
- Each asset directory MUST include a `README.md` documenting: the source URL, the vendor's usage rules, and the procedure for re-fetching on update. See [`src/renderer/src/assets/mattermost/README.md`](../src/renderer/src/assets/mattermost/README.md) as the reference example.
- Render verbatim assets via `<img>`, NOT inline `<svg>` with `currentColor`. The `<img>` tag is structurally insulated from parent CSS `color` rules, which protects the asset from accidental recoloring.
- Do not add hand-drawn `currentColor` vendor silhouettes. If a platform has a recognizable mark, follow the Mattermost/Telegram/Discord pattern instead.

### An app's mark outside macOS comes from `build/icon.png`

Every PwrSuite app builds its macOS icon from an Icon Composer package
(`build/icon.icon`), and `actool` derives a legacy `.icns` from it at package
time. **Neither is the mark to use anywhere else.** Every member of that
`.icns`, and the `build/icon-macos.png` beside it, is padded to Apple's
824-in-1024 safe-area template — the plate covers 80% of its canvas.

For any non-macOS context — a web page, a favicon, a cross-app brand mark in
another app's UI — use **`apps/desktop/build/icon.png`**, the full-bleed master
each repo already keeps as its Windows/Linux source. That is what PwrAgent
serves for its own mark on the OAuth callback page, and what
[`scripts/sync-pwrsuite-brand-icon.mjs`](../scripts/sync-pwrsuite-brand-icon.mjs)
copies from a sister checkout.

Getting this wrong does not look like a bug in the asset — it looks like a
layout problem on whatever surface drew it, and the local fix is to scale the
mark back up in CSS. PwrAgent carried that compensation at three draw sites
across two stylesheets before the assets were re-sourced, and the second one
was added months after the first by someone looking at one small mark. If a
mark paints at 80% of what is beside it, re-source the asset.
