# PwrAgent Repository Guidance

## Source of Truth

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

- Treat existing brainstorms, plans, and solutions as historical records.
  - The record directories are `docs/brainstorms/`, `docs/plans/`, and `docs/solutions/`.
  - Do not delete or rewrite a record without explicit user authorization.
  - Read a record only for a specific provenance question or an explicit document reference.
  - Use current code, `ARCHITECTURE.md`, and package guidance for current behavior and API shape.
- Default `rg` searches exclude brainstorms, plans, and solutions through [`.rgignore`](.rgignore).
  - Use `rg --no-ignore` or `rg -u` only when you need these records.
- Read the [workflow label list](.github/workflows/README.md) before you use a CI-triggering label.
- Exclude `apps/desktop/.local/protocol-captures/` from broad searches.
  - Search that directory only for captured E2E protocol work.

### Command output

- Keep model-visible command output bounded.
- Tool output becomes thread context. Later turns can replay that output.
- For broad discovery, start with `rg -l` or `rg --count-matches`.
- Exclude `__tests__` from discovery unless tests are in scope.
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
- For PwrSuiteLab macOS Tart, runner, or headed E2E work, follow
  `.agents/skills/macos-vm-e2e-lab/SKILL.md`. It routes to PwrSuiteLab.
  Do not provision a product-local Tart lab from this repository.
- For PwrSuiteLab Windows probes or headed E2E, read
  `.agents/skills/use-windows-vm-lab/SKILL.md` in the attached lab checkout.
  Do not use the macOS VM skill for Windows work.
- Use the attached primary PwrSuiteLab checkout for its controllers. Check an
  expected ignored config with an exact filesystem test. `rg --files`,
  `git ls-files`, and other worktrees do not prove that config is absent.
- Do not read or print lab configuration. If the exact default is absent, ask
  the operator for an existing config path only.
- Review the current ownership and readiness constraints before you change:
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
- ESLint sets existing `no-explicit-any`, `exhaustive-deps`, and intentional patterns to `warn`.
- CI blocks errors. CI does not block warnings.
- Do not add style or whitespace rules to ESLint.
- Do not use `eslint --fix` to format code.

### Formatting

- The repository intentionally has no automatic formatter.
- Format code by hand.
- Prettier is not a dependency.
- The repository has no `.prettierrc`, `format` script, or CI formatting step.
- Never run `npx prettier`, `npx prettier --write`, or `prettier --write` on repository files.
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
  - Use `messaging` for Telegram, Discord, adapters, and messaging integrations.
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

### Third-party dependency licenses

- Three scripts cover licensing. They check different things.

| Script | Checks |
|---|---|
| [`check-package-licenses.mjs`](scripts/check-package-licenses.mjs) | Our own workspace `package.json` files declare MIT. Never looks at a dependency. |
| [`check-third-party-license-allowlist.mjs`](scripts/check-third-party-license-allowlist.mjs) | Every declared license the notice covers is on an allowlist. |
| [`generate-third-party-licenses.mjs`](scripts/generate-third-party-licenses.mjs) | Transcribes the tree into `THIRD_PARTY_LICENSES`. Judges nothing. |

- That last row is the reason the allowlist gate exists.
- The generator groups records by whatever license string pnpm reports.
- Before the gate, a dependency that flipped MIT to GPL-3.0 wrote a new `GPL-3.0` section into the notice.
- `generate-third-party-licenses.mjs --check` then passed, because the committed file matched the generated file.
- CI went green and shipped copyleft.
- The only safety was that a reviewer might notice a new license heading in the diff.
- `pnpm licenses:check` runs the allowlist gate before the notice check.
- A bad license then reports as a licensing problem, not as a stale notice.
- Run the gate alone with `pnpm licenses:allowlist`.
- The gate evaluates each declared license as an SPDX expression, not as a string match.
- `OR` is satisfied by either side. `(MIT OR WTFPL)` passes on its MIT half, so WTFPL needs no allowlist entry.
- `AND` requires both sides. `Apache-2.0 AND GPL-3.0` fails.
- `AND` binds tighter than `OR`.
- Identifier comparison folds case, because SPDX short identifiers are case-insensitive.
- An unparseable string fails. Examples are `UNLICENSED`, `SEE LICENSE IN LICENSE.md`, and a `WITH` exception.
- Refusing to guess is the safe direction for a legal gate.

#### Gate coverage

