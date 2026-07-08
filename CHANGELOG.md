# Changelog

## v1.0.0-beta.45 - 2026-07-07

- Agent Handoffs - Fixed delegated coding threads so handoff-created threads no longer appear as persona Agent threads, while explicit Agent flows and manually marked Agent threads keep their Agent marker.
- Thread Navigation - Normalized existing handoff threads on read so accidental Agent badges from older handoff instructions disappear without clearing intentionally marked Agent metadata.
- Worktree Branches - Improved grouped subthread branch pickers so they immediately show the full known branch inventory, reuse cached branch status across worktrees, and still keep per-worktree current branch and upstream state accurate.

## v1.0.0-beta.44 - 2026-07-07

- Review Command - Fixed `/review` in multi-worktree threads so PwrAgent requires the intended project when ambiguous, runs the review from the selected workspace, and uses the thread-derived base branch instead of guessing `main` or `master`.
- Edits Panel - Corrected edited-file diff stats so dirty chips expand collapsed untracked directories, zero-line changes use file-count labels, and the All files view shows the current net worktree diff instead of historical summed edits.
- Forked Threads - Kept forked-thread Edits views scoped to work done after the fork, so copied ancestor history no longer appears as edits made in the fork.
- Agent Handoffs - Fixed grouped handoffs launched from subthreads so new delegated threads stay visible as siblings under the root thread instead of disappearing as hidden grandchildren.
- Pricing - Preserved completed-turn usage durations after a turn settles or a thread is reopened, keeping elapsed-time cards consistent with live turns.
- Thread Titles - Stopped rejecting generated titles solely because they omit ticket or PR references from quoted prompt context.
- Dependencies - Refreshed production and development dependencies, including `node-pty`, Vite toolchain packages, and npm patch groups.

## v1.0.0-beta.43 - 2026-07-06

- Messaging Working Updates - Reworked messaging progress controls around a single Working Updates dial, with in-turn prose routed through the same coalescing policy and streaming controls hidden by default unless explicitly enabled.
- Messaging Streaming - Fixed provider streaming edits to coalesce with exponential backoff and flush final answers immediately, reducing Telegram/Slack/Mattermost rate-limit pressure during long turns.
- Inbound Automations - Hardened inbound-triggered automations with restart-safe hourly run caps, visible skipped-run markers for throttled messages, and provider-aware destination pickers that preserve friendly conversation titles.
- Slack Authorization - Fixed group-DM detection so Slack slash commands and block actions no longer trust spoofable `mpdm-` channel names when applying conversation access gates.
- Pricing - Added Live turn markers, running per-turn durations, observed cold/hot context replay counts, and sub-agent replay visibility so token usage and cost attribution match what the app actually observed.
- Forked Threads - Fixed forked-thread pricing so inherited parent context is shown as a zero-cost fork point instead of being re-billed as a historical usage estimate.
- Messaging Activity - Fixed the MSG titlebar popover hover path so operators can move from the status button into the panel without pinning it open.
- Tooling - Added correctness-only ESLint in CI without adopting Prettier, then reduced the baseline warning count by removing dead code and low-risk hygiene issues.

## v1.0.0-beta.42 - 2026-07-04

- Updates - Fixed macOS restart-to-update so Squirrel.Mac can finish swapping the downloaded app before PwrAgent quits or relaunches, preventing relaunch into the old version or exiting without applying the update.
- Release Publishing - Fixed prerelease-tagged builds so future beta releases are born as GitHub `Pre-release` instead of accidentally becoming Latest before operator promotion.
- Dependencies - Refreshed production AI and messaging SDK dependencies, including AI SDK, xAI, Feishu/Lark, LINE, and Mattermost packages.

## v1.0.0-beta.41 - 2026-07-03

