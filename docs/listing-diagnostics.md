# Thread listing cause diagnostics

Hot CPU captures now write listing history in the adjacent `*.diagnostics.json`
artifact. Main captures include `listings`; renderer captures include both
`listings` (the main process) and `rendererListings` (that renderer). This is
in-memory accounting until a CPU artifact is saved. It makes no per-event log,
filesystem, IPC, or SQLite write. SQLite cost is **0 MB/day**.

In normal app sessions, schema version 2 arms each ring while its CPU monitor
is on. Each renderer reload re-arms the new document while its monitor runs.
Stopping the monitor clears its ring and removes renderer input listeners.
When a renderer CPU capture is still saving at shutdown, its sidecar uses the
main-ring snapshot taken before the shared main monitor can clear it. Unpackaged
replay E2E also arms the main ring for failure attachments without CPU profiling.
Backing slots contain serialized, allowlisted scalar records, never requests,
notifications, thread objects, DOM nodes or event objects. Main's promise
identity lookup remains a WeakMap and is replaced when monitoring stops.
Pending operations from an earlier monitor cannot attach stale parent IDs,
end records, or settlement records to a newly enabled monitor. Disabled
accounting preserves the existing asynchronous operation completion boundary.

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
| `owner-page` | One admitted page operation, including capacity wait. It loads once, whatever lands during it. |
| `owner-read` | An actual owner load attempt after admission. |
| `index` | Shared local membership-index construction, pending reuse, or completed reuse. |
| `registry` | Registry listing execution, pending reuse, or completed listing cache hit. |
| `provider` | A Codex listing scan, or a join to that scan. |
| `provider-rpc` | An actual `thread/list` RPC attempt. `page` and `attempt` distinguish pagination from protocol fallback. |

A cursor hit skips index construction. An index cache hit skips the registry
and provider. A registry hit skips the provider. `cancel` records revocation or
a deadline; it does **not** claim that a non-cooperative underlying provider
has stopped. Its physical attempt may settle later. `overtaken` with
`owner-invalidated` means an event arrived during the read. The page still
went to the readers that joined it, but was not kept as the query's current
result; readers that arrived after the event wait for one follow-up page,
which has its own `owner-page` start. An `owner-read` `overtaken` means the
Attention view held something observed after that index's listing began: a
boundary, or a newer listing from another read for the view. The index was
reconciled without changing those members, not reread. RPC fallback attempts carry
`provider-fallback`. Durations are wall time, not CPU time.

`source` distinguishes local viewer work, remote viewer demand, and incoming
Federation owner work. `inventory` distinguishes owner and viewer inventories.
Provider categories are Codex, ACP, or aggregate; individual ACP transport
calls are not instrumented. Known registry caller reasons are recorded;
unrecognized labels become `unknown`. The fixed `:archived-metadata` suffix is
retained for known callers: its pages are the archived metadata traversal
inside that listing, not separate listing invocations.

The bounded sidebar and Star Map project controllers attach a random
renderer-lifetime `origin` plus numeric `view`, `effect`, `logical`, and
`attempt`. Match these across renderer dispatch, IPC, and the owner process;
the origin survives Federation forwarding and contains no machine identity.
The renderer ring also records effect setup/disposal, demand changes, pending
reuse, invalidation, cancellation, and page-size/cursor recovery. A logical
read can legitimately issue several pages. Stable semantic demand ignores
all diagnostic metadata.

Do not group by `view` alone: every renderer can have view 1. Group main IPC
requests by `(origin, sender, view, effect)` and match the renderer snapshot's
`origin` before counting its requests. One capture's main ring can contain
several windows. The November 18 capture on 1.4.10 contained 60 main IPC
starts from two origins: 45 from one window and 15 from the profiled window.
These were page reads, not 60 human navigation actions.

Renderer `invalidate` records include the allowlisted `trigger`, source,
numeric `batch`, and candidate resource `count`, including resources that
already owe a read or whose returned proof will resolve the notice. `refresh`
has its own batch, selected count and `invalidatedOnly` flag. Each `queued`
read receives a numeric `read` and `resource`. Its `dispatch` and `settled`
records include query kind, target scope, inventory, cause, trigger, the
invalidation batch that fenced the baseline (`batch`) and refresh batch
(`refreshBatch`). The aggregate `invalidations` count says
how many events collapsed before dispatch; preceding invalidation records
retain their sequence. Queue wait and API duration are separate milliseconds.
Attempts correlate with main through `(origin, view, effect, logical, attempt)`;
no new request fields are sent over IPC or Federation.

While monitoring, capture listeners count `scroll`, `pointerdown` and `keydown`
without inspecting event targets, key values or text. Adjacent same-kind input
within 100 ms shares one slot with `count`, first `at` and `lastAt`, without a
flush timer. Nearby interaction is correlation, not proof of a refresh cause;
a scroll anchor update alone performs no page read. Continuation and selection
recovery remain identified by their read causes.