- The gate covers the records the notice is built from.
- It reads the npm production tree for the `@pwragent/desktop...` pnpm selector.
- The `...` suffix is load-bearing. Keep it.
- A bare `@pwragent/desktop` selects that one project.
- `pnpm licenses list` then reports only the dependencies that `apps/desktop/package.json` declares.
- Every dependency reached through a workspace package is invisible to that selector.
- `@pwragent/desktop` depends on eight workspace packages.
- The whole npm tree under the six messaging providers ships in the packaged application.
- Before the suffix, 69 shipped packages were absent from the notice and ungated.
- `NOTICE_PNPM_FILTER` in [`generate-third-party-licenses.mjs`](scripts/generate-third-party-licenses.mjs) holds this selector.
- The generator and the gate import that one constant, so the two cannot drift.
- A test asserts the exact selector string, because dropping the suffix leaves every check passing.
- It reads `NOTICE_DEV_DEPENDENCIES` from the `all` report.
- That set holds Electron, a devDependency that ships and that `--prod` never reports.
- The generator and the gate import that one set, so the two cannot drift.
- Add a name to `NOTICE_DEV_DEPENDENCIES` when a devDependency starts shipping.
- The synthesized platform variants copy `declaredLicense` from their parent record.
- Gating the production tree therefore gates them.
- The gate reports a failure when a surface produced no records at all.
- An empty report is otherwise indistinguishable from a clean tree.
- The gate does **not** cover these sources:
  - Optional dependencies that the running machine did not install. The generator does not pass `--no-optional`, and the CI `Lint` job runs on `ubuntu-latest` only.
  - A platform variant's own package metadata. The notice prints the parent's license for every variant, so neither script ever reads one.
  - devDependencies outside `NOTICE_DEV_DEPENDENCIES`. They do not ship and the notice does not disclose them.
  - Chromium and Node.js components inside Electron. The notice points at Electron's upstream generated credits.
  - Codex App Server Rust crates. PwrAgent invokes a locally installed Codex App Server and vendors no crate.

#### Changing the allowlist

- Adding an id to `ALLOWED_LICENSE_IDS` is a legal decision.
- Make that decision in a commit that says why.
- Never add an id to make CI green.
- Strong copyleft and source-available terms are permitted nowhere.
- Those terms include GPL, AGPL, BSL, SSPL, and Commons Clause.
- LGPL is also permitted nowhere.
- PwrAgent ships no LGPL component, and the notice carries no FSF text and no written source offer.
- An LGPL arrival would therefore have nothing to disclose with.
- `MPL-2.0` is the one copyleft id on the allowlist.
- Its copyleft binds the MPL-licensed files themselves.
- It places no condition on the larger work that includes them.
- Do not read that entry as permission for file-scoped copyleft in general.
- The seeded list records drift that existed before any policy was enforced.
- `BlueOak-1.0.0` and `Python-2.0` were already in the shipped tree and documented nowhere.
- `0BSD`, `CC0-1.0`, `MPL-2.0`, and `Unlicense` are approved ids that the production tree does not use today.

#### Dependabot PRs regenerate the notice automatically

- `licenses:check` compares the committed notice against the installed tree.
- Any dependency change therefore makes the committed notice stale.
- Dependabot cannot run `pnpm licenses:generate` itself.
- Every Dependabot PR used to land with `Lint` red on that one line.
- Each one needed a hand-pushed follow-up commit.
- [dependabot-licenses.yml](.github/workflows/dependabot-licenses.yml) pushes that commit.
- Read its header before you edit it.
- Four controls keep a dependency bump from running its install scripts with a
  token that can write to this repository:
  - The `guard` job pins the actor to `dependabot[bot]` and the head to this repo.
  - A file guard refuses any PR that touches more than dependency manifests.
  - Only the `regenerate` job holds `contents: write`, reached through `needs: guard`.
  - The install runs `--ignore-scripts`.
- The workflow runs the allowlist gate first and pushes nothing if it fails.
- That ordering is the reason unattended regeneration is safe.
- A bad license stops the job instead of arriving as a bot commit with green CI.

##### Editing the workflow

