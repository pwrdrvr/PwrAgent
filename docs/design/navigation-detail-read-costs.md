# Selected-detail and backend metadata read costs

Selecting one identity previously invoked `reconcileNavigationSnapshot` with a
one-element thread array. The reconciliation still enumerated all managed-child
relationships, directory launchpads and directory overlays, read backend state,
and serialized a snapshot. The backend's `lastSnapshotHash` was that serialized
JSON, encoded again inside the backend payload. A cache avoided some reads but
could not bound a cold read or an invalidated read.

`projectNavigationThreadDetail` now uses the existing pure thread materializer
with one overlay, its queued execution mode and messaging bindings. It retains
the previous backend initialization/known-key rules for unread state. Explicit
managed-child detail is addressable, just like its collection resource; managed
children remain excluded from navigation membership. Provider resolution, live
Token Miser merging, PR canonicalization, Git hydration, detail byte limits and
collection paging retain their existing service paths.

Complete reconciliation stores `sha256:` plus a 64-character hex digest. The
shared serializer is named `serializeNavigationSnapshotForHash` to distinguish
its output from the digest. Partial reconciliation does not serialize for
comparison, and an unchanged complete snapshot does not rewrite backend state.

## Compatibility and query plan

Schema v66 creates a covering expression index over backend scope, known-key
JSON and a bounded hash expression. A legacy oversized hash is represented by a
small, truthy sentinel in the index. It preserves initialization semantics but
cannot compare equal to a new digest, so the next complete snapshot reports a
change once and replaces the old value through its normal write.

The migration builds the index without rewriting backend payloads. SQLite
maintains the index in the source write's transaction, including writes from
older processes. Deletes and rollbacks need no application cleanup. No timer,
per-event sidecar write, application-only invalidation or background backfill is
introduced. A concurrent opener rechecks the version inside an immediate
transaction before building the index.

The checked-in regression asserts `SEARCH backends USING COVERING INDEX` and
checks the VDBE program: no `Column` reads from the backend table cursor and no
`Function` operations. Moving JSON extraction into a SELECT without this index
would still parse megabytes inside SQLite and would fail this test.

The existing single-scope metadata cache remains an optimization. Correctness
and the payload-read bound hold with a new store on every call. Known identities
remain a list, so metadata cost scales with that list, not snapshot history.
Selected detail also still reads the selected thread's own overlay/history.

## Integration with startup maintenance (#2367)

The merged retention migration owns v65. Backend metadata moves to v66, so a
profile already upgraded by #2367 still installs the index. The v66 transaction
also creates the retention table if missing: earlier builds of this unmerged
PR used v65 for the index alone. Both v65 shapes therefore converge without
losing archive receipts or rewriting backend payloads. Fresh databases and v64
upgrades install both schemas.

Maintenance deletes from five detail tables, not `threads`, `backends`, or
`thread_navigation_relationships`. Its worker opens `StateDb` before cleanup.
A cross-connection regression runs the detail deletions, ordinary expiry, and
actual compaction, then verifies unchanged selected configuration, backend rows,
relationships, covering-index reads, and database integrity. External maintenance
can invalidate the existing metadata cache; the resulting cold read still uses
the covering index. The existing compaction page-budget fixture grows by one
index page: 4,120 additional WAL bytes, with unchanged deletion pages and commit
counts. At the maximum once-daily cadence this fixture adds 0.00412 MB/day;
real index size scales with the known-key lists. The isolated real-copy index
measured below occupied 28,672 bytes.

## Measured evidence

Measurements on 2026-09-27 used a consistent read-only SQLite backup of the
operator's 324,648,960-byte PwrAgent database, then disposable copies. Baseline
source was commit `9dddfffbe` (includes #2357). These measurements predate
#2367 and describe the metadata change, not combined startup-maintenance time. Only aggregate measurements are
published; the database and thread content remain private.

Each latency result uses 5 warmup calls and 20 measured calls, with a fresh store
per call to defeat application caches. OS/SQLite pages may be warm. The detail
comparison selects a small existing Codex overlay to isolate unrelated global
work, and asserts identical resulting thread configuration.

| Operation | Before | After |
|---|---:|---:|
| Largest backend metadata read, native text bytes | 9,355,352 | 10,922 |
| Metadata median / p95 | 14.57 / 15.31 ms | 0.038 / 0.051 ms |
| Selected projection, returned SQL rows | 1,227 | 2 |
| Selected projection, SQL get/all calls | 7 | 3 |
| Selected projection, native text bytes | 3,567,791 | 12,505 |
| Selected projection median / p95 | 10.81 / 11.50 ms | 0.078 / 0.091 ms |

The three-row backend index built in 20.8 ms, occupied 28,672 bytes, and wrote
65,952 bytes of WAL in one isolated transaction. A separate full StateDb.open
comparison on fresh copies measured 300 ms before and 326 ms after; these are
single observations, not latency percentiles. Existing startup work dominated
both opens. This is evidence for this long-lived database, not a universal
startup-time guarantee for arbitrarily large backend rows.

With WAL checkpointing disabled during each isolated write measurement:

| Backend persistence operation on the real-data copy | Time | WAL bytes |
|---|---:|---:|
| Legacy full value rewritten | 45.3 ms | 9,579,032 |
| First replacement by digest | 16.3 ms | 160,712 |
| Subsequent changed digest | 0.44 ms | 65,952 |

The first replacement frees old overflow pages; it is deliberately measured
separately from steady writes. This change does not vacuum the database.

Checked-in contrived budgets measure twenty selected reads at **zero commits**,
and an unchanged complete read plus a partial read plus one changed complete
snapshot at **one commit** (12,360 observed WAL bytes for the small fixture).
The real-copy changed-write projection at an assumed one change/minute is
`(1/60) × 65,952 × 86,400 = 94.97 MB/day`, versus 13,793.81 MB/day for the legacy
rewrite at that frequency. These are rate scenarios, not an observed polling
frequency. At 100 changed snapshots/day the new cost is 6.60 MB/day; unchanged
and selected-detail reads add 0 MB/day. The index adds no commits of its own.

## Reproducing and regression coverage

`apps/desktop/scripts/benchmark-navigation-detail.ts` accepts a private database
snapshot under `apps/desktop/.local/` and a git-exported baseline overlay module.
It opens the supplied snapshot read-only, makes its own disposable backup,
asserts output equivalence, and prints only aggregate read costs. Run from the
desktop package, for example:

```sh
pnpm --filter @pwragent/desktop exec tsx scripts/benchmark-navigation-detail.ts \
  .local/bounded-detail-proof/baseline.db \
  .local/bounded-detail-proof/baseline-store.ts
```

The baseline export must resolve its relative imports to this checkout's source
and alias the renamed shared serializer back to `buildNavigationSnapshotHash`.
The private snapshot must be produced with SQLite's backup API, not by copying
a live main file without its WAL.

The regression suites cover oversized legacy reads, bounded index size, digest
size and equality, v64 migration without payload rewrite, external writes,
transaction rollback, deletion, known-key encoding, selected projection parity,
absence of global scans, explicit managed-child detail, collection paging, live
helper links, and checked-in commit budgets. The two initial oversized-read and
non-digest tests failed against the baseline before implementation.

These measurements cover main-process paths, not the separate renderer React
CPU findings or all-thread overlay materialization. A complete snapshot still
serializes its comparison input transiently before hashing. Runtime validation
requires a build containing the new code and a fresh CPU capture; passing these
checks alone does not prove that every hot-CPU warning has disappeared.
