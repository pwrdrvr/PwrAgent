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

- Use ESLint only as a correctness linter.
- Run `pnpm lint:eslint`.
- The CI `Lint` job also runs these checks:
  - `lint:sql`.
  - `lint:codex-storage`.
  - `lint:colors`.
  - `licenses:check`.
  - `typecheck`.
  - `lint:boundaries`.
- [`eslint.config.mjs`](eslint.config.mjs) enables the recommended TypeScript ESLint rules.
- The renderer also uses the classic React Hooks rules.
- The ESLint configuration has no style rules.
- Fix all ESLint errors.
- Existing `no-explicit-any`, `exhaustive-deps`, and intentional patterns can produce warnings.
- CI blocks errors. CI does not block warnings.
- Do not add style or whitespace rules to ESLint.
- Do not use `eslint --fix` to format code.

### Formatting

- The repository intentionally has no automatic formatter.
- Format code by hand.
- Prettier is not a dependency.
- The repository has no `.prettierrc`, `format` script, or CI formatting step.
- Never run `npx prettier` or `prettier --write` on repository files.
- Without a local dependency, `npx` downloads Prettier and uses its default configuration.
- Those defaults conflict with the hand-maintained repository style.
- The defaults also reformat unchanged code.
- In PR #934, Prettier changed approximately 90 unrelated lines around a three-line change.
- Those changes made the diff larger and reduced the value of `git blame`.
- A full repository test changed approximately 77% of files.
- The project rejected that full repository reformat.
- Do not introduce an isolated Prettier reformat.
- Inspect adjacent code before you format new code.
- Use these local style rules:
  - Double quotes.
  - Two-space indentation.
  - Semicolons.
  - Trailing commas in multiline literals.
  - Leading binary operators in wrapped expressions.
- Put a wrapped binary operator at the start of the continuation line:

  ```ts
  const ok =
    isAllowed(char)
    || SAFE_PUNCTUATION.has(char)
    || isDigit(char);
  ```

- Prettier puts these operators at the end of the prior line.
- The repository contains more than 500 leading-operator lines.
- Make new code match adjacent code.
- Keep each diff limited to the requested change.
- If a file has unrelated inconsistencies, do not change those lines.

## Agent Instruction Files

- Put a `CLAUDE.md` symlink next to each `AGENTS.md` file.
- Point each symlink to its sibling `AGENTS.md` file.
- This structure gives Codex and Claude the same local guidance.

## Pull Requests

- Use Conventional Commit-style PR titles: `type(scope): short description`.
- Select the scope that matches the changed area:
  - Use `messaging` for adapters and messaging integrations.
  - Use `desktop` for the desktop application.
  - Use `agent-core` for coding-agent backends and ACP integration.
  - Use `release` for packaging, signing, notarization, distribution, and automatic updates.
  - Use `docs` for documentation.
  - Use `tests` for test coverage, fixtures, and test infrastructure.

## Release / Distribution

- Read the [desktop release runbook](docs/desktop-release-runbook.md) for release procedures.
- The runbook covers packaging, signing, notarization, publishing, and automatic updates.
- PwrAgent uses the MIT license. PwrDrvr LLC owns the project.
- Preserve the repository `LICENSE` file.
- Preserve each package `license: "MIT"` declaration.
- Preserve the third-party license report.
- Do not change the first-party license without an explicit PwrDrvr LLC policy change.
- Do not remove license disclosures without an explicit PwrDrvr LLC policy change.

## Runtime Configuration

- Store all desktop configuration and state under `~/.pwragent/`.
- This directory is the **PwrAgent root**.
- For isolated E2E or development work, override the root with `PWRAGENT_HOME=/path/to/root`.
- Select a named profile with `PWRAGENT_PROFILE=<name>`.
- If the variable is not set, use the `default` profile.
- Store profile settings in `~/.pwragent/profiles/<name>/config.toml`.
- Store profile state in `~/.pwragent/profiles/<name>/state/state.db`.
- Before an incompatible TOML shape change, read [config-file-evolution.md](docs/config-file-evolution.md).
- Apply all of these configuration evolution rules:
  - Read fallback.
  - Lazy conversion.
  - Legacy comment.
  - Dual write.
