# Thread-search pruning CPU investigation

Baseline: `208b845a5140c08faafc1cd21c3aac25e7035e2a` (`origin/main`
when this investigation began). Measurements use private synthetic databases;
the operator application and state database were never opened or modified.

## Recorded evidence

The supplied PwrAgent 1.4.2 main-process profile `main-hot-0002.cpuprofile`
contains 69.901 seconds, including 54.933 seconds before the CPU trigger.
The trigger was `2026-11-14T04:47:06.582Z`, at 68.295% main-process CPU;
the completion notification was `04:47:21.629Z`. The relevant trigger
interval is recording seconds 52.933–54.933, not the completion notification.

Inclusive sampled time in `pruneMissingThreads` is 1,960.811 ms in that
interval and 2,858.996 ms across the recording. Native SQL frames do not
identify individual statements or deletion counts. There are zero overlapping
listing events, Git buckets, or directory enrichment buckets in the supplied
adjacent diagnostics. This is separate from renderer navigation refresh work.

## Correction and inventory authority

`ThreadSearchThreadLister` returns available rows, with no completeness proof.
`listThreadSearchCandidates` can continue aggregate discovery after Codex
failure, and listing paths can return cached, limited or unavailable-provider
inventories. Even an archive-inclusive response cannot authorize deletion.

Search now uses the current request's identities for metadata and transcript
candidates, before ranking limits. Omitted cached rows remain durable but are
invisible to that request. The backend and archive filters still apply. A later
request can rediscover those rows without delete/reinsert churn.

Indexing yields between groups of 64 rows and checks cancellation before the
next group. Explicit complete-inventory cleanup inspects 64 documents via an
identity-key cursor, filters backend/archive/retention in that window, and
batches eligible deletes in one transaction. It creates no background timer
and search never invokes it. A complete sweep requires repeated calls; each
scope's in-memory cursor wraps at the end. Input inventory normalization still
costs O(number of retained identities); database work is bounded by the window.

Schema v82 copies existing FTS identity/rowid pairs once, preserving the token
index and canonical encoded identities. Replacements reuse the mapped FTS
rowid; deletion seeks it directly. Mapping rowids are explicit integer primary
keys, so `VACUUM` preserves them. Keyed identity probes detect older writers
sharing the database: a mismatched mapping takes a compatibility scan and is
repaired on refresh. New identities skip that scan; allocation stays above both
FTS and mapping keys, preventing collisions with legacy rows.

The all-status `(backend, thread_id)` usage index serves direct history and the
automation execution-thread join. Provider and status remain unrestricted:
superseded-only usage still retains titles. Automation owner lookup uses its
existing backend/thread index. No usage facts or billing predicates change.

## Native SQL measurements

The query-budget test runs the full migrated schema and repository
`better-sqlite3` SQLite **3.53.4**, with 100, 1,000 and 10,000 documents,
usage lines and automation runs, both with and without `ANALYZE`. All rows are
invented. Timing below sums three native `.run()` calls per statement type,
for direct usage, automation execution usage and no usage. It excludes prepare,
transaction and JavaScript costs; it is an observation, not a timing gate or a
claim about which SQL dominated the packaged recording.

| 10,000-row case | Baseline | Correction |
|---|---:|---:|
| FTS deletes, no statistics | 3.428 ms | 0.020 ms |
| FTS deletes, analyzed | 3.413 ms | 0.026 ms |
| Title retention, no statistics | 0.569 ms | 0.019 ms |
| Title retention, analyzed | 0.064 ms | 0.073 ms |

Without statistics the old usage predicate scans a covering provider-first
index. With representative statistics it uses a skip-scan:
`ANY(provider) AND backend=? AND thread_id=?`. Thus the abbreviated schema
observation does not establish an unavoidable usage scan. The new index gives
both direct and automation usage a covering two-key seek in either condition.
FTS changes from unconstrained virtual-table scan to rowid equality.

Ranked search iterates FTS MATCH once and checks inventory membership before
ranking limits, then looks documents up by identity. Driving MATCH by each
inventory rowid restarts ranking statistics and becomes quadratic for dense
visible matches. Filter-only searches still seek inventory document identities.

A value-preserving probe on the MATCH right-hand side counts native cursor
openings. At review head `048d4e7`, dense LIMIT-10 searches showed:

| Visible matching titles | Before | Correction | MATCH cursor opens |
|---|---:|---:|---:|
| 1,000 | 46.10 ms | 2.75 ms | 1,000 → 1 |
| 2,000 | 139.77 ms | 4.07 ms | 2,000 → 1 |
| 4,000 | 545.89 ms | 7.39 ms | 4,000 → 1 |
| 8,000 | 2,011.35 ms | 14.63 ms | 8,000 → 1 |

