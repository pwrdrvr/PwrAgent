# Managed subagent navigation reads

`SqliteOverlayStore.reconcileNavigationSnapshot` discovers managed workers from
parent overlays, then excludes ordinary grouped handoffs by reading each
candidate child's `handoffOrigin.groupingMode`. The relationship can be written
by another PwrAgent process sharing the profile, including a supported older
build that recreates a stale native-worker card.

The inherited implementation selected and parsed complete overlays twice. Large
activity histories, agent instructions, and other unrelated metadata crossed the
SQLite/V8 boundary even though this path only needs relationship fields.

## Read behavior

- The first query keeps the existing `monitorThreadId` substring predicate and
  projects parent identity plus only `backend` and `monitorThreadId` from each
  object in `subAgents`. `json_each` and `json_group_array` omit nested task/title
  metadata. Non-object entries retain the existing iteration behavior; a
  non-array `subAgents` value projects as null.
- The second query retains its primary-key candidate lookup and projects only
  `handoffOrigin.groupingMode`. Neither query returns full overlay payloads.
- `json_valid` guards extraction so malformed unrelated rows cannot abort the
  query. Overlay normalization only removes a legacy agent persona; it does not
  change the projected relationship fields.
- The child set is reused only when both SQLite `data_version` and
  `total_changes()` match the values captured **before** the last scan.
  `data_version` catches other connections' commits; `total_changes()` catches
  local writes, including direct SQL outside the overlay store. A concurrent
  commit during a scan therefore invalidates the next read.
- Calls inside a transaction neither consume nor publish the cached set. This
  prevents transaction snapshots and rolled-back savepoints from escaping.
- Backend reads still select the current row every time. One bounded cache
  retains the last payload and normalized state, avoiding repeated identity
  normalization when the row's bytes are equal. Scope changes, replacements,
  deletes, and writes from another process remain visible.