- Do not use `PWRAGNT_STATE_ROOT` or `PWRAGNT_CONFIG_PATH`.
- The application does not read those removed variables.
- Multiple instances can safely share one profile database through SQLite WAL mode.
- Do not add a lock file for this database.

### Dev-only env vars

These variables are for development only.

- Production operators must not set these variables.
- A packaged build ignores each variable.
- If a packaged build finds one, startup writes a `mainLog.error` entry.
- The packaged build then treats the variable as unset.

`PWRAGENT_PROFILE_AUTO_CREATE=1`

- Skip the onboarding prompt when a named profile does not exist.
- Use this variable for E2E fixtures and replay harnesses that need a profile directory.
- Production launches must use the onboarding wizard.
- The wizard prevents an unrequested mapping to a Codex authentication profile.
- Issue #524 explains this requirement.

`PWRAGENT_DEV_DISABLE_SECRET_STORAGE=1`

- Skip all `safeStorage` operations.
- The wizard silently discards secrets that the operator enters.
- Secret indicators on the Settings screen report `unavailable`.
- Use this workaround only for unsigned development builds on macOS.
- Those builds can show a `Keychain Not Found` dialog because they have no stable signing identity.
- Signed release builds do not have this problem.
- After development, enter the secrets again in **Settings → Models** on a signed build.

`PWRAGENT_DEV_SQLITE_WRITE_METRICS=1`

- Count process-level SQLite commits, statements, rows, WAL growth, and table activity.
- `StateDb.open` installs the metrics wrapper after schema setup.
- Set `PWRAGENT_DEV_SQLITE_WRITE_METRICS_FILE=<path>` to select an output file.
- The metrics file gets one JSON line of totals for each source.
- Read "Sqlite Write-Volume Instrumentation" in [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md).

## Frontend and Desktop UI

- Before renderer UI work, read the [desktop style guide](docs/design/desktop-style-guide.md).
- Before color or theme work, read the [UI theme guide](docs/UI-THEME.md).
- Use existing theme tokens before you add local CSS.
- Prefer a thread-first information hierarchy to a generic dashboard layout.
- Do not put scaffold narration in the user interface.
- Do not put placeholder implementation text in the user interface.

### Reuse existing chrome — copy tokens, don't pick new ones

Before you build new window chrome, open `apps/desktop/src/renderer/src/styles/app.css`.

- Find the existing primitive that has the same function.
- Copy its token references.
- Do not select a different token because it looks similar.
- Keep brand presentation identical in all windows.

This rule applies to these elements:

- Title-bar strips.
- Brand marks.
- Breadcrumbs.
- Eyebrows.
- Path or application rows.

Canonical primitives and the tokens they read:

| Primitive | Brand | Brand accent | Eyebrow | Breadcrumb separator | Breadcrumb current |
|---|---|---|---|---|---|
| `.sidebar__brand` (main sidebar) | `--text-primary` | `--accent` | n/a | n/a | n/a |
| `.settings-nav__brand` (Settings nav) | `--text-primary` | `--accent` | n/a | n/a | n/a |
| `.settings-titlebar__*` (Settings right-pane) | n/a | n/a | `--accent` | `--text-muted` | `--text-primary` |
| `.activity-titlebar__*` (Activity window) | `--text-primary` | `--accent` | `--accent` | `--text-muted` | `--text-primary` |

`apps/desktop/src/renderer/src/styles/__tests__/theme-contract.test.tsx` enforces this token contract.

- The test compares brand accent tokens across the listed primitives.
- The test also compares Activity and Settings breadcrumb tokens.
- If you intentionally change a chrome token, change the test in the same commit.
- This paired change makes the design decision visible during review.

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