The same view with a new effect number identifies an effect setup/cleanup
cycle, including development StrictMode replay. It is not by itself proof of
a defect: API replacement can also restart an effect. The StrictMode fixture
shows two setups, cancellation of the first before dispatch, and two distinct
queries from the surviving effect (`directory-index` and `lens`). An unchanged
rerender sends neither again. Other navigation consumers retain their typed
consumer/query/read-reason attribution at IPC; absent lifecycle/trigger fields
mean unknown, not an inferred StrictMode duplicate.

Invalidation metadata contains a fixed cause category and an allowlisted
protocol method (for example `turn/completed`). Later coalesced notices retain
their own invalidation records. If a seen notice during a child membership
read requires another page, that replacement carries the seen trigger.
Main invalidation events retain the individual method sequence.
Refresh reads also carry `diagnostic.caller` through IPC into main's `caller`
field, independently of the event in `trigger`. For example, a read can have
`caller: scheduled/thread-lifecycle` and `trigger: turn/completed`. The first
caller queued for a physical read remains attached to its retries; a later
coalesced replacement has its own caller. The renderer records it on both
`refresh` and `dispatch`, so main-only captures no longer need the initiating
renderer event to interpret it.

`navigation/refresh` identifies the public generic refresh entry point; it
does **not** prove that the operator clicked Refresh. Known PR-detach,
messaging-unbind, remote-pin, reply, automation, and scheduled lifecycle paths
supply explicit fixed labels. Missing labels in older captures remain unknown.
No request scope, event fencing, or provider page policy is changed by a label.

Sidebar and project-card periodic refreshes explicitly say `timer`; project
and sidebar owner notifications retain their cause. No payload, title, prompt,
path, raw thread ID, owner ID, or exception message is copied into this history.

## Bounds and cost

The main ring holds 4,096 events; each renderer holds 1,024. Snapshots exclude
events older than 120 seconds. Appending overwrites one slot in O(1), without
serializing a request or scanning retained history. Each append serializes
only its small scalar record. `recorded`, `overwritten`, and main stage/phase
totals count the current enabled monitor interval. Adjacent input coalescing
increments the slot's `count`, rather than appending another event. A busy
interval can overwrite causal events: a missing `targetId` event is not proof
that no work ran. Do not use monitor-lifetime totals as trigger-window counts.

Promise identities use weak references. Diagnostic records contain only fixed
vocabulary, bounded opaque tokens, booleans, and numbers. Reading a renderer
ring makes one CDP call per saved profile, with a one-second deadline. A closed
or unresponsive renderer yields `rendererListings: null` and preserves the
main history and CPU artifact. This optional read can delay the save by up to
that deadline; it never runs on event append.

Federation traffic tests include the diagnostic metadata in their request-byte
budgets and expose its contribution as `diagnosticBytes`. They charge diagnostic
counters at maximum safe-integer width, so process lifetime and digit transitions
cannot change a snapshot. Cause/trigger strings and every other field remain in
the measurement; adding metadata still raises the checked-in budget.

Checked-in regression budgets:

| Scenario | Recorded events / executions |
| --- | --- |
| Eight concurrent consumers, 500 provider rows | 11 events; one provider scan and one RPC |
| Three logical IPC reads; two overlap and the third reuses the index | 24 events; two owner loads and one index construction |
| StrictMode sidebar mount plus unchanged rerender | At most 15 renderer events, including queue/settlement; two legitimate query dispatches |
| One invalidation and refresh of Q loaded queries | At most 3 summary/input slots + 3Q queue/dispatch/settlement records; Q API calls |

A macOS local run on 2026-09-28 measured 100,000 populated appends in 38.05 ms
(**0.38 µs/event**), 10,000 traced async operations in 14.16 ms
(**1.42 µs/operation**), and a full ring snapshot in 0.42 ms (780,519 serialized
bytes). These microbenchmarks measure instrumentation, not an application CPU
improvement. CI checks event counts and storage bounds rather than a flaky
wall-time threshold. There are no stack captures or per-row events.

A native macOS arm64 / Node 26.12.1 run on November 17, concurrent with
validation, measured serialized records at 2.23 µs/main append and
1.05 µs/renderer append (100,000 populated records each). Full snapshots
parsed 4,096 main slots in 2.33 ms (858,358 serialized bytes) and 1,024
renderer slots in 0.96 ms (469,141 bytes). These measurements
describe instrumentation cost, not a packaged CPU improvement. The renderer
test enforces a 768 KiB populated snapshot bound.

To reproduce the local timing report from the repository root:

```sh
mkdir -p .local
PWRAGENT_LISTING_DIAGNOSTICS_BENCHMARK=1 pnpm test apps/desktop/src/main/__tests__/listing-diagnostics-budget.test.ts
cat .local/listing-budget.json
```

No general duplicate-dispatch defect or percentage speedup was established by
this change. The records supply the evidence needed for the next live capture.
