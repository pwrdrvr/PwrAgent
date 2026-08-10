# PwrAgent Repository Guidance

## Source of Truth

- Product requirements live in `docs/brainstorms/`
- Implementation plans live in `docs/plans/`
- UI theme tokens and visual language live in [docs/UI-THEME.md](docs/UI-THEME.md)
- Desktop UI direction lives in [docs/design/desktop-style-guide.md](docs/design/desktop-style-guide.md)
- The PwrAgent v2 design source bundle (HTML/CSS/JSX prototypes + chat transcripts) lives in [docs/design/pwragent-v2/](docs/design/pwragent-v2/) — see [docs/design/pwragent-v2/SOURCE.md](docs/design/pwragent-v2/SOURCE.md) for provenance and the "reference, not copy verbatim" policy
- The operator-facing site at <https://docs.pwragent.ai> lives in its own repo at [pwrdrvr/docs.pwragent.ai](https://github.com/pwrdrvr/docs.pwragent.ai) (split out from this repo on 2026-05-25). Edit there for per-platform setup walkthroughs, streaming/webhook explainers, and Settings → Messaging reference content. Contributor-facing messaging docs stay in [docs/messaging-*.md](docs/).

## Workflow

- Treat plan documents as decision artifacts, not implementation scripts.
- Keep changes aligned with the current active plan unless the user explicitly changes scope.
- Do not delete or "clean up" files in `docs/brainstorms/`, `docs/plans/`, or future `docs/solutions/` directories. **Don't rewrite plan / brainstorm / solution files that weren't created on your current branch either** — they are point-in-time decision artifacts, a historical record of what was decided when. The one exception: the plan file your current branch is executing is fair game for in-flight updates (progress checkboxes, deferred-to-implementation answers resolved as you work). The root [`.rgignore`](.rgignore) skips all three directories from default `rg` searches; override per-search with `rg --no-ignore` (or `rg -u`) when you actually want to grep them. Full rules in [`docs/plans/AGENTS.md`](docs/plans/AGENTS.md).
- GitHub Actions labels that intentionally trigger workflow behavior are
  documented in [.github/workflows/README.md](.github/workflows/README.md).
  Check that list before adding or using a CI-triggering PR label.
- Exclude `apps/desktop/.local/protocol-captures/` from broad searches by default. Only search it when the task is specifically about captured E2E protocol snippets.
- Never read Codex-owned storage files directly from PwrAgent code. Treat
  Codex session JSONL files, rollout files, and Codex sqlite databases as
  private implementation details; use the Codex App Server protocol instead.
  PwrAgent-owned files under `~/.pwragent/` and repo-local test fixtures are
  fine when the feature explicitly owns them. CI enforces common cases with
  `pnpm lint:codex-storage`; do not bypass that check by renaming variables or
  shelling out. The sole exception is
  `apps/desktop/src/main/codex-app-server/invalid-response-message-id-recovery.ts`,
  which PwrDrvr LLC explicitly authorizes to repair only protocol-identified
  rollouts after the exact Responses API invalid message-ID-prefix failure.
  That module must remain backup-first, atomic, thread-validated, and limited
  to removing invalid `id` fields from response items whose type is `message`.
- Use the project-local [desktop E2E fixture seeding skill](.agents/skills/desktop-e2e-fixture-seeding/SKILL.md) when seeding or refreshing desktop replay fixtures from live captured sessions.
- For reliable desktop E2E runs, prefer `pnpm test:desktop-e2e` from the repo root. The package-level `pnpm --filter @pwragent/desktop test:e2e` path is also safe now because it builds `apps/desktop/out/` before launching Playwright.
- **An operator may have a lab available for off-desktop Windows or macOS E2E
  testing.** Ask the operator for a pointer to the appropriate lab repository
  or skill before running headed desktop E2E.
