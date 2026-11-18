# Primary CI timing audit

Frozen at 2026-11-18T20:02:25.943634+00:00. Source baseline `fcef4ee4c933c52d79c7ac23785bdcf6bbbf78a0`.

Latest 200 unique CI workflow run IDs by created_at/id; all events, branches and conclusions. Analyze original attempt 1; retain latest attempt metadata separately.

Sample range: 2026-11-17T20:49:54Z through 2026-11-18T19:21:26Z. Workflow `261997450`. Manifest SHA-256: `9a6706ffedd7e65c45817eebbc8019b450b1a36bf36aba58b405a5885c0abdf6`.

## Coverage and interpretation

- Original-attempt job metadata: 200/200 runs; 200 distinct head SHAs.
- Events: {'pull_request': 139, 'push': 61}; main branch: 61, other branches: 139.
- Latest conclusions at snapshot: {'None': 1, 'cancelled': 18, 'failure': 41, 'success': 140}. These are not initial-test success rates: retries may recover failures.
- Rerun IDs: [44374979692, 44328352146, 44203670501, 44173417742]. Job statistics use attempt 1 only. Artifacts on these IDs retain unknown attempt and are excluded from initial-test rankings.
- Artifacts: {'downloaded': 1665, 'not-selected-redundant-or-no-timings': 3792, 'budget-excluded': 421}. Download order is newest run then name; budget exclusions bias per-test coverage toward recent runs, not the job sample.
- Timing formats: {'playwright-html-embedded-zip': 1207, 'vitest-json': 284}; 162/200 runs have downloaded per-test observations (including unknown-attempt artifacts).
- Per-test known-initial run coverage by platform: {'linux': 160, 'macos': 70, 'windows': 69}. Unit duration coverage is macOS Vitest JSON only; Linux/Windows compact retry reports contain outcomes, not durations. Runs listing no artifacts: 2. Listed expired artifacts: 0.
- Missing, interrupted, not-run, and skipped timings are not imputed. Interrupted/cancelled job durations are censored observations, not completed workloads. Timeout rates reflect API job conclusions; a job-budget termination may be labelled cancelled.
- Platforms/lane names/runner labels stay separate. Runner image versions are unavailable in job API metadata. All longitudinal tables below are descriptive mixtures across source revisions and potentially runner images; they establish observed cost, not matched performance or speedup. Strict head-SHA cohorts have one run each, so within-revision variation is not estimable.
- queueAndDependencyS is run-created to job-start: it includes scheduling AND dependency waits. Pure scheduler queue is unavailable; do not quote it as queue alone.
- Test-command steps include harness/startup/hooks; per-test Playwright durations include test hooks. Sum of case durations is serial load, not wall time or the workflow DAG critical path.

## Highest observed job cost

Seconds; total in runner-hours. n excludes skipped/absent durations; conclusions include all observed jobs. Failure/cancel/timeout percentages are job conclusions, not initial case outcomes.