- Inbound Automations - Added Slack and Telegram message-triggered automations with provider/conversation pickers, sender and text filters, live preview, task prompts, and reply-to-source or Agent-context-only results.
- Automation Safety - Added coalescing, idempotency, per-automation run limits, crash-safe delivery markers, and source-message loop protection for inbound-triggered runs.
- Slack Authorization - Redesigned Slack access around explicit DM, team, channel, channel-user, response-mode, and group-DM controls, with locked-down defaults for fresh configs.
- Slack Pairing and Settings - Reworked Slack pairing, onboarding, and Settings so operators can approve users, channels, and teams independently from one observed pairing flow.
- Messaging Delivery - Fixed provider streaming so Slack, Mattermost, and Feishu post the first stream chunk then edit it, and stopped completed turns from flooding channels with repeated final messages.
- Messaging Rate Limits - Updated Slack and Mattermost delivery budgets to allow normal agent-turn bursts while preserving throttling for real channel saturation.
- Thread Context - Added thread controls for removing stale PR associations and linking additional project directories without changing the underlying agent transcript.
- Agent Handoffs - Fixed cross-project handoffs so agents bind worktree creation to an explicit trusted target directory instead of accidentally reusing the parent workspace.
- Markdown Files - Added in-app previews for local `.md` transcript links and a detached Files window for opening multiple Markdown files in the thread workspace context.
- Composer and Markdown - Preserved bold/marked text around whitespace, horizontal rules, and `- --` list text across compose, edit, render, and copy-back flows.
- Integrated Terminal - Preserves live terminal views when switching threads or hiding the terminal, avoiding scrollback resets and replay noise.
- Review Command - Defaults bare `/review` to the base branch target, focuses the chooser, and lets Enter start the selected review without another click.
- Thread Search and Visibility - Thread search now finds pasted thread UUIDs, and clean Codex handoff threads stay visible in the interactive thread list.
- Messaging Activity - Made the Activity window denser, resizable, and collapsible; fixed the MSG titlebar control hover target across text and icons.
- Usage Visibility - Exposed system title-helper runs in sub-agent and pricing views so automatic thread naming is visible and attributable.
- Minor - Compact long environment action durations, fixed stale PR-chip tooltips after browser handoff, skipped disabled Grok thread listing noise, and updated `actions/checkout` to v7.

## v1.0.0-beta.40 - 2026-06-29

- Workspace Moves - Added same-thread workspace moves so agents can move the current thread into a linked worktree and continue there without creating a child handoff thread.
- Agent Coordination - Exposed pending workspace moves to thread inspection tools, deduped duplicate move requests, and kept queued turns behind the move continuation.
- Composer Paste - Fixed HTML-only pastes inside active code blocks and blockquotes so SQL and other multi-line content stays inside the current block.
- Thread State - Fixed idle thread refresh races that could detach an active review turn and leave the renderer stuck thinking after the review completed.
- Thread List Refresh - Pauses long-idle navigation polling after 30 minutes without activity and reduces repetitive diagnostics to debug logs.
- Composer State - Replaces promoted optimistic user-message placeholders when the matching real Codex item arrives, avoiding duplicate-looking prompts while preserving true repeated submissions.

## v1.0.0-beta.39 - 2026-06-28

- Workspace Handoffs - Improved handoff creation visibility so pending child-thread setup is surfaced before slow worktree or environment setup completes, reducing duplicate handoffs.
- Workspace Branch State - Fixed local handoff branch metadata so branch chips and drift checks recover from stale `HEAD` data and use the current linked checkout.
- Integrated Terminal - Fixed terminal launches to open in the thread's current handoff workspace instead of falling back to stale project metadata or the home directory.
- Startup Recovery - Skips unloadable automation rows created by newer builds without mutating them, reports skipped automations at startup, and shows a native error dialog with log access for early boot failures.
- Release Notes - Automated GitHub Release note publishing from `CHANGELOG.md` after release assets upload, with extraction tests and non-empty body verification.
- Minor - Refreshed TipTap/ProseMirror dependencies and third-party license metadata.

## v1.0.0-beta.38 - 2026-06-26

- Worktree Handoffs - Fixed new-worktree handoffs so requested worktree isolation is enforced, setup failures are surfaced, and agent-created threads cannot silently fall back to the caller's workspace.
- Worktree Forks - Improved fork-into-new-worktree flow with immediate environment setup progress, streamed setup output, and corrected branch metadata for detached destination worktrees.
- Branch Context - Added base-branch metadata to thread rows, branch tooltips, and agent-facing thread status so release-branch work can show base branch and ahead/behind-base state.
- Updates - Fixed update checks to ignore tag-only or assetless failed releases instead of 404ing on a missing latest-mac.yml.
- Release Packaging - Pinned Windows packaging to the Visual Studio 2022 runner path and locked that expectation in release:check so native rebuilds do not fail on VS 2026 runner images.
- Reliability - Bounded SQLite WAL/log churn and added guardrails against future append-heavy autoincrement tables.

## v1.0.0-beta.37 - 2026-06-24

