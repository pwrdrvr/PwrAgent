---
title: Desktop Design Overhaul (Tangerine Terminal v2)
type: feat
status: completed
date: 2026-05-04
---

# Desktop Design Overhaul (Tangerine Terminal v2)

## Overview

Apply a comprehensive design refresh to the PwrAgent desktop renderer based on
the latest design exploration, then build the supporting features (messaging
status, thread reactions, PR chips, messaging activity screen, sticky directory
headers, application icon glyphs) and the long-overdue Diff Eliding setting
that gates xAI requests we currently send unconditionally.

The plan is intentionally **wireframe-first then feature-by-feature**. Each
implementation unit ships a slice that is independently testable and visually
verifiable, so the user can sign off (or course-correct) before the next unit
starts. CSS-only units must not change wiring, event handling, or persistence
shape; functional units carry their own contract and persistence changes.

## Problem Statement

The current desktop UI works but has accumulated several rough edges that the
design exploration calls out:

1. **Emoji as iconography** — `📁`, `🗂`, `🌿`, `⚙️` etc. ship as text glyphs,
   render inconsistently across macOS versions, and look amateurish next to the
   product's "Tangerine Terminal" thesis. The branch and folder icons in the
   sidebar masthead are *also* too thin and low-contrast against the
   near-black surface.
2. **Settings screens are awkward** — back button is on the far right,
   layout pattern doesn't accommodate inline help, no "test connection"
   affordance for credential-based settings (Messaging, Models). Adding more
   settings will keep widening these gaps.
3. **Messaging is opaque** — there is no in-product way to see whether
   Telegram/Discord are running, no way to safely toggle them off without
   restarting the app, no per-thread visibility into which platforms a thread
   is bound to, no way to unbind from the desktop, and no audit log of who
   has been messaging the agent. Security-sensitive: the user wants to be
   able to spot "is someone else in my Telegram talking to my agent."
4. **Thread list is information-thin for active work** — no PR chips, no
   per-thread status reactions, directory header scrolls away on long
   directory lists.
5. **Diff Eliding is unimplemented** — we may be sending xAI condensation
   requests on every turn, with no setting to disable or pin to a specific
   model. The user explicitly believes this has been firing daily without
   their consent.

## Proposed Solution

A four-phase rollout. Phase 0 introduces shared infrastructure (icon library,
status tokens). Phase 1 applies the visual style pass across existing screens
without changing any behavior. Phases 2–4 add the new functional surfaces
(Diff Eliding, sticky headers, reactions, PR chips, messaging status,
activity screen). Each phase ends in a stable, ship-able state.

The design exploration is the **visual reference**, not the spec. The user
has explicitly overridden several proposals from it (see *Design Overrides*
below) — when the design exploration and this plan disagree, the plan wins.

## Design Overrides (from user direction)

These take precedence over the design exploration:

1. **Keep the existing thinking / in-progress indicators** on thread rows and
   in the chat. Do not replace with the design exploration's variant.
2. **Keep the unread cookie indicator** on the thread list. Do not replace.
3. **Keep the moon-phase context-window indicator** as it is.
4. **Diff Eliding setting under Experimental is required** and must wire
   through to actually gate the xAI condensation requests (see U2.1, U2.2).
5. **Drop the design exploration's "Other" experimental settings** — those
   were placeholder examples. Adapt and **keep our existing experimental
   settings** as-is.
6. **Left bar / top of window stays approximately as it is now.** The design
   exploration has a pixel-alignment artifact where a horizontal divider
   crosses the sidebar; we don't need that divider on the sidebar at all.
   The recent context-rail-restoration and stoplight-alignment work
   (commits `a4e8b422`, `3d947c4c`) is correct and must not regress.

## Technical Approach

### Architecture

#### Affected surfaces

| Area | Files |
|------|-------|
| Sidebar header / chrome | [apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx](apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx) |
| Thread rows + chips | [apps/desktop/src/renderer/src/features/navigation/ThreadRow.tsx](apps/desktop/src/renderer/src/features/navigation/ThreadRow.tsx), [apps/desktop/src/renderer/src/features/navigation/ThreadMetaChips.tsx](apps/desktop/src/renderer/src/features/navigation/ThreadMetaChips.tsx) |
| Directory list | [apps/desktop/src/renderer/src/features/navigation/DirectoriesList.tsx](apps/desktop/src/renderer/src/features/navigation/DirectoriesList.tsx) |
| Settings shell | [apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx](apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx), `*Settings.tsx` siblings, [apps/desktop/src/renderer/src/features/settings/settings-fields.ts](apps/desktop/src/renderer/src/features/settings/settings-fields.ts) |
| Theme tokens | [apps/desktop/src/renderer/src/styles/app.css](apps/desktop/src/renderer/src/styles/app.css), [docs/UI-THEME.md](docs/UI-THEME.md) |
| Messaging runtime | [apps/desktop/src/main/messaging/messaging-runtime.ts](apps/desktop/src/main/messaging/messaging-runtime.ts), [apps/desktop/src/main/messaging/messaging-config.ts](apps/desktop/src/main/messaging/messaging-config.ts), [packages/messaging/](packages/messaging/) |
| xAI condensation | [packages/agent-core/src/providers/xai-ai-sdk-object-client.ts](packages/agent-core/src/providers/xai-ai-sdk-object-client.ts) and its callers |
| Overlay state (reactions, PRs) | [apps/desktop/src/main/state/overlay-store-sqlite.ts](apps/desktop/src/main/state/overlay-store-sqlite.ts) |
| Settings persistence | [apps/desktop/src/main/settings/desktop-settings-service.ts](apps/desktop/src/main/settings/desktop-settings-service.ts) |
| Shared contracts | [packages/shared/src/contracts/navigation.ts](packages/shared/src/contracts/navigation.ts), `agent.ts`, `settings.ts` |
| Renderer hook | [apps/desktop/src/renderer/src/features/settings/useDesktopSettings.ts](apps/desktop/src/renderer/src/features/settings/useDesktopSettings.ts) |

#### New surfaces

- `apps/desktop/src/renderer/src/icons/` — centralized SVG icon components
  (folder, branch, worktree, telegram, discord, github, vscode, ghostty,
  terminal, neovim, etc.)
- `apps/desktop/src/renderer/src/features/messaging-activity/` — new screen
  for the per-thread messaging audit log
- `apps/desktop/src/renderer/src/features/threads/reactions/` — UI + hook
  for emoji reactions on rows
- `apps/desktop/src/renderer/src/features/pr-status/` — PR chip rendering
  and GitHub status fetcher (renderer-side cache, main-process fetcher)

### Implementation Phases

Each phase is one or more *implementation units*. Every unit lists Goal,
Files, Approach, Patterns to follow, Verification, Execution note, and Test
scenarios. Units within a phase usually depend on the previous one; phase
boundaries are stable ship points.

---

#### Phase 0 — Foundations (no user-visible change)

**U0.1: Centralized icon library**

- **Goal**: Replace inline SVGs and emoji glyphs with a small set of typed
  React icon components. Establish a single import path for any icon used
  across the renderer.
