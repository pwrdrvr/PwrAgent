# Desktop App Guidance

## Style Guide

Before renderer UI work, read [../../docs/UI-THEME.md](../../docs/UI-THEME.md),
the visual theme source of truth (theme thesis, palette and token usage,
component theme rules, interaction constraints, visual anti-patterns), and
[../../docs/design/desktop-style-guide.md](../../docs/design/desktop-style-guide.md)
for product tone, typography, shell composition, sidebar and thread-row rules,
component constraints, copy rules, and anti-patterns.

## Code Formatting & Linting

Run `pnpm lint:oxlint` after edits and `pnpm lint:oxlint:typed` for production
receiver safety; CI runs both. There is no autoformatter by design: never run
Prettier on a renderer or main-process file or reformat with linter fixes.
Match adjacent code by hand, including leading binary operators. The repo-root
`AGENTS.md` has the full scope, native typecheck command, and formatting policy.

## Non-Negotiables

- Attention, Drafts, Inbox, Recents, and Directories live in one icon-only
  thread lens switch; Inbox is the default browsing lens.
- A thread's unsent composer draft is window-local state, never federated.
  Derive it from the composer draft store (`useThreadDraftIndicators`), not
  from `NavigationThreadSummary`.
- Attention is a work queue: focusing a thread there must not clear its unread
  cookie. Replying or explicitly choosing Mark Read clears it. See
  [thread navigation rules](../../docs/thread-navigation-rules.md#unread-behavior)
  for why that rule is lens-scoped rather than global.
- Attention rows are ranked per turn, not per update
  ([attention-order.ts](src/renderer/src/features/navigation/attention-order.ts)).
  Do not re-sort the lens by `updatedAt` — that is the bug the ranks exist to
  fix. New signals that should move a row need a transition in the reducer, not
  a tiebreaker in the sort.
- User-curated Pins live as a scrollable section at the top of each directory
  in the Directories lens. While `general.pinned_threads_on_top` is on (the
  default), Inbox (the Updated tab) and Recents (the Created tab) also share
  one collapsible Pinned group at their top, holding every pin across
  projects in the same global order. Each lists every other thread by its own
  time below the group, and a thread renders in only one of them. Off, both
  are pure time sorts and do not float pins.
- Unread state uses the orange cookie marker, not punctuation badges.
- The sidebar is an information surface, not a stack of generic cards.
- Do not use browser-default controls in shipped UI.
- Do not ship implementation-status narration in user-facing copy.
- Keep radius at `8px` or below.
- Favor one accent color and neutral surfaces.

### Worktree Archive and Migration Safety

- Archive only non-primary worktrees after creating their snapshots.
- Validate migrated destination history before archiving the source thread.

### Branch-Drift Dialog

- Use `isBranchDrifted` for sidebar and dialog decisions so both surfaces share
  one predicate.
- Defer branch-drift dialogs during active turns and recheck the selected thread
  after the turn settles.

### Native Notifications

- Keep native notification eligibility and deduplication in the main process.
- Emit notifications only for opted-in inactive windows and clear waiting keys
  after user action or terminal completion.

### Markdown and External Links

- Treat bare domains and local paths as text; only explicit links may open
  externally.
- Validate external URLs in the main process with an allowlist after renderer
  filtering.

### Star Map Interactions

- Guard canvas pan, wheel, and keyboard handlers in interactive children. Agent
  map commands are answered exactly once and never move keyboard focus. Before
  changing Star Map interactions, its view snapshot, or Agent map commands, read
  [docs/star-map-interactions.md](docs/star-map-interactions.md#star-map-interactions).

### Full Access Escalation

- Every renderer surface that can raise a thread's execution mode goes through
  `useExecutionModeSelection`, never `desktopApi.setThreadExecutionMode`
  directly. An agent never raises access itself; it proposes a `start_thread`
  to-do card. Messaging surfaces deliberately use their own permission gate.
- Before adding or changing any execution-mode control, to-do card start, or
  messaging escalation, read [docs/full-access-escalation.md](docs/full-access-escalation.md#full-access-escalation).

## Codex Data Boundary

Desktop code must not inspect Codex-owned storage directly. Do not open, parse,
query, or infer behavior from Codex session JSONL files, rollout files, or
Codex sqlite databases, even when the Codex App Server protocol returns a path
to one of those files. Use protocol fields from the Codex App Server instead.
PwrAgent-owned JSONL, sqlite, config, and replay fixture files remain OK when
the desktop app or test harness owns that data. CI runs
`pnpm lint:codex-storage` to catch common violations; do not bypass or rename
around that check. Fix the data flow by using protocol fields or changing the
protocol. The one PwrDrvr LLC-authorized exception is
`src/main/codex-app-server/invalid-response-message-id-recovery.ts`: it may
rewrite only the protocol-identified rollout for the exact Responses API
invalid message-ID-prefix recovery, after stopping the Codex writer, creating
a durable backup, and validating the session belongs to the requested thread.

## Codex Runtime Safety

- Keep Windows sandbox setup explicit, active-profile scoped, and delegated to
  Codex.
- Never elevate the Electron process or claim readiness before restart and
  fresh readiness evidence.

## Running the App for Development

Choose the checkout and profile first: run the project-local
[`pwragent-dev-profile` skill](../../.agents/skills/pwragent-dev-profile/SKILL.md)'s
`status` before any `restart`. Do not override `HOME` or set `NODE_ENV`. Never
target the generic `Electron` / `com.github.Electron` identity or the installed
`com.pwrdrvr.pwragent` bundle, never launch bare Electron without the PwrAgent
app entry, and stop if the target is ambiguous. Before launching, restarting,
or driving a desktop app window (Computer Use, Playwright, a controller), or
changing messaging/federation lease startup, read
[docs/running-the-app.md](docs/running-the-app.md#running-the-app-for-development).

## Renderer update diagnostics in release builds

`window.__pwragentRendererUpdates` keeps a bounded, content-free history of
composer, Tiptap, context-card, and tooltip update requests; normal recording
has no timers, IPC, logging, or database writes. Before investigating an update
loop or recovery report, or changing that recorder, read
[docs/renderer-update-diagnostics.md](docs/renderer-update-diagnostics.md#renderer-update-diagnostics-in-release-builds).

## Profiling the Renderer with React DevTools

React DevTools is opt-in through `PWRAGENT_DEV_REACT_DEVTOOLS` /
`PWRAGENT_DEV_REACT_PROFILING`; never add `react-devtools` to `package.json`,
and packaging must never ship the bridge. Before profiling the renderer or
changing those variables, read
[docs/react-devtools-profiling.md](docs/react-devtools-profiling.md#profiling-the-renderer-with-react-devtools).

## Desktop E2E Specs

Import `test` from `e2e/fixtures/electron-test`. Scope locators to a container
or use test ids (`history-nav-back`, `composer-stop-turn`): Playwright matches
names and `getByLabel` as substrings. Before writing or changing a desktop E2E
spec, adding an `aria-label`, or inspecting the branch-drift dialog, read
[docs/e2e-specs.md](docs/e2e-specs.md).

## Capturing README Screenshots

`pnpm --filter @pwragent/desktop screenshot:readme` and `screenshot:docs-site`
capture native windows on a Retina display, through a noise filter. Before
running, adding, or changing a README or docs-site capture, read
[docs/screenshots.md](docs/screenshots.md#capturing-readme-screenshots).

## Capturing Agent Protocol Traffic

Answer agent wire-behavior questions with a capture, not source reading or the
committed `*-build.json` fixtures. Keep raw account captures under `.local/` and
never commit them. Before capturing ACP or Codex account protocol, or changing
ACP session lifetime, read [docs/protocol-captures.md](docs/protocol-captures.md).

## Thread Row Density and X-ray

Density lives in CSS only (`<html data-density>`). Before changing thread-row
chips, density rules, X-ray, or density previews, read
[docs/thread-row-density.md](docs/thread-row-density.md#thread-row-density-and-x-ray).

## Accessibility

`e2e/a11y.spec.ts` gates WCAG 2.2 AA with axe in every color theme. Every
`aria-modal` dialog uses `useModalDialog`, every `role="menu"` uses
`useMenuNavigation`, and a single choice uses `Select`, never a native
`<select>`; never add private Escape or Tab listeners. Before adding or
changing a dialog, menu, select, popup, or audited surface, or extending the
audit, read [docs/accessibility.md](docs/accessibility.md#accessibility).

## Config File Evolution

Before changing `config.toml` keys in a backwards-incompatible way, read
[../../docs/config-file-evolution.md](../../docs/config-file-evolution.md).
The desktop config writer must preserve recognized legacy shapes when possible,
mark them with the `pwragent-legacy-settings` comment, lazily convert on save,
and avoid whole-file rewrites that discard user comments.

## Explicit-Save Settings Forms

Never copy the settings snapshot back into form state; use `useSettingsDraft`
and `useUnsavedSettingsChanges`. Before changing a Settings form with a Save
button, read [docs/settings-forms.md](docs/settings-forms.md#explicit-save-settings-forms).

## Thread History Persistence

Thread transcripts, rollout events, streamed message deltas, prompt text,
assistant text, and command output history must not be written into the desktop
sqlite database. Store only desktop metadata there. For the full rule and the
ACP fallback direction, read
[../../docs/thread-history-persistence.md](../../docs/thread-history-persistence.md)
before changing ACP session storage, thread replay restoration, or rollout
persistence. Its one exception is tracked review findings (`thread_reviews`):
capped excerpts that only To-dos and the review agent tools read. The
transcript renders a review from its own entry and reads only status from that
table.

## Pull-Request Status Source of Truth

The overlay attachment list owns which PRs a thread has; the PR status registry
owns their state. Every path that serves PR chips must canonicalize through the
registry, and a thread never inherits another thread's PRs. Before changing PR
attachment, lookup, polling, status events, or PR fetch trust, read
[docs/pull-request-status.md](docs/pull-request-status.md#pull-request-status-source-of-truth).

## Thread-State Update Bus

A `BackendRegistry` mutation of persistent thread state emits a typed
`AppServerNotification`; do not add ad-hoc IPC channels or per-controller
refresh fan-outs. Before adding or changing a thread-state field, its
notification, or execution-mode queue events, read
[docs/thread-state-update-bus.md](docs/thread-state-update-bus.md#thread-state-update-bus).

## Dependency Boundary Enforcement

**DO NOT, under any circumstances, loosen the dependency boundary rules.**

The desktop app sits at the **top** of the dependency hierarchy and may import any `@pwragent/*` package. However:

- The **renderer** (`src/renderer/`) may only import `@pwragent/shared`. All other package access must go through IPC to the main process.
- The **main process** may import any package but must not create circular dependencies.

- **DO NOT** add exceptions, allowlists, or `severity: "ignore"` overrides to `.dependency-cruiser.cjs`
- **DO NOT** import provider SDKs (`grammy`, `discord.js`, `telegraf`) in `src/main/messaging/core/`
- **DO NOT** introduce circular dependencies between any modules
- If a rule blocks your change, the change is architecturally wrong — redesign it

Enforcement runs via `pnpm lint:boundaries` and fails CI on any violation.

## Vitest Guards

Desktop Vitest fails a test that spawns a real agent CLI, runs Git against the
checkout, makes an outbound request, or touches operator state. Fix a failure
by injecting a seam, never by widening a guard. Before fixing a guard failure,
or changing the guards, `PWRAGENT_HOME`, XDG, or `PATH` sandboxing in
`vitest.workspace.ts`, read [docs/vitest-guards.md](docs/vitest-guards.md).

## Sqlite Write-Volume Instrumentation

Measure commits, not statements, and record every per-command, per-turn,
per-item, per-event, or timer write path as a write budget. Before adding such
a write, changing a budget, or running `pnpm test:sqlite-writes`, read
[docs/sqlite-write-volume.md](docs/sqlite-write-volume.md#sqlite-write-volume-instrumentation).

## SQLite Query Rules

- Never interpolate user-sourced values into SQL strings. Always use
  `better-sqlite3` prepared statements with positional or named bindings.
- Messaging-platform inbound text is the highest-risk SQLite input category:
  public Telegram, Discord, Mattermost, Slack, Signal, Feishu, and future
  adapter traffic must be treated as hostile even when the local desktop user
  trusts the bound thread.
- Generated SQL fragments are only allowed for non-data structure, such as a
  generated `?, ?, ?` placeholder list. Hardcoded maintenance table names must
  stay allowlisted by the SQL-template lint guard.
- Run `pnpm lint:sql` after changing desktop main-process SQLite code. It flags
  interpolated SQL template strings in the messaging/state persistence surface.

## Implementation Notes

- No raw color literals outside the `:root` token blocks in `styles/app.css`.
  Theme and density come from per-profile `config.toml`
  `[general.appearance]`; never persist them in localStorage.
- Every tooltip is a portal on `document.body`; never draw one with `::after`.
- Before changing renderer styles, tokens, theme or density plumbing,
  tooltips, or hover cards, read
  [docs/renderer-implementation-notes.md](docs/renderer-implementation-notes.md#implementation-notes).

## Third-Party Brand Assets

Use vendor brand-kit files verbatim, each with a `README.md`, rendered through
`<img>`. Outside macOS, an app's mark comes from `build/icon.png`. Before adding
or changing a vendor or PwrSuite mark, read
[docs/brand-assets.md](docs/brand-assets.md#third-party-brand-assets).

## Quit Retries

Re-issue a deferred quit through `retryQuitAfterDispatch`; never call
`app.quit()` from a `before-quit` listener or a microtask chain. Before
changing quit, shutdown, or `before-quit` handling, read
[docs/quit-retries.md](docs/quit-retries.md#quit-retries).

## Worktree Path Computation

- **All worktree paths** must use the shared `computeWorktreePath` from `src/main/app-server/git-directory-service.ts`.
- There are two code paths that create worktrees: `prepareLaunchpadWorkspace` (in `git-directory-service.ts`) and `handoffLocalToWorktree` / `handoffLocalChangesToDetachedWorktree` (in `git-workspace-handoff-service.ts`). Both must use the same path builder.
- The naming pattern is `<root>/<hash>/<project-folder-name>` where `<hash>` is `Date.now().toString(36)` and `<project-folder-name>` is `path.basename(repoRoot)` preserving original casing.
- Do not introduce additional worktree path builders — centralize in `computeWorktreePath`.

## Release Notes

Never hardcode a version string; use `app.getVersion()` or
`desktopApi.readAppMetadata()`. Before release-note, signing-identity, or
secret-store migration work, read [docs/release-notes.md](docs/release-notes.md#release-notes).