- Thread Pricing - Enabled the Pricing tab by default and kept sub-agent rows aligned with the selected USD and Codex Credits display units.
- Agent Handoffs - Fixed agent-created handoffs so ungrouped delegated threads can no longer silently reuse the caller's worktree outside grouped subthreads.
- Shutdown Reliability - Quieted branch-drift and app-server close races so late Codex responses and shutdown refreshes do not produce noisy errors during app close.
- Security and Dependencies - Updated production and test dependencies, refreshed third-party licenses, and forced transitive Undici versions to patched releases.
- Minor Fixes - Fixed reasoning-only and empty tool-response handling in the legacy direct-xAI Grok backend. This does not apply to Grok Build via ACP.

## v1.0.0-beta.36 - 2026-06-21

- Agent Handoff Tools - Added PwrAgent app, thread, messaging, and task handoff tools so agents can inspect and coordinate work across PwrAgent surfaces.
- Codex Subagents - Added native Codex subagent visibility in the context rail, including clearer subagent kinds and details.
- Integrated Terminal - Added a per-thread terminal from the thread header so command-line work can stay attached to the active thread and workspace.
- Worktree Edits - Added non-turn file changes to the context rail and sidebar chips, while filtering noisy untracked directories and deduping active-turn edits.
- Pricing - Added a persistent thread pricing ledger with running totals, context replay estimates, and corrected GPT-5.5 historical pricing.
- Messaging Attachments - Added Markdown artifact previews and file attachments so messaging surfaces can share generated docs and inspect attachments from agent tools.
- Messaging Questionnaires - Added support for Codex skill questionnaires, durable pending prompts, and direct final-answer submission from messaging flows.
- Worktree Launchpad - Added a searchable branch picker and unified project/branch picker popovers for repos with many branches.
- Composer - Improved complex Markdown pastes, including blockquoted lists, mixed blockquote content, nested rich lists, and prefixed initial code blocks.
- Approvals - Improved approval prompts with backend-provided choices and clearer file-change approval context.
- Thread List - Fixed input-needed threads, delayed unread clearing, PR chip check refreshes, overflowing sidebar chips, and masthead/sidebar alignment.
- Thread UI - Improved env action cards, settings toggles, tooltip dismissal, image lightbox close behavior, terminal resize blending, and sidebar resize CPU usage.
- Security and Privacy - Avoided unnecessary keychain prompts and redacted Codex environment success logs.
- Minor - Refreshed PwrAgent v2 design prototypes, resolved Dependabot npm alerts, stabilized test flakes, improved CI ripgrep installation, and updated release-note guidance.

## v1.0.0-beta.35 - 2026-06-15

- Improved composer paste handling so rich clipboard content reconstructs lists, preserves inline code styling, and handles nested fenced code blocks consistently.
- Added Escape-key handling to close the thread search screen without disturbing the current thread context.
- Fixed pull-request progress chips so merged PR commits count as pushed work.
- Polished thread hierarchy layout by vertically centering the sub-thread toggle on the title line.
- Updated production and development dependencies, including Vite, Tiptap/ProseMirror, and Node type definitions.
- Fixed release packaging after the Vite/Rollup update by pinning Rollup to a mature native-binary set that satisfies the repository's dependency age policy.

## v1.0.0-beta.34 - 2026-06-15

- Added deep-linking from thread search results to the matched message, including loading older history when needed and landing on the highlighted match instead of the bottom of the thread.
- Improved edited-file rows with a single-row transcript layout, clearer status pills, ignored-file indicators, repo-relative paths, open-in-editor actions, and clickable timestamps that scroll back to the relevant transcript turn.
- Defaulted the context rail to pinned-open for discoverability while preserving explicit unpin preferences and fixing the rail resize handle accessibility contract.
- Improved pull-request status freshness by refreshing retained PR chips by URL and fanning out status updates to every matching PR key.
- Fixed startup blocking by profiling launch work, unblocking startup paths, and keeping Codex shell policy aligned with hydrated environment state.
- Fixed messaging-launched threads so launchpad environment setup runs before the first turn and environment selections are hydrated before the first prompt.
- Polished sidebar and thread-list layout with narrower lens labels, a compact "Dirs" label at small widths, flush sub-thread parent rows, standardized disclosure chevrons, and broader thread-list cache reuse.
- Fixed composer pastes that mix prose and fenced code so paragraph breaks are preserved when rich clipboard HTML is available.
- Fixed the release workflow's Windows setup path by avoiding the pnpm action setup failure mode on Windows runners.