- **Files**:
  - new: `apps/desktop/src/renderer/src/icons/index.ts` — re-export all
  - new: `apps/desktop/src/renderer/src/icons/FolderIcon.tsx`,
    `BranchIcon.tsx`, `WorktreeIcon.tsx`, `WorkspaceIcon.tsx`,
    `TelegramIcon.tsx`, `DiscordIcon.tsx`, `GitHubIcon.tsx`,
    `SettingsIcon.tsx`, `NewThreadIcon.tsx`, etc.
  - update: any current callers of inline SVGs (Sidebar masthead,
    ThreadMetaChips, ThreadContextPanel, settings rows)
- **Approach**: Functional components with `size`, `weight`, `className`
  props. Use `currentColor` for stroke/fill so callers control color via
  CSS. Default `strokeWidth: 1.75` (heavier than current 1.5 — matches
  user's "more weight" complaint without going chunky). Pull existing
  inline SVG paths into the new components verbatim where possible.
- **Patterns to follow**: Match the existing inline SVG conventions in
  [Sidebar.tsx:273](apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx)
  (gear icon) and [Sidebar.tsx:284](apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx)
  (new-thread icon). Co-locate stories for each icon under
  `__tests__/icons-render.test.tsx`.
- **Verification**: Snapshot test renders every icon at default + hover
  size. Visual diff: no icon should change appearance for callers that
  haven't migrated yet (this unit only adds; U0.1 → U1.x removes
  duplicates). `pnpm typecheck` clean.
- **Execution note**: Pure additive. No behavior change.
- **Test scenarios**:
  - Each icon component accepts `size`, `className`, `aria-label` props
  - `currentColor` flows from parent CSS color
  - Snapshot stable across renders

---

**U0.2: Status tokens for indicator colors**

- **Goal**: Add semantic color tokens for state indicators
  (green/yellow/gray/red), and a small motion token for the "blink"
  animation used by messaging status indicators. Document in
  [docs/UI-THEME.md](docs/UI-THEME.md).
- **Files**:
  - update: [apps/desktop/src/renderer/src/styles/app.css](apps/desktop/src/renderer/src/styles/app.css)
    — add `--status-ok`, `--status-warning`, `--status-suspended`,
    `--status-error`, `@keyframes status-blink`, `.status-dot--blink`
  - update: [docs/UI-THEME.md](docs/UI-THEME.md) — document the new
    semantic tokens and constraint (status colors must remain low-volume
    relative to tangerine accent)
- **Approach**: Add the tokens directly under the existing
  `:root` block in `app.css`. Status colors should be muted enough that
  they read as functional state, not as decoration. Define the blink as
  `@keyframes status-blink { 0%,100% { opacity: 1 } 50% { opacity: 0.45 } }`
  with `animation: status-blink 1.6s ease-in-out infinite` on a
  `.status-dot--blink` modifier class. This animation will be reused by
  U4.1 (header platform status) and U4.3 (per-thread bound indicator).
- **Patterns to follow**: Existing `--accent-soft`, `--accent-bright`
  pattern in `app.css` for semitransparent variants.
- **Verification**: `app.css` lint passes (project uses no CSS linter
  beyond TS-side checks; visual review only). UI-THEME.md updated with
  the new tokens listed under "Status colors". No CSS rules currently
  rely on `--status-*` so this is purely additive.
- **Execution note**: Pure additive. No behavior change.
- **Test scenarios**: N/A (token-only).

---

#### Phase 1 — Visual styling pass (wireframe-level, no new features)

**U1.1: Sidebar masthead icons heavier and higher contrast**

- **Goal**: Increase weight and contrast of the folder/branch icons that
  render in the runtime-identity chips at the top of the sidebar. The
  user's specific complaint: these are "super thin, super difficult (low
  contrast) to see". Take cues from PwrSnap which uses the same theme but
  reads better.
- **Files**:
  - update: [apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx](apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx)
    around lines 568–588 (`RuntimeIdentityButton`)
  - update: [apps/desktop/src/renderer/src/styles/app.css](apps/desktop/src/renderer/src/styles/app.css)
    `.runtime-identity__icon` (line ~349)