| Job | n | hours | p50 | p90 | p95 | max | IQR | MAD | CV | fail/cancel/timeout % |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| Windows desktop-main (lane 1 of 2) | 200 | 37.00 | 708.0 | 777.1 | 792.0 | 868.0 | 171.2 | 78.5 | 0.2 | 2.5/4.5/0.0 |
| Windows desktop-main (lane 2 of 2) | 200 | 33.83 | 595.0 | 725.2 | 738.2 | 790.0 | 158.0 | 91.5 | 0.2 | 2.5/4.0/0.0 |
| Linux Desktop E2E (lane 1 of 4) | 200 | 27.58 | 506.5 | 566.2 | 582.1 | 658.0 | 95.2 | 46.0 | 0.1 | 1.0/2.0/0.0 |
| Lint | 200 | 25.11 | 437.0 | 541.0 | 548.0 | 1200.0 | 144.5 | 69.5 | 0.2 | 0.0/2.5/0.0 |
| Windows renderer + packages (lane 2 of 2) | 200 | 21.93 | 389.0 | 469.0 | 472.0 | 525.0 | 95.5 | 54.5 | 0.2 | 1.0/2.0/0.0 |
| Windows renderer + packages (lane 1 of 2) | 200 | 20.10 | 376.0 | 425.0 | 435.1 | 512.0 | 91.0 | 45.0 | 0.2 | 1.0/1.5/0.0 |
| Linux Desktop E2E (lane 3 of 4) | 200 | 19.29 | 345.5 | 378.0 | 395.5 | 670.0 | 42.2 | 20.5 | 0.1 | 0.5/1.5/0.0 |
| macOS Desktop E2E (lane 1 of 4) | 93 | 18.96 | 744.0 | 865.8 | 909.0 | 914.0 | 114.0 | 60.0 | 0.1 | 0.0/7.5/0.0 |
| Linux Desktop E2E (lane 4 of 4) | 200 | 18.62 | 334.5 | 370.3 | 400.0 | 663.0 | 53.0 | 25.5 | 0.1 | 1.0/1.0/0.0 |
| Linux Desktop E2E (lane 2 of 4) | 200 | 17.74 | 321.5 | 355.0 | 363.3 | 663.0 | 46.0 | 23.5 | 0.1 | 1.0/1.0/0.0 |
| Test (lane 3 of 4) | 200 | 16.63 | 294.5 | 360.1 | 367.0 | 386.0 | 80.5 | 40.5 | 0.2 | 1.0/1.0/0.0 |
| Test (lane 1 of 4) | 200 | 16.59 | 299.0 | 355.1 | 360.0 | 407.0 | 72.0 | 37.0 | 0.2 | 1.0/1.0/0.0 |
| Test (lane 4 of 4) | 200 | 16.23 | 302.0 | 338.1 | 347.1 | 499.0 | 68.2 | 33.0 | 0.2 | 2.5/1.0/0.0 |
| macOS Desktop E2E (lane 2 of 4) | 93 | 16.17 | 623.0 | 765.4 | 802.0 | 908.0 | 106.0 | 57.0 | 0.2 | 0.0/1.1/0.0 |
| Test (lane 2 of 4) | 200 | 16.09 | 279.5 | 344.0 | 351.0 | 770.0 | 76.5 | 41.5 | 0.2 | 2.5/1.0/0.0 |
| macOS Desktop E2E (lane 4 of 4) | 93 | 15.71 | 639.0 | 728.8 | 759.4 | 910.0 | 141.0 | 69.0 | 0.2 | 3.2/1.1/0.0 |
| macOS unit tests (lane 1 of 4) | 93 | 15.27 | 589.0 | 697.0 | 757.0 | 929.0 | 85.0 | 43.0 | 0.2 | 2.2/1.1/0.0 |
| macOS Desktop E2E (lane 3 of 4) | 93 | 14.84 | 573.0 | 665.0 | 712.4 | 914.0 | 69.0 | 41.0 | 0.2 | 1.1/1.1/0.0 |

## Setup/build/test-command separation

Per-step seconds, descriptive p50 / p95. A missing phase is not zero; multiple commands in a phase remain separate observations in steps.jsonl.

| Job | Phase | n | p50 / p95 s |
|---|---|---:|---|
| Linux Desktop E2E (lane 1 of 4) | setup/other | 1407 | 2.0 / 20.0 |
| Linux Desktop E2E (lane 1 of 4) | test-command | 204 | 460.5 / 523.9 |
| Linux Desktop E2E (lane 1 of 4) | retry | 199 | 1.0 / 2.0 |
| Windows desktop-main (lane 1 of 2) | setup/other | 1200 | 2.0 / 56.0 |
| Windows desktop-main (lane 1 of 2) | test-command | 200 | 632.5 / 704.0 |
| Windows desktop-main (lane 1 of 2) | retry | 213 | 2.0 / 3.0 |
| Windows desktop-main (lane 2 of 2) | setup/other | 1200 | 2.0 / 56.0 |
| Windows desktop-main (lane 2 of 2) | test-command | 200 | 515.5 / 654.1 |
| Windows desktop-main (lane 2 of 2) | retry | 218 | 2.0 / 4.1 |