## v1.0.0-beta.33 - 2026-06-14

- Added browser-style Back/Forward navigation across threads and search results, including keyboard and mouse navigation shortcuts.
- Added search shortcuts: Cmd/Ctrl+Shift+F for global thread search, Cmd/Ctrl+F for in-thread find, sidebar quick-jump, and PR-number search.
- Added Sub-thread and Fork actions to child thread cards, inserting new child threads directly below the source card without creating invisible deeper nesting.
- Moved edited files into the context rail, with per-turn grouping, persistent edit history, dirty/unpushed thread chips, and live git-state refresh.
- Added commit/push state badges for edited-file groups, including copyable short SHAs and clearer diff stat rendering.
- Polished the edited-files rail with fixed headers, controlled scrolling, better file-row sizing, pinned file rows, and bounded/debounced git-state resolution.
- Made Codex turn failures durable in the transcript and sidebar state, with sticky failure toasts and retained diagnostics.
- Tightened sidebar density, reduced gutters, capped long directory thread lists behind Show more/less, and improved thread chip ordering.
- Fixed transcript wrapping for long unbroken plain-text runs.
- Fixed malformed nested code fence rendering.
- Fixed stale messaging turns stuck in waiting state.
- Hid retired Codex 5.3 models.
- Improved branch-drift checks by reusing navigation thread lists.
- Reduced noisy per-thread routing logs during content search.

## v1.0.0-beta.32 - 2026-06-11

- Added a "without a directory" option for new threads so users can start work without first choosing or linking a project folder.
- Added independent draft, conflicted, and closed pull-request chip states so thread rows can show PR status more accurately.
- Improved the thread search panel with tighter integration and polish after the beta.31 search launch.
- Modeled Codex reviews as subagents and refined sub-agent cards in the context rail.
- Shared pull-request status across related threads and rendered Pull Requests as cards consistent with the Sub-Agents tab.
- Preserved image attachment filenames through composer and transcript handling.
- Added token usage cost breakdowns for completed turns.
- Clarified monitor command ownership in messaging and command surfaces.
- Fixed desktop polish issues including thin classic scrollbars and the macOS fullscreen stoplight inset.

## v1.0.0-beta.31 - 2026-06-11

- Added agentic thread search with a dedicated search panel, FTS-backed thread indexing, provider adapters, navigation contracts, and renderer/main coverage so users can search across existing agent threads instead of manually scanning the sidebar.
- Added subagent task monitoring and dynamic PwrAgent tool-routing foundations, including task monitor tools, thread and messaging agent tools, shared contracts, and backend wiring for future agent-driven thread and messaging workflows.
- Redesigned the thread context rail into tabbed panels for thread info, linked projects, pull requests, provider status, and subagents, with shell-level panel toggles and keyboard chords that avoid Windows double-toggle and macOS Option-compose issues.
- Improved Windows desktop behavior with custom frameless window chrome, source-display window placement, main-window-close app quit behavior, and a themed quit-confirmation dialog that hides the native menu bar.
- Improved composer and transcript usability with redesigned pasted-image attachments, materialized transcript data images, preserved Codex message timestamps and usage pricing, oversized diff omission, lower transcript DOM weight, and capped renderer protocol payloads.
- Improved messaging reliability with status card pickers, outbound activity summaries, transcript-tail resume reposts, deleted Telegram topic cleanup, projected launchpad option materialization, slow-mode status navigation, and ACP replay leak prevention.
- Added in-app update controls in Settings, clearer update actions, and corrected release process guidance so beta releases that should update users stay on GitHub's Latest channel.
- Expanded hot CPU diagnostics with capture presets, heap snapshot handoff, compact profile handoff behavior, paused wakeup sampling during CPU profiles, dev performance-measure pruning, and reduced replay typecheck overhead.
- Fixed environment setup, review turns, Kimi approval commands, PR/title detection, noisy logs, broken stdio failures, env-action elapsed formatting, sidebar sticky-header coverage, child-worktree branch selection, and launchpad review state seeding.
- Updated release/CI Actions to newer setup actions and added broad regression coverage across agent tools, backend registry behavior, messaging, transcript rendering, update checks, window placement, keyboard accelerators, thread search, and hot CPU profiling.

## v1.0.0-beta.30 - 2026-06-08

