# Usage Activity performance evaluation

Split persistent interval indexing out of [PR 3033](https://github.com/pwrdrvr/PwrAgent/pull/3033) before merging. Retain SQL helper aggregation, backend-aware grouping, compatible rollup IDs, and the consistent snapshot/exact-window cache. The revision on `perf/usage-activity-tradeoff` also avoids the separate turn lookup index: completion first tries existing backend/thread indexes, then falls back to the original `usage_turn_id` relationship. This preserves the completion CPU improvement without adding per-update WAL.

The R-tree is substantially faster for sparse moving reads, but it increases ongoing write CPU and WAL with Usage Activity closed. Its benefit depends on read/write frequency. The simpler endpoint candidate indexes measured here also amplify writes and lose their read advantage with future history. The proposed split intentionally retains history scans for ordinary overlap reads; its bounded materialization tests make no claim of bounded SQLite scan work.

## Measurements and assumptions

All measurements used contrived temporary databases in Sandboxer `sb_ptv1u843it`, Ubuntu x64, 8 vCPUs on AMD EPYC 9254, Node 22.23.3, pnpm 12.9.1, and better-sqlite3's SQLite 3.53.4. Each case has five repetitions of 120 operations after 20 warmup writes. CPU is process user plus system time, including the store's SQL, hydration, rollups, cloning, and the small observation wrapper. It is not wall time, renderer CPU, IPC cost, or an end-to-end Electron improvement. The original single macOS CPU capture establishes none of those improvements.

Setup, migrations, seeding, and checkpointing are excluded. WAL autocheckpointing is disabled during measurement; file databases use the test helper's `/dev/shm` location. WAL quantities therefore measure generated frames, not physical disk latency or SSD traffic. Benchmarks ran serially before full verification. Repetitions are sequential, rather than randomized across variants. Medians and observed minimum/maximum ranges for every phase are in [the result data](usage-activity-performance-results.json); small percentage differences inside those ranges are not reliable wins.

The past fixture has 20,000 old lines across contrived threads. The two-sided fixture divides 20,000 lines between old and future timestamps. Dense adds 6,000 finalized system helpers in one group to the past fixture. Ordinary windows span ten seconds; dense windows span five hours. Every read advances both bounds with the simulated clock, as ordinary UI presets do. Main fixtures also include a spanning turn whose authoritative completion differs from its stale line timestamps. Account/rate histories are not populated in the timing fixtures; preservation is checked separately.

Real live upserts advance the clock one second per operation. Real completion cycles insert a pending turn and record its authoritative completion, leaving accounting pending. Helpers are finalized inserts with parent summaries. Raw updates isolate `updated_at`/token writes at 100 ms or 60-second intervals. These are explicit synthetic rates, with no sleeping and no implied operator cadence.

## Closed window write costs

Each cell is **write CPU ms / WAL MB** for 120 operations, with decimal MB. A completion cycle includes two existing commits; the other cases have one per operation.

| Workload | Baseline | PR R-tree | Candidate indexes | Proposed query split |
| --- | ---: | ---: | ---: | ---: |
| Live upserts with turn identity | 120.7 / 6.427 | 148.1 / 6.971 | 118.0 / 7.910 | 124.8 / 6.427 |
| Pending turn and completion cycles | 826.5 / 9.880 | 187.5 / 12.459 | 130.7 / 11.874 | 130.2 / 9.880 |
| Finalized helper inserts | 94.8 / 10.111 | 139.4 / 12.867 | 102.8 / 12.105 | 99.2 / 10.111 |

The completion improvement in the PR is attributable to its ordinary `usage_turn_id` index, independently of the R-tree. An aggregation-plus-lookup-index variant measured 128.0 ms for completion cycles, but added 4,120 WAL bytes per live upsert. Existing upsert statements rewrite that index even when the relationship is unchanged. The proposed query reaches similar completion CPU with baseline WAL, using a fast indexed identity check whose successful result implies the original relationship. Its fallback admits every relationship the original query admitted, including differing backend or thread identities.

## Moving window total CPU

Each cell is **total read plus write CPU ms**, including loop overhead. Ordinary turn upserts use the past fixture; the last two rows use line upserts and their named history shape.

| Workload per repetition | Baseline | PR R-tree | Candidate indexes | Proposed query split |
| --- | ---: | ---: | ---: | ---: |
| 120 live writes and 2 reads | 127.7 | 152.7 | 135.9 | 130.3 |
| 120 live writes and 120 reads | 563.8 | 227.7 | 637.4 | 589.2 |
| Two-sided history, 120 writes and 120 reads | 707.1 | 197.9 | 1,199.8 | 738.9 |
| Dense helpers, 120 writes and 120 reads | 5,252.7 | 2,132.2 | 2,709.8 | 1,931.8 |

For the first row, the write/read CPU phases were 119.4/8.1 ms on baseline, 151.1/1.3 ms on the PR, 125.8/9.5 ms with candidate indexes, and 121.5/8.5 ms on the revision. At one live write per second this means one read per minute. At one read per write, the R-tree clearly wins sparse reads; SQL aggregation alone is sufficient to outperform it on this dense helper fixture. SQLite VM instruction counts do not account for hydration and JavaScript allocation, so the earlier increase in helper SQL instructions does not establish a total CPU regression.

For a rate model, use `CPU/day = writes/day × CPU/write + reads/day × CPU/read`. On the narrow past-history live-update case, the measured R-tree write premium and moving-read savings imply a rough break-even of one read per 13 writes against baseline, or one per 17 writes against the revision. This assumes stable per-operation costs and output size and excludes completion cycles. It is a workload-specific estimate, not a product-wide threshold.

## Cache reuse and refresh frequency

Across each variant's five moving read-only controls, cache reuse was **0/600**. Across unchanged fixed-window controls, it was **595/600** for the PR, candidate, and revision: one initial miss per repetition, then 119 hits. Baseline has no such cache. Moving reads with interleaved writes also had zero hits. The revision's 120 moving read-only calls took 427.5 ms versus 402.5 ms on baseline and 56.7 ms with the R-tree; the exact-window cache does not solve ordinary moving refreshes.

`UsageActivity.tsx` refreshes on manual action, selection changes, and focus after 60 seconds of staleness. There is no one-minute polling timer. Thus neither one read per second nor one read per minute should be treated as an observed UI rate. A closed Usage window issues no reads while writers still pay index costs. Truly idle applications perform no new maintenance writes.

## WAL frequency projections

These are assumptions applied to measured WAL growth, not observed daily usage. A 32-byte WAL header is excluded when calculating a per-operation rate.

| Assumed workload | Baseline MB/day | PR R-tree MB/day | Added by PR MB/day |
| --- | ---: | ---: | ---: |
| 500 real helper inserts/day, seeded history | 42.1 | 53.6 | 11.5 |
| One raw live update/minute, continuously advancing | 5.9 | 29.7 | 23.7 |
| One real live upsert/second, continuously active | 4,627.6 | 5,019.1 | 391.6 |

The last row is an extreme uninterrupted activity assumption, not expected daily load. Of the PR's 391.6 MB/day premium there, about 356.0 MB/day also appears with the ordinary turn lookup index alone. The candidate indexes add about 1,067.9 MB/day over baseline at the same rate. The proposed revision matches baseline WAL in the measured live/helper/completion workloads and adds no persistent index, timer, or maintenance commit.

The original small fixture's 65,920 to 86,520 bytes per helper and 17.8 MB/day minute-maintenance premium remain valid for that fixture. With seeded history, R-tree page occupancy increases the observed cost: 120 minute-crossing raw updates generated 494,432 bytes on baseline, 2,472,032 on the PR, and 988,832 with candidate indexes. WAL is data/layout dependent, so deterministic budgets assert commits/statements/rows, not exact frame bytes. The revised checked-in fresh-database budgets record 65,920 bytes for one helper, 412,000 for 100 raw updates, and 70,040 for a pending-turn/completion cycle, with 1, 100, and 2 commits respectively.

## Candidate design and preservation

The concrete candidate is commit `2d78a3fcd`. It unions an indexed line fallback endpoint with indexed authoritative turn completions, then rechecks exact joined predicates. Helper admission separately unions line and turn starts, preserving reversed-interval behavior as well. It uses expression/partial B-trees and a reverse turn lookup, without a key table or R-tree. This is a superset admission design, not an assertion that a single timestamp can solve arbitrary overlap. Future rows still become candidates for a historical window; the two-sided benchmark demonstrates the CPU consequence. Its mutable endpoint index adds a WAL page to each raw live update.

The proposed revision retains authoritative turn/line endpoint precedence, pending/finalized behavior, rate-limit/account history, every rollup sum, compatible wire IDs, backend-aware grouping, title identity, ordering, the 5,001 sentinel/5,000 ordinary-row limit, and existing helper output semantics. It removes derived experimental schema on reopen without altering ledger facts. Regressions cover sub-minute boundaries, old/new connection invalidation, rollback, cross-backend/account groups, and migration. Completion regressions explicitly exercise both the indexed identity path and the original cross-identity fallback. Materialization budgets remain; R-tree seek/maintenance assertions are removed because their implementation is no longer proposed.

## Reproduction and revisions

The isolated evaluation started clean at verified head `860a894c9fe8d8ff01c357626b45dfd608703235`. Baseline is its merge base `71d93469054b6ba75c9a6d022b45d0a4b794fb91`. Read-only inspection found the prior PR 3033 thread, usage-related worktrees, and overlapping `perf/turn-end-ledger-reads` store/cache work; no other open implementation PR appeared in the usage search. No overlapping branch was incorporated. PR 3033 remains unmerged and its branch is unchanged.

| Variant | Main benchmark commit | Additional turn harness commit |
| --- | --- | --- |
| Baseline | `6ff8b6e68f9a153698a4f7db1b83f7bdd875112e` | `bf7ad94a25984cafaa6914776e00f1db71efe40f` |
| PR production code | `5c926b8b4` | `999d866c316936daf0751ec722a5cefc7d0f4582` |
| Candidate | `2d78a3fcd` | `706539ed72e66992f61488a5b240ddded2b9f2ec` |
| Aggregation alone | `20c8bf2dd` | same commit |
| Aggregation and lookup index | `288e7f0f2` | same commit |
| Proposed query split | `8843971d1` | same commit |

Harness commits `5c926b8b4` and `5c358c40d` only add tests; they can be cherry-picked onto the baseline or verified PR without adopting candidate production code. All primary variants ran the complete 180-sample main harness and 40-sample turn harness. Lookup and proposed-query runs selectively repeated the relevant main cases; the recorded result file preserves which cases were actually timed. Every reported case has five samples. Setup ran separately per worktree; dependencies were not shared between worktrees.

Run through the Sandboxer verification skill, not on the local machine when Sandboxer is connected:

```sh
PWRAGENT_USAGE_PERF_DIR="$PWD/.local/usage-perf" \
PWRAGENT_USAGE_PERF_VARIANT=query \
pnpm test apps/desktop/src/main/__tests__/usage-activity-performance.test.ts \
  apps/desktop/src/main/__tests__/usage-activity-turn-performance.test.ts --maxWorkers=1
python3 scripts/summarize-usage-activity-performance.py .local/usage-perf
```

Raw contrived JSONL is retained under `.local/usage-tradeoff/results/` in the evaluation worktree and archived as `.local/usage-tradeoff/raw-results.tar.gz` (SHA-256 `be9434e39085cc21fe75cb0e37c2f1b585f352c10f5f27d535708f42fb0af57d`). The sandbox-only harness commits are preserved in `.local/usage-tradeoff/measurement-harness-commits.bundle`. The checked-in result file stores every case's phase medians/ranges, WAL, operation counts, and cache hits. The performance tests are opt-in and do not impose flaky timing thresholds on CI. No live profile was opened or mutated, and no operator records were used as fixtures.

Code commit `b7be6f73d40aa2828c96aeff15fbf488dfc9a3e2` passed full verification in Sandboxer `sb_ptv1u843it`: `lint exit=0 secs=62`, including syntax/typed Oxlint, types and the other lint gates; `unit exit=0 secs=138`, with 21,616 passed and 83 skipped across two shards. Candidate-only pricing/account compatibility checks passed 76 tests. All benchmark invocations exited 0. Budget calibration ran with `UPDATE_SQLITE_WRITE_BUDGETS=1`; only the relevant measured scenario changes were retained, and the final committed budgets passed without update mode. Verification is Linux-only; no headed macOS/Windows run was made. The prior 21,611-test pass belongs to verified head 860a894c; the later static review added no dynamic evidence.