The invalidation semantics follow SQLite's
[`data_version`](https://www.sqlite.org/pragma.html#pragma_data_version) and
[`total_changes`](https://www.sqlite.org/c3ref/total_changes.html) contracts.
There is no timer, persistent index, trigger, schema migration, or new write.

A database change still causes a full parent payload scan. Invalidation is
conservative: unrelated writes also invalidate it, and complete navigation
reconciliation already writes the backend baseline. Thus the warm result below
applies to repeated reads without intervening writes, including partial
projections; it is not a claim that every complete reconciliation avoids scans.
Caller frequency/admission remains separate work in PR #2001.

## Reproducible measurement

From the repository root, export the baseline implementation and run both
versions in the same Node process with the same native SQLite library:

```sh
mkdir -p apps/desktop/.local
git show 314f16851:apps/desktop/src/main/state/overlay-store-sqlite.ts > apps/desktop/.local/overlay-store-baseline.ts
pnpm --filter @pwragent/desktop exec tsx scripts/benchmark-managed-subagent-scan.ts .local/overlay-store-baseline.ts
```

The probe creates and deletes its own temporary WAL database. It uses 629
parents, 629 children, 3,000 unrelated threads, and 10,000 legacy encoded backend
identities. Parent and child overlays carry synthetic activity metadata; every
fourth child is an ordinary grouped handoff. It asserts equal results before
measuring the actual complete helper methods, including both queries,
JSON parsing, normalization, and key construction. Five warmup samples precede
20 measured samples. Invalidated samples force a local write outside timing;
byte accounting runs separately from timed samples.

Initial measurements before the nested subagent projection, on Apple M4 arm64,
Node 24.18.0, V8 13.6, better-sqlite3's SQLite 3.53.2:

| Read | Baseline median / p95 | Changed median / p95 |
| --- | --- | --- |
| Complete managed-child helper, invalidated | 66.765 / 79.209 ms | 50.673 / 53.211 ms |
| Complete managed-child helper, unchanged database | 66.765 / 79.209 ms | 0.0044 / 0.0057 ms |
| Backend read, identical payload | 1.821 / 2.169 ms | 0.077 / 0.112 ms |

| Native result text | Baseline | Changed |
| --- | ---: | ---: |
| Parent query, 629 rows | 15,122,198 bytes | 62,680 bytes |
| Child query, 629 rows | 15,100,344 bytes | 12,631 bytes |

The invalidated helper median improved about 24%; total returned text fell about
99.75%. Timing is observational, not a CI threshold. A repeat under concurrent
lint/typechecking was noisier (101.4 to 88.4 ms medians, with a worse changed p95),
so absolute timings should not be interpreted independently of machine load.
This is a synthetic same-runtime comparison, not an Electron recapture or proof
of a PR #2001 regression. The original M5 capture motivated the investigation;
no running default app was restarted and no operator database was read.

## Nested subagent projection follow-up

The initial projection still returned complete subagent objects. A task/title
can itself carry arbitrarily large metadata. The current fixture therefore adds
a 2 MiB title to one subagent, and the regression still requires both native
results and parser inputs to remain below 1 KiB for its small relationship set.
The production query adopts the narrower projection integrated into #2001.

Using the same runtime above and the updated synthetic fixture:

| Comparison | Baseline median / p95 | Narrow projection median / p95 |
| --- | --- | --- |
| Original main `314f16851`, invalidated helper | 67.952 / 74.900 ms | 58.314 / 62.311 ms |
| Previous PR head `aa69e75e0`, invalidated helper | 47.998 / 51.065 ms | 60.076 / 65.787 ms |

The two comparisons are separate same-process runs. Unchanged reads measured
0.0037–0.0038 ms. The narrower query is about 14% faster than original main on
this fixture but about 25% slower than the prior projection: reducing transferred
bytes does not eliminate the SQL cost of extracting fields from every subagent.
This is an explicit materialization bound, not a claim of another cold CPU win.

Parent/child native text bytes were 17,219,361 / 15,100,344 for original main,
2,159,843 / 12,631 for the previous PR head, and **46,326 / 12,631** for the new
projection. Backend handling is unchanged; versus original main its median was
1.634 → 0.072 ms in the updated run.

The reproduction command above now includes the large title. To compare against
the prior PR version, export `aa69e75e0` instead of `314f16851`. Both baseline and
changed cold samples now force invalidation outside timing, so a baseline that
already has caching cannot accidentally measure warm reads or return no byte
accounting rows.

## Regression and write budgets

`overlay-store-managed-subagent-scan.test.ts` covers identity fallback, trimming,
self-reference and duplicate exclusion, malformed rows, grouped handoffs,
local mutations, a second connection, an independent writer process, a commit
between the queries, transactions/savepoints, and backend replacement/deletion.
The materialization test bounds both native result bytes and JSON parser input,
so a full-payload regression fails without a fragile wall-clock assertion.

The checked-in `managed-subagent-navigation-reads` budget measures ten cold and
ten warm helper/backend reads after real database setup: **0 commits, 0 write
statements, 0 changed rows, 0 observed WAL bytes**. Added write cost is therefore
0 writes/second × commit cost × 86,400 seconds = **0 MB/day**. Existing full
reconciliation writes are unchanged.


## PR #2001 integration measurement

The integration retains #2001's projection of individual subagent fields and
adds a large nested subagent title to the materialization regression. The same
synthetic probe compared signed pre-integration `3c9c61281` with the resolved
implementation at `720ecffd0`, using Node 24.18.0 / SQLite 3.53.2 on Apple M4.
The exported baseline's relative imports were redirected to this checkout's
`src/main/state` modules because #2001 adds a runtime relative-pin helper.

| Read | #2001 before median / p95 | Integrated median / p95 |
| --- | --- | --- |
| Complete helper, invalidated | 65.616 / 75.354 ms | 55.011 / 57.734 ms |
| Complete helper, unchanged database | 65.616 / 75.354 ms | 0.0049 / 0.0129 ms |
| Backend read, identical payload | 1.660 / 2.411 ms | 0.0784 / 0.1100 ms |

Returned parent/child text changed from 67,083 / 35,904 bytes to
46,326 / 12,631 bytes. The approximately 16% invalidated-helper improvement is
relative to #2001's already compact projection, not to main's former full
payload reads. Existing limitations still apply: unrelated writes invalidate
reuse, a cold scan remains a scan, and no live Electron CPU improvement has yet
been measured.