- Added the Windows port foundation with a Windows CI lane, NSIS installer packaging, Git-for-Windows bash command execution, process-tree cleanup, and cross-platform path handling. Windows installers are built as unsigned workflow artifacts while code signing is still pending.
- Fixed directory/thread organization so the same thread never appears under multiple directory rows, ACP worktree threads group under their repository row, and pinned thread ordering works globally across Codex and ACP backends.
- Fixed queued replies so they still dispatch after a completed turn changes branch state, while fresh sends continue to run the selected-thread branch-drift preflight.
- Improved messaging-launched threads so the first message is materialized through the normal launchpad path, environment setup can run before the first turn, and partial launch failures bind the created thread instead of orphaning it.
- Improved messaging status cards with real backend metadata for usage, account, and rate-limit state, while redacting OpenAI account email outside direct messages.
- Made onboarding messaging setup safer by making Skip the default action and gating Continue behind the acknowledgement checkbox with clearer visual feedback.
- Added clearer Env action feedback in the composer with immediate Run-button spinner state, second-granularity live durations, and a short success-confirmation window.
- Added Codex and ACP parity gates that compare real captured turns against the shared agent-kit normalizers, including the resolved ACP tool path parity fix.
- Updated desktop runtime, production, development, Tiptap/ProseMirror, Vite, and agent-kit dependencies; hardened CI/test behavior and purged raw protocol captures from fixtures.

## v1.0.0-beta.25 - 2026-06-07

- Reworked ACP provider discovery around the shared agent-kit multi-install engine so Gemini, Grok, Kimi, and Qwen can find PATH installs, well-known install directories, and manual overrides through one consistent path.
- Rebuilt Settings -> AI Providers so Codex and ACP providers live in one screen, each ACP provider appears even when it is not installed, discovered installs can be pinned with Using/Use rows, manual paths work across providers, and providers can be disabled individually.
- Fixed ACP chat launch selection so the launched provider binary matches the install shown as Using in Settings and disabled providers are hidden from new-thread choices.
- Fixed Kimi Code mode handling so Kimi uses one ACP runtime-mode selector and no longer sends the legacy rejected `/yolo` command when the provider advertises its own modes.
- Fixed Gemini ACP recovery paths so failed launchpads can return to the editable draft, concrete Homebrew/user-bin executables are preferred, slow provider failures show visible waiting activity, and reloaded Gemini threads keep their real history.
- Improved ACP transcript reliability by keeping live tool activity in transcript order and adding local smoke/parity harnesses for real-agent ACP validation and the next normalizer migration.
- Moved shared Codex discovery, JSON-RPC, and ACP substrate toward published `@pwrdrvr` agent-kit packages while preserving release/license metadata.
- Fixed smaller desktop and release issues including skill catalog refresh after changes, latest-request token-usage labeling, onboarding profile graduation, release download stats, and the Electron 41.7.1 patch update.

## v1.0.0-beta.24 - 2026-06-06

- Fixed local Codex environment hydration so successful project setup can preserve non-secret toolchain environment values for future local Codex threads and environment actions.
- Improved terminal outcome notifications with short auto-close behavior, stale notification cleanup when a new turn starts, Show routing, and clearer project/thread context.
- Added profile-scoped persistence for the selected thread-list lens so PwrAgent reopens on the last-used Inbox, Created, or Directories view without first painting the default tab.
- Reduced renderer CPU from thinking scanner animations by moving scanner phase alignment into CSS animation delays instead of frame-by-frame root variable updates.
- Added release maintenance-branch support for future long-lived `releases/<major>.<minor>` patch trains, with CI and release metadata checks covering `releases/**`.
- Tightened Codex environment profile test isolation so CODEX_HOME assertions no longer leak through the real login-shell environment probe.

## v1.0.0-beta.23 - 2026-06-05

- Fixed Kimi Code ACP discovery so GUI-launched PwrAgent can find the default `~/.kimi-code/bin/kimi` install path and detect ACP support from the `kimi acp --help` exit code instead of brittle help text.
- Added a durable ACP capability freshness cache so opening Settings no longer launches every discovered ACP agent just to refresh capabilities and model lists.
- Improved hot renderer CPU diagnostics with per-core CPU percentages, Settings controls, bounded heap snapshot capture, and live profiler reconfiguration without an app restart.
- Added more preset thread reactions in the thread-list reaction picker.
- Switched desktop Codex App Server protocol usage to the published `@pwrdrvr/codex-app-server-protocol` package while keeping dependency boundaries intact.
- Fixed release packaging so the Lark Suite axios-range shim follows the deployed SDK version instead of silently breaking on SDK upgrades.

