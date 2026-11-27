# GitHub Actions Labels

Some PR labels intentionally alter workflow behavior. Keep label names
namespaced with `ci:` when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `ci:full` | `ci.yml` | Runs every unit test and Desktop E2E spec on a PR, where the test plan would otherwise select the affected ones, and adds the macOS unit tests, macOS Desktop E2E and Windows Desktop E2E. Without it, PRs skip those jobs unless they change a platform-specific path and the required `Desktop E2E` check accepts the skipped macOS lanes; verified `main` pushes can narrow those suites and releases and the daily run exercise the full matrices. The classifier reads labels live, so after adding the label use **Re-run all jobs** or push. **Re-run failed jobs** does not rerun the succeeded classifier, so it does not pick the label up. See [cross-platform jobs on PRs](#cross-platform-jobs-on-prs). |
| `ci:a11y` | `ci.yml` | Runs the accessibility audit (`apps/desktop/e2e/a11y.spec.ts`) on a PR, in the `Linux Desktop a11y` job's two lanes. Without it, a PR skips that job unless `ci:full` is present, the PR changes `a11y.spec.ts`, a narrowed test plan selects the spec, or a platform-specific path runs the cross-platform jobs. It runs on release pushes, the daily run, and when the `main` plan selects it or requires full E2E. Like `ci:full`, the classifier reads it live, so after adding it use **Re-run all jobs** or push. See [accessibility audit on PRs](#accessibility-audit-on-prs). |
| `ci:windows-e2e` | `ci.yml` | Runs all four `Windows Desktop E2E` lanes on a PR without enabling macOS unit/E2E (`ci:full`) or the three-sample native diagnostic capture (`ci:windows-shutdown-diagnostics`). Without it, a PR runs one narrowed Windows Desktop E2E lane automatically when the test plan narrows E2E to affected specs (for example a spec-only edit), and skips full Windows Desktop E2E on product-code PRs unless `ci:full`, a platform-specific path, or `ci:windows-shutdown-diagnostics` is present. The classifier reads it live, so after adding it use **Re-run all jobs** or push. |
| `ci:benchmark-checks` | `check-performance.yml` | Compares base and PR syntax lint, typed lint and typecheck on one GitHub-hosted `macos-26` runner. Records three paired samples, runner/hardware identity and system load. Adding this label starts the benchmark. |
| `ci:build-preview` | `preview-build.yml` | Builds an ad-hoc signed, unnotarized macOS preview DMG and uploads it as a workflow artifact. Use for PRs that change release packaging, installer assets, or desktop distribution behavior. |
| `ci:windows-package` | `ci.yml` | Builds the unsigned Windows NSIS installer (`release.mjs --win`) and uploads it as a workflow artifact. Off by default — the normal Windows CI job is build + test only. Adding the label alone does not start CI; add it before opening the PR, rerun CI, or push a commit after adding it. The release workflow (`release.yml`) builds the Windows installer automatically on version tags. |
| `ci:windows-shutdown-diagnostics` | `ci.yml` | Runs three full Windows Desktop E2E samples across the usual four lanes, with signed Handle/CDB tools, native process and pipe observation, and bounded native stack captures. Default CI runs one sample across four lanes with ordinary shutdown reports. No PDBs are downloaded. Adding the label alone does not start CI; add it before opening the PR, rerun CI, or push a commit after adding it. See [shutdown diagnostics](../../docs/playwright-worker-shutdown-diagnostics.md#opt-in-hosted-windows-pipe-evidence). |
| `ci:windows-shutdown-diagnostics` | `windows-native-quit-repro.yml` | Separately compares fresh stock-Electron profiles beside the checkout and under the OS temp directory: 25 per location and quit mode, with and without session preparation. Records storage volume/device, native identity, pipe and stack evidence under the existing capture limits. It stops on the first abnormal case. Adding this label starts the probe; opening, reopening, or pushing the labeled PR also starts it. Manual dispatch is available. |
| `ci:linux-packages` | `linux-packaging.yml` | Builds and smoke-tests x64 and arm64 Linux packages for same-repository PRs. Off by default on PRs. Adding this label starts packaging; pushes and reopens rerun it while the label remains. Adding another label does not rerun it. There is no changed-path filter. Pushes to `main` do not start this workflow. Manual dispatch remains available, and the release workflow (`release.yml`) still packages Linux automatically on version tags. |

If you add another label-influenced workflow path, document it here in the same
change as the workflow update.

## Cross-platform jobs on PRs

PRs run Lint, Build, the affected Linux unit and E2E tests, Windows verify
and the affected Windows unit tests. A selected E2E list also runs on
Windows. Ordinary PRs leave full macOS and Windows E2E to `main`. Use
`ci:full` to exercise all suites on a PR. Native inputs, platform-specific
specs, and unverifiable classifier results still run every platform.

Each push to `main` retains a separate run. A verified fast-forward can
narrow unit suites and test-only E2E across all platforms. Product changes
still run full Desktop E2E across all platforms. Release pushes and the
daily `main` run use the full matrices. See [test impact](../../docs/pr-test-impact.md).

Measured over 1,000 CI runs from 2026-11-04 to 2026-11-11 (789 PR, 211 push):

| Job family | Runner minutes per day on PRs | Failed PR runs | PR runs where it was the only E2E failure |
|---|---|---|---|
| macOS Desktop E2E (4 lanes) | ~4,200 | 3.5% | 2 of 657 |
| macOS unit tests (4 lanes) | ~2,900 | 12.5% (not a required check) | n/a |
| Windows Desktop E2E (4 lanes, advisory) | ~3,500 | 10.0% (not a required check) | n/a |

Over the same week, `main` pushes still caught three macOS-only E2E failures,
so a macOS break lands on `main` and is caught there instead of on the PR.

## Accessibility audit on PRs

`a11y.spec.ts` audits every surface in all eleven shipped appearances. On
Linux it costs about 376 seconds of test time, more than any Desktop E2E lane;
that is the median of three main runs in November 2026. It runs in its own job,
`Linux Desktop a11y (lane N of 2)`, and the Linux Desktop E2E lanes never
collect it. Its regressions are contrast, focus and role failures that `main`
reports on the next push, so pull requests skip the job unless:

- the PR has `ci:a11y` or `ci:full`;
- it changes `apps/desktop/e2e/a11y.spec.ts`;
- a narrowed test plan selects the spec, for example after a change to a
  fixture it uses;
- the cross-platform jobs run, which also covers a failed label or file lookup.

The required `Desktop E2E` check accepts the skipped job only in that case.
macOS and Windows Desktop E2E keep the audit in their own lanes. Before
changing an audited surface or theme tokens, add `ci:a11y` or run the audit
locally (see [accessibility](../../apps/desktop/docs/accessibility.md#accessibility)).

## Consolidated test retry report

Each code-impacting CI run uploads `ci-flake-report-<attempt>`, containing one
`flake-report.json` for all unit and desktop E2E lanes on Linux, macOS, and
Windows. Download that single artifact from the workflow run to inspect test
IDs and names, platform, lane, diagnostic sample, initial completion, and each
failed test's observed retry outcome. `recovered` means the individual test
reported its expected outcome on retry; `failed` means it failed again, and
`unknown` includes missing, skipped, interrupted, or ambiguous retry results.
The slice's job and step outcomes give the surrounding result; a recovered test
alone does not mean the entire job passed.

The report lists absent slices separately and marks an absent or incomplete
first report; neither is a clean test run. Counts reflect only received
reports, so missing or incomplete slices may contain unreported failures.
Platforms the classifier skipped on a PR are listed under `notRun` and are not
counted as missing. A workflow cancelled before consolidation may not produce the artifact. Every
run attempt has its own artifact: a partial job rerun may leave other slices
missing in that attempt. Compact per-slice artifacts are retained for seven
days, and the consolidated artifact for 30 days. Existing detailed retry and
Playwright artifacts remain available for diagnosis.

## Model request impact

The Linux Lint job measures outbound model request bodies for Codex, Claude,
and Antigravity. It starts the pinned agent runtimes through PwrAgent's
normal thread and turn entry points. Local fake model endpoints answer the
first turn and a follow-up with synthetic responses. No provider login or
real credential is needed. The artifact contains only byte and call counts.

The check budgets each provider's total request body bytes, number of
model calls, primary request body, input and history, instructions, and tools.
The primary request is the largest model request in the turn. Instruction
bytes cover system fields and system or developer messages. Instructions
embedded in a user message count toward input and history. The totals include
auxiliary model calls, such as Antigravity's title-generation call.

The same job configures three fake MCP connections with 80 tools each and
checks the first turn and follow-up again for each provider. It fails on
excess total bytes, tool bytes, or model calls. It also fails if Codex, Claude,
or Antigravity in gateway mode adds fixture tool schemas before discovery.
Antigravity's stdio fallback has a separate ceiling that accounts for eager
tool schemas.

The job uploads `model-request-results` for the default case and
`model-request-mcp-results` for the large catalog even when a ceiling fails.
The publisher on `main` compares the default case in one comment per PR into
`main`. It uses the successful push for the recorded PR base when available
and otherwise uses a recent successful `main` push with measurements. Docs-only
PRs that skip Lint do not produce measurements.

For a local run, set `PWRAGENT_MODEL_BENCH_CODEX` and `PWRAGENT_MODEL_BENCH_AGY`
to the pinned executables in an OS temp directory, then run
`pnpm test apps/desktop/src/main/__tests__/model-request-size.test.ts --maxWorkers=2`.
The benchmark uses the workspace's pinned Claude SDK binary. Set
`PWRAGENT_MODEL_BENCH_RESULT` or `PWRAGENT_MODEL_BENCH_MCP_RESULT` to output files
to export the respective numeric results.

Set `PWRAGENT_MODEL_BENCH_COMPARISON` to a new local file to also capture a
fresh turn and follow-up through PwrAgent and a fresh turn directly from each
CLI. Both paths use the same binary, model, first prompt, and synthetic starting
directory with fresh agent homes and no custom Agent instructions. Both Codex
runs use workspace-write with the noninteractive approval policy. The comparison
file includes the synthetic JSON request bodies and is written locally with
restricted permissions.
