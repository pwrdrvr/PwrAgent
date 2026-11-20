# Linux unit-test allocation

The Linux CI unit job runs four parallel lanes with a ten-minute test-step
deadline. Only this job uses `vitest.linux-ci.mts`, which extends the shared
workspace configuration with `scripts/ci/linux-unit-sequencer.mjs`.
Desktop-main and desktop-renderer are allocated independently using measured
costs. Desktop-main retains its fork pool and per-file isolation. Worker counts,
test ordering within a lane, readiness checks and deadlines remain Vitest's
existing configuration. Other projects retain Vitest's hash-based ownership.

## Evidence

[Main run 43949436837](https://github.com/pwrdrvr/PwrAgent/actions/runs/43949436837)
at `c56bff20ea68e785592b0c70e89e79cab8243ffa` and
[PR run 43950624095](https://github.com/pwrdrvr/PwrAgent/actions/runs/43950624095)
both reached the Linux lane-1 deadline while still completing test files.
There was no final Vitest summary. The report is written by `onTestRunEnd`,
so the subsequent missing `unit-first.json` was a consequence of interruption.

Vitest's default sequencer hashes paths and divides the sorted files by count.
The first hash shard owned all three longest desktop-main files:

| File | Main test time | PR test time |
| --- | ---: | ---: |
| `owner-conformance.test.ts` | 113.793s | 112.196s |
| `archive-worktree-restart.test.ts` | 80.694s | 79.782s |
| `headless-profile.oracle.test.ts` | 67.007s | 67.340s |

Across both main lanes, desktop-main reported 835.3s versus 384.9s of test
work. Those tests run concurrently within each lane; their wall-clock phases
were about 6m20s versus 3m35s. Lane 2 completed the whole workspace slice in
480.62s. Lane 1 was still completing files at its deadline. This evidence
identifies an allocation imbalance rather than an assertion or shutdown
failure. The PR's preview change is independent of this allocation.

## Renderer allocation evidence

[PR run 44007133052](https://github.com/pwrdrvr/PwrAgent/actions/runs/44007133052)
at head `5b0a3817a53cce336bffe9db08e667f8011c5213`
completed every planned test module but crossed the ten-minute step deadline:
lane 1 took 532.28s and lane 2 took 600.76s. The lane-2 completion report
recorded 14,984 passed tests, 83 skipped, no unfinished modules, and no
unhandled errors. Its retry failed because there were zero failed tests.

The renderer still used hash-based ownership. Lane 1 received 257.805s of
renderer test work and lane 2 received 369.223s. The largest measured
renderer file was 34.467s; lane 2 held the settings, composer, session-state,
sidebar, navigation, and thread-view files together. These durations come
from both native Linux lanes.

`linux-renderer-unit-costs.json` records the 22 renderer files above five
seconds in that run. Replaying the current workspace inventory with these
sparse estimates and the 468 measured renderer durations assigns 312.636s
and 314.392s of actual test work to the two lanes. This is an allocation
model, not a measured new CI wall time. The new
partition property failed on the prior sequencer: with four lanes and one new
file, the estimated imbalance was 62.909s, above the largest file's 34.467s.

## Runner-speed evidence and lane count

With two balanced lanes,
[PR run 44111357566](https://github.com/pwrdrvr/PwrAgent/actions/runs/44111357566)
again crossed the ten-minute step deadline. Lane 2 reported a Duration of
609.86s with every test passing, and its retry failed because no tests had
failed. The cause was runner speed, not allocation. Five main runs
(44021057434, 44102962515, 44107691727, 44108073103 and 44114042498) and
this PR run were measured across all twelve lanes. Each file's time was
compared with its median across those runs.

- The median work per lane was within 7% across both lanes in every run. In
  the failing run it was 829s on lane 1 and 831s on lane 2.
- The median per-file ratio for each lane ranged from 0.69x to 1.22x. The
  failing lane ran at 1.20x. The slower lane alternated between lane 1 and
  lane 2 from run to run.
- Vitest's Duration was 0.567 to 0.608 of the lane's summed file time.

The suite holds 1,761s of median file work. With two lanes, a 1.22x runner
projects to about 650s, over the deadline before setup. With four lanes,
replaying the sequencer on the main inventory gives 424s to 457s of median
work per lane, about 340s of Duration on the slowest runner measured. The
desktop-main and desktop-renderer cost tables were left unchanged; they
already balance the measured work. A property test in
`linux-unit-sequencer.property.test.mjs` reads the lane count from `ci.yml`.
It requires the heaviest-lane bound (one lane's share plus the largest file,
at 1.22x and 0.608) to stay within 75% of the step deadline. The two-lane
workflow failed that rule at 733s.

## Allocation and maintenance

`linux-unit-costs.json` records desktop-main files taking more than five
seconds in the main run above, across both lanes. Values are the milliseconds
from each completed file's default-reporter line. All unlisted files receive
a one-second estimate, so newly added files participate immediately. The
estimates are scheduling hints, never runtime deadlines or permission to skip.
The renderer table uses the same threshold and fallback, with its own source
run and commit.

The registry split refreshed the remaining registry suite and four outliers
using passing file measurements from [run 44546599956](https://github.com/pwrdrvr/PwrAgent/actions/runs/44546599956)
and [run 44594264644](https://github.com/pwrdrvr/PwrAgent/actions/runs/44594264644).
The replacement PR's lane 3 reported 612s of main-process file work while
the other lanes reported 319s to 331s. Replaying its full main-process
inventory with the five updated weights distributes the same observed work
across the four lanes with a 508s peak. This replay holds file times fixed.

For each of desktop-main and desktop-renderer, assign the largest estimate
first to the lane with the least estimated work. Break file ties by
repository-relative path and lane ties by lane index. This makes ownership
independent of discovery order and
checkout location. Every file belongs to exactly one lane, including new or
renamed files. The completion reporter and native-fixture setup already ask
the configured sequencer for the selection, so their ownership follows the
same allocation.

Replaying the current default-branch file list with the original run's actual
test times gives 607s versus 613s of desktop-main work. This is a workload
model, not a claim about future wall time. Refresh the relevant project's
sparse estimates from both completed Linux lanes if new outliers make the
allocation uneven.
Do not collect timings from only one lane or use local macOS/Windows timings.

For a local allocation inventory, use:

```sh
pnpm exec vitest list --config vitest.workspace.mts --filesOnly --json
```

The sequencer property tests enforce complete partitioning, deterministic
ownership, a cost difference bounded by one indivisible file, unchanged
ownership for other projects, and agreement with the completion reporter.
The measured-outlier regression failed with the original BaseSequencer:
292,305ms of imbalance exceeded the largest file's 113,793ms cost.