- Keep the file guard's `allowed` regex in sync with `packages:` in `pnpm-workspace.yaml`.
- A workspace directory missing from that regex blocks its own Dependabot PRs.
- `packages/messaging/providers/*` is three levels deep, so a two-level regex is wrong here.
- Keep the `paths:` trigger filter in sync with the same globs.
- `pnpm-workspace.yaml` is deliberately absent from the allowed set.
- It carries `onlyBuiltDependencies`, which decides whose install scripts may run.
- The file guard fails closed. An unreadable file list is an error, not an empty violation list.
- Do not fold the `gh api` call into a pipeline with `grep`.
- That substitution lets `grep`'s exit status stand in for the API's and fails open.
- Do not add a build, test, or typecheck step to the `regenerate` job.
- The `--ignore-scripts` tree has no Electron binary and no rebuilt native addon.
- The PR's own CI run covers those checks on a normal install with no privileged token.
- The `secrets` context is not available in a step-level `if`.
- An unavailable context reads as empty, so `if: secrets.FOO == ''` is true even when `FOO` is set.
- Do the presence tests in job-level `env`, which can read secrets.

##### Token

- A push made with the default `GITHUB_TOKEN` does not trigger new workflow runs.
- Without a different token the PR keeps showing its stale red checks.
- The workflow prefers a GitHub App token, then `RELEASES_PAT`, then `GITHUB_TOKEN`.
- `RELEASES_PAT` already exists here, so the fallback works with no provisioning.
- Prefer a narrowly-scoped App anyway.
- `RELEASES_PAT` is broad, and this job installs PR-controlled dependencies under `pull_request_target`.
- To use the App path, set repository variable `LICENSES_BOT_APP_CLIENT_ID`.
- Also set repository secret `LICENSES_BOT_APP_PRIVATE_KEY`.
- Install that App on this repository with `contents: write`.
- Both are required. Setting one alone falls back and warns.

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

- A build is packaged when `app.isPackaged === true`.
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
- Secret pills on the Settings screen report `unavailable`.
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

### Reuse existing chrome tokens

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

### Thread model and lenses

- Threads are first-class and may exist without a directory.
- Attention, Drafts, Inbox, Recents, and Directories use one thread lens switch.
- Each lens tab contains only an icon or status indicators.
- Put the lens name in the `aria-label` and tooltip.
- A thread can have links to multiple Git directories.

### Attention lens

- Use Attention as the work queue.
- Include threads with a live turn.
- Include threads that wait for review.
- Use two count indicators instead of a tab icon:
  - A scanner for turns in progress.
  - An orange cookie for unread threads.
- Show zero for each empty count.
- Make an indicator grey when its count is zero.
- Do not hide a zero indicator. A missing indicator makes an idle tab appear broken.

### Attention order

- Order Attention by turn, not by activity.
- All other lenses use a pure `updatedAt` or `createdAt` sort.
- Do not use `updatedAt` to order Attention.
- `updatedAt` changes for each streamed item, subagent call, and tool result.
- Activity ordering would move queue items while the operator uses the queue.
- Give each Attention member a rank when its turn starts.
- Keep that rank for the complete turn.
- A thread can move at most twice during one turn.
- The optional second move occurs when the turn ends.
- `general.attention_promote_on_turn_end` controls that move and defaults to on.
- When enabled, move a finished turn to the top for review.
- Apply this promotion to a turn that the current window observed.
- Also apply it to a turn that starts and finishes between polls.
- Messaging and peer-driven turns can use this case.
- For that case, treat an idle member with a newer `updatedAt` as a finished turn.
- Never use this detection path for a live turn.
- Use a monotonic counter for ranks. Do not use a clock.
- Do not call `Date.now()` from the render path.
- Do not create rank ties.
- Scope ranks to current Attention membership.
- If a thread leaves and returns, give it a new rank at the top.
- The reducer and design rationale are in [attention-order.ts](apps/desktop/src/renderer/src/features/navigation/attention-order.ts).

### Drafts lens

- Drafts is the second state lens.
- Use Drafts for threads that contain unsent composer text.
- Sort Drafts by recent activity.
- Store a draft on the machine where the operator writes it.
- Store the latest draft in `composer_draft_latest`.
- Restore that draft during the next application launch.
- Never federate draft text.
- A viewer can draft a reply to a thread from a peer instance.
- Show the Draft chip only to that viewer.
- Do not show that draft to the instance that owns the thread.
- This rule prevents publication of an operator's unsent text.
- Show the Draft chip in every lens.
- The current implementation has two intentional limits:
  - Draft storage is machine-wide, but each window reads it only during mount.
  - A second window does not update its Draft chips until it restarts.
  - Launchpad composer text has no thread row.
  - Therefore, the lens label uses `replies`.
  - Its empty state is `No unsent replies.`