## v1.0.0-beta.22 - 2026-06-04

- Fixed native desktop approval notifications so the notification `Approve` action resolves the pending approval through the normal server-request flow, contributed by Serhii Novachenko (@serejja) in #637.
- Kept unsupported platforms on passive notification behavior while sharing approval decision mapping between renderer and notification approval paths.

## v1.0.0-beta.21 - 2026-06-03

- Added sub-thread grouping in the sidebar and real Codex thread forks, including same-worktree forks, managed-worktree forks, UI-only sub-thread launchpad creation, collapse state, and child ordering in thread lists.
- Added the foundation for Codex thread migration between profiles, with Settings -> Thread Management source selection, Copy/Move starts, replay validation, source archive safeguards, and main-process-only rollout path handling.
- Added bounded scrolling for long transcript code blocks and blockquotes so large outputs stay readable without stretching the entire transcript.
- Added a native File -> New Thread command with `CmdOrCtrl+N`, contributed by Serhii Novachenko (@serejja) in #628.
- Added sidebar masthead tooltips for Automations, Settings, and New Thread icon buttons, contributed by Serhii Novachenko (@serejja) in #627.
- Added hot renderer CPU diagnostics that can be enabled from Settings in packaged builds and writes profile-scoped `.cpuprofile` artifacts after sustained renderer CPU spikes.
- Fixed queued and review turn handling so queued blockers persist per thread, stale review Thinking/Stop state clears correctly, and failed or cancelled pre-start queued turns clean up visible pending UI.
- Fixed Codex terminal turn failures so failed turns surface in the transcript and bound messaging conversations instead of disappearing into logs.
- Fixed transcript and automation polish including markdown rendering for automation details, slash autocomplete reopening after query edits, copyable pull request URLs from thread-list chips, and dependency/update maintenance.

## v1.0.0-beta.20 - 2026-06-01

- Added Qwen Code as a first-class ACP backend with local discovery, configurable executable path, model/mode support, launchpad/runtime plumbing, and Qwen-specific permission handling.
- Added provider-native commands in the composer slash menu so ACP/Codex command shortcuts can be surfaced from the active backend while preserving local skill mentions.
- Added a messaging status controller popover with a master on/off switch, per-platform status rows, degradation details, and quick access to messaging activity.
- Added quit confirmation when Codex or ACP threads are active or queued, with a Settings -> General opt-out for operators who prefer immediate quit behavior.
- Improved turn reliability by queueing follow-up sends while a thread is thinking, stabilizing review turns, and preventing queued review dispatch races.
- Improved Codex Fast mode behavior by wiring the Fast checkbox to Codex's `priority` service tier, clearing stale service tiers when Fast is off, and keeping launchpad settings aligned with the submitted UI state.
- Improved Codex usage and transcript handling with image-token accounting, cached/uncached/reasoning token display, list-price estimates, reusable local image inputs, and stronger hydration for image turns.
- Improved environment actions with clearer spawn-failure diagnostics, stale-shell fallback behavior, terminal-ordered stdout/stderr output, stable live-output selection, and protocol-capture support.
- Fixed desktop usability issues including spellcheck context menus, copyable activity/error cards, clearer unavailable reasons when Codex is logged out, external Codex session filtering, generated Codex chat cleanup, image-only steering-card cleanup, and safer shutdown window lifecycle handling.
- Improved performance, packaging, and maintenance with lazy-loaded Settings/Onboarding screens, renderer vendor chunk splitting, Electron runtime repair, normalized profile log scoping, quieter background polling logs, and dependency updates.

## v1.0.0-beta.19 - 2026-05-30

- Added opt-in native attention notifications for background approval requests, user-input questions, and terminal turn completion/failure/cancellation, contributed by Serhii Novachenko (@serejja) in #578.
- Fixed onboarding wizard and Codex config warning overlay clickability while preserving draggable titlebar behavior, contributed by Serhii Kushch (@serhiikushch) in #588.
- Added the Grok CLI ACP backend with local discovery, custom path override, Default/Full Access control via `/always-approve`, Grok session-summary title updates, and canonical Grok transcript/backend labels.
- Hid the legacy direct-xAI AgentCore Grok backend behind an experimental flag and clarified that the Settings → Models Grok API key only applies to that experimental backend.
- Removed the misleading editable Codex profile strategy control from Settings → General while keeping onboarding replay inference for existing profile pairings.
- Improved desktop runtime dependency handling by separating Electron-adjacent Dependabot groups and adding a fallback that verifies and restores a runnable Electron binary after install.
- Updated Electron and development tooling dependencies, then restored the pinned runtime path required by CI and packaging.

