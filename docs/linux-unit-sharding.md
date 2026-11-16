# Linux unit-test allocation

The Linux CI unit job runs two parallel lanes with a ten-minute test-step
deadline. Only this job selects `scripts/ci/linux-unit-sequencer.mjs`.
Desktop-main retains its fork pool and per-file isolation. Worker counts,
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

## Allocation and maintenance

`linux-unit-costs.json` records desktop-main files taking more than five
seconds in the main run above, across both lanes. Values are the milliseconds
from each completed file's default-reporter line. All unlisted files receive
a one-second estimate, so newly added files participate immediately. The
estimates are scheduling hints, never runtime deadlines or permission to skip.

Within desktop-main, assign the largest estimate first to the lane with the
least estimated work. Break file ties by repository-relative path and lane
ties by lane index. This makes ownership independent of discovery order and
checkout location. Every file belongs to exactly one lane, including new or
renamed files. The completion reporter and native-fixture setup already ask
the configured sequencer for the selection, so their ownership follows the
same allocation.

Replaying the current default-branch file list with the original run's actual
test times gives 607s versus 613s of desktop-main work. This is a workload
model, not a claim about future wall time. Refresh the sparse estimates from
both completed Linux lanes if new outliers make the allocation uneven.
Do not collect timings from only one lane or use local macOS/Windows timings.

For a local allocation inventory, use:

```sh
pnpm exec vitest list --config vitest.workspace.ts --filesOnly --json
```

The sequencer property tests enforce complete partitioning, deterministic
ownership, a cost difference bounded by one indivisible file, unchanged
ownership for other projects, and agreement with the completion reporter.
The measured-outlier regression failed with the original BaseSequencer:
292,305ms of imbalance exceeded the largest file's 113,793ms cost.
