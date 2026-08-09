# Desktop App Guidance

## Style Guide

Use [../../docs/UI-THEME.md](../../docs/UI-THEME.md) as the visual theme source of truth for renderer UI work.

Use [../../docs/design/desktop-style-guide.md](../../docs/design/desktop-style-guide.md) for broader desktop layout, product tone, component behavior, and copy guidance.

The theme guide defines:

- theme thesis
- palette and token usage
- component theme rules
- interaction constraints
- visual anti-patterns

The desktop style guide defines:

- product tone
- typography
- shell composition
- sidebar and thread-row rules
- component constraints
- copy rules
- anti-patterns

## Code Formatting & Linting

ESLint is the correctness linter — run `pnpm lint:eslint` (CI runs it too) and
fix its errors; **don't run `eslint --fix` to reformat**. There is no
autoformatter by design: **never run Prettier (`npx prettier` /
`prettier --write`)** on a renderer or main-process file — no config is
committed, so `npx` applies tool defaults that fight the hand-maintained house
style (notably leading binary operators) and reformat untouched code. Match the
surrounding file by hand. See "Code Formatting & Linting" in the
[repo-root `AGENTS.md`](../../AGENTS.md) for the full rule and the house-style
summary.

## Non-Negotiables

- Inbox, Recents, and Directories live in one thread lens switch; Inbox is the
  default browsing lens.
- User-curated Pins live as a scrollable section at the top of Inbox and
  Recents.
- Unread state uses the orange cookie marker, not punctuation badges.
- The sidebar is an information surface, not a stack of generic cards.
- Do not use browser-default controls in shipped UI.
- Do not ship implementation-status narration in user-facing copy.
- Keep radius at `8px` or below.
- Favor one accent color and neutral surfaces.

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

## Running the App for Development

Choose the target checkout and profile before starting or controlling an app.
For a checkout-bound `dev` profile, use the project-local
[`pwragent-dev-profile` skill](../../.agents/skills/pwragent-dev-profile/SKILL.md):

```bash
.agents/skills/pwragent-dev-profile/scripts/pwragent-dev-profile.zsh status --root "$PWD"
.agents/skills/pwragent-dev-profile/scripts/pwragent-dev-profile.zsh restart --root "$PWD"
```

Run `status` first and only `restart` when a new process is actually wanted.
The skill supplies both `PWRAGENT_PROFILE=dev` and
`PWRAGENT_INSTANCE_ROOT="$PWD"` so it manages the instance for this checkout.
Use the
[`pwragent-dev-restart` skill](../../.agents/skills/pwragent-dev-restart/SKILL.md)
for a delayed restart that must survive the current in-app Agent session.

To launch the desktop app with live threads and real user state, run from the **repo root** (or worktree root):

```bash
pnpm dev
```

- Do **not** override `HOME` or set `NODE_ENV` — the app needs the real user data directory to load saved threads and Keychain secrets.
- Messaging adapters are guarded by a profile-scoped sqlite lease. A shared runtime lease manager records the owning PID once and checks whether that process is still alive when another instance challenges the lease. The first confirmed absence is persisted; after a one-minute reclaim grace, PID reuse cannot revive the dead owner. If another live instance already owns messaging for the active profile, this process stays usable but leaves messaging stopped.
- The federation runtime asks the same lease manager for a parallel profile-scoped lease (lease key `profile-federation`, independent of the messaging lease). If another live instance already runs federation for the active profile, this process keeps its federation runtime stopped and reports the holder in federation health instead of fighting over the shared instance identity.
- Use `pnpm dev:no-messaging` when you explicitly want to guarantee that this app process never starts messaging adapters.
- For visual verification of UI changes, either command can show real threads in the sidebar and thread detail pane; prefer `dev:no-messaging` when the UI work does not need live messaging.
- If the app starts but shows no threads, you are likely running from the wrong directory or with overridden env vars.

### Targeting an Existing Electron App

- Confirm the intended checkout/profile with the dev-profile skill before
  driving a window. Dev builds run as the generic `Electron` process and share
  the `com.github.Electron` bundle id with every other unsigned Electron app.
  **Never target either generic identity.** Do not target the installed
  `com.pwrdrvr.pwragent` bundle either: it is a packaged build and does not
  contain the checkout's code.
- Launch or inspect with the project-local dev-profile skill. Its successful
  `status` / `restart` / `verify` output includes a `Computer Use target` line
  with the checkout-local Electron main PID, exact `Electron.app` path,
  expected native window title (`PwrAgent`), and renderer URL/port. For Computer
  Use, target that exact app path, then confirm the returned window title and
  AX URL match before clicking anything. The title alone is not unique when
  another PwrAgent checkout is open; the port alone is not enough without the
  checkout-local executable and `--app-path` process evidence.
- If the target cannot be resolved unambiguously, stop instead of guessing.
  An ambiguous lookup can raise or operate a sibling Pwr app, another checkout,
  or an unrelated project's broken default Electron window.
