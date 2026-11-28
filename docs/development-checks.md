# Development Checks and Formatting

Read this before source edits, dependency installation, test execution, lint/tooling changes, or desktop CI work. These are repository requirements; use the native platform route for the behavior being verified.

## Linux sandbox setup

- Install and desktop dev/preview run an advisory, read-only check of Electron's
  setuid helper. User namespaces may allow launch without that helper.
- From the repository root, use `pnpm check:linux-sandbox` to repeat the check
  and `pnpm fix:linux-sandbox` for the fatal SUID sandbox error.
- The fixer resolves this checkout's installed helper and explicitly uses sudo
  for `chown root:root` followed by `chmod 4755`, then verifies the result.
  It is idempotent; both commands safely no-op on non-Linux platforms.
- Never request sudo automatically during install or launch, run the app as
  root, or disable sandboxing. Reinstalling dependencies or replacing Electron
  may require repeating the repair. Mount/security policy can still block startup.
- Keep a separate `pnpm install` per worktree. Sharing root `node_modules` cannot
  supply package-local links; sharing package `node_modules` can bind workspace
  imports to donor source and make installs/native staging mutate shared files.
  A symlink to a repaired helper inherits permissions but is not a complete fix.

## Verification

- Run unit tests, lint and typecheck locally using the commands below or in repository CI.
- Desktop E2E uses the existing local and CI routes. Linux checks do not verify
  macOS or Windows behavior; use the corresponding native CI or PwrSuiteLab skills.
- For optional remote verification, check PwrAgent's `manage_mcp_connections`
  with `action: list` for account capacity and `action: describe_thread` for
  thread access. Boat must be selected and ready for this thread and report
  `sandboxStart.canStart: true` in the account list. If Boat is at its limit,
  report the reason and use local checks and repository CI without waiting.
- Use Boat only when the operator asks or approves in this thread. If you
  propose it, say it bills per second while running and wait for approval.
  If approval or capacity is missing, keep using local checks and CI.
  Follow the [Boat verification skill](../.agents/skills/boat-verification/SKILL.md)
  for setup, checks and cleanup. The
  [old Sandboxer procedure](../.agents/skills/sandboxer-verification/SKILL.md)
  is preserved as a historical reference.

### Codex sandbox codesign failure

On macOS, Codex Auto/Default access sandboxes can make the desktop test
bootstrap fail in `packages/pwragent/scripts/stage-runtime.mjs` with `codesign`
reporting `runtime/bin/git: invalid signature (code or signature have been
modified)`. The same checkout and normal test command passed in
operator-selected Full Access on 2026-11-15, including the Outpost build and
signature check.

- First rerun the exact command outside the Codex sandbox using
  operator-authorized Full Access or native CI.
- Do not re-sign binaries, weaken signature checks, omit the build hook as a
  fix, or open another repair card for this known sandbox-only symptom.
- Investigate a signing defect if it also reproduces outside the sandbox.

## Desktop test operations

