# PwrAgent Repository Guidance

Read the task-specific references below before doing the work they cover. They contain mandatory requirements, scoped approvals, and procedures; they are loaded on demand rather than repeated here.

## Sources and Scope

- Use current code, [ARCHITECTURE.md](ARCHITECTURE.md), and package guidance for current behavior and API shape.
- Before desktop application work, read [apps/desktop/AGENTS.md](apps/desktop/AGENTS.md).
- Before renderer UI work, read [docs/design/desktop-style-guide.md](docs/design/desktop-style-guide.md); before color or theme work, read [docs/UI-THEME.md](docs/UI-THEME.md).
- The [PwrAgent v2 design bundle](docs/design/pwragent-v2/) contains HTML, CSS, and JSX prototypes. Use it as a reference, not an exact copy; read its [SOURCE.md](docs/design/pwragent-v2/SOURCE.md) for history and usage policy.
- Operator documentation belongs in [pwrdrvr/docs.pwragent.ai](https://github.com/pwrdrvr/docs.pwragent.ai): platform setup, streaming, webhooks, and Settings references. Keep contributor messaging documentation in [docs/](docs/).
- Treat `docs/brainstorms/`, `docs/plans/`, and `docs/solutions/` as historical records. Do not delete or rewrite them without explicit user authorization. Read one only for a specific provenance question or explicit document reference.
- Default `rg` searches exclude those records through [`.rgignore`](.rgignore). Use `rg --no-ignore` or `rg -u` only when you need them.
- Exclude `apps/desktop/.local/protocol-captures/` from broad searches; search it only for captured E2E protocol work.
- Put a `CLAUDE.md` symlink next to every `AGENTS.md`, pointing to its sibling `AGENTS.md`, so Codex and Claude receive the same guidance.
- Add repository skills under `.agents/skills/`. `.claude/skills` is a symlink to it because Claude Code discovers project skills only there; never replace it with a directory.
- Keep this file under 24 KiB, `apps/desktop/AGENTS.md` under 16 KiB, and every AGENTS.md chain from the root down under 32 KiB (`pnpm lint:agent-instructions`, also checked by CI's classifier). Codex silently drops AGENTS.md text past 32 KiB along a path. Put details in a linked document and leave a line here saying when to read it.

## Deferred Work and Reviews

- When you find work worth doing but outside this change, raise a PwrAgent to-do card with `add_todo`. This includes gaps, follow-ups, and review findings. The operator does not read deferred-work notes in PR descriptions; do not substitute a PR body, commit message, or code comment for a card.
- If an existing thread owns the work, give the card a `send_message` action with that thread's target; otherwise use `start_thread`. The action prompt must contain the complete, standalone request: the destination cannot see the original card.
- A finding not worth doing needs no card; explain that decision in your reply.
- Settle every tracked finding with `update_review_item`: `addressed` with what changed, `declined` with the reason, or `deferred` after raising a card and passing its id as `todoId`. Claude Code's `skipped` becomes `declined` without a reason; defer it if still worth doing. See [finding outcomes](docs/thread-reviews.md#finding-outcomes).

## Bounded Command Output

- Keep model-visible output bounded; tool output enters thread context and can be replayed.
- Start broad discovery with `rg -l` or `rg --count-matches`. Exclude `__tests__` unless tests are in scope. Then inspect only needed files and line ranges; use `rg -n -C` only on a selected file or small file set.
- Give `sed` an explicit file and line range; it does not use an ignore file. Use the minimum context needed for the next decision.
- Do not combine content-producing reads and searches with `&&`: their standard output becomes one tool result.
- For an intentionally broad scan, redirect all output to an ignored `.local/` log. Report the exact command, exit state, matching file and result counts, failures and warnings, then return only a bounded tail or the fields needed next.
- For native file reads, locate the symbol and request its line range. Start Git inspection with `git diff --stat`, then open the relevant hunks.
- Run the smallest test target that exercises the change. For verbose commands, archive both output streams, preserve the original exit status, and return failing test names and the relevant error block. When available, `capture_token_miser_command` provides an exact-output handle for supported foreground commands.
- Do not use tool-result truncation as an output budget.

## Ownership and Data Boundaries

- PwrAgent code must not read Codex-owned session JSONL, rollout files, or SQLite databases. They are private implementation details; use the Codex App Server protocol for Codex data.
- Never extract or refresh a harness's credentials, call its provider with them, or spoof its User-Agent; use its protocol or CLI. Before touching usage limits, account probes, or harness auth, read [the rules](docs/harness-and-provider-usage.md).
- Features may read PwrAgent-owned files under `~/.pwragent/`; tests may read repository-local fixtures they own. Do not bypass `pnpm lint:codex-storage` with variable renames or shell commands.
- PwrDrvr LLC authorizes only `apps/desktop/src/main/codex-app-server/invalid-response-message-id-recovery.ts` for a narrow repair: only protocol-identified rollouts, only the Responses API invalid message-ID-prefix failure. Validate the thread first, create a backup, make the repair atomic, and remove only invalid `id` fields from response items of type `message`.
- Store desktop configuration and state under the **PwrAgent root**, `~/.pwragent/`. Isolate E2E/development with `PWRAGENT_HOME=/path/to/root`; select `PWRAGENT_PROFILE=<name>` (default: `default`). Settings live in `profiles/<name>/config.toml`; state in `profiles/<name>/state/state.db` under that root.
- Do not use removed variables `PWRAGNT_STATE_ROOT` or `PWRAGNT_CONFIG_PATH`. Multiple instances share a profile database through SQLite WAL; do not add a lock file.
- Before changing runtime configuration, profiles, storage, or development variables, read [docs/runtime-configuration.md](docs/runtime-configuration.md). Development variables are not for production operators; packaged builds ignore and log them. React DevTools builds must never ship.
- Before an incompatible TOML shape change, read [docs/config-file-evolution.md](docs/config-file-evolution.md) and apply read fallback, lazy conversion, legacy comment, and dual write.

## Verification and Platform Constraints

Follow [local CPU checkout](docs/local-cpu-checkout.md) to reserve CPU capacity before local test runs and builds.

- Before source edits or lint/tooling changes, read [code formatting and linting](docs/development-checks.md#code-formatting--linting). Before test execution, read [verification](docs/development-checks.md#verification). Before desktop E2E, screenshot capture, or desktop CI work, read [desktop test operations](docs/development-checks.md#desktop-test-operations).
- For macOS desktop Playwright, including inspect specs and screenshot capture, prefer the dedicated E2E VM when available and follow the [macOS VM E2E lab skill](.agents/skills/macos-vm-e2e-lab/SKILL.md) for on-demand startup through PwrSuiteLab Control MCP. Host runs are allowed when the VM is unavailable or the operator is away from the host desktop and using messaging or a remote Federation viewer, unless the operator asks to keep runs off the host.
- Run unit tests, lint, and typecheck locally or in repository CI. After code edits, run `pnpm lint:oxlint`; production unbound-method checking uses `pnpm lint:oxlint:typed`. Fix all lint errors. `pnpm build` strips types and does not replace lint or `pnpm typecheck`. Run `pnpm lint:boundaries` before pushing.
- If a macOS desktop test bootstrap fails in `stage-runtime.mjs` with a `codesign` invalid-signature error inside a Codex sandbox, follow [the codesign note](docs/development-checks.md#codex-sandbox-codesign-failure); never re-sign binaries, weaken signature checks, drop the build hook, or open a repair card.
- Bug fixes must state the broken rule as a property, model, or oracle test and confirm it fails on pre-fix code; so must rule-heavy logic, state machines, concurrency, and state derived from git, provider events, or an owning instance. Commit counterexamples as examples; generated tests only within [CI budget](docs/property-model-oracle-testing.md#what-to-check-in). Read it first: examples alone have asserted bugs as correct.
- Use the [PwrAgent scaling audit skill](.agents/skills/pwragent-scaling-audit/SKILL.md) to check for quadratic work and fanout when changing Federation protocol handling, Git or forge behavior, incoming transcript parsing or rendering, or transcript loading when returning to a thread.
- Keep a separate `pnpm install` per worktree. Never share root or package `node_modules`: package links can bind to donor source and installs/native staging can mutate shared files.
- Never automatically request sudo during install/launch, run the app as root, or disable sandboxing. Before Linux dependency installation, dev/preview launch, or fatal SUID sandbox repair, read [Linux sandbox setup](docs/development-checks.md#linux-sandbox-setup).
- Linux checks do not verify macOS or Windows behavior. Use native CI or the corresponding PwrSuiteLab skill. For lab operations, read the exact macOS/Windows skill routes in [desktop test operations](docs/development-checks.md#desktop-test-operations); do not improvise product-local Tart labs or direct Tart/SSH access.
- Before changes to Windows Git/Bash process ownership, Vitest isolation, queue/composer lifecycle tests, or lazy renderer readiness, review the ownership/readiness constraints in that same reference. Do not substitute retries, longer timeouts, fewer workers, or serial lanes for ownership or evidence-based readiness fixes.
- macOS CI and release jobs must use free GitHub-hosted `macos-26`, never paid larger runners, `macos-26-intel`, or self-hosted machines. Fork PRs run every macOS job; actool 26 requires a macOS 26 host.
- Check whether Boat is available in PwrAgent before planning remote verification. If Boat is busy or unavailable, use local checks and repository CI without waiting for a slot. Use Boat only when it can start a sandbox and the operator approves or asks in this thread, and read the [Boat verification skill](.agents/skills/boat-verification/SKILL.md) first.
- Read the [workflow label list](.github/workflows/README.md) before using a CI-triggering label.

### SQLite write budgets

- New writes per command, turn, item, streamed event, or timer require measurement and a checked-in budget that fails when the write count changes. Measure commits, not statements; wrap the feature, not setup.
- Before adding such writes or changing budgets, read [Sqlite Write-Volume Instrumentation](apps/desktop/docs/sqlite-write-volume.md#sqlite-write-volume-instrumentation) for calibration baselines, `measureSqliteWrites`, the budget JSON, `UPDATE_SQLITE_WRITE_BUDGETS=1`, and `pnpm test:sqlite-writes`. Keep each write-cost change visible as one reviewable diff line.
- Calculate writes/second × commit cost × session duration and report MB/day. If excessive, report it and ask the user to select another design constraint; do not quietly ship it. Consider one transaction, a flush window, boundary-based persistence, or no persistence.

## Code Style and Architecture

- Format by hand; there is no automatic formatter. Never run `npx prettier`, `npx prettier --write`, or `prettier --write` on repository files. Do not introduce an isolated Prettier reformat, style/whitespace lint rules, or linter fixes to format code.
- Inspect adjacent code and match it: double quotes, two spaces, semicolons, trailing commas in multiline literals, and leading binary operators on continuation lines. Keep the diff scoped; leave unrelated inconsistencies alone.
- Before removing an unused binding, check whether it represents a missing call or assertion. Check leading unused parameters, unused class members, and orphaned exports by hand; syntax lint does not catch all of them.
- Never weaken `.dependency-cruiser.cjs`: no exceptions, allowlists, or `severity: "ignore"` overrides. Do not import above a layer, add cycles, move code, or restructure it to bypass a boundary. Redesign a blocked change.
- Internal dependency order (lowest to highest):
  - `packages/shared`: no internal imports.
  - `packages/messaging/interface`, `packages/federation`, `packages/agent-tools`, and `packages/owner-core`: each imports only `shared` among workspace packages. `owner-core` holds host-independent owner policy, services, and ports, including thread lifecycles, navigation, queues, durable requests, runtime leases, research, and the Codex App Server client.
  - `packages/sqlite-storage` implements profile storage and may import `shared` contracts and `owner-core` ports. Access it through the owner host's storage adapters and state internals.
  - Each `packages/messaging/providers/{discord,feishu,line,mattermost,slack,telegram}` imports only `messaging/interface`, never another provider.
  - `apps/desktop` contains the Electron shell, the headless Node host, and their shared `startOwnerServices` composition root. Its main process can import workspace packages subject to the storage and shell boundaries.
  - Runtime libraries and CLI source under `packages/*/src` and `packages/*/bin` must not import `apps/`. For packaging, `packages/pwragent/scripts/build.mjs` calls `apps/desktop/scripts/build-headless.mjs`. Outpost CLI source consumes the emitted `dist/index.js`; direct workspace package imports and raw SQLite access are forbidden there.
- The desktop renderer may import only `@pwragent/shared` directly; access every other package through main-process IPC. CI fails every boundary violation.

## Desktop Product Rules

- Use existing theme tokens before local CSS. Prefer thread-first information hierarchy. Do not put scaffold narration or placeholder implementation text in the UI.
- Before changing window chrome, title strips, brand marks, breadcrumbs, eyebrows, or path/application rows, read [docs/desktop-chrome-tokens.md](docs/desktop-chrome-tokens.md). Reuse canonical token references and `BrandLockup`; keep brand presentation identical across windows and change contract tests with intentional token changes.
- Before changing lenses, Attention membership/order, unread state, drafts, pins, drag/grouping, reply acceptance, queued sends, or owner/federation behavior affecting them, read [docs/thread-navigation-rules.md](docs/thread-navigation-rules.md).
- Before changing how an Agent's instructions reach a backend, or adding a backend, read [docs/agent-instructions.md](docs/agent-instructions.md). Each backend delivers them once; an Agent in a repository never has an instruction file written there.
- Threads are first-class and can exist without a directory or link to multiple Git directories. Keep unsent drafts local to the viewer's machine; never federate draft text. Report replies only after backend acceptance, including queued sends; failed sends keep the thread in Attention.

## Pull Requests, Releases, and Licenses

- Before drafting or editing a PR title or description, or capturing or attaching PR media, read [docs/pull-request-guidance.md](docs/pull-request-guidance.md), `~/.codex/pr-style.md`, and the PR template. They hold the title scopes, the required before/after screenshots, and the `gh --attach` media rules.
- Before release/distribution work, read [docs/desktop-release-runbook.md](docs/desktop-release-runbook.md) for packaging, signing, notarization, publishing, and updates.
- Before app/Dock icon, macOS packaging, actool/Xcode, or icon-compiling CI changes, read [docs/macos-app-icons.md](docs/macos-app-icons.md). Keep `mac.icon` on `build/icon.icon`; do not hand-build or restore a `.icns`. Packaging requires actool 26+ and icon changes require verification on the newest shipped macOS.
- PwrDrvr LLC owns PwrAgent; keep first-party code MIT and preserve `LICENSE` and third-party disclosures. Before changing shipped dependencies (including fonts), licenses, license tooling/allowlists, embedded Git, or AppImage packaging, read [docs/third-party-license-notices.md](docs/third-party-license-notices.md): copyleft and source-available terms (GPL, AGPL, LGPL, BSL, SSPL, Commons Clause) are prohibited outside its scoped approvals, and adding an allowlist id is a legal decision.

## Messaging Guidance

- Before messaging package work, adding an integration, changing providers, or selecting owners of messaging calls/workflows, read [packages/messaging/AGENTS.md](packages/messaging/AGENTS.md).
- For responsibilities, data flow, capability profiles, callback delivery models, and the file map, read [docs/messaging-architecture.md](docs/messaging-architecture.md); for the formal adapter contract, read [docs/messaging-adapter-contract.md](docs/messaging-adapter-contract.md).
- Before adding a provider, read [docs/messaging-adding-a-provider.md](docs/messaging-adding-a-provider.md).
- For operator setup, messaging commands, Cloudflare Tunnel, Tailscale Funnel, or HTTP callback providers, read [docs/messaging-platform-integration.md](docs/messaging-platform-integration.md).
- For permission catalogs, built-in roles, enforcement points, or audit behavior, read [docs/messaging-rbac.md](docs/messaging-rbac.md).
