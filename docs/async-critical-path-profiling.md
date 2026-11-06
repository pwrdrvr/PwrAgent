# Async critical path profiling

The November 3, 2026 static audit had no runtime measurements. A committed,
test-only baseline (`c00dd4e98`) ran before production scheduling changed. The
final comparison uses identical fixtures on the original source (`4acf0f208`)
and changed source (`de652c9b2`). Both runs used Sandboxer `sb_ju8rhtxsha`, an
Ubuntu x64 large VM, Node 24.22.1, and pnpm 12.13.0.

These are controlled runtime dependency experiments, not production latency
measurements. Cold is the first request on a fresh registry; modules are already
loaded, and OS caches are not cleared. Warm is the median of three subsequent
requests using the same registry, database, and caches. Each scenario has its
own registry. The SQLite store and registry execute real code; external service
latencies are fixed fixture delays.

| Boundary (ms) | Before cold | After cold | Before warm | After warm |
| --- | ---: | ---: | ---: | ---: |
| Submit → registry acceptance | 254.2 | 77.8 | 225.2 | 78.0 |
| Submit → provider `turn/start` acceptance | 250.4 | 75.2 | 222.1 | 74.5 |
| Submit → first-token marker | 311.3 | 136.1 | 282.4 | 134.2 |
| First send → registry acceptance | 505.6 | 201.3 | 460.0 | 168.4 |
| First send → provider `turn/start` acceptance | 501.0 | 196.0 | 458.6 | 167.0 |
| First send → first-token marker | 560.7 | 256.2 | 518.7 | 227.3 |
| Selected transcript request → response | 146.2 | 22.8 | 134.9 | 28.0 |
| Selected detail request → readiness | 246.8 | 64.3 | 0.9 | 0.9 |

The send fixture selects six independent MCP connections, each taking 30 ms,
with 25 ms config inventory, 20 ms model inventory, and 10 ms provider acceptance.
Two background threads are active before the first submit. Transcript reads
take 15 ms and encounter buffered usage from those threads and the selected
thread, 40 ms pricing publication per target, and two 20 ms optional repairs.
Detail reads cover twelve directories with 20 ms cold Git probes and a warm
fixture cache. Physical Git admission and coalescing are separately covered by
the existing `GitReadCache` tests; the fixed-delay fixture does not measure Git
process execution. The first-send scenario uses a local workspace and no
environment action. Worktree creation, environment command execution, and
network model latency are outside these figures.

The first-token marker arrives 60 ms after the fixture provider accepts the
request. Its timestamp is captured at arrival, independently of when the
registry finishes acceptance bookkeeping. It measures scheduling boundaries,
not a model's time to first token.

A separate click fixture drives the production session and selected-detail
hooks and timestamps their React readiness commits. Its fixed services return
the transcript after 15 ms and detail after 80 ms. It verifies that the two
observations are independent; it does not measure Electron paint, IPC, startup
module loading, or server work.

| Renderer boundary (ms) | Before cold | After cold | Before warm | After warm |
| --- | ---: | ---: | ---: | ---: |
| Click → transcript readiness | 18.4 | 18.4 | 0.8 | 0.9 |
| Click → selected-detail readiness | 84.4 | 83.1 | 81.4 | 82.2 |

## Scheduling and ownership

Transcript hydration awaits already-arrived usage derivation, the shared
batched durability chain, and replay supersession. Pricing publication has its
own chain, and per-thread publications serialize their fresh reads and emits.
A failed durability write prevents hydration and retains the retry batch.
Optional directory and native-worker repairs run in the background, retain
only the latest pending replay per thread, publish their existing updates, and
drain before shutdown closes the store.

MCP registration admits four independent connections at a time and preserves
selected order after per-connection failures. Config inventory starts once cwd
is known. Registration still enters the existing broker ownership checks;
missing isolation inventory still fails closed. The three capability helpers
continue to share the memoized server capability read and are not counted as
three RPCs.

Selected detail admits four linked-directory Git reads at a time through the
existing registry/cache path. Results retain input order, revision computation,
the 100-directory admission limit, and rejection behavior. Independent ancillary
reads can overlap asynchronous Git/stat work. Async SQLite wrappers still run
synchronous database work and do not create overlapping SQLite I/O.

Queued agent and permission changes settle before turn preparation. Runtime,
MCP, config inventory, input preparation, and model settings overlap according
to their data dependencies; PDF preparation waits for PDF bridge availability.
Independent branches drain on failure before the start reservation is released.
Attachment ownership admits four items while sharing a 128 MiB source-buffer
budget. The existing per-owner asset lock and immutable-copy validation remain
in place. Mutable files are read into an allocation bounded by their admitted
size and rejected if they grow or shrink. PDF and local preview loops keep
their existing per-turn budgets. Adapter input callbacks retain their ordering.

Provider/model inventory can overlap launchpad environment-option reads.
Workspace creation, environment setup, permission changes, lifecycle locks,
and resume-before-turn ordering remain sequential where required. Messaging
admission reads follow authorized media preparation so a completion during
media work cannot leave input queued against an earlier busy snapshot. The
owner's shared FIFO revalidates occupancy at dispatch and concurrent-start
refusals still queue the prepared input. Existing permission checks precede
dispatch.

A successful remote launchpad publishes its optimistic thread before viewer
draft reset, pin persistence, and subthread ordering. Pin persistence precedes
the order write; both precede refresh. Refresh rechecks selection ownership.
Draft recovery and persistence failure notices remain covered by hook tests.

## Diagnostics and reproduction

The existing `ListingDiagnostics` ring now carries `workflow` spans for
transcript, selected detail, submit acceptance, provider turn start, first send,
thread start, input preparation, MCP registration/inventory, usage durability,
workspace preparation, and environment setup. Starts and ends share an id;
`parentId` links dependent spans. Overlapping span durations must not be added
as though they were sequential.

The ring holds 4,096 events for 120 seconds and is included in existing main
CPU/profile diagnostic captures. Recording introduces no timer, logging, IPC,
or SQLite persistence. Additional SQLite write volume is 0 MB/day. No new
periodic, per-turn, or per-event database write was added.

Run the fixtures on the commit under test using the local or CI test route:

```sh
PWRAGENT_PROFILE_CRITICAL_PATHS=1 pnpm test \
  apps/desktop/src/main/__tests__/async-critical-path-profile.test.ts \
  apps/desktop/src/renderer/src/lib/__tests__/async-selection-profile.test.tsx
```

The fixtures print `CRITICAL_PATH_PROFILE` and `SELECTION_PROFILE` JSON samples.
They are opt-in and use real clocks without timing thresholds in correctness
tests. The final matching baseline is sandbox commit
`1c53843791e35ed0a4bfcc70ccd90e0157c9718c`, containing only the current timing
fixtures on the original production source. Both comparison runs passed all
three profiling checks (exit 0). The production changes at `1b46bc42f`
passed 2,458 focused correctness checks (exit 0, 42 s) and full lint, including
typed lint, type checking, and dependency boundaries (exit 0, 71 s).
