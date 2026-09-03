# PwrAgent v2 design bundle — provenance

This directory is a frozen copy of the [Claude Design](https://claude.ai/design)
`PwrAgent` project. The version checked into the repo is **source-only** —
HTML/CSS/JSX prototypes, the canvas records, and the SVG brand assets. The
private parts of the project (chat transcripts and the user's pasted reference
screenshots) are intentionally **not** committed.

It exists so people without Claude Design access can read the design.

## Source

- Project: `PwrAgent` — `019df437-879b-7ea9-89a7-aa689d28f06f`
  (<https://claude.ai/design/p/019df437-879b-7ea9-89a7-aa689d28f06f>)
- Imported on: 2026-09-03
- Imported on branch: `docs/refresh-pwragent-v2-design-bundle`
- Imported by: mirroring the live project file-by-file (see "How to update this
  directory")

Previous import: 2026-05-05 on branch `feat/ux-v2-settings`, from the export
handle `https://api.anthropic.com/v1/design/h/tGC-osBjQefOVjqFI0wCzA` with the
`PwrAgnt v2.html` entry file. Export handles expire; that one now returns 404.
Treat any handle recorded here as historical, not as a way back to the bundle.

The 19 files carried over from that import are byte-identical to the 2026-05-05
commit. The rest of this directory is new.

## What's checked in

- `README.md` — the bundle's own handoff doc ("CODING AGENTS: READ THIS
  FIRST"). This is still the 2026-05-05 exporter's output: this import mirrored
  the project directly rather than unpacking an export, so there was no new
  exporter README to replace it with. Its bundle-layout claims (a `chats/`
  folder, a `pwragent/` path prefix) describe the export, not this directory.
- `project/PwrAgnt v2.html`, `v3`, `v4` — the original v2 pass. Entry points;
  follow their imports (`titlebar.jsx`, `sidebar.jsx`, `settings.jsx`, etc.) to
  understand how the pieces fit together.
- `project/As Built 2026-09-01 - *.dc.html` — the as-built reconciliation pass.
  Six screens measured against the shipping renderer, in both themes, with the
  resolved token values. `- Index` is the entry point.
- `project/* UX Review.dc.html` — per-surface review passes (Settings panels,
  sidebar identity chrome, window chrome, Token Miser, progress scanners).
- `project/* Shipped.dc.html` — records of what shipped for a reviewed surface.
- `project/Pricing *.html`, `Review Card Provenance.html`,
  `Settings Provider Nav.html` — standalone prototypes.
- `project/*.jsx` + `project/*.css` + `project/lib/colors_and_type.css` — the
  React prototypes and stylesheets the pages above pull in.
- `project/support.js` — the canvas runtime the `.dc.html` pages need. Machine
  generated; don't hand-edit it.
- `project/assets/*.svg` — brand glyphs.

Use this file (`SOURCE.md`) as the canonical guidance for using the design.

## What's NOT checked in (and why)

The Claude Design project also contains:

- `chats/` — the back-and-forth between the user and the design assistant
  (part of the export bundle, not of the project's own files)
- `project/uploads/` — screenshots the user pasted during the design
  conversation

Both of these can carry private context — internal product decisions, paths,
account names, identifying details from screenshots, etc. They are useful as
local reference while the design is being implemented but **must not** be
checked into the repository.

This is locked in `.gitignore` (top-level) so a future re-import doesn't
accidentally include them:

```
docs/design/pwragent-v2/chats/
docs/design/pwragent-v2/project/uploads/
```

Two further exclusions, applied by hand on 2026-09-03:

- `project/apps/desktop/scripts/generate-dmg-background.swift` and its
  `project/github.md` sync manifest. That file is a mirror of the real
  repo file at `apps/desktop/scripts/generate-dmg-background.swift`, which the
  design project edited and synced back. It was byte-identical to the repo's
  copy at import time. Checking it in here would create a second copy of live
  repo code that can only rot.

## Redactions

Keep this list current. Anything here has to be re-applied on the next import,
because the upstream project still carries the original text.

- 2026-09-03, `project/Settings Plugins MCPs UX Review.dc.html`: a Codex profile
  named after the user's employer was replaced with `work` (9 occurrences). The
  page uses it as an example of a second, non-default Codex profile
  (`~/.codex/profiles/<name>`), so the substitution costs the page nothing.

Personal paths of the form `/Users/huntharo/...` appear in mock thread data
throughout the bundle. They were already checked in as of 2026-05-05 and are
left alone — rewriting them would be an in-place edit of design content (see
below).

## How to update this directory

The upstream project is the source of truth. Replace this directory wholesale;
don't hand-patch it. Mixing in-place edits with re-imports loses the link
between what's checked in and what the user approved in the design session.
The Redactions section above is the one exception, and it is deliberately a
short, listed, mechanical set.

1. Mirror the project's files to a staging directory outside the repo. The
   `claude-design` MCP tools (`list_files`, then `read_file`) are the portable
   way. `render_preview` returns a short-lived `serve_url` whose token is
   project-scoped, so a single token can fetch every path — much cheaper, but
   note that endpoint injects a preview harness (a `data-omelette-injected`
   `<style>` + `<script>` block, ~20 KB) into every HTML response. Strip it and
   check each file against the byte size `list_files` reported.
2. **Do not fetch `chats/` or `project/uploads/`.** (They'd be gitignored
   anyway, but keep the working tree clean.)
3. Scan the staging directory before it touches the repo: employer names,
   personal paths, tokens (`xoxb-`, `ghp_`, `sk-ant`, `Bearer`), and anything
   else that shouldn't ship. Record what you redact under "Redactions".
4. Replace this directory wholesale: `rm -rf docs/design/pwragent-v2/project`
   then `cp -R <staging>/project docs/design/pwragent-v2/`.
5. Replace `README.md` if you produced a real export bundle and its README has
   changed.
6. Update the "Source" section of this file: project id, date, branch, method.

## Relationship to the desktop codebase

This bundle is **reference**, not a target to copy verbatim. Specific
divergences the user has set as policy:

- The design's **unified app-wide title bar** (a single `pa-tb` strip across the
  top of every screen, in `titlebar.jsx`) is still **NOT** the macOS treatment.
  On macOS the main app screen keeps `hiddenInset`, the sidebar masthead, and
  its existing `Sidebar` + `ThreadView` chrome. The title-bar visual treatment
  is applied inside the **Settings** overlay as a per-pane header
  (`.settings-titlebar__*`), and the Activity/Logs windows carry their own
  separate primitive (`.activity-titlebar__*`). The theme contract enforces
  this split.
- **Windows is the exception, added after the May import.** `AppTitleBar`
  (`apps/desktop/src/renderer/src/features/chrome/AppTitleBar.tsx`) renders a
  single frameless strip — wordmark, menu, actions, drag region, Window
  Controls Overlay — and the sidebar masthead and per-screen MSG button are
  hidden there. It returns `null` off win32. So the design's unified strip does
  ship, but only where the platform has no `hiddenInset` equivalent.
- The 2026-09-01 as-built pass records the shipped state of these surfaces;
  read it before assuming a prototype's chrome is current.
- For broader desktop product direction, see
  [docs/design/desktop-style-guide.md](../desktop-style-guide.md).
- For visual tokens (colors, typography, accent rules), see
  [docs/UI-THEME.md](../../UI-THEME.md).
