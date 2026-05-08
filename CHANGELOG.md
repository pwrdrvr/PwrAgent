# Changelog

## v1.0.0-alpha.6 - 2026-05-08

- Advanced the desktop v2 interface with new status tokens and iconography, redesigned settings screens, sticky directory headers, PR chips, thread reactions, and project-directory picker affordances.
- Expanded messaging with capability discovery, adaptive command rendering, a canonical help surface, bot-mention command aliases, Mattermost support, official provider icons, and clearer streaming-response guidance.
- Improved Codex execution safety with a single app-server process, queued permission-mode changes, explicit approval/sandbox policy propagation, and default-access workspace-write enforcement.
- Hardened messaging, settings, and transcript behavior with provider identifier validation, SQLite input-binding coverage, safer config persistence, Discord/Telegram shutdown fixes, transcript ordering tie-breaks, and reaction preservation on refresh.
- Strengthened release and CI operations with the redesigned DMG installer, release-skill squash-merge flow, broader pull-request CI coverage, and live agent-core smoke-test skipping when unrelated files change.

## v1.0.0-alpha.5 - 2026-05-04

- Fixed launchpad composer drafts so rich text formatting and intentional blank lines survive app restarts without compounding extra spacing.
- Added a guarded desktop release metadata check so release tags must match `apps/desktop/package.json` and `CHANGELOG.md` before signing and notarization begin.

## v1.0.0-alpha.4 - 2026-05-04

- Rebranded the desktop app from PwrAgnt to PwrAgent.
- Relocated desktop config and state under the PwrAgent home/profile layout backed by SQLite.
- Added optional streaming responses for hosted messaging providers.
- Fixed recent desktop regressions around worktree thread deduplication, Tiptap draft preservation, Better SQLite rebuilds, messaging startup logging, and worktree storage controls.

## v1.0.0-alpha.3 - 2026-05-03

- Added the custom desktop titlebar using the macOS `hiddenInset` window style.

## v1.0.0-alpha.2 - 2026-05-03

- Hardened remote messaging thread status flows.
- Hid the development-only runtime identity indicator in production desktop builds.

## v1.0.0-alpha.1 - 2026-05-03

- Fixed packaged-app startup issues that could leave the desktop window blank or prevent provider loading.
- Continued hardening the first release pipeline after the initial alpha packaging pass.

## v1.0.0-alpha.0 - 2026-05-03

- Added the first macOS arm64 desktop release pipeline with electron-builder packaging, signing, notarization, GitHub release publishing, and auto-update wiring.
- Added release runbooks and PwrDrvr LLC product metadata for the signed desktop app.
- Fixed release-test portability by avoiding a hard dependency on `rg` in the shell-command test path.
