# Changelog

## v1.0.0-beta.12 - 2026-05-20

- Added a WCAG AA accessibility gate for the desktop renderer, including baseline fixes for composer autocomplete, sidebar tabs, resize controls, and transcript list semantics.
- Added IntelliJ IDEA and Warp autodiscovery for desktop application settings.
- Added Electron E2E coverage proving appearance theme and density updates broadcast across auxiliary windows.
- Improved LiveWorkRail expanded-diff scrolling so sticky file toggles pin flush to the rail header without a visual gap.
- Fixed environment setup transcript output so command/path/output text can be selected and copied while setup is still running.
- Enforced SQL and renderer color lint checks in CI.
- Patched dependency advisories by pinning updated `brace-expansion`, `ws`, and `protobufjs` resolutions.

## v1.0.0-beta.11 - 2026-05-19

- Added archived-thread settings with project/profile grouping, restored-thread filtering, and worktree restore handling.
- Added visible Codex environment setup and action-run failure diagnostics, including streamed command output, status anchors above the composer, dismiss controls, and safer stale-run cleanup.
- Added first-run profile bootstrap plumbing so new profiles can defer Codex thread loading until onboarding completes when the onboarding gate is enabled.
- Improved LiveWorkRail behavior with a working collapse chevron, merged summary title, sticky per-file diff headers, and real Electron E2E coverage for collapse behavior.
- Improved theme polish with renderer color-literal linting, light/dark token documentation, screenshot theme/density controls, synced appearance updates across auxiliary windows, and better light-theme titlebar contrast.
- Fixed compact-density skill chips so composer and transcript chips remain visible outside the thread list.
- Updated GitHub Actions dependency maintenance to focus Dependabot on major action bumps, including release/download-artifact and docs-site action updates.

## v1.0.0-beta.10 - 2026-05-18

- Added a live work rail above the composer that keeps active and last-turn plan, edited-files, and changed-files context visible without duplicating transcript rows.
- Added inline expansion for edited-file diffs in the live work rail, plus collapse and sidebar docking controls for the rail.
- Added a macOS Profiles menu and profile switching flow so profiles can be opened and managed from the app menu.
- Fixed git worktree and handoff operations so git commands run with the prepared desktop environment instead of a stale or incomplete process environment.
- Improved transcript ordering and file-change rendering coverage around live work, changed files, and wall-clock timestamp ties.

## v1.0.0-beta.9 - 2026-05-18

- Fixed Settings -> Updates so the prerelease channel displays the highest available semver version instead of whichever GitHub prerelease appeared first by publish order.
- Fixed a transcript ordering race where file-change activity like "Changed 1 file" could appear after later tool or assistant activity during fast event bursts.
- Improved live file-change transcript handling so repeated file deltas merge through the same session-state path as other optimistic activity.

## v1.0.0-beta.8 - 2026-05-17

- Added an update channel setting so the desktop app can check either the latest stable release or prerelease builds.
- Added light/dark/auto appearance controls and density variants, with shared theme bootstrapping across desktop windows.
- Added pinned and manually sorted directories in the sidebar, including navigation persistence, reorder controls, and context-menu shortcuts.
- Added Settings access from the macOS app menu and gated developer-only menu items behind a desktop setting.
- Tightened directory row spacing, sidebar scrolling, and pin-reorder affordances.
- Fixed Codex environment setup path handling so configured setup commands stay bounded to the intended workspace.
- Cleared the axios advisory set with a pinned dependency override.
- Updated the README and docs site with stronger download/docs calls to action, accessibility checks, figure captions, and PwrAgent branding.

## v1.0.0-beta.7 - 2026-05-17

- Added desktop auto-update restart banner plumbing so installed updates can surface an in-app restart prompt in builds after this bridge release.
- Improved updater state handling with preload, IPC, renderer, and E2E coverage for update download and restart flows.
- Fixed the About settings version display so the packaged app no longer repeats the version string.
- Added Open Graph and Twitter Card metadata to the docs site for cleaner social previews.
- Updated the repository GitHub Sponsors metadata.

## v1.0.0-beta.6 - 2026-05-16

- Moved the macOS release pipeline to a two-stage build where the prepare job runs tests, builds the signing input without Apple secrets, hashes the artifact, and hands it to a protected signing job.
- Scoped Apple signing and notarization secrets to the GitHub `apple-signing` environment so the final release job requires explicit environment approval before secrets are exposed.
- Kept Universal macOS packaging and the stable `PwrAgent.dmg` latest-download alias while exercising the isolated signing flow.
- Updated the release runbook and release skill with the new environment approval expectations for beta/stable desktop releases.
- Added Dependabot workflow and package update coverage, including pinned GitHub Action bumps for the release workflow.

## v1.0.0-beta.5 - 2026-05-16