### Inbox, Recents, and Directories

- Use Inbox as the default browsing lens.
- Sort Inbox by recent activity.
- Show all threads in Inbox.
- Sort Recents by thread creation time.
- Show all threads in Recents.
- This creation-time order prevents active threads from moving.
- Keep Inbox and Recents as pure sort orders.
- Do not create a pinned section in those lenses.
- In Inbox, show each pinned thread at its normal `updatedAt` position.
- In Recents, show each pinned thread at its normal `createdAt` position.
- Offer visible pin ordering only in Directories.
- The pin-order controls are:
  - Drag.
  - The `⌘⇧↑` and `⌘⇧↓` shortcuts.
  - **Move Up** and **Move Down** in the context menu.
- Within each directory, show pinned threads first.
- Sort unpinned directory threads by thread creation time.

### Unread behavior

- Show unread state as an orange cookie on thread rows in every lens.
- In all lenses except Attention, clear unread state when the thread gets focus.
- In Attention, keep unread state when the thread gets focus.
- In Attention, clear unread state only after the operator sends a reply.
- The composer reports accepted sends and steers through `onUserRepliedToThread`.
- That callback calls `markThreadsSeen`.
- Do not apply reply-only clearing to other lenses.
- A global rule would leave read threads unread when the operator does not reply.
- Keep normal focus-based clearing in ordinary browsing lenses.
- Skip `retainedUnreadThread` in Attention.
- That mechanism normally clears a retained thread when the operator leaves it.
- Apply the exemption to the Attention lens, not to a thread.
- If the operator leaves Attention, clear the selected thread's unread state.
- This rule applies when the selected thread remains selected in the next lens.
- Tests in `useThreadNavigation.test.tsx` enforce both parts of this transition.

### Reply acceptance

- Report a reply only after the backend accepts it.
- Do not report a reply when the operator only attempts it.
- Call `onUserRepliedToThread` only after `startTurn` or `steerTurn` resolves.
- Apply the same rule when `useQueuedTurnRelease` sends a queued turn.
- If the send fails, keep the thread in Attention.
- Early reporting would remove a thread for a message that never left the machine.

## Dependency Boundary Enforcement

Never weaken the dependency boundary rules.

- `.dependency-cruiser.cjs` defines the layered architecture.
- `dependency-cruiser` reads this configuration.
- Do not add an exception or allowlist to that file.
- Do not add a `severity: "ignore"` override.
- Do not import from a package above the current package layer.
- Do not introduce a circular dependency.
- Do not move code to bypass a boundary.
- Do not restructure code to bypass a boundary.
- If a boundary blocks a change, redesign the change.

Use this dependency order from lowest to highest:

- `packages/shared` imports no internal package.
- `packages/messaging/interface` imports only `packages/shared`.
- `packages/messaging/providers/*` imports only `packages/messaging/interface`.
- `apps/desktop` can import any package.

The renderer has an additional boundary.

- `apps/desktop/src/renderer/` can import only `@pwragent/shared` directly.
- Access every other package through the main-process IPC bridge.
- Run `pnpm lint:boundaries` before you push.
- CI fails for every boundary violation.

## App-Specific Guidance

- Before desktop application work, read [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md).
- Before messaging package work, read [packages/messaging/AGENTS.md](packages/messaging/AGENTS.md).
- Read the messaging package guidance before you:
  - Add a messaging integration.
  - Change messaging provider code.
  - Select the owner of messaging calls or workflow logic.
- Read [messaging-architecture.md](docs/messaging-architecture.md) for:
  - Package responsibilities.
  - Data flow.
  - Capability profiles.
  - Callback delivery models.
  - The messaging file map.
- Read [messaging-adapter-contract.md](docs/messaging-adapter-contract.md) for the formal adapter contract.
- Read [messaging-adding-a-provider.md](docs/messaging-adding-a-provider.md) before you add a provider.
- Read [messaging-platform-integration.md](docs/messaging-platform-integration.md) for:
  - Operator setup.
  - Messaging commands.
  - Cloudflare Tunnel deployment.
  - Tailscale Funnel deployment.
  - HTTP callback providers.
- Read [messaging-rbac.md](docs/messaging-rbac.md) for:
  - The permission catalog.
  - Built-in roles.
  - Enforcement points.
  - Audit behavior.
