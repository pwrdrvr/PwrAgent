# Sqlite Write-Volume Instrumentation

Moved from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps a summary and
says when to read this document. Relative links were updated for this location.

## Sqlite Write-Volume Instrumentation

PR #1406 fixed tool accounting running one implicit transaction per streamed
8 KiB command-output chunk: **3,693 commits and 58 MB of WAL growth** for a
single `find /`, to persist about nineteen integer counters. The whole suite
passed either way. It had to be found by hand.

The reason nothing caught it is worth internalizing before you reach for a
unit test here: **the main-process suites mock the overlay store.**
`backend-registry.test.ts` alone constructs `createOverlayStoreMock` in 450+
places, so no sqlite is involved and no assertion about write behavior is
possible. The code path that writes for real only runs in the app — which the
E2E harness does exercise, against a real `state.db` under a temp
`PWRAGENT_HOME`.

So the instrumentation lives on the database, in
[`src/main/state/sqlite-write-metrics.ts`](../src/main/state/sqlite-write-metrics.ts),
and covers vitest, E2E, and dev runs from one place.

**Measure commits, not statements.** Each implicit transaction flushes its
dirty pages, and a row update drags along every index it moved — in #1406's
case four 4 KB pages per write, because `observed_at` sits in all three
indexes on `thread_tool_invocations`. Ranking by statements would call a
batched migration expensive and a per-event write loop cheap.

### Running it

```bash
pnpm test:sqlite-writes                       # whole suite, then the ranking
pnpm test:sqlite-writes apps/desktop/src/main/__tests__/state-db.test.ts
```

Every desktop E2E run reports automatically — the harness is the only place
the real write path executes, the overhead is a `statSync` per commit against
a run that launches Electron, and the ranking prints at teardown into the run
log (`e2e.log` on the lab guest). Opt out with
`PWRAGENT_DEV_SQLITE_WRITE_METRICS=0`.

### Things that will bite you

- **Attach after migrations, not before.** Schema migrations commit once per
  version on a fresh database. A suite that opens a temp db per test would
  otherwise rank whichever file opened the most databases as the heaviest
  writer — the first version of this reported 164 commits for 16 statements.
- **Instrumentation must be invisible to the code it measures.**
  better-sqlite3 hangs `.default` / `.deferred` / `.immediate` / `.exclusive`
  off the callable `transaction()` returns, and they are **not enumerable**.
  Copying with `Object.assign` drops them and every `tx.immediate(...)` caller
  dies with "is not a function"; `pr-auto-dispatch.test.ts` is what caught it.
- **A zero is not a clean bill of health.** A test file that mocks its store
  reports zero writes no matter what it does in production. Read the ranking
  as "of the code that touched real sqlite, here is the order", never as
  coverage.

### Known baselines

Numbers to compare a new write path against, all measured with this harness:

| Path | Cost |
|---|---|
| Streamed command output, per-chunk (pre-#1406) | 3,693 commits / 58 MB WAL for one `find /` |
| Streamed command output, coalesced (today) | 34 commits / 0.54 MB for the same command |
| Environment action output, row rewritten per 500 ms snapshot (former) | 122 commits / 2.9 MB for one minute of output |
| Environment action output, in memory until a run boundary (today) | 2 commits / 74 KB per run, whatever its length |
| Former 10-second runtime lease heartbeats | 720 commits / 2.7 MB per hour (~65 MB/day) |
| PID-owned messaging + federation leases, idle hour | 0 commits / 0 MB WAL |
| PID-owned lease lifecycle (register, acquire/release both, exit) | 6 commits / ~93 KB WAL |
| PID-owned dead-owner observation + takeover, both leases | 5 commits / ~72 KB WAL |
| Whole vitest suite | 51 sources / ~3,000 commits / ~27 MB WAL |
| One replay E2E spec | ~28 commits across two Electron processes |

The former idle figure came from two 10-second sqlite renewal loops. Runtime
leases now register one process identity and verify its PID, instance ID, and
start time against the existing profile runtime marker only when a challenger
tries to acquire messaging or federation. A confirmed dead-owner observation
is persisted and becomes reclaimable after one minute, even if the PID is
reused in the meantime. Holding either lease adds no sqlite timer and no idle
sqlite writes. A process that is alive but hung retains ownership while its
profile marker remains fresh; this deliberately favors preventing dual owners
over preempting a possibly healthy process.

### Transcript accounting indexes

The [usage flush budget](../src/main/__tests__/thread-usage-flush-write-budget.test.ts)
measures 24 single-line storage flushes after seeding a 256-turn ledger.
Each measured turn is inserted and then updated by three more observations.
The control drops the three transcript accounting indexes. Both runs made
24 commits per scenario.

| Turn row | Control WAL bytes | Indexed WAL bytes | Indexed MB/day | Added MB/day |
| --- | ---: | ---: | ---: | ---: |
| Priced root | 1,446,120 | 1,433,760 | 215.06 | −1.85 |
| Unpriced root | 1,454,360 | 1,557,360 | 233.60 | 15.45 |
| Priced child | 1,536,760 | 1,635,640 | 245.35 | 14.83 |
| Unpriced child | 1,516,160 | 1,911,680 | 286.75 | 59.33 |

The projection assumes one continuously active thread flushing once per second
for one hour per day. It multiplies measured bytes per flush by 3,600 and uses
decimal MB. The priced root row is outside all three partial indexes. Its
three-frame difference reflects SQLite page layout in this sample. An
unpriced child turn row can enter all three indexes.

### Antigravity compaction accounting

The [ACP compaction budget](../src/main/__tests__/thread-acp-compaction-write-budget.test.ts)
compares three completed turns with the same billed usage and cost. The
measured scenarios add ordinary fill and one compact request. The no-shrink
scenario flushes billing before completion, as does its control.

| Scenario | Control commits | Measured commits | Control WAL bytes | Measured WAL bytes |
| --- | ---: | ---: | ---: | ---: |
| Steered, shrink verified | 3 | 3 | 218,360 | 243,080 |
| Idle, no shrink on first fill | 6 | 6 | 230,720 | 238,960 |
| Idle, shrink verified by a fresh owner | 3 | 3 | 218,360 | 148,320 |

Streamed fill, cached replays, duplicate terminal events, and time spent
waiting add zero commits. Confirmation and its marker share the next ordinary
turn's completion transaction. WAL bytes depend on page layout and the
checkpoint at reopen. Using the largest observed increase, 24,720 bytes per
compaction at ten compactions per day projects about 0.247 MB of additional
WAL per day.

The completion lookup reuses the live root billing index. Idle compaction
seeks the latest completed ACP root turn with a recorded fill in a partial
index. An in-memory probe varied target turns and unrelated billed lines
independently from 1,000 to 4,000. Completion held at 85 SQLite VM steps and
idle baseline lookup at 123. Before indexing, the largest tested cases took
25,078 and 68,077 steps respectively.

A separate file-backed run settled 64, 128, and 256 ordinary ACP turns with
and without the idle baseline index. Each turn made one existing commit in
both configurations. The index added about 4.1–5.2 KB of WAL per turn in
these runs, or about 0.52 MB/day at 100 ordinary ACP turns. It also adds one
4,120-byte frame to the maintenance fixture's VACUUM.

### Write budgets

[`src/main/__tests__/fixtures/sqlite-write-budgets.json`](../src/main/__tests__/fixtures/sqlite-write-budgets.json)
records what each measured scenario costs, and
`sqlite-write-metrics.test.ts` fails when one moves:

```
sqlite write budget "streamed-command-output" changed.
  budget:   2 commits, 2 statements, 2 rows (~36 KB WAL)
  measured: 501 commits, 501 statements, 501 rows (~2820 KB WAL)
```

That is the pre-#1406 write pattern being caught automatically. Note the
budget: **2 commits for 501 streamed events**, because commits must not scale
with events.

**Setup is excluded by construction.** `measureSqliteWrites(fn)` measures only
what the callback does, so opening the database, applying migrations, and
seeding fixtures all sit outside it. A budget therefore tracks the feature and
stays put when a test grows more setup — no classifying writes after the fact,
no arguing about which INSERT was "arrange".

**Only the deterministic counters are asserted.** Commits, write statements,
and rows changed are a pure function of the code path — same operations, same
numbers, on any machine under any load, which is what makes an exact assertion
safe here rather than a tolerance. WAL bytes are *not* deterministic (page fill
and checkpoint timing move them run to run), so `observedWalBytes` is recorded
for humans to read and never asserted. Commits are the honest proxy for volume.

Deviation fails in **both** directions. An increase is the regression this
exists to catch; a decrease means the budget has gone stale and would stop
catching anything, so lowering it is a deliberate act.

### Adding a budget

Any new write path that fires per command, per turn, per item, per streamed
event, or on a timer gets one. Wrap the feature — not its setup — and name the
scenario:

```ts
const { writes } = await measureSqliteWrites(async () => {
  // drive the feature
});
expectSqliteWriteBudget({
  note: "what one unit of work is, in words",
  scenario: "my-feature",
  writes,
});
```

Then record it with `UPDATE_SQLITE_WRITE_BUDGETS=1 pnpm test <file>` and commit
the JSON. Re-record the same way when a change moves a number **on purpose**,
and say why in the commit message — the point of the file is that a write-cost
change shows up as a reviewable line in a diff instead of never showing up at
all.

Before recording, do the projection: writes/second × how long a real session
runs → MB/day. If it looks excessive, raise it rather than baking it in. A
budget is a record of what a path costs, not permission for it to cost that.