## v1.0.0-beta.18 - 2026-05-26

- Added Agent-attached automation scheduling with interval, weekday, and weekly schedules, run history, startup reconciliation, manual runs, messaging delivery, and global Automations management.
- Added automation inspection tools for Agent threads so agents can inspect attached automations, recent runs, and captured run artifacts without injecting synthetic transcript context.
- Added Kimi Code CLI as a first-class ACP backend with local discovery, backend labels, launchpad/runtime plumbing, permission-mode handling, and serialized hidden control prompts for Full Access.
- Improved ACP transcript and history handling with metadata-only session rows, append-only rollout JSONL fallback history, provider `session/load` replay preference, thought/commentary streaming, and protocol capture coverage.
- Added an experimental setting to filter unrelated live transcript events so noisy background threads do not churn the selected thread session state.
- Moved the operator docs site out of this repo into `pwrdrvr/docs.pwragent.ai`, with screenshot capture tooling updated for the sibling docs checkout.
- Added docs screenshot capture coverage for onboarding wizard and LiveWorkRail.
- Updated production dependencies, including Tiptap, React, better-sqlite3, electron-log, AI SDK/xAI, Discord, Feishu, Slack, and Grammy.
- Fixed dependency hygiene with a `qs` security override for Feishu SDK, a Node v24-aligned `@types/node` pin, and minor dev-tool updates.
- Fixed the release workflow typecheck heap limit that caused the `v1.0.0-beta.17` prepare job to abort before publishing.

## v1.0.0-beta.17 - 2026-05-26

- Added Agent-attached automation scheduling with interval, weekday, and weekly schedules, run history, startup reconciliation, manual runs, messaging delivery, and global Automations management.
- Added automation inspection tools for Agent threads so agents can inspect attached automations, recent runs, and captured run artifacts without injecting synthetic transcript context.
- Added Kimi Code CLI as a first-class ACP backend with local discovery, backend labels, launchpad/runtime plumbing, permission-mode handling, and serialized hidden control prompts for Full Access.
- Improved ACP transcript and history handling with metadata-only session rows, append-only rollout JSONL fallback history, provider `session/load` replay preference, thought/commentary streaming, and protocol capture coverage.
- Added an experimental setting to filter unrelated live transcript events so noisy background threads do not churn the selected thread session state.
- Moved the operator docs site out of this repo into `pwrdrvr/docs.pwragent.ai`, with screenshot capture tooling updated for the sibling docs checkout.
- Added docs screenshot capture coverage for onboarding wizard and LiveWorkRail.
- Updated production dependencies, including Tiptap, React, better-sqlite3, electron-log, AI SDK/xAI, Discord, Feishu, Slack, and Grammy.
- Fixed dependency hygiene with a `qs` security override for Feishu SDK, a Node v24-aligned `@types/node` pin, and minor dev-tool updates.

## v1.0.0-beta.16 - 2026-05-23

- Added Linux Debian package release support for x64/amd64 and arm64, with stable latest-download aliases, manual package upgrades, desktop launcher integration, and published `SHA256SUMS`.
- Added ACP registry-backed desktop backends with allowlisted agent discovery, install records, Settings management, stdio runtime support, and hardened binary checksum/platform checks.
- Added ACP runtime mode selection in messaging flows so `/new` and bound-thread status cards expose discovered runtime modes and keep privileged modes gated.
- Added explicit backend/provider selection for messaging-created new threads, including `/new`, `/resume --new`, and New help actions.
- Added Telegram forum topic ownership so monitor fanout can create, bind, report permissions for, and safely clean up thread-owned topics.
- Surfaced Codex config trust warnings in the desktop UI with a Trust action for project-local config, hooks, and exec policy warnings.
- Surfaced subagent review/collaboration activity in transcripts, including spawned/waited agent status and returned agent output.
- Fixed long threads opening at the top and made Jump to latest land at the bottom in one click.
- Fixed messaging Full Access approvals so inherited Full Access can start cleanly while explicit escalation remains guarded.
- Fixed Workspace worktree handoff controls for non-git workspaces, composer inline-mode escape behavior, thread title hit targets, and repaired-mtime thread timestamps.
- Fixed Linux Debian metadata so package builds include the required project homepage.
- Fixed Linux packaging so electron-builder accepts the deployed Feishu SDK dependency tree after the root `axios` security override.
- Fixed the Linux desktop-entry packaging configuration that caused the `v1.0.0-beta.14` release workflow to fail before artifacts were published.