- Use the [desktop E2E fixture seeding skill](../.agents/skills/desktop-e2e-fixture-seeding/SKILL.md) for live captured sessions.
- Run desktop E2E from the repository root with `pnpm test:desktop-e2e`.
- The package command `pnpm --filter @pwragent/desktop test:e2e` is also safe.
- Both commands build `apps/desktop/out/` before Playwright starts.
- For macOS desktop Playwright, follow the [VM preference and host exceptions](../AGENTS.md#verification-and-platform-constraints).
  Native CI is also available for verification. An approved Boat sandbox can
  run Linux desktop E2E when the prerequisites in the Boat skill are met.
- For PwrSuiteLab macOS Tart, runner, or headed E2E work, follow
  [the macOS VM E2E lab skill](../.agents/skills/macos-vm-e2e-lab/SKILL.md). It uses PwrSuiteLab Control MCP's
  current schemas and served skills when connected. Use the
  managed-controller fallback only when MCP is unavailable, preserving existing
  scoped authorizations. Do not provision a product-local Tart lab or improvise
  direct Tart or SSH access from this repository.
- For PwrSuiteLab Windows probes or headed E2E, read
  `.agents/skills/use-windows-vm-lab/SKILL.md` in the attached lab checkout.
  Do not use the macOS VM skill for Windows work.
- PwrSuiteLab also manages access to reusable Windows EC2 instances when
  available. Consult that project's current Windows EC2 skill and documentation
  for availability and operations.
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
- macOS CI and release jobs run on free GitHub-hosted `macos-26` runners.
  - Use `macos-26`: actool 26 compiles the app icon and needs a macOS 26 host.
  - Do not use a paid larger size or `macos-26-intel`.
  - Do not move a CI job onto self-hosted machines. This repository is public,
    and fork pull requests run every macOS job.
- For branch-drift dialog screenshots, run `pnpm --filter @pwragent/desktop inspect:e2e:branch-drift`.
- This command opens a replay-backed Electron fixture.
- Close the application to end the command.
- For README screenshots, run `pnpm --filter @pwragent/desktop screenshot:readme`.
- The README screenshot command writes files under `docs/assets/screenshots/`.
- The README itself now uses WebP captures, `docs/assets/screenshots/*.webp`, taken from the built app at 1440×900 on a Retina display with invented showcase data.
- Read "Capturing README Screenshots" in [apps/desktop/docs/screenshots.md](../apps/desktop/docs/screenshots.md#capturing-readme-screenshots) for the complete procedure.
- That procedure identifies the specification, fixtures, state helpers, and native capture tools.
- The terminal or IDE that runs the screenshot test needs macOS Screen Recording permission.
- To focus root Vitest, pass file paths or filters directly to `pnpm test`.
- For example, run `pnpm test apps/desktop/src/main/__tests__/backend-registry.test.ts`.
- Do not put a standalone `--` before the focus arguments.
- The command `pnpm test -- apps/...` runs the full workspace suite.

## Chromium renderer layout check

Install the browser once with
`pnpm --filter @pwragent/desktop exec playwright install --only-shell chromium`.
Run `pnpm --filter @pwragent/desktop test:renderer-layout`.
The required Linux `Test` check includes this Playwright project on product
changes. Vite serves the real renderer components and stylesheet to headless
Chromium. The project runs without Electron. The terminal fixture supplies an
in-memory IPC bridge that records the PTY grid and emits terminal events.

- The sidebar model shares one page across five generated fast-check layouts,
  one for each sidebar lens, and three fixed regressions. It checks that lanes
  fit, lead PR numbers and Minimal's rollups render, and controls fit within
  their surfaces and clipping ancestors.
- The thread terminal model runs four fixed regressions and five generated
  sequences of at most five transitions. It measures xterm rows and the ended
  bar against their clipping bounds, checks grip hit targets and resize
  distances, and compares the painted grid with the PTY size after fitting.

A failure identifies the example or the generated seed and case. Set
`PWRAGENT_LAYOUT_SEED` to the reported seed to replay generated cases. The
thread terminal model uses seed `424242` by default.

## Code Formatting & Linting

- Use Oxlint only as a correctness linter. Run `pnpm lint:oxlint` after edits.
- Run `pnpm lint:oxlint:typed` for the production unbound-method check.
  - CI always runs both passes; routine local syntax lint avoids loading types.
  - Typed lint is uncached: imported declarations can change its results.
  - `scripts/lint-typed.mjs` rejects typed-rule suppression comments, including
    file-wide disables, before invoking the native typed backend. This preserves
    the former ESLint `--no-inline-config` protection.
- `pnpm lint:eslint` is a compatibility alias for both Oxlint passes.
- The former ESLint configs and `lint:eslint:cached` / `lint:eslint:typed`
  commands remain available for migration comparisons.
- The CI `Lint` job also runs SQL, Codex-storage, colors, Electron-version,
  property-budget, license, typecheck and dependency-boundary checks.
- `.oxlintrc.json` preserves the recommended correctness rules and classic
  renderer React Hooks checks. `oxlint.typed.json` scopes the typed rule.
- Fix all lint errors. Existing `no-explicit-any`, `exhaustive-deps` and
  intentional patterns remain warnings. CI blocks errors, not warnings.
- Do not add style or whitespace rules or use linter fixes to format code.
- Run `pnpm typecheck` to use TypeScript 7's native compiler. The
  `typescript-native` alias is pinned separately; TypeScript 6 remains for
  JavaScript API consumers such as ESLint and dependency-cruiser.
- Dependency-boundary checks run uncached so resolution configuration changes
  always rebuild the graph.

### Typecheck projects

`pnpm typecheck` builds the workspace package references and checks desktop
production code outside the renderer. It uses separate compiler processes
for desktop main tests, E2E and scripts, and for renderer code and tests.
Use `pnpm --filter @pwragent/desktop typecheck`
for desktop and its dependencies, or run an individual package's typecheck
script. Add workspace projects to `tsconfig.typecheck.json` and declare their
direct TypeScript references in the consuming configs.

Workspace packages emit declarations and build state to their local
`node_modules/.cache/pwragent-typecheck/` directories. Project references
redirect TypeScript to these declarations while runtime bundlers resolve the
existing source exports. The desktop test projects resolve implementation
source because some tests and benchmark scripts exercise private members whose
types declaration emit erases. The desktop editor and bundler use
`apps/desktop/tsconfig.json`.
When changing test root patterns, update the corresponding exclusions in
`apps/desktop/tsconfig.production.json`.

On hosts reporting less than 32 GiB of RAM, the main test, E2E, and script
stage and desktop watch use two checkers and a `4608MiB` soft Go memory
limit. On hosts with at least 32 GiB, they use four checkers and Go's default
memory behavior. The other stages default to four checkers. Pass
`--checkers` or set `GOMEMLIMIT` to override the defaults.

Use `pnpm typecheck --clean` to clear the generated typecheck outputs and
`pnpm typecheck --verbose` to see which projects are rebuilt.
The build runner checks the installed pnpm graph, workspace manifests, and
direct dependency targets at startup and invalidates cached checks when they
change.

`pnpm --filter @pwragent/desktop typecheck --watch` uses the full desktop
config in one compiler process so that production, tests, E2E, and renderer
files are all watched. The root workspace command requires a finite check.

### Main function bytecode budget

- Run `pnpm check:main-bytecode` after main-process or reachable first-party
  helper changes. CI's Lint job runs it and retains the full JSON report.
- The command rebuilds shipped main, measures actual desktop-main Vitest SSR
  on Node, and compiles production ESM on Node and Electron. It shares the
  compiler mechanism with the renderer while preserving their transforms.
- Every first-party function, including anonymous/nested functions and newly
  extracted helper modules, has the same 25,600-byte early operational budget.
  Unmapped functions retain the budget. Synthetic frames and third-party
  dependencies are measured and reported separately.
- This is a chosen policy, not a V8 hard cutoff or a latency claim. See
  [the main audit, exact maxima, coverage and limits](main-bytecode-budget.md).

### Renderer function bytecode budget

- Run `pnpm check:renderer-bytecode` after changing `DesktopAppShell`, `Sidebar`,
  `ThreadView`, `AutomationEditor`, `Composer`, or their extracted helpers.
  The CI Lint job runs it too.
- The check uses the real Vitest SSR transform and module wrapper, then asks
  V8 to compile every function in the covered modules without executing them.
  It checks both ordinary output and output compressed by Vite's Oxc minifier.
- Each function, including nested and anonymous callbacks, has a 25 KiB
  (25,600-byte) operational budget. This chosen early budget is distinct from
  V8's default 60 KiB TurboFan eligibility limit and is not a universal latency
  threshold. Runtime performance claims require three plain-Node and three
  no-Sparkplug measurements, with machine and runtime details reported.
- `scripts/renderer-bytecode-scope.mjs` owns the eight entry modules: the five
  views plus Composer's three extracted hooks. All new relative imports,
  reexports, renderer aliases and literal lazy imports are followed recursively.
  Moving a callback to a new helper module does not remove its coverage.
- `scripts/renderer-bytecode-boundaries.json` lists pre-existing independent
  dependencies outside these controllers' ownership. It is an explicit scope
  boundary, not a bytecode exemption within a covered module. Do not add an
  extracted helper to that list to pass the check. A scope change requires a
  reviewable rationale; this budget does not cover the entire renderer.
- `--report <path>` saves every measured function and the complete scope as
  JSON. `--scope <path>` accepts alternate roots and boundaries for audit and
  oracle fixtures; CI always checks the default scope.
- Extract cohesive state, effects and actions into custom hooks, and use pure
  projections or stable module-level components for presentation. Keep
  callbacks and state at the same lifetime as their owning view.
- Keep JSX construction in separate named function frames (declarations or
  directly called function expressions). The minifier folds single-use arrow
  helpers back into their callers. Calling a helper
  preserves the component's hook order and React identity while compiling the
  render body separately from setup. Do not replace the call with an inline
  return or render a locally defined helper as a React component.
- The compiler subprocess reduces disassembly as it streams. It does not
  change V8 tiers or flags in the app or test workers. Bytecode size is a
  compiler eligibility check, not a runtime latency benchmark.

### Unused imports and locals fail CI

- `typescript/no-unused-vars` is an error in the syntax pass.
- `pnpm build` strips types and does not replace lint or typecheck.
- An underscore prefix silences intentionally unused bindings.
- Before deleting an unused binding, determine whether it represents a missing
  call or assertion.
- Check leading unused parameters, unused class members and orphaned exports
  by hand; the syntax rule does not cover every one of these cases.

### Lint scope

- Syntax lint covers `packages/**/*.{ts,tsx}`, `apps/*/**/*.{ts,tsx}` and
  root-level `*.ts` and `*.mts`, including desktop E2E helpers, scripts and configs.
- JavaScript and `.mjs` files remain outside this correctness gate.
- Typed lint covers `apps/*/src/**` and `packages/**`, excluding tests, fixtures
  and generated files. Its guard reads the same patterns from the typed config.
- Keep both Oxlint configs at the repository root: relative override patterns
  are resolved against the config location.

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
