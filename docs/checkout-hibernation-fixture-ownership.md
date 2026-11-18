# Checkout hibernation fixture ownership

This follow-up preserves the earlier native-suite investigation and adds the
canonical-queue validation at `f66cf3200bf11ef2689f0de6137830e46be29171`, based
on main `a90af8c87424c26889fae517ad8b1863690af88b`. Its normal native full run
passed 29,644 tests and failed only the five-second multi-wave hibernation
membership test: 2,159 files passed, nine files and 108 tests skipped, 237.84 s.
The unchanged 98-test file then passed in isolation in 39.23 s. Neither result
prints a fast-check seed. These observations do not establish host contention.

The immutable source-log SHA-256 values are:

- Full failure: `34120ca1d6fd1398a2f36581f68a1e8b898ad4ca63a488b8cf03be06e65dc638`.
- Isolated pass: `fb285f4e8f258879ff8cf2e926db4077c6a732d5069c45c8c8e706fbc79a59f8`.

The test is byte-identical at original base `b13f0692d`, the supplied main,
and investigation main `fd46b42be8a83799f5e2af13f129b3ba11533174`. PR #3896
changes only the held-updater fixture and its evidence report; its readiness
fix does not own checkout fixtures or cover this test.

## Cold work before changes

A native observation of the unchanged multi-wave test recorded:

| Phase | Wall time |
| --- | ---: |
| Initial Git/SQLite fixture | 125 ms |
| Five more worktrees and the unrelated fleet | 264 ms |
| Review scan | 151 ms |
| Hibernation apply | 1,811 ms |
| Assertions | 1 ms |
| Complete body | 2,353 ms |

Git Trace2 recorded 281 process starts, including Git's own child commands:
102 `rev-parse`, 30 `ls-files`, 18 `diff`, 18 `symbolic-ref`, and other snapshot,
checkout and safety operations. Worker-process CPU was 526 ms; that excludes
Git child CPU and cannot establish scheduling delay by subtraction. Repeated
probes span review, fresh admission and snapshot/removal validation. No process
or probe count is reduced here. The six real worktrees, 220 unrelated owners,
multiple apply waves and one archived-membership read assertion remain intact.

## Independently reproduced ownership defect

The old hook joined only selected suboperations. The main batch test's complete
setup/apply/assertion promise was absent, so a deadline could let teardown close
its registry and SQLite database and remove its root while the body continued.

Four controlled minimal oracles fail against the pre-fix paths:

- Teardown retires a gated test's resources before real Git, filesystem and
  SQLite reads finish; all three native reads reject after premature retirement.
- An already-aborted case allocates two fixture roots.
- A retired fixture admits a new SQLite database open.
- An aborted Git helper persists a config mutation, verified through Git itself.

Every original asynchronous callback now belongs to its test owner. Retirement
closes admission, releases existing gates and joins complete test work before
resource disposal and provider reset. Fixture, Git and database admission check
the owning signal and retirement state. The control oracles have a separate
outer lifetime so they can request fixture retirement without joining themselves.

All 64 original callback bodies, covering 98 cases, remain byte-identical inside
the wrapper. All 102 native tests pass, including the four new oracles; timeout,
worker, concurrency, isolation, property bounds and SQLite budgets are unchanged.
This fixes the demonstrated retirement/admission rules. The initiating full-suite
deadline remains unattributed; a later focused pass does not erase that failure.
No additional full-suite run was made to obtain a green result.

Byte-identical logs, source hashes, cold Git trace, pre-fix assertions, final
validation and callback audit are retained under
`.local/native-suite-cohort/checkout-hibernation-followup/`. Verification uses
this worktree's own frozen dependencies and the normal native build hook.