## v1.0.0-beta.15 - 2026-05-23

- Added Linux Debian package release support for x64/amd64 and arm64, with stable latest-download aliases, manual package upgrades, desktop launcher integration, and published `SHA256SUMS`.
- Added ACP registry-backed desktop backends with allowlisted agent discovery, install records, Settings management, stdio runtime support, and hardened binary checksum/platform checks.
- Added ACP runtime mode selection in messaging flows so `/new` and bound-thread status cards expose discovered runtime modes and keep privileged modes gated.
- Added explicit backend/provider selection for messaging-created new threads, including `/new`, `/resume --new`, and New help actions.
- Added Telegram forum topic ownership so monitor fanout can create, bind, report permissions for, and safely clean up thread-owned topics.
- Surfaced Codex config trust warnings in the desktop UI with a Trust action for project-local config, hooks, and exec policy warnings.
- Surfaced subagent review/collaboration activity in transcripts, including spawned/waited agent status and returned agent output.
- Fixed long threads opening at the top and made Jump to latest land at the bottom in one click.
- Fixed messaging Full Access approvals so inherited Full Access can start cleanly while explicit escalation remains guarded.
- Fixed Workspace worktree handoff controls for non-git workspaces, composer inline-mode escape behavior, thread title hit targets, and repaired-mtime thread timestamps.
- Fixed the Linux desktop-entry packaging configuration that caused the `v1.0.0-beta.14` release workflow to fail before artifacts were published.

## v1.0.0-beta.14 - 2026-05-23

- Added Linux Debian package release support for x64/amd64 and arm64, with stable latest-download aliases, manual package upgrades, desktop launcher integration, and published `SHA256SUMS`.
- Added ACP registry-backed desktop backends with allowlisted agent discovery, install records, Settings management, stdio runtime support, and hardened binary checksum/platform checks.
- Added ACP runtime mode selection in messaging flows so `/new` and bound-thread status cards expose discovered runtime modes and keep privileged modes gated.
- Added explicit backend/provider selection for messaging-created new threads, including `/new`, `/resume --new`, and New help actions.
- Added Telegram forum topic ownership so monitor fanout can create, bind, report permissions for, and safely clean up thread-owned topics.
- Surfaced Codex config trust warnings in the desktop UI with a Trust action for project-local config, hooks, and exec policy warnings.
- Surfaced subagent review/collaboration activity in transcripts, including spawned/waited agent status and returned agent output.
- Fixed long threads opening at the top and made Jump to latest land at the bottom in one click.
- Fixed messaging Full Access approvals so inherited Full Access can start cleanly while explicit escalation remains guarded.
- Fixed Workspace worktree handoff controls for non-git workspaces, composer inline-mode escape behavior, thread title hit targets, and repaired-mtime thread timestamps.

## v1.0.0-beta.13 - 2026-05-22

- Added transcript copy controls for full messages, code blocks, blockquotes, and launchpad error text.
- Added selected-thread project breadcrumbs, with a clickable thread title that scrolls the matching sidebar row into view.
- Fixed transcript wrapping for long inline and fenced-code lines.
- Added the first-run onboarding wizard, including theme/density setup, Codex profile model selection, optional messaging setup, paired PwrAgent/Codex profile provisioning, and replay support.
- Added bootstrap-mode startup so fresh installs and missing profile names no longer silently create or bind to the operator's existing `default` Codex profile.
- Added onboarding prerequisite checks for Codex CLI discovery and xAI API key setup, with Linux discovery paths and deferred Codex spawning while onboarding is incomplete.
- Fixed onboarding messaging setup so provider secrets start the runtime during the wizard, pairing can be approved inline, and Telegram pairing is more tolerant of whitespace and typo cases.
- Fixed queued-turn release handling to prevent duplicate queued turn submission.
- Fixed Linux auxiliary window menus and Linux onboarding startup behavior.
- Fixed empty thread panes and directory headers so window dragging/selection chrome behaves correctly.
- Added an Apple signing secret upload helper for release maintenance.

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