- With a Codex browser/Electron controller, select and reuse the existing
  PwrAgent Electron target and its window/page binding. With persistent
  `node_repl` Playwright, reuse the existing `electronApp` and `appWindow`
  handles. Playwright's `_electron.launch()` always creates a new process; it
  cannot attach those handles to an arbitrary Electron app that was started
  elsewhere, so use Computer Use or an existing controller binding instead.
- If a separate Playwright-owned instance is explicitly required, prefer the
  repository's E2E/inspect commands. A manual Playwright launch must pass the
  PwrAgent package entry: `.` with `cwd` set to `apps/desktop`, or
  `apps/desktop` with `cwd` set to the repository root, plus the intended
  `PWRAGENT_PROFILE` and `PWRAGENT_INSTANCE_ROOT` environment.
- **Never launch `Electron.app`, its `Contents/MacOS/Electron` executable, or
  the repo's Electron binary without the PwrAgent app entry/path.** A bare
  Electron launch opens Electron's default shell, not PwrAgent.

## E2E Locator Hygiene Around Global Chrome

The thread/search title bars always render the history Back/Forward
buttons (accessible names `Back` and `Forward`), and they stay mounted
behind overlays like the onboarding wizard. A page-wide
`getByRole("button", { name: /Back/i })` will resolve to multiple
elements and fail Playwright strict mode. When writing specs:

- Scope to a container (`dialog.getByRole(...)`) or anchor the regex to
  the full label (e.g. the wizard's `/^← Back/i`).
- Target the history buttons themselves via their test ids:
  `history-nav-back` / `history-nav-forward`.

## Inspecting Branch Drift Dialog E2E

To open the replay-backed "Thread branch changed" dialog and keep Electron
open for manual screenshots, run from the repo root:

```bash
pnpm --filter @pwragent/desktop inspect:e2e:branch-drift
```

The script builds the desktop app, launches a deterministic branch-drift
fixture in headed Electron, waits with the dialog visible, and exits only
after you close the Electron window or quit the app. Use this for visual
inspection of the dialog instead of the normal `thread-branch-drift.spec.ts`,
which closes Electron automatically after assertions pass.

## Capturing README Screenshots

The PNGs and animated GIF the top-level README references under
`docs/assets/screenshots/` are produced by an inspect-style Playwright
spec that drives five known UI surfaces and shells out to Swift for
native macOS window capture (with stoplights, drop shadow, and retina
resolution — Playwright's `Page.screenshot()` only grabs the renderer
DOM, which loses the OS chrome).

Re-capture all five with:

```bash
pnpm --filter @pwragent/desktop screenshot:readme
```

For the **docs-site** screenshots (the `docs.pwragent.ai` site —
Settings → Applications / Worktrees / Models panels, Settings →
Messaging panels for each of the six platforms, and a Recents lens
hero), the docs themselves live in a separate repo at
[pwrdrvr/docs.pwragent.ai](https://github.com/pwrdrvr/docs.pwragent.ai)
but the capture pipeline still lives here. The command is:

```bash
pnpm --filter @pwragent/desktop screenshot:docs-site
```

It runs the same `capture-window.swift` pipeline as the README
screenshots and uses `PWRAGENT_DOCS_SITE_SCREENSHOT_CAPTURE=1` as
its gate. PNGs are written into the **sibling docs.pwragent.ai
checkout**'s `assets/screenshots/` directory — by default
`~/github/docs.pwragent.ai/assets/screenshots/`, overridable via
the `PWRAGENT_DOCS_SITE_REPO` environment variable when your
checkout lives somewhere else. After the run, `cd` into that
checkout to review + commit the captured PNGs. See the docs repo
for its own SHOT_LIST tracking.

### Capturing under a non-default theme or density

Both screenshot pipelines honor two optional env vars that seed the
launched profile's `[general.appearance]` block before Electron boots:

- `PWRAGENT_SCREENSHOT_THEME` — `dark` (default), `light`, or `system`.
- `PWRAGENT_SCREENSHOT_DENSITY` — `mission-control` (default) or `compact`.

Defaults match the committed PNGs (dark + mission-control), so omitting
the variables leaves the existing pipeline pixel-stable. The pre-React
bootstrap (main → preload → inline script in `index.html`) applies the
matching `<html data-*>` attributes on the first paint, so no UI driving
is required to flip the theme — just set the env var:

```bash
PWRAGENT_SCREENSHOT_THEME=light \
  pnpm --filter @pwragent/desktop screenshot:readme
```

The wiring lives in
[`e2e/fixtures/screenshot-appearance.ts`](e2e/fixtures/screenshot-appearance.ts)
and is consumed by both inspect specs. The capability is intentionally
scoped to the screenshot pipelines — production E2E keeps its dark
default unconditionally so color-assertion tests stay deterministic on
every CI runner.

We do not currently regenerate the committed PNGs under light theme or
ship them in the docs site. That's tracked separately under issue #508
(theming v1 polish follow-up to #472).

The script builds the desktop app, launches it headed against curated
replay fixtures + state-seeded sqlite rows, takes the screenshots,
then runs the **noise filter** (`filter-noise-screenshots.mjs`) to
revert any PNG whose pixels are identical to the committed version
— the `screencapture` encoder produces nondeterministic byte streams
for deterministic input pixels, and PNGs don't delta-compress in
git's pack format, so committing re-encode noise adds ~900 KB per
file per regen for zero visual benefit. macOS Screen Recording
permission is required for whichever terminal/IDE runs the spec —
the first invocation triggers the system prompt; subsequent runs
are silent.

Pieces, all under `apps/desktop/`:

| File | What it does |
|---|---|
| `e2e/readme-screenshots.inspect.spec.ts` | Five tests, one per surface. Gated behind `PWRAGENT_SCREENSHOT_CAPTURE=1`. |
| `e2e/docs-site-screenshots.inspect.spec.ts` | Tests producing PNGs for `docs.pwragent.ai` (Settings panels + per-provider Messaging panels + Recents hero + composer features + first-run onboarding wizard + live work rail). Gated behind `PWRAGENT_DOCS_SITE_SCREENSHOT_CAPTURE=1`. Output lands in the **sibling docs repo's** `assets/screenshots/` (default `~/github/docs.pwragent.ai/`, override with `PWRAGENT_DOCS_SITE_REPO`). |
| `e2e/fixtures/readme-recents-hero/replay.fixture.json` | Hand-crafted populated thread list for the hero shot. Edit by hand to retune. |
| `e2e/fixtures/readme-state-seeding.ts` | Direct sqlite/config seeders for messaging bindings, activity log entries, pairing tokens, and Telegram-enabled config. |
| `e2e/fixtures/docs-site-state-seeding.ts` | All-providers-enabled `config.toml` seeder so the per-platform Settings → Messaging captures can scroll directly to each platform's section without driving the Enabled toggle in the UI. |
| `scripts/capture-window.swift` | Resolves the Electron window's CGWindowID and runs `screencapture -l <wid>`. Optional `--title=<substring>` for multi-window apps. |
| `scripts/filter-noise-screenshots.mjs` | Post-capture cleanup. Iterates modified PNGs in the current repo (default: under `docs/assets/screenshots/` only) or another repo (via `--root <path>`, used by `screenshot:docs-site` against the sibling docs repo). Decodes HEAD and working-tree to TIFF via `sips`, SHA-256 compares. Identical → `git restore --source=HEAD --worktree`. Visually different → kept for review. Net-new PNGs (untracked) are left alone. |
| `scripts/render-indicator-overlay.swift` | Paints a numbered step-indicator pill onto a single PNG via Core Graphics + Core Text. |
| `scripts/stitch-demo-gif.ts` | Reusable GIF stitcher. Annotates each frame via the indicator-overlay Swift helper, then encodes via two-pass ffmpeg `palettegen`/`paletteuse`. CLI: `--output`, `--frame-duration-ms`, `--no-indicator`, `--indicator-position top|bottom`. |

To produce a new multi-frame demo GIF outside the README spec:

```bash
pnpm --filter @pwragent/desktop exec tsx \
  apps/desktop/scripts/stitch-demo-gif.ts \
  --output docs/assets/screenshots/screenshot-some-demo.gif \
  --frame-duration-ms 1500 \
  docs/assets/screenshots/some-demo-frame-1.png \
  docs/assets/screenshots/some-demo-frame-2.png \
  docs/assets/screenshots/some-demo-frame-3.png
```

Works for 2+ frames; the indicator scales horizontally with frame
count.

## Capturing ACP Protocol Transcripts

`scripts/capture-acp-transcript.mjs` drives a real ACP agent over stdio the
way `AcpAgentClient` does — same `initialize` params, `session/new`, one
`session/prompt` — and writes every JSON-RPC frame in both directions to
stdout:

```bash
node apps/desktop/scripts/capture-acp-transcript.mjs \
  --cmd ~/.kimi-code/bin/kimi --args acp \
  --cwd /tmp/acp-scratch \
  --prompt "tell me your favorite breakfast cereal" > capture.json
```

Flags: `--cmd` (required), `--args` (comma-separated), `--cwd`, `--prompt`,
`--quiet-ms` (drain window after the prompt resolves), `--timeout-ms`,
`--allow-tools`. Exit code is 0 only on a completed capture.

Reach for this whenever a question about an agent's wire behavior would
otherwise be answered by reading its source or guessing. **The committed
`__tests__/fixtures/acp-transcripts/*-build.json` fixtures cannot answer
turn-end questions** — they are normalizer-parity captures containing no
completed turn, so grepping them for usage, stop reasons, or totals returns a
confident wrong answer. That mistake is why
`kimi-code-0-31-cereal.json` exists: a full captured turn establishing that
Kimi Code 0.31.1 puts no token usage on the ACP wire.

Two things to know before running it:

- **Permission requests are denied by default.** Pass `--allow-tools` only
  when tool traffic is the point, and point `--cwd` somewhere disposable when
  you do — the harness answers on your behalf and the agent acts for real.
- **Output is raw protocol.** The operator home directory and the capture cwd
  are rewritten, but an agent can echo anything it read into a transcript.
  Read a capture before committing it as a fixture.

## Accessibility

The renderer is audited against WCAG 2.0 / 2.1 / 2.2 Level AA via
`apps/desktop/e2e/a11y.spec.ts`, which launches Electron under the
existing replay-fixture harness and runs `@axe-core/playwright`'s
`AxeBuilder` against each surface. CI picks it up automatically through
`pnpm run test:desktop-e2e` — no separate workflow.

Things to know when extending the audit:

- **Surface coverage.** Each `test(...)` block drives the renderer to a
  state (open thread, settings overlay, settings → messaging, the Star
  Map layer, the Star Map intake dialog) and then calls `runAxe(window)`.
  Add a new block per surface you want gated; go through
  `launchAuditApp()`, which emulates reduced motion and takes an optional
  `fixturePath` / `theme`.
- **Seed the fixture so the surface is actually populated.** The smoke
  fixture's thread reaches no Star Map lane — `deriveInboxState` keeps a
  first-snapshot thread out of the inbox, and an idle thread with no PR
  and no unpushed commits matches no attention category — so auditing the
  map on it would scan chrome and no cards. `e2e/fixtures/star-map/` is a
  hand-written fixture (same class as `readme-recents-hero/`) whose
  threads are `threadStatus: "active"` for exactly that reason. Check
  what your surface renders before trusting a green run.
- **Every surface is audited in both themes.** The file wraps its
  `describe` in `for (const theme of AUDIT_THEMES)` and threads the theme
  into `launchAuditApp({ theme })`, so a new block is gated in light and
  dark for free. This matters because contrast is the one rule class that
  is genuinely theme-dependent — roles, names, and focus order are not.
  The gate ran dark-only for its whole life, which is how three
  token-level light-theme contrast failures shipped unnoticed.
- **`runAxe(window, { include })` narrows the scan to one subtree.** No
  block passes it today, and it is not a tool for silencing a failure —
  everything outside the scope stops being gated. Prefer a
  `KNOWN_VIOLATIONS` entry, which waives one selector for one rule and
  leaves the rest of the surface audited. (It exists because the
  celestial-watermark blocks once scoped to `.thread-view__primary` to
  avoid measuring window-wide light-theme debt; that debt is fixed, light
  theme is gated unscoped, and those blocks folded their
  watermark-is-painted assertion into "open thread view".)
- **Reduced motion has to reach the element that animates.** The gate
  emulates `prefers-reduced-motion: reduce` so it measures contrast at
  rest; a rule that zeroes the animation on the wrong selector leaves
  text mid-fade and axe reports a real-looking contrast miss. That is how
  the Star Map card rise was caught: the animation lives on
  `.star-map-card-shell`, the reduced-motion rule named `.star-map-card`.
- **`setLegacyMode(true)` is required under Electron.** The default
  `AxeBuilder.analyze()` opens a worker page via
  `browserContext.newPage()` to scan cross-origin iframes; Electron's
  CDP target returns "Not supported" for that. The renderer is
  single-origin with no cross-origin iframes, so the legacy
  single-context path covers everything we ship.
- **`KNOWN_VIOLATIONS` is a baseline, not a permission slip.** Each
  entry waives one selector for one rule with a written reason. Fix
  the underlying issue, then delete the entry — axe will hold the
  line on it going forward.
- **No raw color literals outside the token blocks** (see Implementation
  Notes below) — this is also what keeps the contrast pair audited by
  axe stable across theme + density variants.

To run the gate locally:

```bash
pnpm --filter @pwragent/desktop exec playwright test \
  -c playwright.config.ts e2e/a11y.spec.ts
```

(The package's `test:e2e` script does a full Electron rebuild + Vite
build first; the `playwright test` form above skips that when you've
already built once.)

## Config File Evolution

Before changing `config.toml` keys in a backwards-incompatible way, read
[../../docs/config-file-evolution.md](../../docs/config-file-evolution.md).
The desktop config writer must preserve recognized legacy shapes when possible,
mark them with the `pwragent-legacy-settings` comment, lazily convert on save,
and avoid whole-file rewrites that discard user comments.

## Thread History Persistence

Thread transcripts, rollout events, streamed message deltas, prompt text,
assistant text, and command output history must not be written into the desktop
sqlite database. Store only desktop metadata there. For the full rule and the
ACP fallback direction, read
[../../docs/thread-history-persistence.md](../../docs/thread-history-persistence.md)
before changing ACP session storage, thread replay restoration, or rollout
persistence.

## Pull-Request Status Source of Truth

There are two stores holding PR data, and they answer **different
questions**. Do not treat them as interchangeable:

- **Attachment list** — `ThreadOverlayState.prs` (sqlite `threads`
  overlay JSON, written by `setThreadPullRequests`). Authoritative for
  *which* PRs belong to a thread. The status fields on those rows are a
  cached projection and go stale by design: they are only rewritten when
  the attachment list itself is rewritten (a branch lookup).
- **Status** — the PR status registry in `DesktopAppServerService`
  (`prStatusRegistry`, durable via the `pr_status_cache` table).
  Authoritative for *what state* a PR is in. The background poller
  writes here and here only, then emits `pullRequest/status/updated`.
  It never writes back into the overlay.

**Every path that serves PR chips to a client MUST canonicalize the
overlay rows through the status registry.** The seam is the injected
`ThreadPullRequestCanonicalizer` (`setThreadPullRequestCanonicalizer`,
backed by `canonicalizeStoredPullRequests`, which loads
`pr_status_cache` first so it works before any window has driven a
lookup). Use `canonicalizeNavigationThreadPullRequests` for a navigation
snapshot's threads.

Skipping it is not a cosmetic staleness bug. `collectPrPollTargets`
drops terminal PRs from the rotation, so once a PR merges the background
poller emits no further `pullRequest/status/updated` for it — a client
served an uncanonicalized snapshot shows that PR as open with checks
running until something else happens to refresh it. (An owner-side
branch lookup still republishes terminal PRs via
`thread/pullRequests/updated`, so the row can converge if the *owner*
opens that thread — but nothing the viewer does will fix it.) This is
exactly what federation remote viewers hit: their only snapshot source
is `DesktopMessagingBackendBridge.getNavigationSnapshot`, which did not
canonicalize, while the renderer's local path did.

Canonicalization failures degrade rather than propagate:
`canonicalizeNavigationThreadPullRequests` catches, logs, and serves the
overlay rows, because possibly-stale chips beat a failed snapshot (which
for a viewer means a disconnected window).

### Who owns a PR's status when two instances can see it

A window with no federation target shows local threads and pinned remote
rows together, so the same GitHub PR can appear twice — once monitored
by the local poller, once as a peer's observation. Two monitors writing
the same rows from slightly different points in time reads as the status
flickering. The rule is **local monitoring wins, and a peer only fills a
gap it alone can see**:

- `broadcastAgentEvent` drops a remote-stamped `pullRequest/status/updated`
  before it reaches any non-federation window when
  `registry.isPullRequestLocallyMonitored(prKey)` — the PR is attached to
  a local thread's primary workspace, so our own poller owns it. The
  resolver is injected from `DesktopAppServerService` and uses the same
  test as `collectPrPollTargets`. Terminal PRs still count as ours: they
  leave the poll rotation, but our last observation of them is final.
- Federation windows always receive the event. The peer is their only
  source of truth, and their renderer-side target filter decides whether
  it belongs to the instance they front.
- When we *do* own the PR, the pinned remote row still updates — local
  `pullRequest/status/updated` matches by `prKey` across every thread in
  the snapshot, so the local observation lands on the remote row too.
  That is why dropping the peer's copy loses nothing.

`thread/pullRequests/updated` is **not** gated: a thread's *attachment
list* is owned by the instance the thread lives on, so a peer is always
authoritative for its own threads' lists. It is instead scoped by origin
in `applyThreadPullRequestsUpdate`, which matches the thread's
`federation.ref.target` against the event's, so a peer's event cannot
rewrite a local thread that happens to share an id. Do not "fix" the
asymmetry by adding this method to the gate — status and attachment
lists have different owners, and a test pins the distinction.

Two deliberate cases where we defer to the peer rather than claim
ownership, both because claiming it would assert a freshness we do not
have:

- **Non-primary attachments.** The test is the PR matching a local
  thread's *primary* repository, matching `collectPrPollTargets`. A PR
  attached to a local thread some other way is not polled by us either,
  so the peer's observation is the fresher one.
- **Before the first local snapshot.** `attachedPrsByThreadKey` is
  populated by the local navigation-snapshot path, so until it first
  runs every PR answers "not monitored" and peer observations flow
  through. The local poller corrects any row it owns on its next
  observation.

## Thread-State Update Bus

When mutating persistent thread state (model, reasoning effort, fast mode,
permissions/execution mode, name, compaction), `BackendRegistry` MUST emit a
typed `AppServerNotification` from the mutation method on success. That
notification fans out through two existing listeners:

- **Renderer**: `apps/desktop/src/main/ipc/agent-ipc.ts:broadcastAgentEvent` →
  `agent:event` IPC → `desktopApi.onAgentEvent` → `useThreadNavigation`
  patches the navigation snapshot in place.
- **Messaging controllers**: `apps/desktop/src/main/messaging/messaging-runtime.ts`
  fans the event out to every `MessagingController.handleBackendEvent`,
  which routes thread-state methods to `refreshStatusSurfacesForThread`
  to re-render every binding's status surface on its channel.

This is what keeps Telegram, Discord, and the desktop UI in sync when any
surface changes a setting. The cross-surface refresh is automatic — do
NOT add ad-hoc IPC channels or per-controller refresh fan-outs for new
thread-state fields. Instead:

1. Add the new notification method to `AppServerNotification` in
   `packages/shared/src/contracts/normalized-app-server.ts`.
2. Emit from the registry mutation method via `await this.emit(...)`.
3. Add a handler branch in `useThreadNavigation`'s `onAgentEvent`
   subscription, mirroring `applyThreadModelSettingsUpdate` /
   `applyThreadExecutionModeUpdate`.
4. Add a method-name branch in `MessagingController.handleBackendEvent`
   that routes to `refreshStatusSurfacesForThread`.

Mutation handlers in `MessagingController` (e.g. `togglePermissionsMode`)
should NOT call `renderBindingStatus` inline for state that flows through
the bus — the bus is the single source of refresh, and an inline render
would be redundant. Update binding-local preferences before the registry
call so the bus-path render sees fresh prefs.

For binding-local mutations that do NOT flow through the registry
(e.g. `cycleToolUpdateMode`, `syncConversationName`), keep the inline
`renderBindingStatus` call — there's no bus event for those.

### Permission-mode queue events

A toggle of `executionMode` while a turn is active produces additional
notifications beyond `thread/executionMode/updated`:

- `thread/executionMode/queued` — fired when the registry queues a
  pending mode change instead of applying it immediately. Params:
  `{ threadId, queuedExecutionMode, queuedAt }`. Renderer patches
  `NavigationThreadSummary.queuedExecutionMode` and shows the queue
  indicator in the composer; messaging posts an audit message in every
  bound conversation with a Cancel button.
- `thread/executionMode/queueCleared` — fired on either `cancelled`
  (user clicked Cancel) or `applied` (turn ended and the queue
  flushed). Params: `{ threadId, reason: "applied" | "cancelled" }`.
  Renderer clears the queue indicator; messaging edits the previously
  posted audit message in place (or falls back to a fresh message if
  edit fails). On `applied`, this fires AFTER `thread/executionMode/updated`
  — clients should see the apply before the queue-clear so the UI
  transitions cleanly through "queued → applying → applied".

The persistent `permissionTransitionLog` on `ThreadOverlayState` (capped
at 100 entries, sqlite-backed) is the audit trail. Renderer materializes
log entries into the transcript as synthetic activity entries with id
prefix `permission-transition-`. The queue itself (`queuedExecutionMode`,
`queuedExecutionModeAt`) lives in registry memory only and is cleared on
app restart — that's intentional, since the active turn would have been
interrupted on shutdown.

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

## Sqlite Write-Volume Instrumentation

PR #1406 fixed tool accounting running one implicit transaction per streamed
8 KiB command-output chunk: **3,693 commits and 58 MB of WAL growth** for a
single `find /`, to persist about nineteen integer counters. The whole suite
passed either way. It had to be found by hand.

The reason nothing caught it is worth internalizing before you reach for a
unit test here: **the main-process suites mock the overlay store.**
`backend-registry.test.ts` alone constructs `createOverlayStoreMock` in 450+
places, so no sqlite is involved and no assertion about write behavior is
possible. The code path that writes for real only runs in the app — which the
E2E harness does exercise, against a real `state.db` under a temp
`PWRAGENT_HOME`.

So the instrumentation lives on the database, in
[`src/main/state/sqlite-write-metrics.ts`](src/main/state/sqlite-write-metrics.ts),
and covers vitest, E2E, and dev runs from one place.

**Measure commits, not statements.** Each implicit transaction flushes its
dirty pages, and a row update drags along every index it moved — in #1406's
case four 4 KB pages per write, because `observed_at` sits in all three
indexes on `thread_tool_invocations`. Ranking by statements would call a
batched migration expensive and a per-event write loop cheap.

### Running it

```bash
pnpm test:sqlite-writes                       # whole suite, then the ranking
pnpm test:sqlite-writes apps/desktop/src/main/__tests__/state-db.test.ts
```

Every desktop E2E run reports automatically — the harness is the only place
the real write path executes, the overhead is a `statSync` per commit against
a run that launches Electron, and the ranking prints at teardown into the run
log (`e2e.log` on the lab guest). Opt out with
`PWRAGENT_DEV_SQLITE_WRITE_METRICS=0`.

### Things that will bite you

- **Attach after migrations, not before.** Schema migrations commit once per
  version on a fresh database. A suite that opens a temp db per test would
  otherwise rank whichever file opened the most databases as the heaviest
  writer — the first version of this reported 164 commits for 16 statements.
- **Instrumentation must be invisible to the code it measures.**
  better-sqlite3 hangs `.default` / `.deferred` / `.immediate` / `.exclusive`
  off the callable `transaction()` returns, and they are **not enumerable**.
  Copying with `Object.assign` drops them and every `tx.immediate(...)` caller
  dies with "is not a function"; `pr-auto-dispatch.test.ts` is what caught it.
- **A zero is not a clean bill of health.** A test file that mocks its store
  reports zero writes no matter what it does in production. Read the ranking
  as "of the code that touched real sqlite, here is the order", never as
  coverage.

### Known baselines

Numbers to compare a new write path against, all measured with this harness:

| Path | Cost |
|---|---|
| Streamed command output, per-chunk (pre-#1406) | 3,693 commits / 58 MB WAL for one `find /` |
| Streamed command output, coalesced (today) | 34 commits / 0.54 MB for the same command |
| Former 10-second runtime lease heartbeats | 720 commits / 2.7 MB per hour (~65 MB/day) |
| PID-owned messaging + federation leases, idle hour | 0 commits / 0 MB WAL |
| PID-owned lease lifecycle (register, acquire/release both, exit) | 6 commits / ~93 KB WAL |
| PID-owned dead-owner observation + takeover, both leases | 5 commits / ~72 KB WAL |
| Whole vitest suite | 51 sources / ~3,000 commits / ~27 MB WAL |
| One replay E2E spec | ~28 commits across two Electron processes |

The former idle figure came from two 10-second sqlite renewal loops. Runtime
leases now register one process identity and check the recorded PID only when a
challenger tries to acquire messaging or federation. A confirmed dead-owner
observation is persisted and becomes reclaimable after one minute, even if the
PID is reused in the meantime. Holding either lease adds no timer and no idle
sqlite writes. A process that is alive but hung retains ownership; this
deliberately favors preventing dual owners over preempting a possibly healthy
process.

### Write budgets

[`src/main/__tests__/fixtures/sqlite-write-budgets.json`](src/main/__tests__/fixtures/sqlite-write-budgets.json)
records what each measured scenario costs, and
`sqlite-write-metrics.test.ts` fails when one moves:

```
sqlite write budget "streamed-command-output" changed.
  budget:   2 commits, 2 statements, 2 rows (~36 KB WAL)
  measured: 501 commits, 501 statements, 501 rows (~2820 KB WAL)
```

That is the pre-#1406 write pattern being caught automatically. Note the
budget: **2 commits for 501 streamed events**, because commits must not scale
with events.

**Setup is excluded by construction.** `measureSqliteWrites(fn)` measures only
what the callback does, so opening the database, applying migrations, and
seeding fixtures all sit outside it. A budget therefore tracks the feature and
stays put when a test grows more setup — no classifying writes after the fact,
no arguing about which INSERT was "arrange".

**Only the deterministic counters are asserted.** Commits, write statements,
and rows changed are a pure function of the code path — same operations, same
numbers, on any machine under any load, which is what makes an exact assertion
safe here rather than a tolerance. WAL bytes are *not* deterministic (page fill
and checkpoint timing move them run to run), so `observedWalBytes` is recorded
for humans to read and never asserted. Commits are the honest proxy for volume.

Deviation fails in **both** directions. An increase is the regression this
exists to catch; a decrease means the budget has gone stale and would stop
catching anything, so lowering it is a deliberate act.

### Adding a budget

Any new write path that fires per command, per turn, per item, per streamed
event, or on a timer gets one. Wrap the feature — not its setup — and name the
scenario:

```ts
const { writes } = await measureSqliteWrites(async () => {
  // drive the feature
});
expectSqliteWriteBudget({
  note: "what one unit of work is, in words",
  scenario: "my-feature",
  writes,
});
```

Then record it with `UPDATE_SQLITE_WRITE_BUDGETS=1 pnpm test <file>` and commit
the JSON. Re-record the same way when a change moves a number **on purpose**,
and say why in the commit message — the point of the file is that a write-cost
change shows up as a reviewable line in a diff instead of never showing up at
all.

Before recording, do the projection: writes/second × how long a real session
runs → MB/day. If it looks excessive, raise it rather than baking it in. A
budget is a record of what a path costs, not permission for it to cost that.

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

- Centralize visual tokens in `styles/app.css` before expanding renderer surfaces.
- **No raw color literals outside `:root` / `:root[data-theme="..."]`.** All
  hex / rgb / hsl / `color-mix(in srgb, #..., ...)` constants belong in the
  token blocks at the top of `styles/app.css`. Use `var(--token)` everywhere
  else. The renderer ships light and dark themes via `data-theme` attribute
  selectors plus a synchronous pre-React bootstrap in `index.html` — any new
  raw color literal in a component rule (or further down in `app.css`) will
  not flip with the theme and is a regression. Derived alpha overlays should
  use `color-mix(in srgb, var(--token) <pct>%, transparent)` so they
  automatically follow the token in every theme.
- **Theme + density source of truth is per-profile `config.toml`
  `[general.appearance]`.** The full path: main process
  `readBootstrapAppearance` (sync TOML read in
  `src/main/settings/appearance-bootstrap.ts`) → BrowserWindow
  `webPreferences.additionalArguments` → preload
  `contextBridge.exposeInMainWorld("__pwragentAppearance", …)` → inline
  `<script>` in `src/renderer/index.html` sets `<html data-theme/data-density>`
  before any React code runs. The renderer's `useAppearance` hook adopts
  the snapshot value when it arrives over IPC and writes changes back via
  `writeSettingsConfig({ general: { appearance: { theme, density } } })`.
  The hook lifts to `App.tsx` and threads the controller down — instantiate
  it once per window so the React state is consistent. Do not reintroduce
  localStorage as a persistence layer; TOML is authoritative across all
  windows and profiles.
- Reuse shell primitives instead of adding one-off page styling.
- When in doubt, make the interface calmer, denser, and more editorial.
- For tooltips inside clipped or layered surfaces (sidebar, scroll regions,
  overflow-hidden chips, draggable rails, or anything that must escape the
  left bar), use `src/renderer/src/lib/useViewportTooltip.tsx` with the
  shared `.viewport-tooltip` class. CSS pseudo-element tooltips
  (`tooltip-target` + `data-tooltip`) are only for elements whose ancestors
  all render with `overflow: visible`; otherwise they get clipped or lose
  z-order fights against the main surface.
  - **Structured hover cards pass their own class instead of
    `.viewport-tooltip`.** The hook takes a `ReactNode`, so a card with
    sections and meters (`.context-usage-card`, `.pr-status-card`) styles
    itself; keep new ones on those two's measurements so the app's hover
    cards stay one family. Plain text tooltips keep `.viewport-tooltip`.
  - **Check the layer your trigger lives in.** The portal renders on
    `document.body`, and `.app-shell` opens no stacking context, so
    full-window layers (Settings and Star Map at `z-index: 120`) sit in the
    same root stacking context and will paint OVER a tooltip left at the
    default 90. Anything reachable from those surfaces needs an explicit
    higher layer — see `.messaging-status-tooltip`, `.pr-status-card`, and
    `.star-map-card__tooltip`.
  - **A card with content worth hearing needs `aria-describedby`.** Point the
    trigger at the hook's `tooltipId` while `visible`; nothing else references
    the portal, so an unwired card is sighted-only. Do not solve this by
    stuffing the data into the trigger's `aria-label` — that changes the
    control's name, not its description.
- Use the project-local [desktop E2E fixture seeding skill](../../.agents/skills/desktop-e2e-fixture-seeding/SKILL.md) when capturing or refreshing replay-backed desktop E2E fixtures.

## Third-Party Brand Assets

- Vendor-supplied brand assets (logos, marks, icons) live under `src/renderer/src/assets/<vendor>/` as **verbatim files from the vendor's official brand kit** — never hand-redrawn, recolored, or otherwise altered.
- Each asset directory MUST include a `README.md` documenting: the source URL, the vendor's usage rules, and the procedure for re-fetching on update. See [`src/renderer/src/assets/mattermost/README.md`](src/renderer/src/assets/mattermost/README.md) as the reference example.
- Render verbatim assets via `<img>`, NOT inline `<svg>` with `currentColor`. The `<img>` tag is structurally insulated from parent CSS `color` rules, which protects the asset from accidental recoloring.
- Do not add hand-drawn `currentColor` vendor silhouettes. If a platform has a recognizable mark, follow the Mattermost/Telegram/Discord pattern instead.

## Worktree Path Computation

- **All worktree paths** must use the shared `computeWorktreePath` from `src/main/app-server/git-directory-service.ts`.
- There are two code paths that create worktrees: `prepareLaunchpadWorkspace` (in `git-directory-service.ts`) and `handoffLocalToWorktree` / `handoffLocalChangesToDetachedWorktree` (in `git-workspace-handoff-service.ts`). Both must use the same path builder.
- The naming pattern is `<root>/<hash>/<project-folder-name>` where `<hash>` is `Date.now().toString(36)` and `<project-folder-name>` is `path.basename(repoRoot)` preserving original casing.
- Do not introduce additional worktree path builders — centralize in `computeWorktreePath`.

## Release Notes

- The first signed v1.x build is signed under the PwrDrvr LLC Developer ID
  (Team ID `T44CNHC4UH`) with bundle id `com.pwrdrvr.pwragent`. macOS Keychain
  scopes `safeStorage` keys by signing identity + bundle id, so any pre-v1.0
  development build's encrypted secrets at
  `~/.local/state/pwragent/settings-secrets.json` (Telegram / Discord bot
  tokens) WILL fail to decrypt under the new signed build. The
  `desktop-secret-store` returns `undefined` on decrypt failure and prompts the
  user to re-enter the secret in Settings — no crash, no stale ciphertext
  re-used as plaintext. Document this in v1.0.0 release notes for any internal
  testers upgrading from pre-v1.0 dev builds.
- Hardcoded version strings in shipped code are an anti-pattern. Always use
  `app.getVersion()` (main process) or `desktopApi.readAppMetadata()` (renderer)
  so every release reports its real version.
