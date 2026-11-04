# Desktop E2E shard allocation

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
costs. Platform skips contribute collected tests and zero execution cost.

[The measured input](desktop-e2e-shard-durations.json) records median completed
group durations in seconds, in collection order. Each non-a11y row sums the
spec's attempts before taking its median across successful lanes. Each a11y
test has its own row and stable Playwright ID. Failed or interrupted lanes
are never treated as complete timing samples.

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
python3 scripts/ci/fit-desktop-e2e-shards.py --fit
python3 scripts/ci/fit-desktop-e2e-shards.py --weights 83:82:67:88
```

## Hosted verification

The repeated hosted measurements are recorded after the verification runs
complete. Production job deadlines, worker count, retries, lane count,
concurrency, rendering settings, and shutdown circuit are unchanged.