- Switched the macOS release build to a Universal Apple Silicon + Intel package, with versioned Universal DMG/ZIP artifacts and a stable `PwrAgent.dmg` alias for latest-release website downloads.
- Added persistent composer draft recovery so previous draft text can be restored with the Up Arrow after navigation, reloads, and app restarts.
- Fixed release and license help links so About/Settings opens the PwrAgent release page and bundled license disclosures in branded app windows.
- Fixed profile-scoped directory filtering so workspace rows and scratch projects stay tied to the active PwrAgent profile.
- Fixed Codex environment setup commands so actions run from the thread workspace instead of the wrong directory.
- Updated docs for composer draft recovery, Universal release packaging, and the public latest-DMG download flow.
- Updated the release skill and release runbook to match the Universal macOS workflow and stable `PwrAgent.dmg` alias.

## v1.0.0-beta.4 - 2026-05-16

- Added PwrAgent and Codex profile management, including profile-scoped settings, Codex account email display, and faster default-profile startup.
- Added Codex environment setup controls so launchpads can surface, configure, and run repository setup commands before starting work.
- Hardened Codex binary discovery by rejecting stale or blocked Codex executables before launch and improving PATH hydration for desktop sessions started outside a shell.
- Added Feishu / Lark messaging support with inbound event handling, outbound formatting, credential validation, settings UI, status icons, and setup docs.
- Expanded messaging controls with Full Access shortcuts, a monitor command, mention-help new-thread shortcuts, a skills browser in status cards, resume reply reposting, and safer lease cleanup during shutdown.
- Improved workspace and navigation reliability around managed worktree labels, worktree directory consolidation, selected-thread read state, PR terminal refreshes, branch-drift handling, context rail hover behavior, and stale PR chips.
- Improved desktop ergonomics with a logs help window, source links that open at target lines, copyable thread metadata chips, safer pasted text and image labels, visible directory header controls, and refined launchpad setup output.
- Published the first docs.pwragent.ai docs site with desktop, settings, messaging, provider setup, rate-limit, streaming, and Codex usage guides.
- Strengthened release and CI reliability with Node 24 action updates, docs-site-only CI skipping, pinned ripgrep installation, pnpm supply-chain hardening, binary asset attributes, and screenshot post-processing.

## v1.0.0-beta.3 - 2026-05-12

- Rebuilt the beta.2 release contents after fixing the ASAR verification rule that incorrectly rejected LINE's runtime PNG brand icon.
- Added a Full Access confirmation dialog that explains filesystem, network, exfiltration, and supply-chain risks before switching a thread or launchpad out of Default Access.
- Added LINE as a first-class messaging provider with webhook signature verification, outbound rendering, attachment handling, credential testing, settings UI, status icons, and setup docs.
- Improved desktop review workflows by queueing `/review` starts during active turns, preventing helper-thread title sync, and making review result cards wrap long file paths with clearer severity badges.
- Improved transcript markdown rendering with dedicated table bubbles, content-aware table column profiling, horizontal overflow handling, and better layouts for review/findings tables.
- Fixed several desktop stability issues, including navigation refresh loops, queued-turn release timing, accepted branch-drift state, Codex app-server PATH hydration, Git discovery failures, and stale messaging state for archived threads.
- Added in-app changelog access from Settings and the Help menu, with `CHANGELOG.md` shipped in the Electron bundle.
- Added native macOS screenshot capture tooling for README-quality desktop screenshots from replay fixtures.
- Polished messaging visuals and behavior with Slack activity icons, context-rail-safe status indicators, clearer git discovery failure surfaces, and safer Telegram/archived-thread state cleanup.

## v1.0.0-beta.2 - 2026-05-12

- Added a Full Access confirmation dialog that explains filesystem, network, exfiltration, and supply-chain risks before switching a thread or launchpad out of Default Access.
- Added LINE as a first-class messaging provider with webhook signature verification, outbound rendering, attachment handling, credential testing, settings UI, status icons, and setup docs.
- Improved desktop review workflows by queueing `/review` starts during active turns, preventing helper-thread title sync, and making review result cards wrap long file paths with clearer severity badges.
- Improved transcript markdown rendering with dedicated table bubbles, content-aware table column profiling, horizontal overflow handling, and better layouts for review/findings tables.
- Fixed several desktop stability issues, including navigation refresh loops, queued-turn release timing, accepted branch-drift state, Codex app-server PATH hydration, Git discovery failures, and stale messaging state for archived threads.
- Added in-app changelog access from Settings and the Help menu, with `CHANGELOG.md` shipped in the Electron bundle.
- Added native macOS screenshot capture tooling for README-quality desktop screenshots from replay fixtures.
- Polished messaging visuals and behavior with Slack activity icons, clearer git discovery failure surfaces, and safer Telegram/archived-thread state cleanup.

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