Slowest observed test-job wall duration per run (not a full DAG critical path): Windows desktop-main (lane 1 of 2): 97 runs; macOS Desktop E2E (lane 1 of 4): 44 runs; Windows desktop-main (lane 2 of 2): 33 runs; macOS Desktop E2E (lane 2 of 4): 6 runs; macOS unit tests (lane 1 of 4): 4 runs; macOS Desktop E2E (lane 4 of 4): 4 runs.

## Highest observed per-case cost

Rankings use the original workflow attempt and initial test command. Playwright uses internal retry index zero in that command. Results from the separate CI retry command remain in the evidence. Vitest JSON does not expose internal retry index (null), so unit observations are not claimed to be initial internal attempts. Durations omit skipped/interrupted cases; counts/statuses remain in evidence. Paths/titles are identities, not deletion evidence. Values across changed source remain descriptive.

| Platform/lane | Test | n / runs | total s | p50 | p95 | max |
|---|---|---:|---:|---:|---:|---:|
| e2e/linux/3 | rendering-diagnostics.spec.ts: status dots dip from one shared timer and leave offscreen dots still | 159 / 159 | 4598.0 | 28.9 | 29.6 | 31.0 |
| e2e/linux/3 | onboarding-wizard.spec.ts: Onboarding wizard > Multiple-mode finish quits the bootstrap window AND doesn't materialize a phantom 'default' profile | 159 / 159 | 3589.8 | 22.6 | 22.9 | 23.8 |
| unit/macos/2 | apps/desktop/src/main/__tests__/worktree-archive-git.property.test.ts: bounds archive-all Git output independently of a 201-checkout fleet | 68 / 68 | 2828.5 | 42.0 | 55.0 | 94.3 |
| e2e/linux/3 | settings-rendering-diagnostics.spec.ts: Settings offers a staged rendering capture without Developer Mode | 154 / 154 | 2727.2 | 17.7 | 18.1 | 19.2 |
| e2e/linux/3 | rendering-diagnostics.spec.ts: production usage warning settles without sustaining compositor frames | 159 / 159 | 2561.7 | 16.1 | 16.6 | 17.5 |
| e2e/macos/3 | rendering-diagnostics.spec.ts: status dots dip from one shared timer and leave offscreen dots still | 69 / 69 | 2181.1 | 31.5 | 33.4 | 35.1 |
| e2e/windows/3 | rendering-diagnostics.spec.ts: status dots dip from one shared timer and leave offscreen dots still | 69 / 69 | 2013.1 | 28.8 | 30.5 | 31.3 |
| e2e/linux/1 | archive-group-dialog-layout.spec.ts: keeps the archive group confirmation usable at every window size and zoom | 152 / 152 | 1728.3 | 11.8 | 12.9 | 14.2 |
| e2e/linux/1 | codex-environment-setup.spec.ts: thread environment Run command uses the current cwd after workspace handoff | 152 / 152 | 1583.9 | 10.4 | 10.8 | 11.2 |
| unit/macos/1 | apps/desktop/src/main/__tests__/headless-profile.oracle.test.ts: fresh desktop and Node roots preserve one profile's native identities, titles and canon... | 69 / 69 | 1512.5 | 21.6 | 31.7 | 34.6 |
| e2e/linux/4 | sidebar-hover-user-actions.spec.ts: sidebar commands under a resting pointer > an unpinned selected directory does not flash back to pinned under churn | 160 / 160 | 1437.5 | 9.1 | 9.7 | 10.3 |
| e2e/linux/4 | update-check.spec.ts: a menu check reports itself live and ends on an actionable offer | 160 / 160 | 1432.9 | 9.0 | 9.3 | 9.4 |
| e2e/linux/4 | thread-branch-drift.spec.ts: keeps the branch drift warning open after refreshing observed checkout state | 160 / 160 | 1431.2 | 8.9 | 9.3 | 9.9 |
| e2e/linux/1 | a11y.spec.ts: desktop renderer accessibility (WCAG2 AA, dark theme) > smoke fixture surfaces have no violations | 157 / 157 | 1411.9 | 8.9 | 12.2 | 18.9 |

