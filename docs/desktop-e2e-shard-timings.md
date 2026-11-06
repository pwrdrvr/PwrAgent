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
costs. Platform skips contribute collected tests and their negligible
recorded duration.

[The measured input](desktop-e2e-shard-durations.json) records median completed
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
python3 scripts/ci/fit-desktop-e2e-shards.py --fit
python3 scripts/ci/fit-desktop-e2e-shards.py --weights 83:82:67:88
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
