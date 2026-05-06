# PwrAgent v2 design bundle — provenance

This directory is a frozen export from [Claude Design](https://claude.ai/design)
for the PwrAgent v2 design pass. The version checked into the repo is
**source-only** — HTML/CSS/JSX prototypes and the SVG brand assets. The
private parts of the original export (chat transcripts and the user's pasted
reference screenshots) are intentionally **not** committed.

## Source

- Exported from: `https://api.anthropic.com/v1/design/h/tGC-osBjQefOVjqFI0wCzA`
  with the `PwrAgnt v2.html` entry file
- Imported on: 2026-05-05
- Imported on branch: `feat/ux-v2-settings`

## What's checked in

- `README.md` — the bundle's own handoff doc ("CODING AGENTS: READ THIS FIRST").
  Explains the bundle layout and the "recreate pixel-perfectly, don't copy
  structure" rule.
- `project/PwrAgnt v2.html` — entry point; follow its imports (`titlebar.jsx`,
  `sidebar.jsx`, `settings.jsx`, etc.) to understand how the pieces fit
  together.
- `project/*.jsx` + `project/styles.css` + `project/lib/colors_and_type.css` —
  the design's React prototypes and stylesheet.
- `project/assets/*.svg` — brand glyphs.

Note: the bundle's `README.md` references a `chats/` folder and tells coding
agents to read the transcripts first. Those transcripts are **not** in this
checked-in copy (see "What's NOT checked in" below). Use this file
(`SOURCE.md`) as the canonical guidance for using the design instead.

## What's NOT checked in (and why)

The original Claude Design export also contains:

- `chats/` — the back-and-forth between the user and the design assistant
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

## How to update this directory

If the design evolves and you re-export from Claude Design:

1. Extract the new bundle to `/tmp/pwragent-design-new/` (or wherever).
2. **Delete the new bundle's `chats/` and `project/uploads/` folders** before
   copying anything in. (They'd be gitignored anyway, but keep the working
   tree clean.)
3. Replace this directory wholesale: `rm -rf docs/design/pwragent-v2/project`
   then `cp -R /tmp/pwragent-design-new/pwragent/project docs/design/pwragent-v2/`.
4. Replace the `README.md` if the bundle's own README has changed.
5. Update the "Imported on" date in the front matter of this file.

Don't mix in-place edits with re-imports — that loses the link between what's
checked in and what the user approved in the design session.

## Relationship to the desktop codebase

This bundle is **reference**, not a target to copy verbatim. Specific
divergences the user has set as policy:

- The design's **unified app-wide title bar** (a single `pa-tb` strip across
  the top of every screen) is **NOT** what we're shipping. The main app
  screen keeps its existing `Sidebar` + `ThreadView` chrome; the title-bar
  visual treatment is applied **only inside the Settings overlay** as a
  per-pane header. See plan
  [docs/plans/2026-05-05-004-feat-settings-overlay-titlebar-plan.md](../../plans/2026-05-05-004-feat-settings-overlay-titlebar-plan.md).
- For broader desktop product direction, see
  [docs/design/desktop-style-guide.md](../desktop-style-guide.md).
- For visual tokens (colors, typography, accent rules), see
  [docs/UI-THEME.md](../../UI-THEME.md).