## High variation shortlist

Descriptive only; n≥10 and p50≥1s. Ranked by IQR/median to resist isolated outliers. Check source/runner changes before attributing variance to tests.

| Platform/lane | Test | n | IQR/median | MAD s | p50 / p95 / max s |
|---|---|---:|---:|---:|---|
| macos/4 | packages/owner-core/src/__tests__/research-service.differential.property.test.ts: research service, validated against projections accepts, refuses and | 69 | 1.37 | 0.8 | 1.2 / 2.9 / 4.6 |
| macos/2 | composer-draft-persistence-regression.spec.ts: keeps Tiptap launchpad and reply drafts with pasted images across switching and refresh | 10 | 1.23 | 0.9 | 6.1 / 15.6 / 16.0 |
| macos/3 | apps/desktop/src/main/__tests__/usage-activity-cadence.test.ts: replays active and idle usage cadence: duplicate-10hz | 69 | 0.97 | 0.5 | 1.1 / 2.3 / 4.6 |
| macos/2 | composer-draft-persistence-regression.spec.ts: keeps every pasted line inside the active Tiptap code block | 10 | 0.96 | 1.0 | 3.9 / 11.2 / 11.4 |
| macos/1 | apps/desktop/src/main/__tests__/owner-conformance.test.ts: owner conformance: desktop and the Outpost outpost terminal failure leaves accepted new_tur | 69 | 0.91 | 0.4 | 1.5 / 4.1 / 5.0 |
| macos/2 | composer-markdown-paste.spec.ts: pasting prose without a code block preserves paragraph separators | 68 | 0.81 | 1.0 | 3.3 / 6.5 / 12.7 |
| linux/4 | shared-messaging-profile.spec.ts: desktop reads portable pairing and activity and hands local service mutations back to Node | 160 | 0.80 | 0.7 | 2.2 / 7.7 / 12.3 |
| macos/3 | apps/desktop/src/main/__tests__/backend-registry.test.ts: DesktopBackendRegistry reports detached HEAD as the expected branch for new worktree forks | 69 | 0.79 | 0.9 | 2.2 / 4.7 / 5.1 |
| macos/3 | apps/desktop/src/main/__tests__/usage-activity-cadence.test.ts: replays active and idle usage cadence: steady-10hz | 69 | 0.75 | 0.5 | 1.1 / 2.9 / 3.5 |
| macos/3 | apps/desktop/src/main/__tests__/pr-auto-dispatch-limits.property.test.ts: Auto-fix repair turns with repeated enable requests (model) never lets repea | 69 | 0.74 | 0.6 | 2.1 / 4.0 / 4.3 |

## Reproduction and limits

Run `python3 scripts/ci/audit-runs.py collect --before 2026-11-18T19:21:26Z`, `python3 scripts/ci/audit-runs.py artifacts`, `python3 scripts/ci/audit-tests.py`, `python3 scripts/ci/audit-runs.py summarize`, then `python3 scripts/ci/audit-report.py`. Frozen cache makes resumption deterministic; use a fresh --root to select a new sample. Four workers, transport-only bounded backoff, 128 MiB/ZIP and 2 GiB compressed download budget. No reruns or remote mutations. Raw ZIPs, manifest, SHA hashes, JSONL observations, status counts, full quantiles and phase breakdowns remain under ignored `.local/ci-audit/`.

Unit/E2E classification reports and deletion branches are independent. Timing alone cannot establish uselessness. Every removal needs protected behavior, a surviving stronger test, source evidence, and native CI validation. No local unit/typecheck/E2E was run for this audit. Static Oxlint, typed lint, and boundaries passed (existing warnings). Expected deletion savings remain estimates until measured.
