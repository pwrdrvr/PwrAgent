# Thread listing cause diagnostics

Hot CPU captures now write listing history in the adjacent `*.diagnostics.json`
artifact. Main captures include `listings`; renderer captures include both
`listings` (the main process) and `rendererListings` (that renderer). This is
in-memory accounting until a CPU artifact is saved. It makes no per-event log,
filesystem, IPC, or SQLite write. SQLite cost is **0 MB/day**.

## Reading a capture

Filter events by `at` (Unix milliseconds) around the CPU profile interval. A
`start`/`end` pair shares an `id`; `parentId` links a child operation to its
caller. IDs are process-local; the snapshot identifies the process. For reused
work, follow `targetId` on `coalesced` or `cache-hit`, rather than counting that
logical request as another physical execution.

| Stage | Meaning |
| --- | --- |
| `ipc` | A renderer request crossed IPC, with numeric sender and cause metadata. |
| `navigation` | A logical pool request. Different consumers may join one execution. |
| `owner-page` | One admitted page operation, including capacity wait and invalidation retries. |
| `owner-read` | An actual owner load attempt after admission. |
| `index` | Shared local membership-index construction, pending reuse, or completed reuse. |
| `registry` | Registry listing execution, pending reuse, or completed listing cache hit. |
| `provider` | A Codex listing scan, or a join to that scan. |
| `provider-rpc` | An actual `thread/list` RPC attempt. `page` and `attempt` distinguish pagination from protocol fallback. |

A cursor hit skips index construction. An index cache hit skips the registry
and provider. A registry hit skips the provider. `cancel` records revocation or
a deadline; it does **not** claim that a non-cooperative underlying provider
has stopped. Its physical attempt may settle later. `retry` with
`owner-invalidated` means an event arrived during the read. RPC fallback
attempts carry `provider-fallback`. Durations are wall time, not CPU time.

`source` distinguishes local viewer work, remote viewer demand, and incoming
Federation owner work. `inventory` distinguishes owner and viewer inventories.
Provider categories are Codex, ACP, or aggregate; individual ACP transport
calls are not instrumented. Known registry caller reasons are recorded;
unrecognized labels become `unknown`.

The bounded sidebar and Star Map project controllers attach a random
renderer-lifetime `origin` plus numeric `view`, `effect`, `logical`, and
`attempt`. Match these across renderer dispatch, IPC, and the owner process;
the origin survives Federation forwarding and contains no machine identity.
The renderer ring also records effect setup/disposal, demand changes, pending
reuse, invalidation, cancellation, and page-size/cursor recovery. A logical
read can legitimately issue several pages. Stable semantic demand ignores
all diagnostic metadata.

The same view with a new effect number identifies an effect setup/cleanup
cycle, including development StrictMode replay. It is not by itself proof of
a defect: API replacement can also restart an effect. The StrictMode fixture
shows two setups, cancellation of the first before dispatch, and two distinct
queries from the surviving effect (`directory-index` and `lens`). An unchanged
rerender sends neither again. Other navigation consumers retain their typed
consumer/query/read-reason attribution at IPC; absent lifecycle/trigger fields
mean unknown, not an inferred StrictMode duplicate.

Invalidation metadata contains a fixed cause category and an allowlisted
protocol method (for example `turn/completed`). The controller records the
latest relevant method and the number of invalidations collapsed into the
next read. Main invalidation events retain the individual method sequence.
Sidebar and project-card periodic refreshes explicitly say `timer`; project
and sidebar owner notifications retain their cause. No payload, title, prompt,
path, raw thread ID, owner ID, or exception message is copied into this history.

## Bounds and cost

The main ring holds 4,096 events; each renderer holds 1,024. Snapshots exclude
events older than 120 seconds. Appending overwrites one slot in O(1), without
serializing a request or scanning retained history. `recorded`, `overwritten`,
and main stage/phase totals remain exact process-lifetime counters. A busy
interval can overwrite causal events: a missing `targetId` event is not proof
that no work ran. Do not use process-lifetime totals as interval counts.

Promise identities use weak references. Diagnostic records contain only fixed
vocabulary, bounded opaque tokens, booleans, and numbers. Reading a renderer
ring makes one CDP call per saved profile, with a one-second deadline. A closed
or unresponsive renderer yields `rendererListings: null` and preserves the
main history and CPU artifact. This optional read can delay the save by up to
that deadline; it never runs on event append.

Checked-in regression budgets:

| Scenario | Recorded events / executions |
| --- | --- |
| Eight concurrent consumers, 500 provider rows | 11 events; one provider scan and one RPC |
| Three logical IPC reads; two overlap and the third reuses the index | 24 events; two owner loads and one index construction |
| StrictMode sidebar mount plus unchanged rerender | At most 10 renderer events; two legitimate query dispatches |

A macOS local run on 2026-09-28 measured 100,000 populated appends in 38.05 ms
(**0.38 µs/event**), 10,000 traced async operations in 14.16 ms
(**1.42 µs/operation**), and a full ring snapshot in 0.42 ms (780,519 serialized
bytes). These microbenchmarks measure instrumentation, not an application CPU
improvement. CI checks event counts and storage bounds rather than a flaky
wall-time threshold. There are no stack captures or per-row events.

To reproduce the local timing report from the repository root:

```sh
mkdir -p .local
PWRAGENT_LISTING_DIAGNOSTICS_BENCHMARK=1 pnpm test apps/desktop/src/main/__tests__/listing-diagnostics-budget.test.ts
cat .local/listing-budget.json
```

No general duplicate-dispatch defect or percentage speedup was established by
this change. The records supply the evidence needed for the next live capture.