- Before changing Windows Git/Bash process launch or shutdown, Vitest process
  isolation, queue/composer lifecycle tests, or lazy-renderer readiness, read
  [Windows Vitest stability: process ownership and lifecycle truth](docs/solutions/2026-08-06-windows-vitest-process-isolation.md).
  Git-for-Windows launcher handoffs, non-atomic descendant cleanup, and
  optimistic renderer synchronization have all caused expensive Windows-only
  flakes; retries, wider timeouts, fewer workers, and serial lanes are not
  substitutes for evidence-backed ownership and readiness fixes.
- The macOS CI lane uses the selected-repository **PwrDrvr macOS**
  organization runner group, shared only with PwrSnap. Do not add a
  repository-scoped runner or widen access to the rest of the organization.
- For manual screenshots of the branch-drift dialog, run `pnpm --filter @pwragent/desktop inspect:e2e:branch-drift`; it opens a replay-backed Electron fixture and waits until you close the app.
- To regenerate the README screenshots under `docs/assets/screenshots/`, run `pnpm --filter @pwragent/desktop screenshot:readme`. The full walkthrough (spec, fixtures, state-seeding helpers, native capture utilities) lives in [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md) under "Capturing README Screenshots". macOS Screen Recording permission is required for whichever terminal/IDE runs the spec.
- When focusing root Vitest runs through `pnpm test`, pass file paths or filters directly, for example `pnpm test apps/desktop/src/main/__tests__/backend-registry.test.ts`. Do not insert a standalone `--` before the focus args; `pnpm test -- apps/...` makes Vitest run the full workspace suite.
- **Any new sqlite write that fires per command, per turn, per item, per
  streamed event, or on a timer must be measured before it ships, and pinned
  by a checked-in write budget** that fails the suite when it moves. Do the arithmetic out loud: writes/second × commit
  cost × how long a real session runs → MB/day. Sqlite commits are the unit,
  not statements — each implicit transaction flushes its dirty pages plus every
  index the row moved (~4 KB/page, and a timestamp column in an index moves on
  every write). Two calibration points: tool accounting once wrote per streamed
  8 KiB chunk, costing 3,693 commits and 58 MB of WAL for one `find /`
  (PR #1406); the former 10-second runtime lease heartbeats cost 720 commits
  and 2.7 MB/hour per running instance, about 65 MB/day. PID-owned runtime
  leases now cost zero sqlite commits while idle. **If the projection looks excessive, say so to the
  user rather than shipping it quietly — the right answer is often that the
  design constraint has to change** (batch into one transaction, debounce
  behind a flush window, accumulate in memory and persist on a boundary, or
  not persist at all), and that is their call to make. Budgets live in
  `apps/desktop/src/main/__tests__/fixtures/sqlite-write-budgets.json`; wrap the
  feature (not its setup) in `measureSqliteWrites` and record with
  `UPDATE_SQLITE_WRITE_BUDGETS=1`, so a write-cost change lands as a reviewable
  line in the diff instead of never surfacing. Survey a whole run with
  `pnpm test:sqlite-writes`. See "Sqlite Write-Volume Instrumentation" in
  [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md).

## Code Formatting & Linting

**There is a linter (ESLint) but no autoformatter — and that split is
deliberate. Run ESLint; hand-format; never run Prettier.**

- **ESLint is adopted — as a correctness linter, not a formatter.** Run
  `pnpm lint:eslint` (CI's `Lint` job runs it too, alongside `lint:sql`,
  `lint:codex-storage`, `lint:colors`, `licenses:check`, `typecheck`, and
  `lint:boundaries`). The config is [`eslint.config.mjs`](eslint.config.mjs):
  typescript-eslint recommended + classic react-hooks (scoped to the renderer),
  **no stylistic rules**. Fix the errors it reports. A block of pre-existing
  findings (`no-explicit-any`, `exhaustive-deps`, and intentional patterns) is
  set to `warn` as a burn-down baseline — CI blocks on errors, not warnings.
  Do NOT add stylistic/whitespace rules and do NOT run `eslint --fix` to
  reformat code: formatting is not ESLint's job here.
- **Prettier is deliberately absent.** No dependency, no `.prettierrc`, no
  `format` script, no CI formatting step. **Never run `npx prettier` or
  `prettier --write` on repo files.** Because no config is committed, `npx`
  downloads Prettier and applies its built-in defaults, which fight this repo's
  hand-maintained house style and reformat large spans of untouched code. On
  PR #934 a single `npx prettier --write` on one file rewrote ~90 unrelated
  lines around a 3-line change, bloating the diff and muddying `git blame`. A
  full-tree Prettier reformat was evaluated (it touched ~77% of files) and
  declined; don't reintroduce it ad hoc.
- **Match the surrounding code by hand.** The house style (verify against
  neighbors, don't assume): double quotes, 2-space indent, semicolons, trailing
  commas on multi-line literals, and **leading binary operators** on wrapped
  expressions — the operator starts the continuation line:

  ```ts
  const ok =
    isAllowed(char)
    || SAFE_PUNCTUATION.has(char)
    || isDigit(char);
  ```

  Prettier's default flips these to trailing operators; there are 500+ leading-
  operator lines in the tree, so a default run is pure churn. Format new code to
  look like its neighbors.
- Keep diffs scoped to your actual change. If a file is already inconsistent,
  leave the untouched lines alone rather than "tidying" them.

## Agent Instruction Files

- Keep a sibling `CLAUDE.md` symlink next to every `AGENTS.md`, pointing at that `AGENTS.md`, so Codex and Claude read the same local guidance.

## Pull Requests

- Use Conventional Commit-style PR titles: `type(scope): short description`.
- Prefer scopes that match the project area being changed:
  - `messaging` for Telegram, Discord, adapters, and messaging integrations.
  - `desktop` for the desktop app itself.
  - `agent-core` for coding-agent backend and ACP integration changes.
  - `release` for packaging, signing, notarization, distribution, and auto-update pipeline.
  - `docs` for documentation changes.
  - `tests` for test coverage, fixtures, and test infrastructure.

## Release / Distribution

- The desktop release pipeline (Mac, signing, notarization, auto-update) is
  documented in [docs/desktop-release-runbook.md](docs/desktop-release-runbook.md).
- The Phase 1 → Phase 2 distribution channel migration runbook lives at
  [docs/desktop-distribution-phase-2-runbook.md](docs/desktop-distribution-phase-2-runbook.md).
- PwrAgent is MIT-licensed, owned by PwrDrvr LLC. Treat the repo-root
  `LICENSE`, package `license: "MIT"` declarations, and third-party license
  aggregation as load-bearing release metadata. Do not introduce a different
  first-party license or remove license disclosures without an explicit policy
  change from PwrDrvr LLC.

## Runtime Config

- All desktop config and state lives under `~/.pwragent/` (the "PwrAgent root").
- Override the root with `PWRAGENT_HOME=/path/to/root` for isolated E2E or dev-profile use.
- Select a named profile with `PWRAGENT_PROFILE=<name>` (defaults to `default`).
- Per-profile layout: `~/.pwragent/profiles/<name>/config.toml` (settings), `~/.pwragent/profiles/<name>/state/state.db` (sqlite).
- Before making a backwards-incompatible TOML config shape change, read [docs/config-file-evolution.md](docs/config-file-evolution.md) and follow its read-fallback, lazy-conversion, legacy-comment, and dual-write rules.
- Removed env vars (no longer honored): `PWRAGNT_STATE_ROOT`, `PWRAGNT_CONFIG_PATH`.
- Multiple instances can share the same profile DB safely (sqlite WAL mode); no lockfile needed.

### Dev-only env vars

These are **dev-only escape hatches**. They are silently ignored in packaged production builds (`app.isPackaged === true`); production operators MUST NOT set them. Each is rejected at startup with a `mainLog.error` line if it appears alongside a packaged build, then treated as unset.

- `PWRAGENT_PROFILE_AUTO_CREATE=1` — Bypass the onboarding wizard's "set up profile" prompt for missing-named-profile boots. Used by E2E fixtures and replay harnesses that need a profile dir materialized without operator interaction. Production launches MUST go through the wizard so an operator never gets a silently-created profile mapped to a Codex auth profile they didn't ask for (see issue #524).
- `PWRAGENT_DEV_DISABLE_SECRET_STORAGE=1` — Skip `safeStorage` operations entirely. Wizard typed secrets are SILENTLY DROPPED; settings-screen secret pills report "unavailable." Workaround for unsigned dev Electron builds on macOS that surface a confusing "Keychain Not Found" dialog because the binary lacks a stable code-signed identity (signed release builds don't have this problem). Operator re-enters secrets in Settings → Models on a real build afterwards.
- `PWRAGENT_DEV_SQLITE_WRITE_METRICS=1` — Count sqlite write volume (commits, write statements, rows, WAL growth, per table) for the process. Wraps the database in `StateDb.open` after schema setup. Paired with `PWRAGENT_DEV_SQLITE_WRITE_METRICS_FILE=<path>`, which appends one JSON line of totals per source. See "Sqlite Write-Volume Instrumentation" in [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md).

## Frontend and Desktop UI

- For renderer UI work, follow the desktop style guide before inventing local styling.
- For colors, tokens, and visual theme decisions, follow the UI theme guide before adding local CSS.
- Favor thread-first information hierarchy over generic dashboard layout.
- Do not ship scaffold narration or placeholder implementation copy in user-facing UI.

### Reuse existing chrome — copy tokens, don't pick new ones

When you build new chrome (a title bar strip, a brand mark, a breadcrumb,
an eyebrow, a path/app row), open `apps/desktop/src/renderer/src/styles/app.css`
and copy the token references from the existing primitive that solves the
same problem. Don't pick a new token because it "looks similar" — the brand
across windows must read identically.

Canonical primitives and the tokens they read:

| Primitive | Brand | Brand accent | Eyebrow | Breadcrumb separator | Breadcrumb current |
|---|---|---|---|---|---|
| `.sidebar__brand` (main sidebar) | `--text-primary` | `--accent` | n/a | n/a | n/a |
| `.settings-nav__brand` (Settings nav) | `--text-primary` | `--accent` | n/a | n/a | n/a |
| `.settings-titlebar__*` (Settings right-pane) | n/a | n/a | `--accent` | `--text-muted` | `--text-primary` |
| `.activity-titlebar__*` (Activity window) | `--text-primary` | `--accent` | `--accent` | `--text-muted` | `--text-primary` |

`apps/desktop/src/renderer/src/styles/__tests__/theme-contract.test.tsx`
locks the brand-accent + breadcrumb token contract across these primitives.
A test fails if anyone (you, a future PR) picks a different accent token
for a brand mark or drifts the Activity titlebar breadcrumb away from the
Settings titlebar. **If you need to deliberately change a chrome token,
change the test in the same commit** so the intent is reviewed, not
accidental.

## Current Product Direction

- Threads are first-class and may exist without a directory.
- Attention, Drafts, Inbox, Recents, and Directories share the thread lens
  switch. The tabs are icon-only; the lens name lives in `aria-label` and the
  tooltip.
- Attention is the work-queue lens: threads with a live turn or waiting to be
  reviewed, in recent-activity order. Its tab is two indicators with counts
  (scanner + in-progress, cookie + unread) rather than an icon, and each goes
  grey at zero so the tab reads as "nothing running, nothing unread" without
  being opened. A zero is shown, never hidden — a vanishing count makes an
  idle tab look like a broken one.
- Drafts is the second state lens: threads holding unsent composer text, in
  recent-activity order. A draft belongs to whoever typed it — it is stored in
  that machine's `composer_draft_latest` table, re-hydrated on the next launch,
  and deliberately **never federated**. A viewer that half-writes a reply to a
  peer's thread sees its own "Draft" chip on that row; the owning instance does
  not, because publishing an operator's unsent text to another machine is not
  something the affordance is worth. Threads carry the chip in every lens, not
  only this one.
- Inbox is the default browsing lens: all threads in recent-activity order.
- Recents shows all threads in thread-creation order so active threads do not
  jump around.
- Inbox and Recents are **pure sort orders** — they do not float pinned threads
  into a section. A pinned thread appears in its natural position by
  updated/created time. Pin *ordering* (drag, the ⌘⇧↑/↓ shortcut, and the
  context menu's Move Up / Move Down) is offered only in Directories, the one
  lens where pin order is visible.
- Directories keep pinned threads first within each directory, then sort
  unpinned threads by thread creation time.
- Unread state remains available as the orange cookie marker on thread rows
  wherever they appear.
- **Unread clears on focus everywhere except the Attention lens.** There,
  focusing a thread deliberately leaves the cookie in place and only a reply
  clears it (the composer reports sends and steers via
  `onUserRepliedToThread`, which routes to `markThreadsSeen`). The rule is
  scoped to that lens rather than global on purpose: a global "only a reply
  clears unread" would stop every lens's unread count draining on its own, so
  a thread you read and decide not to answer would sit unread until you
  explicitly marked it read. Scoping it keeps ordinary browsing unchanged and
  confines the work-queue semantics to the surface that asked for them. The
  `retainedUnreadThread` mechanism is skipped in this lens for the same
  reason — it exists to release (clear) a thread on the way out.
- The exemption belongs to the **lens, not the thread**: leaving Attention
  while an unread thread stays selected marks it seen, because the operator is
  now browsing rather than working a queue. Carrying "never auto-clear" out
  with the thread would leak a rule nobody asked for into every other lens.
  Both halves are pinned by tests in `useThreadNavigation.test.tsx`.
- Reply reporting is **acceptance-gated**, not intent-gated: the composer
  calls `onUserRepliedToThread` only after `startTurn` / `steerTurn` resolves,
  and `useQueuedTurnRelease` does the same when it drains a turn the operator
  queued earlier. Reporting before the await would drop a thread out of the
  queue for a message that never left the machine — the exact loss this lens
  exists to prevent.
- A thread may be associated with multiple linked Git directories.

## Dependency Boundary Enforcement

**DO NOT, under any circumstances, loosen the dependency boundary rules.**

This repository enforces a strict layered dependency architecture via
`dependency-cruiser` (`.dependency-cruiser.cjs`). These rules are load-bearing:

- **DO NOT** add exceptions, allowlists, or `severity: "ignore"` overrides to `.dependency-cruiser.cjs`
- **DO NOT** add imports from packages above a package's layer in the dependency hierarchy
- **DO NOT** introduce circular dependencies between any modules
- **DO NOT** move or restructure code to circumvent boundary rules
- If a rule blocks your change, the change is architecturally wrong — redesign it

The dependency hierarchy (bottom to top):
- **Leaves** (import nothing internal): `packages/shared`
- **Mid-tier**: `packages/messaging/interface` (→ shared only), `packages/messaging/providers/*` (→ messaging/interface only)
- **Top**: `apps/desktop` (→ any package)

Additional renderer constraint: `apps/desktop/src/renderer/` may only import `@pwragent/shared`. All other package access crosses the IPC bridge via the main process.

Enforcement runs via `pnpm lint:boundaries` and fails CI on any violation. Run it locally before pushing.

## App-Specific Guidance

- Additional desktop-app instructions live in [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md).
- Messaging package boundary instructions live in [packages/messaging/AGENTS.md](packages/messaging/AGENTS.md). Review them before adding messaging integrations, changing messaging provider code, or deciding where messaging calls and workflow logic should live.
- For messaging architecture (separation of concerns between interface, providers, and desktop orchestration; data-flow diagrams; the capability-profile system; callback delivery models; file map), read [docs/messaging-architecture.md](docs/messaging-architecture.md). For the formal per-adapter contract, [docs/messaging-adapter-contract.md](docs/messaging-adapter-contract.md). For a hands-on walkthrough when adding a new provider, [docs/messaging-adding-a-provider.md](docs/messaging-adding-a-provider.md). For operator setup, the command surface, and Cloudflare-Tunnel / Tailscale-Funnel deployment for HTTP-callback providers, [docs/messaging-platform-integration.md](docs/messaging-platform-integration.md). For the messaging RBAC capability layer (permission catalog, built-in roles, enforcement surfaces, audit), [docs/messaging-rbac.md](docs/messaging-rbac.md).
