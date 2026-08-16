# PwrAgent Repository Guidance

## Source of Truth

- Product requirements are in `docs/brainstorms/`.
- Implementation plans are in `docs/plans/`.
- UI theme tokens and visual rules are in [docs/UI-THEME.md](docs/UI-THEME.md).
- Desktop UI direction is in [docs/design/desktop-style-guide.md](docs/design/desktop-style-guide.md).
- PwrAgent v2 design references are in [docs/design/pwragent-v2/](docs/design/pwragent-v2/).
  - The bundle contains HTML, CSS, and JSX prototypes.
  - [SOURCE.md](docs/design/pwragent-v2/SOURCE.md) gives the source history and usage policy.
  - Use the bundle as a reference. Do not copy it exactly.
- Operator documentation is in [pwrdrvr/docs.pwragent.ai](https://github.com/pwrdrvr/docs.pwragent.ai).
  - Put platform setup, streaming, webhook, and Settings reference content there.
  - Keep contributor messaging documentation in [this repository](docs/).

## Workflow

- Treat plans as decision records. Do not use them as implementation scripts.
- Follow the active plan unless the user changes the scope.
- Treat brainstorms, plans, and solutions as historical records.
  - Do not delete or rewrite a record without explicit user authorization.
  - You may update the plan that the current branch implements.
  - Limit updates to progress, dependencies, and resolved implementation questions.
  - Read [the historical-document rules](docs/plans/AGENTS.md) before you change these files.
- Default `rg` searches exclude brainstorms, plans, and solutions through [`.rgignore`](.rgignore).
  - Use `rg --no-ignore` or `rg -u` only when you need these records.
- Read the [workflow label list](.github/workflows/README.md) before you use a CI-triggering label.
- Exclude `apps/desktop/.local/protocol-captures/` from broad searches.
  - Search that directory only for captured E2E protocol work.

### Command output

- Keep model-visible command output bounded.
- Tool output becomes thread context. Later turns can replay that output.
- For broad discovery, start with `rg -l` or `rg --count-matches`.
- Exclude tests from discovery unless tests are in scope.
- After discovery, inspect only the files and line ranges that you need.
- Use `rg -n -C` only with a selected file or a small file set.
- Use the minimum context that supports the next decision.
- Give `sed` an explicit file and line range. `sed` does not use an ignore file.
- Do not combine content-producing reads and searches with `&&`.
- The shell sends their combined standard output as one tool result.
- For an intentionally broad scan:
  1. Redirect all output to an ignored `.local/` log.
  2. Report the exact command and its exit state.
  3. Report matching file counts and result counts.
  4. Report failures and warnings.
  5. Return only a bounded tail or the fields needed for the next decision.
- Do not use tool-result truncation as an output budget.

### Codex data boundary

- PwrAgent code must not read Codex-owned storage files.
- Treat Codex session JSONL, rollout files, and SQLite databases as private implementation details.
- Use the Codex App Server protocol for Codex data.
- A feature may read PwrAgent-owned files under `~/.pwragent/`.
- A test may read repository-local fixtures that the test owns.
- CI enforces common violations with `pnpm lint:codex-storage`.
- Do not bypass this check through variable renames or shell commands.
- One module has explicit PwrDrvr LLC authorization for a narrow repair:
  `apps/desktop/src/main/codex-app-server/invalid-response-message-id-recovery.ts`.
  - Repair only rollouts identified by the protocol.
  - Repair only the Responses API invalid message-ID-prefix failure.
  - Create a backup before the repair.
  - Make the repair atomic.
  - Validate the thread before the repair.
  - Remove only invalid `id` fields from response items with type `message`.

### Desktop test operations

- Use the [desktop E2E fixture seeding skill](.agents/skills/desktop-e2e-fixture-seeding/SKILL.md) for live captured sessions.
- Run desktop E2E from the repository root with `pnpm test:desktop-e2e`.
- The package command `pnpm --filter @pwragent/desktop test:e2e` is also safe.
- Both commands build `apps/desktop/out/` before Playwright starts.
- Before headed desktop E2E, ask the operator whether an off-desktop lab is available.
- If a lab is available, ask for its repository or skill.
- Read the [Windows Vitest stability guidance](docs/solutions/2026-08-06-windows-vitest-process-isolation.md) before you change:
  - Windows Git or Bash process launch and shutdown.
  - Vitest process isolation.
  - Queue or composer lifecycle tests.
  - Lazy renderer readiness.
- Git-for-Windows launcher handoffs have caused expensive Windows-only failures.
- Non-atomic descendant cleanup has caused expensive Windows-only failures.
- Optimistic renderer synchronization has caused expensive Windows-only failures.
- Do not substitute retries, longer timeouts, fewer workers, or serial lanes for an ownership fix.
- Do not substitute those workarounds for an evidence-based readiness fix.
- The macOS CI lane uses the selected-repository **PwrDrvr macOS** runner group.
- Only PwrAgent and PwrSnap share this group.
- Do not add a repository-scoped runner.
- Do not give the full organization access to this group.
- For branch-drift dialog screenshots, run `pnpm --filter @pwragent/desktop inspect:e2e:branch-drift`.
- This command opens a replay-backed Electron fixture.
- Close the application to end the command.
- For README screenshots, run `pnpm --filter @pwragent/desktop screenshot:readme`.
- The README screenshot command writes files under `docs/assets/screenshots/`.
- Read "Capturing README Screenshots" in [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md) for the complete procedure.
- That procedure identifies the specification, fixtures, state helpers, and native capture tools.
- The terminal or IDE that runs the screenshot test needs macOS Screen Recording permission.
- To focus root Vitest, pass file paths or filters directly to `pnpm test`.
- For example, run `pnpm test apps/desktop/src/main/__tests__/backend-registry.test.ts`.
- Do not put a standalone `--` before the focus arguments.
- The command `pnpm test -- apps/...` runs the full workspace suite.

### SQLite write budgets

- Measure a new SQLite write if it runs at any of these frequencies:
  - Per command.
  - Per turn.
  - Per item.
  - Per streamed event.
  - On a timer.
- Add a checked-in write budget that fails when the write count changes.
- Calculate the write cost as writes per second × commit cost × session duration.
- Report the projected cost in MB per day.
- Count SQLite commits, not statements.
- Each implicit transaction flushes dirty pages and all changed index pages.
- A SQLite page is approximately 4 KB.
- An indexed timestamp can move one index entry during each write.
- Use these calibration results:
  - PR #1406 wrote once for each streamed 8 KiB chunk.
  - One `find /` caused 3,693 commits and 58 MB of WAL.
  - Former 10-second runtime lease heartbeats caused 720 commits each hour.
  - Those heartbeats wrote 2.7 MB each hour for each running instance.
  - That rate was approximately 65 MB each day.
  - PID-owned runtime leases now make no SQLite commits while idle.
- If the projection is excessive, report it to the user.
- Do not quietly ship an excessive projection.
- Ask the user to select a different design constraint.
- Possible designs include one transaction, a flush window, or boundary-based persistence.
- The correct design can also be no persistence.
- Write budgets are in `apps/desktop/src/main/__tests__/fixtures/sqlite-write-budgets.json`.
- Wrap the feature, not its setup, with `measureSqliteWrites`.
- Record a budget with `UPDATE_SQLITE_WRITE_BUDGETS=1`.
- Keep each write-cost change visible as one reviewable diff line.
- Survey a full run with `pnpm test:sqlite-writes`.
- Read "Sqlite Write-Volume Instrumentation" in [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md).

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
  reviewed. Its tab is two indicators with counts
  (scanner + in-progress, cookie + unread) rather than an icon, and each goes
  grey at zero so the tab reads as "nothing running, nothing unread" without
  being opened. A zero is shown, never hidden — a vanishing count makes an
  idle tab look like a broken one.
- **Attention orders by turn, not by activity.** Every other lens is a pure
  sort over `updatedAt` / `createdAt`; this one is not, because `updatedAt`
  moves on every streamed item, sub-agent invocation, and tool result, and a
  queue that re-sorts under the pointer while two turns run is unusable. Each
  member holds a rank minted when its turn *starts* and left alone for the rest
  of that turn, so a thread moves at most twice per turn no matter how loud the
  turn is. The second move is the one exception, and it is a setting:
  `general.attention_promote_on_turn_end` (default on) gives a finished turn one
  last trip to the top so freshly completed work surfaces for review. That
  covers a turn this window watched run *and* one it only learned about
  afterwards — a messaging- or peer-driven turn can start and finish inside a
  single poll interval, so an idle member whose `updatedAt` advanced counts as a
  finished turn too. A live turn can never take that path, which is what keeps
  it from becoming a back door to update-driven churn. Ranks are
  a monotonic counter, not a clock — no `Date.now()` in a render path and no
  ties to break — and they are scoped to current lens membership, so a thread
  that leaves and returns is fresh activity and re-enters at the top. The
  reducer and the reasoning live in
  [attention-order.ts](apps/desktop/src/renderer/src/features/navigation/attention-order.ts).
- Drafts is the second state lens: threads holding unsent composer text, in
  recent-activity order. A draft belongs to whoever typed it — it is stored in
  that machine's `composer_draft_latest` table, re-hydrated on the next launch,
  and deliberately **never federated**. A viewer that half-writes a reply to a
  peer's thread sees its own "Draft" chip on that row; the owning instance does
  not, because publishing an operator's unsent text to another machine is not
  something the affordance is worth. Threads carry the chip in every lens, not
  only this one. Two limits are deliberate rather than bugs: the storage is
  machine-wide but each window reads it once at mount, so a second open window
  does not light up until it restarts; and launchpad (new-thread) composer text
  has no thread row, so the lens says "replies" and its empty state says "No
  unsent replies."
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
