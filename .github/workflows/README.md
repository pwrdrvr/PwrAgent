# GitHub Actions Labels

Some PR labels intentionally alter workflow behavior. Keep label names
namespaced with `ci:` when they start, skip, or narrow CI work.

| Label | Workflow | Effect |
|---|---|---|
| `ci:full` | `ci.yml` | Runs the macOS unit tests, macOS Desktop E2E and Windows Desktop E2E on a PR. Without it, PRs skip those jobs unless they change a platform-specific path and the required `Desktop E2E` check accepts the skipped macOS lanes; every push to `main` and `releases/**` still runs them. The classifier reads labels live, so after adding the label use **Re-run all jobs** or push. **Re-run failed jobs** does not rerun the succeeded classifier, so it does not pick the label up. See [cross-platform jobs on PRs](#cross-platform-jobs-on-prs). |
| `ci:benchmark-checks` | `check-performance.yml` | Compares base and PR syntax lint, typed lint and typecheck on one GitHub-hosted `macos-26` runner. Records three paired samples, runner/hardware identity and system load. Adding this label starts the benchmark. |
| `ci:build-preview` | `preview-build.yml` | Builds an ad-hoc signed, unnotarized macOS preview DMG and uploads it as a workflow artifact. Use for PRs that change release packaging, installer assets, or desktop distribution behavior. |
| `ci:windows-package` | `ci.yml` | Builds the unsigned Windows NSIS installer (`release.mjs --win`) and uploads it as a workflow artifact. Off by default — the normal Windows CI job is build + test only. Adding the label alone does not start CI; add it before opening the PR, rerun CI, or push a commit after adding it. The release workflow (`release.yml`) builds the Windows installer automatically on version tags. |
| `ci:windows-shutdown-diagnostics` | `ci.yml` | Runs three full Windows Desktop E2E samples across the usual four lanes, with signed Handle/CDB tools, native process and pipe observation, and bounded native stack captures. Default CI runs one sample across four lanes with ordinary shutdown reports. No PDBs are downloaded. Adding the label alone does not start CI; add it before opening the PR, rerun CI, or push a commit after adding it. See [shutdown diagnostics](../../docs/playwright-worker-shutdown-diagnostics.md#opt-in-hosted-windows-pipe-evidence). |
| `ci:windows-shutdown-diagnostics` | `windows-native-quit-repro.yml` | Separately compares fresh stock-Electron profiles beside the checkout and under the OS temp directory: 25 per location and quit mode, with and without session preparation. Records storage volume/device, native identity, pipe and stack evidence under the existing capture limits. It stops on the first abnormal case. Adding this label starts the probe; opening, reopening, or pushing the labeled PR also starts it. Manual dispatch is available. |
| `ci:linux-packages` | `linux-packaging.yml` | Builds and smoke-tests x64 and arm64 Linux packages for same-repository PRs. Off by default on PRs. Adding this label starts packaging; pushes and reopens rerun it while the label remains. Adding another label does not rerun it. There is no changed-path filter. Pushes to `main` do not start this workflow. Manual dispatch remains available, and the release workflow (`release.yml`) still packages Linux automatically on version tags. |

If you add another label-influenced workflow path, document it here in the same
change as the workflow update.

## Cross-platform jobs on PRs

PRs run Lint, Build, the Linux unit and Desktop E2E lanes, and the Windows
verify and unit lanes. The macOS unit tests, macOS Desktop E2E and Windows
Desktop E2E run on every push to `main` (each push has its own concurrency
group, so none is dropped). A PR runs them only with `ci:full`, or when it
changes code that only those runners exercise: `pnpm-lock.yaml`, the
`visual-regression`, `macos-*` and `windows-*` Desktop E2E specs (and the
visual baselines), `apps/desktop/native/**`, `apps/desktop/build/**`, or
`scripts/ci/macos-*`. That rule matched 19 of the 296 PRs merged in the week
measured below. If the classifier cannot read the labels or the full
changed-file list, it runs everything. A PR with
`ci:windows-shutdown-diagnostics` still runs Windows Desktop E2E.

Measured over 1,000 CI runs from 2026-11-04 to 2026-11-11 (789 PR, 211 push):

| Job family | Runner minutes per day on PRs | Failed PR runs | PR runs where it was the only E2E failure |
|---|---|---|---|
| macOS Desktop E2E (4 lanes) | ~4,200 | 3.5% | 2 of 657 |
| macOS unit tests (4 lanes) | ~2,900 | 12.5% (not a required check) | n/a |
| Windows Desktop E2E (4 lanes, advisory) | ~3,500 | 10.0% (not a required check) | n/a |

Over the same week, `main` pushes still caught three macOS-only E2E failures,
so a macOS break lands on `main` and is caught there instead of on the PR.

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
