# Changelog

## v1.0.0-beta.1 - 2026-05-11

- Moved the desktop release channel from alpha to beta after the latest dogfooding fixes.
- Expanded messaging with Slack support, pairing-code authorization, channel binding notifications, slow-mode handling, long-lived status callbacks, hot-applied runtime and authorization updates, startup bot/account metadata, and a redesigned mobile-first handoff branch workflow.
- Improved Codex and desktop workflow safety with auth profile mapping, local-mode fallback outside git repositories, safer handoff behavior that avoids rewriting rollout files, grouped profile scratch projects, and clearer branch-drift dialogs.
- Added navigation and workspace polish with recents thread pins, directory-scoped pinned threads, refreshed git and PR metadata, archive cleanup failure reporting, and transcript/composer spacing fixes.
- Updated distribution readiness with the placeholder `pwragent` npm package, MIT license metadata, generated third-party license disclosures, and release packaging checks that ship first-party and third-party license files.
- Hardened messaging and desktop edge cases around Telegram General topic routing, typing renewal, deferred new-thread failures, callback persistence, unbound callback cleanup, thread creation gating, empty-state layout, runtime tooltips, and thread name routing through the app server.

## v1.0.0-alpha.8 - 2026-05-08

- Fixed workspace handoff controls so directory/workspace migration is blocked while a thread has an active turn, including active turns reported by backend lifecycle notifications and messaging callbacks.
- Fixed new Codex thread startup so the first turn no longer sends a premature `thread/resume` before the initial rollout exists.
- Kept thread reactions synchronized across refreshes, multiple desktop instances, and legacy overlay-store read/write paths.
- Stopped repeated pull-request refresh loops during live Codex turns by coalescing in-flight refreshes and reusing fresh persisted results.
- Improved messaging settings contact lists with authorized contact labels, resolved display names, legacy authorized-ID preservation, stale lookup protection, and sanitized lookup labels.

## v1.0.0-alpha.7 - 2026-05-08

- Fixed GitHub CLI discovery for desktop sessions launched from Finder or the Dock by probing common install locations, supporting configured `gh` paths, and exposing validation controls in Settings.
- Added inline validation for Telegram, Discord, and Mattermost authorization IDs, plus copyable rejected actor and conversation IDs in Messaging Activity.
- Preserved queued mid-turn composer replies when navigating away from a thread and returning before the queued reply is sent or cleared.
- Streamlined release operations with reconstructed early changelog entries, direct maintainer release-metadata pushes, and post-build GitHub Release note updates.

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
