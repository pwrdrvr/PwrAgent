# Star Map opening investigation — 2026-11-18

The original failure is not reproduced or attributed to PR #3769. Three fresh
native launches on current main and three on the rebased PR all passed, with
one renderer call, one preload call, one main-process IPC receipt and one new
native map window per launch. This does not establish that the intermittent
failure is fixed.

## Source and original observation

The PR was rebased onto main `2c7328c13b64f943a5a19b73b3bf6939d37be80c`
and pushed with a lease as `a470e950588f9d5832b3508beb929fda552177df`.
Its earlier history contained phase-one commits already squash-merged into
main; replaying the final feature diff preserved the prior merge resolutions.
The timing refresh remains a separate commit. The original history is retained
locally at `backup/research-harness-pre-rebase-20261118`.

The original failure came from production source
`46cc4f617761610ae17219d1358f9e9a9933f505` in
[timing study 44214604894, macOS lane 4](https://github.com/pwrdrvr/PwrAgent/actions/runs/44214604894/job/134501177342).
`star-map-project-pagination.spec.ts` reported no map window after the existing
six-second wait. Both the main-process and Playwright window lists contained
only the main window. The preload method existed and no renderer error was
recorded. The click itself completed in 218 ms; that is not evidence that the
React handler ran. That failed lane remains excluded from the timing model.

The rebased PR and main have identical versions of `App.tsx`,
`FederationStatusControl.tsx`, `shell/ipc/star-map.ts`, `shell/star-map-window.ts`,
the pagination spec, and its opening helper. The PR adds research methods to
the preload API but does not change its Star Map method. The full Playwright
collection still contains the same 405 IDs after the rebase.

## Bounded native comparison

[Comparison run 44222278558](https://github.com/pwrdrvr/PwrAgent/actions/runs/44222278558)
uses free GitHub-hosted `macos-26` jobs, pinned to the two revisions above.
Each job runs the existing pagination spec with three independent fixture
launches, one worker and zero retries. The job deadline remains 15 minutes;
the helper's six-second opening wait, cleanup, audits and assertions are
unchanged. Spotlight/GPU and shutdown settings follow native CI.

Observation code lives only on diagnostic branch
`codex/star-map-probe-3769-20261118`, commit `5daf3f535`.
It records capturing and bubbling pointer/mouse events, trigger identity,
focus/visibility, renderer and preload call receipts, the main IPC receipt,
and native window lifecycle events. It does not invoke the map itself or
force focus. Artifact names are `star-map-opening-main` and
`star-map-opening-pr`; both retain `star-map-opening.jsonl`, the full test
report, the exact source SHA and the instrumentation patch.

| Source | Native test outcome | IPC receipts per launch | Map creations per launch |
| --- | --- | --- | --- |
| Main `2c7328c13` | 3 passed | 1 / 1 / 1 | 1 / 1 / 1 |
| PR `a470e9505` | 3 passed | 1 / 1 / 1 | 1 / 1 / 1 |

## What remains uncertain

Both revisions replace the header's initial Star Map button during startup.
In three of the six observations, the button receiving the click was already
a different node from the one present when observation began. All six clicks
still reached IPC and created a map. Header replacement is therefore an
observed shared transition, not a demonstrated explanation for the lost click.

The original failure lacks click/IPC receipts and a first-attempt trace.
These short fresh-launch samples also do not reproduce the earlier full
lane's process history, and observation adds some scheduling overhead. They
cannot rule out an intermittent shared startup race or an indirect effect of
the PR. There is no evidence here for weakening readiness, replaying a click,
forcing focus, extending a timeout, or making a speculative lifecycle change.
An actual failing observation with those receipts is needed to select a fix
and a failing owner/model/oracle test.

Full local lint, typecheck and dependency checks passed after the rebase.
The focused Star Map control, window and IPC suites passed all 52 tests.

## Full-lane confirmation

The rebased source's [normal CI run 44221702130](https://github.com/pwrdrvr/PwrAgent/actions/runs/44221702130)
also completed all four macOS E2E lanes successfully in 10:46 / 9:52 / 10:55 /
12:33. Its consolidated `ci-flake-report-1` records complete first attempts
with 77 / 91 / 104 / 133 tests and no macOS E2E failures or retries, covering
all 405 IDs. This provides full-lane evidence for the fitted allocation and
does not turn the earlier interrupted samples into completed measurements.

The overall run failed separate storage-maintenance unit checks and the Windows
standard Markdown E2E assertion. Those failures do not invalidate the completed
macOS samples, and this investigation does not claim the entire PR is green.
