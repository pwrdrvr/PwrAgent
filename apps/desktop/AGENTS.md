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

## Running the App for Development

To launch the desktop app with live threads and real user state, run from the **repo root** (or worktree root):

```bash
pnpm dev
```

- Do **not** override `HOME` or set `NODE_ENV` — the app needs the real user data directory to load saved threads and Keychain secrets.
- Messaging adapters are guarded by a profile-scoped sqlite lease. If another live instance already owns messaging for the active profile, this process stays usable but leaves messaging stopped.
- Use `pnpm dev:no-messaging` when you explicitly want to guarantee that this app process never starts messaging adapters.
- For visual verification of UI changes, either command can show real threads in the sidebar and thread detail pane; prefer `dev:no-messaging` when the UI work does not need live messaging.
- If the app starts but shows no threads, you are likely running from the wrong directory or with overridden env vars.

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

For the **docs-site** screenshots (the `docs.pwragent.ai` site under
[`docs-site/assets/screenshots/`](../../docs-site/assets/screenshots/)
— Settings → Applications / Worktrees / Models panels, Settings →
Messaging panels for each of the six platforms, and a Recents lens
hero) the equivalent command is:

```bash
pnpm --filter @pwragent/desktop screenshot:docs-site
```

It runs ten tests through the same `capture-window.swift` pipeline
but writes into `docs-site/assets/screenshots/` instead of
`docs/assets/screenshots/` and uses `PWRAGENT_DOCS_SITE_SCREENSHOT_CAPTURE=1`
as its gate. See
[`../../docs-site/assets/screenshots/DOCS_SITE_SHOT_LIST.md`](../../docs-site/assets/screenshots/DOCS_SITE_SHOT_LIST.md)
for the shot list and what state each capture needs.

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
| `e2e/docs-site-screenshots.inspect.spec.ts` | Ten tests producing PNGs for `docs.pwragent.ai` (Settings panels + per-provider Messaging panels + Recents hero). Gated behind `PWRAGENT_DOCS_SITE_SCREENSHOT_CAPTURE=1`. Output lands in `docs-site/assets/screenshots/`. |
| `e2e/fixtures/readme-recents-hero/replay.fixture.json` | Hand-crafted populated thread list for the hero shot. Edit by hand to retune. |
| `e2e/fixtures/readme-state-seeding.ts` | Direct sqlite/config seeders for messaging bindings, activity log entries, pairing tokens, and Telegram-enabled config. |
| `e2e/fixtures/docs-site-state-seeding.ts` | All-providers-enabled `config.toml` seeder so the per-platform Settings → Messaging captures can scroll directly to each platform's section without driving the Enabled toggle in the UI. |
| `scripts/capture-window.swift` | Resolves the Electron window's CGWindowID and runs `screencapture -l <wid>`. Optional `--title=<substring>` for multi-window apps. |
| `scripts/filter-noise-screenshots.mjs` | Post-capture cleanup. Iterates modified PNGs under `docs/assets/screenshots/` and `docs-site/assets/screenshots/`, decodes both HEAD and working-tree versions to TIFF via `sips`, SHA-256 compares. Identical → `git restore --source=HEAD --worktree`. Visually different → kept for review. Net-new PNGs (untracked) are left alone. |
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

## Accessibility

The renderer is audited against WCAG 2.0 / 2.1 / 2.2 Level AA via
`apps/desktop/e2e/a11y.spec.ts`, which launches Electron under the
existing replay-fixture harness and runs `@axe-core/playwright`'s
`AxeBuilder` against each surface. CI picks it up automatically through
`pnpm run test:desktop-e2e` — no separate workflow.

Things to know when extending the audit:

- **Surface coverage.** Each `test(...)` block drives the renderer to a
  state (open thread, settings overlay, settings → messaging) and then
  calls `runAxe(window)`. Add a new block per surface you want gated;
  reuse `launchElectronApp` with whatever fixture seeds that state.
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
