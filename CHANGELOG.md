# Changelog

## v1.0.0-alpha.5 - 2026-05-04

- Fixed launchpad composer drafts so rich text formatting and intentional blank lines survive app restarts without compounding extra spacing.
- Added a guarded desktop release metadata check so release tags must match `apps/desktop/package.json` and `CHANGELOG.md` before signing and notarization begin.

## v1.0.0-alpha.4 - 2026-05-04

- Rebranded the desktop app from PwrAgnt to PwrAgent.
- Relocated desktop config and state under the PwrAgent home/profile layout backed by SQLite.
- Added optional streaming responses for hosted messaging providers.
- Fixed recent desktop regressions around worktree thread deduplication, Tiptap draft preservation, Better SQLite rebuilds, messaging startup logging, and worktree storage controls.