- **Approach**: Swap the two inline SVGs in `RuntimeIdentityButton` for
  `<FolderIcon size={13} />` and `<BranchIcon size={13} />` from the new
  icon library. Bump `.runtime-identity__icon` color from
  `var(--accent-bright)` with `opacity: 0.9` to `var(--accent)` at full
  opacity (or a neutral `--text-secondary` at full opacity if the orange
  feels too loud against PwrSnap's reference). Increase the icon
  `strokeWidth` from `1.5` to `1.75` via the icon component default.
- **Patterns to follow**: Tangerine accent reserved for *active* state
  signals (see [docs/UI-THEME.md](docs/UI-THEME.md)). For these chips, the
  identity is informational, not active, so prefer
  `--text-primary` over accent — the chip already sits inside
  `var(--bg-panel)` which gives it enough surface contrast. Match
  PwrSnap's chip treatment for similar information density.
- **Verification**: Visual diff against the existing chips at the same
  zoom level — icons should be more legible without the chip becoming
  visually loud. No layout shift (chip height stays at 22px).
- **Execution note**: CSS + icon swap only. No event-handler changes,
  no DOM structure changes.
- **Test scenarios**:
  - Existing tooltip behavior (data-tooltip on hover) still works
  - Existing click-to-copy still works (`onClick` calls `copyText`)
  - Chip width unchanged at default sidebar width

---

**U1.2: Replace emoji glyphs across renderer**

- **Goal**: Retire emoji-as-icon usage in favor of the icon library.
  Specifically the `📁` / `🗂` / `•` ternary in
  [DirectoriesList.tsx:121](apps/desktop/src/renderer/src/features/navigation/DirectoriesList.tsx),
  any emojis in `ThreadMetaChips.tsx`, and any in `ThreadContextPanel.tsx`.
- **Files**:
  - update: [DirectoriesList.tsx](apps/desktop/src/renderer/src/features/navigation/DirectoriesList.tsx) — `kind` ternary at line 121
  - update: [ThreadMetaChips.tsx](apps/desktop/src/renderer/src/features/navigation/ThreadMetaChips.tsx) — audit for emoji usage
  - update: [ThreadContextPanel.tsx](apps/desktop/src/renderer/src/features/thread-detail/ThreadContextPanel.tsx) — audit for emoji usage
  - any other file flagged by `grep -rn "📁\|🗂\|🌿\|⚙️\|✏️" apps/desktop/src/renderer/src --include="*.tsx"`
- **Approach**: For each emoji, choose the closest icon component and
  swap. Where the emoji is purely status (e.g., a `•` for "unlinked"),
  keep a textual marker but replace the emoji with `<UnlinkedDotIcon />`
  or a styled span. Preserve `aria-label`s on whatever element previously
  held the emoji (or add them if missing).
- **Patterns to follow**: U0.1 icon component conventions. Keep icon
  size proportional to the surrounding text — directory header at 14px
  text gets a 14px or 16px icon.
- **Verification**: `grep -rn "📁\|🗂\|🌿\|⚙️\|✏️" apps/desktop/src/renderer/src --include="*.tsx"` returns no matches after this unit. Visual diff: no
  layout regressions in `RecentsList`, `InboxList`, `DirectoriesList`,
  `ThreadRow`, `ThreadMetaChips`. **Reactions emoji is intentionally
  excluded** from this rule — those are content, not iconography (see
  U3.2).
- **Execution note**: CSS + JSX swap only. Behavior unchanged.
- **Test scenarios**:
  - Existing snapshot tests in
    `apps/desktop/src/renderer/src/features/navigation/__tests__/`
    pass after snapshot updates
  - Each directory `kind` (`directory`, `workspace`, `unlinked`) renders
    a distinct visible icon
  - Screen-reader announces each icon via its `aria-label`

---

**U1.3: Settings screen layout rework**

- **Goal**: Replace the current settings shell with a new layout that:
  (a) shows the PwrAgent brand under the title-bar drag region,
  (b) puts a single `← Exit Settings` link in the top-left under the
      brand (not on the right),
  (c) provides a consistent two-column "label + control / inline help"
      pattern that scales as we add more settings,
  (d) doesn't shift the title-bar drag region or break stoplight
      alignment (recent commits handled this — don't regress).
- **Files**:
  - update: [SettingsScreen.tsx](apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx)
    — restructure header, exit affordance, section layout
  - update: each `*Settings.tsx` sibling
    (`MessagingSettings.tsx`, `ModelsSettings.tsx`,
    `ApplicationsSettings.tsx`, `WorktreesSettings.tsx`,
    `ExperimentalSettings.tsx`, `AboutSettings.tsx`) to use the new
    section/row/help slot pattern
  - update: `app.css` — new `.settings-shell`, `.settings-section`,
    `.settings-row`, `.settings-row__help` rules
- **Approach**: Introduce a small set of layout primitives in
  `SettingsScreen.tsx`: `<SettingsSection title description>`,
  `<SettingsRow label help control />`, where `help` accepts
  inline/markdown explanatory text. Migrate one settings file at a time
  to the new primitives — start with `ApplicationsSettings.tsx` (lowest
  risk, no credentials), end with `MessagingSettings.tsx` (highest risk,
  credentials in keychain). Keep the existing
  `useDesktopSettings` hook unchanged — only the JSX layout shifts.
- **Patterns to follow**: The composer's section pattern in
  [Composer.tsx](apps/desktop/src/renderer/src/features/composer/Composer.tsx)
  (label + control inline). Keep all existing `data-testid` attributes
  used by E2E tests in `apps/desktop/e2e/` so settings E2Es keep passing.
- **Verification**: `pnpm test apps/desktop/src/renderer/src/features/settings/__tests__/` passes (may require snapshot updates). Settings E2E
  spec [composer-draft-settings.spec.ts](apps/desktop/e2e/composer-draft-settings.spec.ts)
  passes. Visual: brand top-left, `← Exit Settings` directly below brand,
  single column of sections, each section header with optional helper
  text, each row with optional inline help.
- **Execution note**: Layout-only. The settings *fields* and their
  persistence stay identical. Migrate settings files one by one, run
  tests between each.
- **Test scenarios**:
  - Clicking `← Exit Settings` returns to the previous view
  - Each existing setting renders with its current value
  - Saving each setting still persists via `desktop-settings-service`
  - Title-bar stoplights remain at their current pixel positions
    (regression test: see [docs/plans/2026-05-04-...](docs/plans/) recent
    masthead/context-rail PRs)

---

**U1.4: Settings test/status indicators for credential-based settings**

- **Goal**: Add a "Test connection" affordance + status pill to settings
  that depend on external credentials: Telegram bot token, Discord bot
  token, xAI API key, Codex auth. Status reads "Confirmed" /
  "Could not connect: <reason>" / "Untested".
- **Files**:
  - new: `apps/desktop/src/renderer/src/features/settings/SettingsTestButton.tsx`
  - update: `MessagingSettings.tsx`, `ModelsSettings.tsx`
  - update: [apps/desktop/src/main/settings/desktop-settings-service.ts](apps/desktop/src/main/settings/desktop-settings-service.ts)
    — expose `testTelegramToken(token)`, `testDiscordToken(token)`,
    `testXaiApiKey(key)` IPC handlers
  - update: [packages/messaging/providers/telegram/](packages/messaging/providers/telegram/)
    — expose a lightweight `testToken(token): Promise<TestResult>`
    that calls Telegram `getMe` and returns
    `{ ok: true, accountName: string } | { ok: false, reason: string }`
  - same for Discord (use `users/@me`)
  - same for xAI (e.g., a 1-token chat completion against `gpt-3.5`-style
    health-check endpoint, or `models` list)
- **Approach**: The test buttons run against the *currently entered*
  value (which may be unsaved), not the persisted value, so the user can
  validate before committing. Show a spinner during the request, then
  the result pill. Persist the most recent test result alongside the
  setting so the user sees the state on re-entering the settings screen.
- **Patterns to follow**: Existing settings IPC patterns in
  `desktop-settings-service.ts`. The Telegram getMe call already exists
  in the adapter — extract it to a small testable function.
- **Verification**: With a known-good Telegram token, "Test connection"
  shows green pill with bot's display name. With an invalid token, shows
  red pill with the API's error message (e.g., "Unauthorized"). With no
  network, shows red pill with "Could not reach api.telegram.org".
  Settings persistence and adapter startup unchanged.
- **Execution note**: Test-first for the IPC handlers — write the
  handler unit test that asserts the structured TestResult shape before
  implementing.
- **Test scenarios**:
  - Telegram getMe success → `{ ok: true, accountName }`
  - Telegram 401 → `{ ok: false, reason: "Unauthorized" }`
  - Network failure → `{ ok: false, reason: "Could not reach …" }`
  - Discord users/@me parity behavior
  - xAI key check: success vs 401 vs network-out
  - The pill state survives a renderer reload (persisted result)
  - Adapter startup logs (from PR #163) are not duplicated by the test

---

**U1.5: Application icons for editor / terminal launchers**

- **Goal**: Replace the current "V VS Code" / "G Ghostty" letter chips
  below the composer with proper application glyphs. Same for any other
  launchers (Terminal, NeoVim) that the app discovers.
- **Files**:
  - new: `apps/desktop/src/renderer/src/icons/apps/VsCodeIcon.tsx`,
    `GhosttyIcon.tsx`, `TerminalIcon.tsx`, `NeoVimIcon.tsx`,
    `CursorIcon.tsx` (and any others surfaced by
    [discover-applications.ts](apps/desktop/src/main/applications/) — TBD)
  - update: the application-button row under the composer (in
    [Composer.tsx](apps/desktop/src/renderer/src/features/composer/Composer.tsx)
    around the "VS Code" / "Ghostty" buttons)
  - update: [ApplicationsSettings.tsx](apps/desktop/src/renderer/src/features/settings/ApplicationsSettings.tsx)
    to show the matching icon next to each discovered app
- **Approach**: Use simple monochrome glyphs in `currentColor`. We are
  intentionally NOT shipping multi-color brand marks (legal/distribution
  ambiguity, plus the design thesis is monochrome-with-tangerine).
  Provide a fallback `AppGlyphIcon` for unknown apps — a small
  squircle with the first letter of the app name (matches the current
  "V" / "G" chip placeholder behavior).
- **Patterns to follow**: U0.1 icon component conventions.
- **Verification**: Each known app's button shows its glyph instead of
  a letter. Unknown apps fall back to the lettered squircle. Click /
  keyboard activation behavior unchanged (`onClick` handler untouched).
- **Execution note**: JSX swap only. Application discovery, IPC
  handlers, and click behavior unchanged.
- **Test scenarios**:
  - VS Code button renders `VsCodeIcon`, opens VS Code on click
  - Unknown app falls back to lettered glyph
  - Settings screen shows the same icon next to the same app

---

#### Phase 2 — Diff Eliding (functional + setting)

**U2.1: Diff Eliding setting under Experimental**

- **Goal**: Add a setting under Experimental for "Diff condensation":
  a master enable/disable toggle, and a model selector
  (`Auto (match backend)` | one of the available models). When disabled,
  no condensation request is sent. When enabled with `Auto`, requests
  use the model that matches the active backend (Codex backend → use a
  Codex condensation; Grok backend → use Grok). When pinned to a
  specific model, all requests use that model regardless of backend.
- **Files**:
  - update: [packages/shared/src/contracts/settings.ts](packages/shared/src/contracts/settings.ts)
    — add `experimental.diffCondensation: { enabled: boolean; model: "auto" | string }`
  - update: [apps/desktop/src/main/settings/desktop-settings-service.ts](apps/desktop/src/main/settings/desktop-settings-service.ts)
    + matching test
  - update: [ExperimentalSettings.tsx](apps/desktop/src/renderer/src/features/settings/ExperimentalSettings.tsx)
    — render the toggle + model picker. Keep our existing experimental
    settings (the design exploration's "Other" examples are explicitly
    dropped per *Override #5*).
  - update: [useDesktopSettings.ts](apps/desktop/src/renderer/src/features/settings/useDesktopSettings.ts)
- **Approach**: Mirror the existing pattern for boolean experimental
  settings (e.g., `composerImplementation`). The model picker pulls from
  the same source `ModelsSettings.tsx` uses to list models, plus a
  prepended `Auto` option.
- **Patterns to follow**: Existing settings field patterns in
  [settings-fields.ts](apps/desktop/src/renderer/src/features/settings/settings-fields.ts).
  Experimental settings persist in the same toml/sqlite path as other
  settings (per [config-and-state-relocation](docs/brainstorms/2026-05-02-config-and-state-relocation-requirements.md)).
- **Verification**: Setting reads/writes round-trip across renderer
  reload. Default value is `{ enabled: false, model: "auto" }` —
  **disabled by default** so we stop sending these requests until the
  user opts in.
- **Execution note**: Test-first on the settings contract — add the
  schema test in
  [settings.test.ts](packages/shared/src/contracts/__tests__/settings.test.ts)
  before wiring the UI.
- **Test scenarios**:
  - Default snapshot includes `diffCondensation: { enabled: false, model: "auto" }`
  - Toggling enabled off then on round-trips through sqlite
  - Picking a specific model persists the model id
  - Picking `Auto` then a specific model then `Auto` again produces
    `"auto"` as the stored value

---

**U2.2: Wire Diff Eliding setting into xAI condensation requests**

- **Goal**: Make the setting actually gate requests. When disabled, the
  caller short-circuits without invoking
  [XaiAiSdkObjectClient](packages/agent-core/src/providers/xai-ai-sdk-object-client.ts).
  When enabled with `Auto`, use the existing per-backend default. When
  pinned, use the chosen model.
- **Files**:
  - identify the caller(s) of `XaiAiSdkObjectClient.generate*` — needs
    investigation; suspected callers include any
    `condense*` / `summarize*` paths in `agent-core` and the desktop
    main-process orchestration layer
  - update: those callers to read the setting (passed through the
    backend-registry layer, not by direct singleton import)
  - update: [packages/agent-core/](packages/agent-core/) condensation
    contract to accept `{ enabled: boolean; model: "auto" | string }`
- **Approach**: Treat this as **characterization-first** — the user
  believes these requests fire daily but the exact call sites and
  trigger conditions need to be mapped before adding gating logic. Step
  1: enumerate every call to `XaiAiSdkObjectClient` and document the
  trigger. Step 2: add a single chokepoint that consults the setting.
  Step 3: route all callers through the chokepoint.
- **Patterns to follow**: Settings flow into the backend layer through
  the existing `desktopSettingsService.readSettings()` + the
  `backend-registry.ts` orchestration. Avoid adding a new global; keep
  the setting passed as a parameter on the request boundary.
- **Verification**: With setting `enabled: false`, no xAI condensation
  request fires across an entire session of varied usage (verified by
  network log + provider-side `XaiAiSdkObjectClient` log entry). With
  `enabled: true, model: "auto"`, behavior matches the current
  always-on default. With `enabled: true, model: "grok-3"`, the request
  payload's model is `grok-3` regardless of backend.
- **Execution note**: Characterization-first. Map call sites first.
- **Test scenarios**:
  - Unit: condensation chokepoint with `enabled: false` returns input
    unchanged, no network call
  - Unit: chokepoint with `enabled: true, model: "auto"` selects the
    backend-default model
  - Unit: chokepoint with `enabled: true, model: "<specific>"` uses
    that model
  - Integration: a turn that previously triggered condensation now
    skips it when disabled
  - Operational: running the desktop app for ~30 minutes with the
    setting off shows zero `XaiAiSdkObjectClient` log entries

---

#### Phase 3 — Thread list polish

**U3.1: Sticky directory headers on Directories tab**

- **Goal**: When scrolling a long directory list on the Directories
  tab, the current directory's header should stick to the top of the
  scroll container so the user always knows which directory the visible
  rows belong to.
- **Files**:
  - update: [DirectoriesList.tsx](apps/desktop/src/renderer/src/features/navigation/DirectoriesList.tsx)
    — wrap each directory header in a `position: sticky` container
  - update: [app.css](apps/desktop/src/renderer/src/styles/app.css) —
    `.directories-list__header { position: sticky; top: 0; z-index: 5; background: var(--bg-sidebar); }` plus a subtle bottom border that
    appears on `.is-stuck` (detect via `IntersectionObserver` if needed)
- **Approach**: CSS-first. Native `position: sticky` works inside
  scroll containers if the parent doesn't have `overflow: hidden` on
  the wrong axis. May require minor restructuring of the list scroll
  container. Avoid JS-driven scroll handlers — they jitter on macOS
  rubber-band scroll.
- **Patterns to follow**: We don't currently have sticky elements;
  introduce the pattern carefully, with clear `z-index` semantics
  (sticky headers must layer above thread rows but below any
  popovers/menus).
- **Verification**: Scroll a directory list with 30+ threads. The
  current directory's header stays at the top of the scroll viewport
  until the next directory's header takes its place. No horizontal
  layout shift. Stoplights and sidebar masthead unaffected.
- **Execution note**: CSS-only. No state changes.
- **Test scenarios**:
  - With 3 directories of 20 threads each, scrolling reveals each
    directory's header at the top of the scroll area in turn
  - The header remains clickable (collapse/expand, "+" button) while
    stuck
  - When the directory is collapsed, no rows render and the header
    behaves like a normal flow element
  - Reduced motion preference: no animation on the stick transition

---

**U3.2: Thread reactions on rows**

- **Goal**: Add a small "add reaction" affordance on each thread row.
  Clicking opens a quick-pick of common reactions (`👀`, `✅`, `❌`,
  `😢`, `🚀`, `🎉`, custom) modeled on GitHub PR reactions. Reactions
  are user-owned (single user, this app) — no per-user tracking, just
  a set of emoji + count (count is always 1 here, so really just a
  set of emoji on each thread). The user uses these as personal status
  markers ("I need to come back to this when it finishes").
- **Files**:
  - update: [overlay-store-sqlite.ts](apps/desktop/src/main/state/overlay-store-sqlite.ts)
    — add a `reactions: string[]` field to the `ThreadOverlayState`
    JSON payload
  - update: [packages/shared/src/contracts/navigation.ts](packages/shared/src/contracts/navigation.ts)
    — add `reactions?: string[]` to `NavigationThreadSummary`
  - update: [backend-registry.ts](apps/desktop/src/main/app-server/backend-registry.ts)
    — IPC for `setThreadReaction(threadKey, emoji, present)` and
    surface reactions through the navigation snapshot
  - update: [ThreadRow.tsx](apps/desktop/src/renderer/src/features/navigation/ThreadRow.tsx)
    — render existing reactions, render an add button
  - new: `apps/desktop/src/renderer/src/features/threads/reactions/ReactionPicker.tsx`
- **Approach**: Reactions are stored as a `string[]` (deduped, ordered
  by insertion). Single user model means no count UI. Quick-pick popover
  uses a small fixed list (`👀 ✅ ❌ 😢 🚀 🎉`) plus a "More…" affordance
  that opens a system emoji picker (macOS `Cmd-Ctrl-Space` programmatic
  trigger, or a small in-app picker).
- **Patterns to follow**: The thread-row context menu pattern in
  `Sidebar.tsx` (overflow button → menu). Persistence layer mirrors how
  `lastSeenAt` and `dismissedAt` are stored on `ThreadOverlayState`.
- **Verification**: Adding a reaction persists across app restart.
  Removing a reaction removes it. Reactions render on the row in the
  order they were added. Click target is small enough not to crowd
  existing chips on dense rows.
- **Execution note**: Test-first on the persistence layer
  (`overlay-store-sqlite` tests in
  `apps/desktop/src/main/__tests__/`).
- **Test scenarios**:
  - Setting a reaction stores it in `directory_launchpads` /
    `threads` table JSON
  - Setting the same reaction twice is idempotent
  - Removing a reaction works
  - Navigation snapshot returns reactions to the renderer
  - UI: clicking add button opens picker, clicking emoji adds it,
    clicking an existing reaction removes it
  - E2E: add + reload + assert visible

---

**U3.3: PR chips on thread rows**

- **Goal**: When a thread has linked GitHub PRs, render compact chips
  on the row showing the PR number and status color (purple = merged,
  green = passing, red = failing, gray = draft / unknown). For threads
  with a single project, format as `#123`. For multi-project threads,
  format as `org/repo#123`.
- **Files**:
  - new: `apps/desktop/src/renderer/src/features/pr-status/PrChip.tsx`
  - new: `apps/desktop/src/main/pr-status/github-pr-fetcher.ts`
    — async fetcher with a small in-process cache and rate-limit awareness
  - new: `apps/desktop/src/main/pr-status/pr-detection.ts`
    — detect PRs from a thread's branch name (call `gh pr view --json`
    against the linked directory's git repo)
  - update: [packages/shared/src/contracts/navigation.ts](packages/shared/src/contracts/navigation.ts)
    — add `prs?: { number: number; org?: string; repo?: string; state: "merged" | "passing" | "failing" | "draft" | "unknown"; url: string }[]` to `NavigationThreadSummary`
  - update: [ThreadRow.tsx](apps/desktop/src/renderer/src/features/navigation/ThreadRow.tsx)
    — render PR chips after existing chips
- **Approach**: Use `gh` CLI (already required for our development
  workflow) for the PR detection. Cache PR status for 60 seconds per
  thread. When `gh` is not installed, gracefully degrade — no chip,
  no error toast. Chip color uses the new status tokens from U0.2.
- **Patterns to follow**: Background refresh patterns from
  [backend-registry.ts](apps/desktop/src/main/app-server/backend-registry.ts).
  Failure handling matches the existing thread-list refresh pattern
  (log + cache stale).
- **Verification**: A thread on a branch with an open PR shows a chip
  with the PR number and the right color. Merging the PR (and
  triggering a refresh) shows purple. A draft PR shows gray. No PR
  shows nothing (not an empty chip).
- **Execution note**: Characterization-first on the `gh` JSON output —
  pin the field shape we read so future `gh` versions don't surprise us.
- **Test scenarios**:
  - `gh pr view --json` parsing handles all four states
  - Multi-project thread renders `org/repo#NNN` format
  - Single-project thread renders `#NNN` format
  - `gh` not installed → no chip, no error
  - Network out → cached chip stays, log entry recorded
  - Click chip → opens PR URL in default browser

---

#### Phase 4 — Messaging UX

**U4.1: Header messaging platform status indicators**

- **Goal**: In the header (right side or top of the title/header area)
  show a Telegram icon and a Discord icon for each *configured*
  platform. Each icon has a small dot (bottom-right) colored by state:
  green = enabled & healthy, gray = configured but suspended, red =
  configured & errored. When the platform is sending or receiving for
  *any* thread, the dot blinks (uses U0.2's `.status-dot--blink`).
- **Files**:
  - new: `apps/desktop/src/renderer/src/features/messaging-status/MessagingStatusBar.tsx`
  - update: [packages/shared/src/contracts/agent.ts](packages/shared/src/contracts/agent.ts)
    — add a `MessagingPlatformStatus` event broadcast over the existing
    agent-event bus
  - update: [messaging-runtime.ts](apps/desktop/src/main/messaging/messaging-runtime.ts)
    — emit status changes (`enabled`, `suspended`, `errored`,
    `activity-start`, `activity-end`) over the bus
  - update: the renderer App shell to render `MessagingStatusBar` in
    the right side of the header next to the model status / settings gear
- **Approach**: Source of truth is the messaging runtime (main process)
  — it knows when adapters start, stop, succeed, fail. Renderer
  subscribes and renders. Activity blink fires on every inbound or
  outbound message and continues for as long as a typing indicator is
  shown on the platform side; debounce at the runtime so we don't blink
  on every chunk of a streamed response.
- **Patterns to follow**: The agent-event bus pattern that already
  pushes `AgentEvent` to the renderer (see
  [DesktopMessagingBackendBridge](apps/desktop/src/main/messaging/desktop-backend-bridge.ts)).
- **Verification**: Telegram-only configured → only Telegram icon in
  header. Both configured → both icons. Disabling Telegram in settings
  → its dot turns gray within 1s. Sending a Telegram message → dot
  blinks during streaming, stops within ~1s of completion.
- **Execution note**: Test-first on the event contract; implement
  runtime emission second; renderer last.
- **Test scenarios**:
  - Runtime emits `enabled`/`suspended`/`errored` transitions
  - Runtime emits `activity-start` on inbound, `activity-end` on
    typing-indicator-stop
  - Two platforms emit independent activity correctly
  - Renderer reflects state changes within 250ms
  - Reduced-motion preference disables blink animation

---

**U4.2: Header messaging on/off toggle**

- **Goal**: Add a small toggle (or a button that opens a tiny menu) in
  the header that lets the user disable all messaging without quitting.
  The toggle reflects current state — also shows "Off" if the app was
  launched with `--disable-messaging`. Toggling off should drain
  in-flight turns gracefully (don't kill mid-stream), then stop adapters
  and update each platform status to suspended.
- **Files**:
  - update: `MessagingStatusBar.tsx` from U4.1 — add the toggle
  - update: [messaging-runtime.ts](apps/desktop/src/main/messaging/messaging-runtime.ts)
    — add `pause()` / `resume()` on the runtime; pause stops adapters
    after current operations drain, resume re-runs the configured
    adapter factory
  - update: IPC layer — new `setMessagingEnabled(enabled: boolean)`
    handler
- **Approach**: `pause()` calls `adapter.stop?.()` after waiting for
  any in-flight work to settle (timeout: 5s, then force-stop). `resume()`
  re-runs `loadConfiguredMessagingAdapters` and restarts. The
  `--disable-messaging` startup flag remains the source of "we never
  even tried to start"; the toggle is layered on top and persists across
  restarts as a user setting (`messaging.userEnabled: boolean`).
- **Patterns to follow**: Existing `MessagingController.dispose()` and
  `messaging-runtime.stop()` patterns.
- **Verification**: Toggle off → all platforms drain & suspend within
  ~5s. Toggle on → platforms re-init and report green. Quit + relaunch
  → toggle state remembered. Launching with `--disable-messaging` shows
  toggle as Off and disables it (with tooltip explaining the flag).
- **Execution note**: Test-first on `runtime.pause()` /
  `runtime.resume()`.
- **Test scenarios**:
  - `pause()` waits for in-flight then stops
  - `resume()` re-creates adapters from current config
  - Multiple `pause()`/`resume()` cycles are safe
  - The user setting persists
  - The CLI flag overrides at startup

---

**U4.3: Per-thread messaging binding indicators + unbind**

- **Goal**: On thread rows that are bound to a messaging platform,
  render a small Telegram/Discord icon in the chip area. Tapping the
  icon opens a tiny menu with "Unbind from <platform>" — which removes
  the binding from the *desktop* side (so the desktop will stop
  responding to that platform's messages for this thread), with a clear
  hint that the user can also unbind from the platform itself if they
  want the binding fully gone there too. While the platform is
  actively sending/receiving for this specific thread, the per-thread
  binding dot blinks (mirrors U4.1, but per-thread).
- **Files**:
  - update: [packages/shared/src/contracts/navigation.ts](packages/shared/src/contracts/navigation.ts)
    — add `messagingBindings?: { platform: "telegram" | "discord" | …; conversationId: string; activeAt?: number }[]` to `NavigationThreadSummary`
  - update: [overlay-store-sqlite.ts](apps/desktop/src/main/state/overlay-store-sqlite.ts)
    — surface bindings (the messaging system already records these
    when threads bind via DM; we may need to add a column or read from
    the existing thread metadata)
  - update: [ThreadRow.tsx](apps/desktop/src/renderer/src/features/navigation/ThreadRow.tsx)
    — render binding icons + handle the unbind menu
  - update: [packages/messaging/](packages/messaging/) — new
    `unbindThread(platform, conversationId)` IPC + main-process handler
- **Approach**: Bindings already exist somewhere in the messaging
  layer (the controller knows which conversation owns which thread).
  Surface that to the navigation snapshot. The unbind action removes
  the binding from the desktop's record; subsequent messages from that
  platform conversation are treated as "ignored" (and surface in U4.4's
  Activity screen).
- **Patterns to follow**: Existing thread-row chip rendering and
  context menu patterns.
- **Verification**: A thread bound via Telegram shows a Telegram chip.
  Unbinding removes the chip. Subsequent inbound messages from the
  same Telegram conversation appear in the U4.4 Activity screen as
  "ignored" rather than creating a new thread.
- **Execution note**: Map current binding storage first; the messaging
  controller already manages this, the renderer just needs visibility.
- **Test scenarios**:
  - Bound thread shows correct platform chip
  - Unbind removes the chip and persists across restart
  - Inbound from unbound conversation goes to "ignored" log
  - Active sending/receiving for the thread blinks the chip dot

---

**U4.4: Messaging Activity screen**

- **Goal**: A new screen (opened from the U4.1 status bar — clicking a
  platform icon, or a dedicated "Activity" affordance) showing:
  (a) all currently-bound threads, with last-received and last-sent
      timestamps and counts
  (b) "Received but ignored" senders/groups — a list of inbound
      messages from senders not on the authorized list, or from
      conversations the user has unbound
  (c) per-binding ability to view recent messages and re-bind/unbind
- **Files**:
  - new: `apps/desktop/src/renderer/src/features/messaging-activity/MessagingActivityScreen.tsx`
  - new: `apps/desktop/src/renderer/src/features/messaging-activity/MessagingActivityList.tsx`
  - new: `apps/desktop/src/main/messaging/activity-log.ts` — small
    rolling log of inbound/outbound events (capped, persisted in sqlite)
  - update: `messaging-runtime.ts` and the per-platform adapters to
    push events into the activity log
  - update: nav routing to render the new screen
- **Approach**: The activity log is intentionally small (e.g., last
  500 events per platform, evicted FIFO). It lives in the same sqlite
  state DB. The screen is read-only except for re-bind/unbind actions
  which call into U4.3's IPC.
- **Patterns to follow**: Settings screen layout from U1.3 (we now
  have a good two-column shell for screens like this).
- **Verification**: Open the screen → see currently-bound threads with
  reasonable timestamps. Send a message from an unauthorized Telegram
  user → it appears in "Received but ignored" within ~1s.
- **Execution note**: Test-first on the activity log persistence layer.
- **Test scenarios**:
  - Activity log evicts at the cap
  - Authorized inbound logged + routed to thread
  - Unauthorized inbound logged + NOT routed
  - Outbound logged with the correct platform
  - Screen renders all three sections (bound, ignored, recent)
  - Unbind from screen propagates back to thread row (U4.3)

---

## Implementation Units (Summary Table)

| Unit | Phase | Dep | Scope | Risk | Execution Note |
|------|-------|-----|-------|------|----------------|
| U0.1 | 0 | — | Icon library | Low | Pure additive |
| U0.2 | 0 | — | Status tokens + blink keyframe | Low | Pure additive |
| U1.1 | 1 | U0.1 | Sidebar masthead icons | Low | CSS + icon swap |
| U1.2 | 1 | U0.1 | Replace emoji glyphs renderer-wide | Low | CSS + JSX swap |
| U1.3 | 1 | — | Settings layout rework | Medium | Migrate file-by-file, run tests between |
| U1.4 | 1 | U1.3, U0.2 | Settings test/status indicators | Medium | Test-first on IPC |
| U1.5 | 1 | U0.1 | Editor/terminal app icons | Low | JSX swap |
| U2.1 | 2 | U1.3 | Diff Eliding setting | Low | Test-first on contract |
| U2.2 | 2 | U2.1 | Wire setting into xAI requests | High | Characterization-first |
| U3.1 | 3 | — | Sticky directory headers | Low | CSS-only |
| U3.2 | 3 | — | Thread reactions | Medium | Test-first on persistence |
| U3.3 | 3 | U0.2 | PR chips | Medium | Characterization-first on `gh` JSON |
| U4.1 | 4 | U0.1, U0.2 | Header platform status | Medium | Test-first on event contract |
| U4.2 | 4 | U4.1 | Messaging on/off toggle | Medium | Test-first on runtime pause/resume |
| U4.3 | 4 | U4.1 | Per-thread bindings + unbind | Medium | Map existing storage first |
| U4.4 | 4 | U4.3 | Messaging Activity screen | Medium | Test-first on activity log |

## Alternative Approaches Considered

1. **One mega-PR for the whole design overhaul**: Rejected. Too risky;
   the user explicitly asked for incremental ship-able units. Also makes
   visual review impossible for individual changes.
2. **Defer Diff Eliding to a separate plan**: Rejected. The user
   surfaced this as part of the same work and (correctly) treats it as a
   unified design+behavior pass. Phase 2 keeps it next to the settings
   redesign that introduces it.
3. **Adopt a third-party icon library (lucide, phosphor, heroicons)**:
   Rejected for the v1 ship. We have ~10–15 icons we actually need and
   want full control over weight/contrast (the current icons being too
   thin is part of why we're doing this work). A small handcrafted set
   keeps bundle size and licensing simple. We can revisit if the count
   grows.
4. **Use a managed multi-color brand mark for VS Code/Ghostty/etc.**:
   Rejected. Distribution license ambiguity for proprietary marks plus
   the design thesis is monochrome. Use simple monochrome glyphs with
   `currentColor`.

## System-Wide Impact

### Interaction Graph

The design overhaul touches multiple subsystems with non-obvious
ripple effects:

- **Icon swap (U1.1, U1.2)** → no behavioral effect; only CSS/DOM. But
  if any E2E test asserts on emoji text content (`page.getByText("📁")`),
  it will break. Audit `apps/desktop/e2e/*.spec.ts` for emoji literals
  before landing U1.2.
- **Settings rework (U1.3)** → renderer DOM changes; E2E tests using
  `data-testid` attributes survive. Tests using accessible names or
  role-based queries may need updating.
- **Diff Eliding gate (U2.2)** → changes when `XaiAiSdkObjectClient` is
  invoked. Any code path expecting an always-condensed prompt will
  receive a raw prompt when the setting is off. Trace every caller and
  document the no-condensation behavior.
- **Reactions (U3.2)** → adds writes to `ThreadOverlayState` on a hot
  path (every reaction click). Re-confirm the overlay-store write
  performance characteristics on a busy thread list.
- **PR chips (U3.3)** → invokes `gh` subprocess. Subprocess output must
  not block thread-list rendering. Use background-refresh pattern.
- **Messaging on/off (U4.2)** → must drain in-flight turns. A mid-turn
  pause must not corrupt the controller's send/receive state.
- **Activity log (U4.4)** → adds writes on every inbound/outbound. Must
  not block message routing if the write fails.

### Error & Failure Propagation

- xAI condensation gate (U2.2): If the setting check throws, default
  to **disabled** (don't send the request). Failing closed is the
  user's stated intent — they're worried about silent over-sending.
- PR chip fetcher (U3.3): `gh` failures (not installed, no auth, rate
  limited, network out) → log + cached state, never an error toast.
- Messaging pause (U4.2): If `adapter.stop?.()` throws, retry once,
  then mark the platform as `errored` and continue. Don't block the
  toggle waiting for a stuck adapter.
- Activity log writes (U4.4): If sqlite write fails, log + drop the
  event. Do NOT propagate the error up to the message-routing path.

### State Lifecycle Risks

- **Reactions**: Writes go to `ThreadOverlayState.reactions` array.
  Concurrent writes (unlikely but possible if user clicks multiple
  reactions fast) must be serialized through the existing
  upsert mechanism.
- **Bindings (U4.3)**: Unbinding removes the desktop's record. If the
  platform side hasn't been notified, the next inbound from the
  conversation will land in the "ignored" log. Acceptable — the user
  understands this and the activity screen makes it visible.
- **Activity log (U4.4)**: Capped FIFO eviction. Eviction at the cap
  is safe (oldest-first). No risk of unbounded growth.
- **Diff Eliding setting flip mid-turn (U2.2)**: If the user toggles
  the setting during a turn, the in-flight turn uses whatever the
  setting was when the turn started. Don't try to mutate a turn in
  flight.

### API Surface Parity

- The Diff Eliding gate must apply to **every** caller of
  `XaiAiSdkObjectClient` — not just one. U2.2's characterization step is
  there specifically to enumerate them.
- Messaging on/off toggle must be honored by both the runtime AND any
  individual adapter that may be reached directly by the controller.
  Audit `MessagingController.handleInboundEvent` for direct adapter
  references that could bypass the runtime.

### Integration Test Scenarios

1. **End-to-end visual smoke**: Launch app, navigate Recents → Inbox →
   Directories → Settings → back. No emoji glyphs. No layout shifts.
   Stoplights aligned. Sidebar chips legible.
2. **Diff Eliding off, full session**: 30-minute scripted session
   exercising tool calls and long replies. Verify zero
   `XaiAiSdkObjectClient` log lines.
3. **Messaging pause/resume cycle**: Start with messaging on, send a
   Telegram message that triggers a long Codex turn, toggle messaging
   off mid-turn. Verify the turn completes, the response is *not* sent
   (because we paused), and the activity log records the dropped send.
   Resume. Verify a new inbound starts a new turn cleanly.
4. **PR chips with `gh` not installed**: Confirm graceful no-op.
5. **Unbinding mid-stream**: Bound thread receiving a streaming
   response from the agent — user clicks Unbind. The current response
   should finish on the platform side (drain) but no new messages
   should be accepted from that conversation.

## Acceptance Criteria

### Functional

- [ ] Every emoji-as-icon usage in renderer JSX is replaced by an icon
      component or styled span (verified by grep).
- [ ] The Sidebar masthead's folder/branch chips are visibly heavier
      and higher contrast against the near-black surface.
- [x] Settings shell has `← Exit Settings` top-left under the brand,
      consistent section/row/help layout, and test affordances on
      credential-based settings. Test affordances landed via the
      `SettingsTestBlock` primitive (Telegram `getMe`, Discord
      `/users/@me`, Grok `GET /v1/models`, Codex `--version`) — see
      `apps/desktop/src/main/credential-tester/credential-tester.ts`
      and `apps/desktop/src/renderer/src/features/settings/SettingsTestBlock.tsx`.
- [ ] Diff Eliding setting exists, defaults to disabled, and gates
      every `XaiAiSdkObjectClient` call site.
- [ ] Sticky directory headers stay pinned during scroll on the
      Directories tab.
- [ ] Reactions can be added/removed from any thread row and persist
      across restart.
- [ ] PR chips render on threads with detected PRs, color-coded by
      state, with single-project (`#NNN`) and multi-project
      (`org/repo#NNN`) formats.
- [ ] Header shows configured platform icons with state colors and
      activity blink.
- [ ] Header has a working messaging on/off toggle that drains in-flight
      operations and persists across restart.
- [ ] Per-thread messaging binding chips render and support unbind
      from the thread row context menu.
- [ ] Messaging Activity screen shows bound threads, ignored senders,
      and recent activity.

### Non-Functional

- [ ] No regression to recently-fixed surfaces:
      - context-rail hover (PR #167-equivalent merged on this branch's
        previous fix)
      - sidebar masthead vertical alignment with stoplights
      - composer Tiptap WYSIWYG persistence
      - launchpad worktree dedup
- [ ] No new dependencies on third-party icon libraries.
- [ ] No new always-on background subprocess; PR fetcher uses
      on-demand `gh` calls with short cache.
- [ ] All renderer additions follow `aria-label` / focus-visible
      conventions documented in the desktop style guide.
- [ ] Reduced-motion preference disables blink and any other added
      animation.

### Quality Gates

- [ ] `pnpm typecheck` clean
- [ ] `pnpm test` ≥ current pass count (no test removed without
      explanation)
- [ ] `pnpm test:desktop-e2e` clean against representative scenarios
- [ ] Each unit lands as its own PR with screenshots before/after
- [ ] Visual review checkpoint after Phase 1 (the wireframe pass)
      before starting Phase 2

## Success Metrics

- **Visual cohesion**: A new contributor opening any screen sees a
  consistent icon set, status indicator pattern, and chip treatment.
- **xAI request volume**: After Phase 2 ships with the setting default
  to off, daily xAI condensation request count drops to 0 for users
  who haven't opted in (verified via local logging).
- **Messaging visibility**: User can answer "Is anyone messaging my
  agent that I haven't authorized?" in under 5 seconds via the
  Activity screen.
- **Per-thread context recall**: Reactions reduce the time to find
  "the thread I was waiting on" from O(scroll-and-read) to O(scan-for-emoji).

## Dependencies & Prerequisites

- `gh` CLI installed for U3.3 PR detection (graceful degradation when
  absent).
- Existing settings persistence layer
  ([config-and-state-relocation plan](docs/plans/2026-05-02-004-feat-config-and-state-relocation-plan.md))
  remains the source of truth.
- Existing messaging adapter contracts
  ([packages/messaging/AGENTS.md](packages/messaging/AGENTS.md)) remain
  unchanged.
- Recent fixes on the previous branch — masthead/context-rail layout
  (commits `a4e8b422`, `3d947c4c`), Tiptap launchpad WYSIWYG
  (PR #166/#167), better-sqlite3 auto-rebuild (PR #165) — are merged
  to main before this work starts.

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Icon swap regresses E2E selectors that match emoji literals | Medium | Low | Audit E2E specs for emoji before U1.2 |
| Settings layout rework breaks settings persistence | Low | High | U1.3 explicitly leaves `useDesktopSettings` and `desktop-settings-service` untouched; layout-only |
| Diff Eliding gate misses a caller, requests still fire | Medium | Medium | U2.2 characterization-first enumerates every call site before the gate is added; verification step is "30-min session = 0 log entries" |
| Messaging pause leaves adapter in zombie state | Medium | High | U4.2 test-first; cycle pause/resume in unit tests; force-stop after 5s timeout |
| PR fetcher rate-limited by GitHub | Low | Low | Cache 60s, gracefully no-op on rate limit |
| Reactions persistence under fast clicks corrupts state | Low | Low | Single-writer through existing overlay upsert path |
| Activity log writes block message routing | Low | High | Best-effort writes; failures logged + dropped; never propagate up |
| Sticky directory header introduces stacking-context bug elsewhere | Low | Medium | Constrain `z-index` to a low value (5) below all popovers/menus (which use 30+) |

## Resource Requirements

- Solo engineer + AI pair, ~2–3 days per phase, ~10 days total elapsed.
- No new infra dependencies.
- Visual review touchpoints after each phase.

## Future Considerations

- Reactions evolve into a small system status taxonomy
  (`needs-review`, `blocked`, `done`) with their own persistence.
- PR chips evolve into a richer "linked work" panel showing CI status,
  reviewers, and inline jump-to-PR.
- Messaging Activity screen evolves into a security audit log with
  exportable CSV.
- The icon library evolves into a shared package if PwrSnap and
  PwrAgent want to share marks.

## Documentation Plan

- Update [docs/UI-THEME.md](docs/UI-THEME.md) with the new status
  tokens and the icon library reference (U0.1, U0.2).
- Update [docs/design/desktop-style-guide.md](docs/design/desktop-style-guide.md)
  with the new settings layout pattern (U1.3) and the messaging status
  pattern (U4.1).
- Add a short note in [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md)
  pointing future contributors at the centralized icon library
  (U0.1) and forbidding new emoji-as-icon usage.
- Add a `docs/messaging-activity-log.md` spec for U4.4's persistence
  shape and eviction rules.

## Sources & References

### Internal References

- Theme tokens: [apps/desktop/src/renderer/src/styles/app.css](apps/desktop/src/renderer/src/styles/app.css)
- Theme thesis: [docs/UI-THEME.md](docs/UI-THEME.md)
- Style guide: [docs/design/desktop-style-guide.md](docs/design/desktop-style-guide.md)
- Sidebar component: [Sidebar.tsx](apps/desktop/src/renderer/src/features/navigation/Sidebar.tsx)
- Directory list (emojis to replace): [DirectoriesList.tsx:121](apps/desktop/src/renderer/src/features/navigation/DirectoriesList.tsx)
- Settings shell: [SettingsScreen.tsx](apps/desktop/src/renderer/src/features/settings/SettingsScreen.tsx)
- xAI condensation client: [xai-ai-sdk-object-client.ts](packages/agent-core/src/providers/xai-ai-sdk-object-client.ts)
- Messaging runtime: [messaging-runtime.ts](apps/desktop/src/main/messaging/messaging-runtime.ts)
- Messaging package boundary: [packages/messaging/AGENTS.md](packages/messaging/AGENTS.md)
- Overlay store: [overlay-store-sqlite.ts](apps/desktop/src/main/state/overlay-store-sqlite.ts)
- Recent context-rail fix that must not regress: commit `a4e8b422`
- Recent masthead alignment that must not regress: commit `3d947c4c`
- Tiptap WYSIWYG persistence (just merged): PR #166

### Related Brainstorms

- [docs/brainstorms/2026-04-30-desktop-settings-config-requirements.md](docs/brainstorms/2026-04-30-desktop-settings-config-requirements.md)
  — informs U1.3, U1.4, U2.1
- [docs/brainstorms/2026-04-30-messaging-platform-integration-requirements.md](docs/brainstorms/2026-04-30-messaging-platform-integration-requirements.md)
  — informs U4.1–U4.4
- [docs/brainstorms/2026-04-20-desktop-tangerine-terminal-visual-system-requirements.md](docs/brainstorms/2026-04-20-desktop-tangerine-terminal-visual-system-requirements.md)
  — informs U0.2 status tokens and U1.x visual pass

### Related Plans

- [docs/plans/2026-05-02-004-feat-config-and-state-relocation-plan.md](docs/plans/2026-05-02-004-feat-config-and-state-relocation-plan.md)
  — settings/state persistence foundation
- [docs/plans/2026-05-02-002-feat-messaging-streaming-responses-plan.md](docs/plans/2026-05-02-002-feat-messaging-streaming-responses-plan.md)
  — messaging streaming behavior referenced by U4.1's blink debounce

### External References

- The provided Anthropic Design exploration was used for visual
  direction; the user's *Design Overrides* (above) take precedence
  where they disagree.
