# Desktop E2E timing refresh — 2026-11-18

The shared allocation changes from `83:82:67:88` to `77:91:104:133`.
The current suite collects 405 tests in 216 groups: 79 individual accessibility
tests and 137 other spec-file groups. Main at `e0adfe155` accounts for 401 tests;
PR #3769 adds three Harness cases and one performance case. The old timing
input described 320 tests, not current main.

Four lanes, one worker, every collected test and platform skip, and the existing
job deadlines remain unchanged. This changes allocation, not test coverage,
assertions, retry policy or readiness waits.

## Native evidence

All current measurements use production source
`46cc4f617761610ae17219d1358f9e9a9933f505`.

- [CI run 44207313806](https://github.com/pwrdrvr/PwrAgent/actions/runs/44207313806)
  supplies four successful Linux lanes and successful macOS lanes 2–4.
  Its cancelled macOS lane 1 is excluded. The preceding cancelled run
  [44203670501](https://github.com/pwrdrvr/PwrAgent/actions/runs/44203670501)
  is diagnostic evidence only, not a timing sample.
- [Timing study 44214604894](https://github.com/pwrdrvr/PwrAgent/actions/runs/44214604894)
  supplies successful macOS lanes 1–3 and all four Windows lanes. It checks out
  that exact source, disables Spotlight and the paravirtual GPU on macOS as CI
  does, and preserves Windows' runner-temp fixture volume. Its only observation
  changes add JSON/step reporters and a named step around the existing axe call.
  The existing shutdown circuit, cleanup and audits still run.

The study used an experimental `60:110:110:125` partition to obtain complete
groups from the previously interrupted portion of the suite. Its actual counts
were 60/112/111/122. This was a measurement partition, not the fitted allocation.

| Platform | Lane 1 | Lane 2 | Lane 3 | Lane 4 |
| --- | ---: | ---: | ---: | ---: |
| macOS job time | 9:42 | 8:09 | 13:49 | 11:26, failed |
| Windows job time | 7:15 | 10:58 | 7:58 | 7:56 |

The failed study lane 4 is excluded in full. It reported a Star Map window-opening
failure, not a deadline failure. Earlier successful lanes at the same production
revision supply those groups. No failed or interrupted lane is treated as a
complete sample, and missing work never receives a zero duration.

Windows' original lane 1 succeeded after a targeted retry, but its HTML report was
replaced by the one-test retry report. The compact first-attempt report retains
completion and IDs but no durations. The new complete Windows collection avoids
treating that one-test HTML report as an entire lane.

The [November 18 input](desktop-e2e-shard-durations-2026-11-18.json) records each group's IDs,
count, seconds and successful sample count per platform. A file's attempt durations
are summed before taking the median across available complete samples. Each
accessibility test is a separate group. The source collections cover all 405 IDs;
Linux/macOS/Windows retain 11/7/12 runtime skips respectively. The
[November 4 input](desktop-e2e-shard-durations-2026-11-04.json) is preserved.

## Where time grew

The same 68 accessibility tests have stable IDs in the three historical native
Mac reports and the current successful study. The table compares sums of their
historical per-test medians with the current observations, in seconds.

| Measurement | November baseline | Current Mac |
| --- | ---: | ---: |
| Test duration | 287.2 | 443.6 |
| Electron launch steps | 54.2 | 69.9 |
| Window readiness steps | 30.4 | 49.0 |
| Context close steps | 21.7 | 32.0 |
| DOM/main evaluation steps | 111.1 | 181.3 |
| Count-query steps | 23.9 | 42.5 |

These are step aggregates, not an exclusive partition or a causal attribution.
The eleven added accessibility groups cost another 88.3 seconds on Mac. Together
the 79 tests cost 531.9 seconds in the successful study, versus 11.1–11.4 minutes
reported in the two interrupted jobs. Host/run variation remains material.

For the same first 60 current tests, Mac/Windows test time was 436.6/317.6 seconds,
while the explicitly timed axe calls were 130.4/127.5 seconds. Mac launch plus
window waits were 113.9 seconds versus Windows' 56.3; context closes were
30.3 versus 13.1. The excess is spread through startup, readiness, interactions
and cleanup, rather than an observed axe-only stall. No evidence here identifies
a lifecycle ownership defect that would justify removing cleanup or readiness.

## Fit and coverage oracle

The existing exhaustive fitter keeps its objective: minimize the sum of the
three platforms' longest modeled lanes, using only measured current inputs.

```sh
python3 scripts/ci/fit-desktop-e2e-shards.py --data docs/desktop-e2e-shard-durations-2026-11-18.json --weights 83:82:67:88 --fit
python3 scripts/ci/fit-desktop-e2e-shards.py --data docs/desktop-e2e-shard-durations-2026-11-18.json --weights 77:91:104:133
```

| Platform | Old modeled lanes, seconds | Fitted modeled lanes, seconds |
| --- | --- | --- |
| Linux | 427.0 / 209.6 / 299.4 / 246.9 | 330.0 / 212.2 / 321.9 / 318.7 |
| macOS | 646.9 / 484.4 / 430.1 / 519.3 | 525.4 / 331.7 / 611.6 / 612.1 |
| Windows | 566.9 / 403.3 / 270.8 / 325.8 | 409.7 / 409.9 / 348.1 / 399.0 |

The first Mac lane loses 121.5 modeled seconds; the platform's modeled maximum
falls 34.8 seconds. Linux and Windows maxima also fall. These are test-duration
estimates, not job-time guarantees: setup, build, reporting and VM variation still
require hosted validation within the existing deadline.

The collection oracle uses actual `playwright test --list --shard=K/4
--reporter=json` output. It requires each modeled group to land in the same lane
as Playwright, all 405 IDs exactly once, and no omitted platform-skipped IDs.
The historical 320-test input fails this oracle against the current collection.
The fitted input and actual collection both reproduce 77/91/104/133 and end at `a11y.spec.ts`,
`electron-fixture-isolation.spec.ts`, `replay-discovery-isolation.spec.ts` and
`workspace-handoff-flows.spec.ts`.

Local verification passed the collection oracle, YAML parsing, full `pnpm lint`
(including typecheck and dependency boundaries), and the workflow policy tests.

After rebasing onto main `2c7328c13`, source `a470e9505` still collects the
same 405 IDs. [Native CI run 44221702130](https://github.com/pwrdrvr/PwrAgent/actions/runs/44221702130)
completed macOS lanes 1–4 in 10:46 / 9:52 / 10:55 / 12:33, within the existing
15-minute deadline. The consolidated report confirms complete first attempts
of 77 / 91 / 104 / 133 tests with no macOS E2E failures or retries. The overall
run has separate unit and Windows failures; see the
[Star Map investigation](desktop-e2e-star-map-opening-2026-11-18.md).