These timings include the test probe and are observations. The gate counts
cursor opens, and a generated oracle checks that full ranked results filtered
by inventory, before LIMIT, equal the scoped results. Ranked work is linear in
matching index entries plus membership preparation, including omitted entries.

Current/newer partial profiles also converge the mapping and usage index.
Rebuilding old-format FTS invalidates its surviving rowid mapping; repair drops
and backfills that derived mapping in the same schema transaction. Healthy
reopens do not scan/backfill FTS or add SQLite writes (0 MB/day).

## Operation and write budgets

Tests assert plans and operation counts rather than elapsed-time thresholds:

- Ten unchanged searches over 100/1,000 omitted document and ledger rows:
  at most 20 prepared operations, no pruning, zero commits/write statements.
- Searches over 100/1,000/10,000 omitted matches: filter-only inventory seeks,
  one outer ranked MATCH cursor, keyed document access, membership before LIMIT.
- Empty inventories: no SQL query.
- Dense 1,000/2,000/4,000/8,000-match inventories: one ranked cursor opening;
  generated inventory/archive/backend cases agree with the full ranking oracle.
- Ten cleanup calls over 100/1,000/10,000 fully retained documents: exactly
  ten indexed range reads, at most 640 returned/inspected documents total.
- Sweeps of 1,000 document/ledger rows with M = 0/1/63/64/65/200 stale
  identities: exactly ceil(M/64) commits and 4M write statements.
- A full 64-deletion slice: 321 prepared operations, 256 write statements,
  one commit. Title, FTS, document and mapping changes are atomic.
- Cancellation after the first indexing slice: exactly 64 rows indexed and
  at most 448 prepared operations before yielding/aborting.

The checked-in SQLite budgets wrap features after setup. WAL bytes are
observations; deterministic commits, statements and changed rows are asserted.
Using decimal MB and `events/second × bytes/event × 86400 seconds`:

| Workload | Commits | Observed WAL | Projected MB/day |
|---|---:|---:|---:|
| Unchanged searches or idle | 0 | 0 | 0 at any search frequency |
| Cold 200-row inventory | 4 | 321,360 B | 3.214 at 10 such inventories/day |
| Explicit 64-row cleanup | 1 | 94,760 B | 0.948 at 10 slices/day |
| One isolated usage-line insert, baseline | 1 | 24,752 B | 24.752 at 1,000 inserts/day |
| Same insert, all-status index | 1 | 28,872 B | 28.872 at 1,000 inserts/day |

The usage index adds no commit: the measured incremental projection is
**4.120 MB/day at 1,000 individually committed new usage lines/day**. Grouped
ledger writes can share pages; this is a one-insert-per-commit calibration.
The existing full-compaction page budget increases by three WAL frames
(12,360 bytes), with the same two commits. At one compaction/day that adds
0.01236 MB/day. The migration's map copy and index construction happen once,
with no recurring migration writes. Search no longer commits per missing identity.

## Regression evidence and reproduction

The provider-inventory oracle failed on unmodified baseline source and shrank
to one unarchived Codex thread omitted from a partial listing. Original cleanup
also failed the 64-row/one-commit budget and unchanged searches invoked pruning
ten times. The deletion and scoped-search plan tests also fail on baseline
source. Baseline files were restored from `git show` for those runs, then the
working correction restored; no operator database was involved.

Properties/model tests cover provider/backend/archive partitions, canonical
ACP identities including colons/percent/Unicode, replacements and rowid reuse,
legacy writers, superseded-only and automation execution usage, and bounded
cleanup sweeps. File-backed tests verify v81 migration, reopen and `VACUUM`.

Against review head `048d4e7`, the ranked-search property shrank to two visible
matching threads and a limit of one: MATCH opened twice. Partial-profile repair
failed with a missing mapping table, and rebuilding old-format FTS with a
surviving sparse mapping failed the rowid-pair oracle. The corrected properties
also cover current/newer schema versions and zero-write healthy reopens.

Run from the repository root:

```sh
pnpm test thread-search
THREAD_SEARCH_BENCHMARK=1 pnpm test apps/desktop/src/main/__tests__/thread-search-query-budget.test.ts apps/desktop/src/main/__tests__/thread-search-maintenance.property.test.ts apps/desktop/src/main/__tests__/thread-search-ranked.property.test.ts --silent=false
pnpm test:sqlite-writes thread-search sqlite-write-metrics voice-navigation-write-budget owner-content-search-persistence overlay-store-usage-pricing state-db.test
```

Benchmark logging is opt-in. Normal tests enforce query and operation budgets
without logging plans or timings. Sandboxer is dormant and was not used.
