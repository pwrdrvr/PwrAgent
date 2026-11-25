# Desktop E2E shard allocation

macOS uses five lanes on GitHub-hosted `macos-26` with weights `69:87:78:87:112`.
The 433-test allocation minimizes the slowest modeled lane across seven recent
main runs with complete Playwright reports. The best four-lane split modeled
at 13:58 against the former 15-minute deadline. Five lanes modeled at 12:14, including
the worst observed setup, build, reporting, and other job overhead (3:14).
The 20-minute job deadline gives slow runners additional time for retries,
reporting, and cleanup. Each lane runs one Playwright worker.

Linux and Windows share `55:114:112:115` across four lanes whenever both run
the accessibility audit, so a Windows-only failure is never an artifact of a
different lane split. A pull request that leaves the audit to `main` runs Linux
alone with `86:75:65:107`; see [without the accessibility audit](#without-the-accessibility-audit). Those weights were fit
to 396 tests in 209 groups; see [November 24 allocation](#november-24-allocation).
The [current fitter input](desktop-e2e-shard-durations.json) includes every test ID,
platform skip and per-run sample from that fit.
The previous `77:91:104:133` allocation is described in the
[2026-11-18 timing refresh](desktop-e2e-shard-timing-refresh-2026-11-18.md),
with its [November 18 fitter input](https://github.com/pwrdrvr/PwrAgent/blob/eea63a2392e4399cc501e8dbee47dd46111a2a62/docs/desktop-e2e-shard-durations.json).

## November 24 allocation

On main run [45525513730](https://github.com/pwrdrvr/PwrAgent/actions/runs/45525513730)
attempt 1, Linux lane 1 passed all 78 of its tests, but Playwright took 9.8
minutes and the step's 10-minute limit killed it. That job's runner was slow:
each test took a median of about 1.4 times as long as on the other runs. The cause was
structural. `77:91:104:133` put all 63 `a11y.spec.ts` tests and 15 other tests
in lane 1, so lane 1 needed about 6.5 minutes on a normal runner. Lanes 2 to 4
needed 4 to 6 minutes.

`a11y.spec.ts` runs in `parallel` mode, so each of its tests is its own shard
group. The new split ends lane 1 after the first 55 accessibility tests. Lane 2
starts with the other 8. No test is removed, skipped or changed.

### Measurements

The input uses Playwright HTML reports from every Linux and Windows lane of
three complete main runs. No E2E spec, Playwright configuration or patch
changed between them:

- [45517722507](https://github.com/pwrdrvr/PwrAgent/actions/runs/45517722507), commit `639472090`.
- [45520142822](https://github.com/pwrdrvr/PwrAgent/actions/runs/45520142822), commit `1e3fea050`.
- [45525513730](https://github.com/pwrdrvr/PwrAgent/actions/runs/45525513730) attempt 1, commit `7881915d8`.

The killed Linux lane 1 still wrote a complete report, with 78 of 78 tests
passing. It is included: its slow runner is the case this allocation must
survive. Each group's `seconds` is the median of the three samples. The
per-run sums are in `sampleSeconds`.

Measured "Run desktop replay-backed Electron tests" step times, in minutes:

| Run | Linux lane 1 / 2 / 3 / 4 | Windows lane 1 / 2 / 3 / 4 |
| --- | --- | --- |
| 45517722507 | 6:45 / 4:36 / 4:38 / 5:51 | 9:26 / 5:43 / 7:32 / 10:03 |
| 45520142822 | 7:12 / 5:28 / 6:19 / 4:56 | 6:11 / 5:08 / 7:24 / 6:51 |
| 45525513730 | 10:05 (killed) / 4:02 / 5:43 / 5:21 | 9:42 / 7:22 / 7:37 / 9:40 |

### Fit

The Linux step has a 10-minute limit. Windows has no step limit, but its job has
a 15-minute limit. The fitter now accepts a test budget for each platform. It
then minimizes the largest fraction of a budget that either platform's longest
lane uses, instead of the sum of the maxima. The budgets are 590 seconds for
Linux: 600 seconds minus about 10 seconds of step overhead. Windows gets 800
seconds: 900 seconds minus about 100 seconds of setup, step and teardown
overhead. Measured lane sums, in seconds:

```sh
python3 scripts/ci/fit-desktop-e2e-shards.py --weights 77:91:104:133 --budgets 590:800 --fit
```

| Allocation | Platform | Lane 1 / 2 / 3 / 4, medians | Longest lane |
| --- | --- | --- | ---: |
| `77:91:104:133` | Linux | 416.1 / 260.2 / 313.0 / 300.9 | 416.1 |
| `55:114:112:115` | Linux | 341.5 / 341.1 / 344.5 / 263.3 | 344.5 |
| `77:91:104:133` | Windows | 520.0 / 318.5 / 412.1 / 539.7 | 539.7 |
| `55:114:112:115` | Windows | 408.0 / 437.8 / 470.9 / 473.6 | 473.6 |

Applied to each run's own measurements, the new split's Linux lanes would have been:

| Run | Old Linux lanes, seconds | New Linux lanes, seconds |
| --- | --- | --- |
| 45517722507 | 389 / 259 / 256 / 331 | 321 / 335 / 290 / 289 |
| 45520142822 | 415 / 304 / 349 / 281 | 340 / 385 / 378 / 246 |
| 45525513730 | 580 / 226 / 314 / 304 | 481 / 328 / 350 / 264 |

On the slow runner, lane 1 would have needed 481 seconds of tests (8:01)
instead of 580. A runner 1.4 times slower than the median, across the longest
new Linux lane, needs 482 seconds. Four lanes cannot do much better: the median
Linux test total is 1,310 seconds, so a perfect four-way split is 328 seconds
per lane, or 459 seconds at 1.4 times.

Optimizing for Linux alone (`48:110:102:136`) would bring the Linux maximum to
330.8 seconds, but it would raise Windows' maximum to 573.5. Optimizing the
old sum-of-maxima objective (`58:121:105:112`) would leave Linux at 358.7.

### Without the accessibility audit

Pull requests without `ci:a11y`, `ci:full`, a change to `a11y.spec.ts`, or the
cross-platform jobs set `PWRAGENT_E2E_SKIP_A11Y=1`. `playwright.config.ts` then
ignores `a11y.spec.ts` and collects 333 tests. Windows Desktop E2E does not run
on those PRs, so this split is fit to Linux alone:

```sh
python3 scripts/ci/fit-desktop-e2e-shards.py --platform linux --without a11y.spec.ts --weights 55:114:112:115 --fit
```

| Allocation | Linux lane 1 / 2 / 3 / 4, medians | Longest lane |
| --- | --- | ---: |
| `55:114:112:115` (counts 50/98/89/96) | 149.7 / 263.3 / 285.7 / 215.3 | 285.7 |
| `86:75:65:107` | 232.9 / 218.0 / 231.3 / 231.9 | 232.9 |

`playwright test --list --shard=K/4` reproduces both splits on the 396-test and
333-test collections: 55/114/112/115 ending at `a11y.spec.ts`,
`federation-services.spec.ts`, `sandboxer-hosted-setup.spec.ts` and
`workspace-handoff-flows.spec.ts`, and 86/75/65/107 ending at
`directory-launchpad-workspace.spec.ts`, `queue-explicit-identity.spec.ts`,
`shared-messaging-profile.spec.ts` and `workspace-handoff-flows.spec.ts`. Every
test appears exactly once.

## November 4 allocation

The shared `PWTEST_SHARD_WEIGHTS` changes from `9:12:12:14` to `83:82:67:88`.
The current suite collects 320 tests in 168 groups: 68 individual a11y groups
and 100 other spec-file groups. The old allocation collects 62/85/79/94 tests;
the refit collects 83/82/67/88 on every platform, including platform skips.

## Measurements and fit

The [Spotlight study from PR #3333](macos-desktop-e2e-timings.md) establishes
the post-indexing-fix macOS baseline, including lane 3's 13:23 sample. This
refit uses exact millisecond durations from Playwright HTML artifacts in
three complete four-lane CI runs on all three hosted platforms:

- [41771113480](https://github.com/pwrdrvr/PwrAgent/actions/runs/41771113480),
  commit `020860d88d35ebbdbd63b9af6c654617502f1422`.
- [41774577161](https://github.com/pwrdrvr/PwrAgent/actions/runs/41774577161),
  commit `a0c7482d42b6383b74ebc9be3934315aab4bc278`.
- [41774684153](https://github.com/pwrdrvr/PwrAgent/actions/runs/41774684153),
  commit `ff7ddf63aff618bb5ee44d287da46dbae9bc6dae`.

There are no changes to E2E specs, Playwright config, or the Playwright patch
between these revisions. All macOS samples disable Spotlight before checkout.
The first run's failed Windows lane 2 is excluded from the fit; the other
35 lanes completed successfully. Successful samples include all retry-attempt
costs. Platform skips contribute collected tests and their negligible
recorded duration.

[The historical measured input](desktop-e2e-shard-durations-2026-11-04.json) records median completed
group durations in seconds, in collection order. Each non-a11y row sums the
spec's attempts before taking its median across successful lanes. Each a11y
test has its own row and stable Playwright ID. Failed or interrupted lanes
are never treated as complete timing samples.

The ten most expensive non-a11y specs on macOS have these measured medians:

| Spec | Linux seconds | macOS seconds | Windows seconds |
| --- | ---: | ---: | ---: |
| `federation-remote-window.spec.ts` | 42.1 | 99.1 | 66.3 |
| `rendering-diagnostics.spec.ts` | 69.2 | 76.1 | 79.4 |
| `onboarding-wizard.spec.ts` | 45.1 | 48.0 | 32.7 |
| `directory-launchpad-workspace.spec.ts` | 36.5 | 40.1 | 99.5 |
| `directory-launchpad-skills.spec.ts` | 33.5 | 38.0 | 72.5 |
| `thread-image-fit.spec.ts` | 16.5 | 29.6 | 25.2 |
| `codex-environment-setup.spec.ts` | 26.6 | 28.9 | 52.3 |
| `composer-markdown-paste.spec.ts` | 22.7 | 27.8 | 48.1 |
| `thread-open-scroll-stability.spec.ts` | 20.9 | 26.4 | 29.0 |
| `update-check.spec.ts` | 24.2 | 26.0 | 26.5 |

Playwright 1.63 first floors each weighted share of the collected count,
distributes the remainder to the earliest lanes, and assigns a whole group
according to the position of its first test. It does not split a file at a
count boundary. The fitter models this directly; its old assignment was
checked against all 320 collected test IDs in the baseline artifacts.
The a11y file retains parallel grouping with one worker.

Enumerating all partitions at three group boundaries finds the minimum sum
of the three platforms' longest modeled lane. The partition's actual test
counts reproduce it as integer weights. This objective gives each platform
its actual seconds saved, matching the previous fit's objective.

| Platform | Old lane 1 / 2 / 3 / 4, seconds | Refit lane 1 / 2 / 3 / 4, seconds | Longest lane change |
| --- | --- | --- | ---: |
| Linux | 253.0 / 218.7 / 279.2 / 292.7 | 310.3 / 229.0 / 256.4 / 247.8 | +6.0% |
| macOS | 261.2 / 259.9 / 439.6 / 398.0 | 329.6 / 333.6 / 351.6 / 344.0 | -20.0% |
| Windows | 329.6 / 455.9 / 422.3 / 470.2 | 431.3 / 468.8 / 361.6 / 416.3 | -0.3% |

These are modeled sums of group medians, not measured future wall times.
Linux accepts a modeled 17.6-second increase to save 88.0 seconds on macOS
without increasing Windows' maximum. Setup, build/bootstrap, reporting,
teardown, and VM variance are outside the model and require hosted validation.

The new lane ends are `async-question.spec.ts`, `federation-services.spec.ts`,
`sidebar-hover-user-actions.spec.ts`, and `workspace-handoff-flows.spec.ts`.
In particular, `federation-remote-window.spec.ts` moves to lane 2, and
`rendering-diagnostics.spec.ts` and `onboarding-wizard.spec.ts` remain in lane 3.

Reproduce the baseline and exhaustive refit with Python's standard library:

```sh
python3 scripts/ci/fit-desktop-e2e-shards.py --data docs/desktop-e2e-shard-durations-2026-11-04.json --fit
python3 scripts/ci/fit-desktop-e2e-shards.py --data docs/desktop-e2e-shard-durations-2026-11-04.json --weights 83:82:67:88
```

To refresh the input, download each successful lane's
`desktop-e2e-{linux,macos,windows}-lane-{1,2,3,4}-artifacts` archive. Its
`playwright-report/index.html` embeds a `data:application/zip;base64,` payload.
The payload's `report.json` lists files; each `{fileId}.json` contains
`tests[].results[].duration` in milliseconds. Sum every attempt per group,
including retries, then take the platform median across complete samples.
Preserve counted platform-skipped groups and collection order. Check the resulting
test-ID assignments against artifacts and actual `playwright test --list
--shard=K/4 --reporter=json` collection before accepting a new fit.

## Hosted verification

Total job time is `completed_at - started_at`, including setup, build, tests,
reporting, and cleanup. Each job runs on a separate fresh hosted VM.

| Phase / run | Platform | Lane 1 | Lane 2 | Lane 3 | Lane 4 |
| --- | --- | ---: | ---: | ---: | ---: |
| Before / [41771113480](https://github.com/pwrdrvr/PwrAgent/actions/runs/41771113480) | Linux | 4:54 | 5:03 | 5:38 | 6:38 |
| Before / [41771113480](https://github.com/pwrdrvr/PwrAgent/actions/runs/41771113480) | macOS | 6:10 | 5:46 | 9:09 | 9:52 |
| Before / [41771113480](https://github.com/pwrdrvr/PwrAgent/actions/runs/41771113480) | Windows | 7:06 | 9:26 (failed) | 8:48 | 10:00 |
| Before / [41774577161](https://github.com/pwrdrvr/PwrAgent/actions/runs/41774577161) | Linux | 5:11 | 4:24 | 6:20 | 6:20 |
| Before / [41774577161](https://github.com/pwrdrvr/PwrAgent/actions/runs/41774577161) | macOS | 4:57 | 5:39 | 8:50 | 7:32 |
| Before / [41774577161](https://github.com/pwrdrvr/PwrAgent/actions/runs/41774577161) | Windows | 6:08 | 9:33 | 8:52 | 9:41 |
| Before / [41774684153](https://github.com/pwrdrvr/PwrAgent/actions/runs/41774684153) | Linux | 6:00 | 4:47 | 5:18 | 5:50 |
| Before / [41774684153](https://github.com/pwrdrvr/PwrAgent/actions/runs/41774684153) | macOS | 7:12 | 7:27 | 8:39 | 7:59 |
| Before / [41774684153](https://github.com/pwrdrvr/PwrAgent/actions/runs/41774684153) | Windows | 7:28 | 9:05 | 9:00 | 9:25 |

| After / [41776179320](https://github.com/pwrdrvr/PwrAgent/actions/runs/41776179320) | Linux | 6:23 | 4:45 | 5:35 | 5:18 |
| After / [41776179320](https://github.com/pwrdrvr/PwrAgent/actions/runs/41776179320) | macOS | 5:43 | 9:03 | 6:02 | 8:13 |
| After / [41776179320](https://github.com/pwrdrvr/PwrAgent/actions/runs/41776179320) | Windows | 6:10 | 10:17 | 7:13 | 7:16 |
| After / [41776179245](https://github.com/pwrdrvr/PwrAgent/actions/runs/41776179245) | Linux | 7:19 | 5:33 | 5:04 | 5:08 |
| After / [41776179245](https://github.com/pwrdrvr/PwrAgent/actions/runs/41776179245) | macOS | 7:29 | 6:59 | 7:44 | 7:26 |
| After / [41776179245](https://github.com/pwrdrvr/PwrAgent/actions/runs/41776179245) | Windows | 5:50 | 10:43 | 7:52 | 8:53 |
| After / [41776179203](https://github.com/pwrdrvr/PwrAgent/actions/runs/41776179203) | Linux | 7:00 | 5:35 | 4:33 | 4:16 |
| After / [41776179203](https://github.com/pwrdrvr/PwrAgent/actions/runs/41776179203) | macOS | 8:37 | 5:20 | 6:10 | 7:14 |
| After / [41776179203](https://github.com/pwrdrvr/PwrAgent/actions/runs/41776179203) | Windows | 8:56 | 9:44 | 7:25 | 8:48 |

All **36 refit jobs succeeded** at `196f1ce363472703f8b492c99dc3b034e0ebd549`,
with identical 83/82/67/88 test-ID assignments across all platforms and repeats.
The three temporary workflows copied the production dependency setup and E2E
jobs; only their trigger and change-classification prerequisites differed.
The temporary workflows were removed after collection. Production job
limits, one worker, one CI retry, four lanes, concurrency, rendering settings,
and the macOS shutdown circuit remain unchanged.

Five initial attempts needed the existing retry: Windows
`new-thread-transcript-sync.spec.ts:415` in samples 1 and 3, Windows
`electron-fixture-isolation.spec.ts:8` in sample 2, macOS
`sidebar-hover-user-actions.spec.ts:171` in sample 2, and macOS
`managed-review.spec.ts:116` in sample 3. All retry costs remain in the table.
The Windows isolation case reported the known open launcher pipe after app
quit; none of these initial failures was suppressed or excluded from timing.

| Platform | Before median slowest lane | After median slowest lane | Change | After worst job |
| --- | ---: | ---: | ---: | ---: |
| Linux | 6:20 | 7:00 | +10.5% | 7:19 |
| macOS | 8:50 | 8:37 | -2.5% | 9:03 |
| Windows | 9:41 | 10:17 | +6.2% | 10:43 |

These compare the three complete baseline runs used for the fit with the
three refit runs above. The failed baseline Windows lane is displayed for
transparency but is not used as a complete timing sample; its run's successful
lane 4 already determines that run's maximum. This is a small independent-VM
sample, not a paired speedup estimate. VM variation and retries remain
material: the modeled 20% reduction in macOS test time did not produce a 20%
reduction in median total job time in these samples. Linux and Windows total
job costs increased, as the table shows.

For comparison, the original three post-Spotlight macOS samples from PR #3333
were 6:10/5:46/9:09/9:52, 7:13/7:41/13:23/9:49, and 7:52/7:34/10:24/7:00.
Their median slowest lane was 10:24. The refit's slowest macOS job was 9:03,
leaving **5:57** inside the retained 15-minute deadline. The absence of a
13-minute outlier in three new runs does not establish a worst-case bound.

## Static and collection verification

- `actionlint` passed for production CI and all three temporary workflows.
- Sandbox `sb_jrw1wbigze`, commit `196f1ce363472703f8b492c99dc3b034e0ebd549`:
  setup exit 0 (3s), `pnpm lint` exit 0 (69s), including syntax/typed Oxlint
  and typecheck. The sandbox was stopped after verification.
- Actual Playwright collection passed for all four new lanes: 320 unique
  tests with no missing or duplicate IDs. Every collected spec and a11y ID
  matches the fitter's assignment.
- All 36 baseline artifact lane manifests match the old model, and all 36
  refit artifact lane manifests match the new model across platforms.
