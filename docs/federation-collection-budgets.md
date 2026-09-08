# Federation collection reads and completion criteria

This records the implemented #2001 cutover and its measured limits. The wire
contract is [Federation navigation v2](federation-navigation-v2.md). Implementation,
automated validation, CI, and operator acceptance are separate gates. All viewers,
owners and gateways used for acceptance must run the cutover build.

## Implemented boundaries

| Initiator / owner operation | Transfer and retention boundary | Readiness / failure behavior |
| --- | --- | --- |
| Main and native remote navigation | Distinct query pages, normally ten rows; at most 100 rows and 252 KiB per result. Authoritative counts and placement are independent of loaded membership. | Selection/history survive unloaded rows. Actions wait for exact owner detail; directory and relative pin actions revalidate on the owner. No partial snapshot adapter. |
| Main, Star Map and incoming peer queries | Shared process pool: eight physical reads, eight collection resources, 32 exact identities, 256 consumers and 64 MiB serialized backing. | Final release aborts the shared read; another consumer keeps it alive. An owner ignoring cancellation keeps its physical slot until settlement. Reconnect deduplicates and late canonical overlays invalidate stale reads. |
| Star Map rows and geometry | Ten-row Attention pages plus complete compact descriptor pages; explicit row continuation. Geometry and exact-card range stores each admit 8 MiB retained and 8 MiB in progress. | Per-owner geometry, row, detail and FIFO readiness. Disconnected rows remain visible; failed facets are unknown, not zero. Local and remote maps use the shared query pool. |
| Drafts and FIFO | Local scope enumeration and explicit owner identity; independent complete FIFO revisions, at most 100 entries / 252 KiB per page and 8 MiB per projection. | Draft text stays local. Partial/failed FIFO reads never prune mirrors. Accepted background release is independent of visible navigation. |
| Renderer event demand | Negotiated event-class selectors through direct owners and gateways; broad navigation invalidations contain compact identity/version metadata. | Exact transcript/pending/scheduled content follows mounted demand. Hidden/closed consumers release leases. No per-event filesystem or SQLite writes. |
| Agent project discovery and creation | At most 100 compact projects / 256 KiB per page. Explicit directory allowlist excludes thread membership, launchpad draft text and Git detail. | Cached read-only owner inventory; one ten-second deadline, exact project lookup for creation, repeated cursor/oversized item errors. |
| Exact archive proof and unknown-owner discovery | At most 100 exact archive IDs per request / 256 KiB. Unknown-owner discovery admits eight peers under one ten-second deadline. | Explicit/remembered owner bypasses fan-out. Duplicate owners reject. Negative absence or failure never proves archival. |
| Search, mentions and messaging browse | Bounded owner query/search APIs; local/early/final messaging publications coalesce under one remote deadline. | Old peers receive upgrade errors; no full-list or snapshot fallback. Late publications cannot replace a newer conversation action. |
| Selected history / open chat card | Existing bounded history page with opaque revision and tiny unchanged response. | First history pages may be multi-megabyte. Provider cursor and content semantics remain separate from navigation; no silent history truncation. |
| Gateway peer directory | At most 100 peers / 256 KiB per page; 256 pages / 16 MiB per atomic replacement; four staging sources, ten-second staging lifetime. | Keep old routes until replacement completes. Disconnect drops staging. Single-frame legacy directory rejects with an upgrade error. Total broadcast work remains O(peers²). |
| Star Map arrangement | 100 entries / 256 KiB per merge page, 256 pages / 16 MiB bootstrap. Owner reads SQLite in pages and caches an unchanged baseline for up to 60 seconds. | Backpressure, tombstones, cancellation and unchanged reconnect resume are preserved. Oversized history fails explicitly. |
| Scheduled projection | Independent complete V2 revision; 100 entries / 252 KiB pages, 8 MiB projection and one ten-second deadline. Shared exact-read admission and native-window-qualified leases. | Bypasses legacy outage cache. A cached tail cannot masquerade as a complete baseline. Close/cancel releases only that consumer; failed replacement preserves accepted state. |

Read-only query/order state adds zero SQLite commits. Budgets count
serialized-equivalent backing unless explicitly described as a heap measurement;
they are not a guarantee that JavaScript objects occupy the same number of bytes.
Owner generations retain compact index objects, with explicit admission limits,
rather than an unbounded serialized wire snapshot. Very large or oversized inputs
fail visibly; the protocol does not silently drop rows to fit a budget.

## What opening Star Map actually reads

`NavigationThreadSummary` extends `AppServerThreadSummary`, not a replay or turn
collection. Normal nodes consume summaries. `StarMapChatCard` mounts
`useThreadSessionState` for an open chat card and requests the initial history
turn limit. Local navigation also keeps transcript history separate.

A small turn count is not a small byte count: a single tool result can be large,
and the normalized replay can represent message text in both entries and messages.
The three observed 3,439,549-byte `backend.readThread` responses identify the owner
and method, but the old log lacks thread IDs. They cannot establish that all three
reads were the same card. New bounded diagnostics include thread ID and
`thread-view` / `star-map-card` attribution without logging prompt or replay text.

Conditional reads address identical retransmissions, not the first large page or
the owner's read/hash CPU cost. Existing replay fitting and the transport's
16 MiB frame ceiling remain in effect. This change does not lower that ceiling
and silently lose history to make a graph look better.

## SQLite write budgets

Checked-in scenarios use real SQLite instrumentation, excluding setup:

| Scenario | Commits | Changed rows | Observed WAL |
| --- | ---: | ---: | ---: |
| Cold + warm owner project reads | 0 | 0 | 0 |
| 1,001 new Star Map entries/tombstones in 11 pages | 11 | 1,001 | 490,280 bytes |
| Identical 11-page reconnect | 11 transaction completions | 0 | 0 |
| Owner reads 1,001 Star Map entries in bounded SQLite pages | 0 | 0 | 0 |
| Explicit resume: local + one coalesced remote publication | 10 | 10 | 156,560 bytes |

At 100 two-publication browse commands/day, the measured projection is about
15.7 MB WAL/day; there is no idle timer write. Each publication follows the
existing durable picker lifecycle (five commits in this fixture). A browse has
at most three publications, independent of peer count: local, one early aggregate,
and final. At that maximum and the same 100 commands/day, the projection is about
23.5 MB/day. This is an explicit operational cost, not a zero-write feature.

At ten bootstraps/day containing 1,001 **new or changed** placements each time,
the measured projection is about 4.9 MB WAL/day. Identical reconnects have zero
WAL growth. Per-entry statement count must not be confused with commit count.

## Acceptance and scope limits

The renderer cutover is implemented. Final acceptance must verify the operator's
Federation with every participating owner and gateway upgraded. Automated tests
and isolated live dev/work checks cover paging, selection, search, Star Map,
reconnect, and independent queue/detail behavior. Passing local checks alone does
not imply that GitHub CI has completed or authorize merging.

A first selected-thread history page can still be multi-megabyte. This protocol
bounds navigation collections and separates history demand; it does not redesign
provider history pagination. The isolated allocation measurement below reports
sampled heap growth for a 10,000-thread query scenario, not production-wide heap
accounting for every Electron renderer and IPC decoder.

### Group archive planning

Group archive discovery reads child-first `group-members` pages of ten rows.
The viewer index supplies discovery hints; each member's owner supplies its
current parent. Planning retains at most 1,000 compact identities and parent
relationships, 1 MiB, eight owners, and 32 ancestry levels, with one ten-second
discovery deadline. An incomplete, unavailable, expired, or over-budget read
fails before archive mutations begin. Each archive revalidates the expected
parent on its owner; an earlier successful archive stays suppressed if a later
member fails. Query reads add zero SQLite commits (0 MB/day added WAL).

### Group unlink planning

Unlink planning accepts at most 100 selected children across eight owners and
retains at most 1 MiB of exact child and parent configuration. One ten-second
planning deadline covers the lookups. Each parent pin lookup requests one exact
row from the window's pin owner, independently of the relationship owner.
Sibling order comes from exact parent configuration. Mutations compare the
expected parent inside the owner's SQLite transaction and require the
`thread_grouping` grant. Pin creation followed by a relative move preserves
unloaded pins; no renderer sends a partial complete-order vector.

`navigation-unlink-relative-pin` measures three commits for one pinned child:
unlink, pin, and relative placement. At 100 children/day and approximately
4 KiB/commit, this is approximately 1.2 MB/day. A rejected parent comparison
writes nothing. There are no timer or idle writes.

## Regression map

- `federation-collection-reads.test.ts`: page rows/UTF-8 bytes, exact selection,
  oversized item failure, batching, original relay deadlines, failure fallback.
- `federation-runtime.test.ts`: real owner project path (zero-write budget),
  arrangement subscriber isolation, resumed/completed bootstrap and cancellation,
  paged peer-directory sends and legacy upgrade rejection, atomic route publication.
- `federation-replacement-pages.test.ts`: incomplete, expired, duplicate,
  superseded and oversized replacements; disconnect cleanup.
- `federation-merge-bootstrap.test.ts`: warm resume, changed/expired baseline,
  retained tombstones and invalidated in-flight cache.
- `federation-navigation-selection.test.ts`: foreign descendant closure,
  cycles, UTF-8/row limits, revision consistency, and unsupported-protocol rejection.
- `StarMapScreen.test.tsx`: saved card restores after its owner is ready while
  an unrelated connected peer remains unresolved.
- `remote-thread-summary-cache.test.ts`: sparse negative coverage, re-added pins,
  non-blocking archive proof and failure retention.
- `federated-thread-target-service.test.ts`: bounded discovery concurrency,
  duplicate-owner rejection, shared active/archive deadline, upgrade rejection without full-list fallback.
- `desktop-messaging-backend-bridge.test.ts` / `messaging-controller.test.ts`:
  local/fast results ahead of slow peers, same picker, failed-peer disclosure,
  invalidated late updates, SQLite publication budget.
- `conditional-thread-read.test.ts` / `useThreadSessionState.test.tsx`:
  multi-megabyte unchanged marker, changed state invalidation, preserved contents
  and opaque pagination cursor.
- `sqlite-write-metrics.test.ts`: changed and identical Star Map bootstraps.

The common collection client owns deadline/upgrade rules for project/archive
consumers, and the merge partitioner owns arrangement page bounds. Replacement
snapshots, history pages, and progressive UI publication have different semantics;
do not collapse them into a generic helper that silently changes those contracts.

### Star Map compact metadata accounting

The renderer's geometry range store and exact-row range store each admit at
most 8 MiB of retained serialized-equivalent backing and 8 MiB of aggregate
in-progress backing, across local and remote owners in that renderer process.
Each store admits at most 256 consumer identities and pending ranges. Replacing
one owner's complete generation temporarily charges both the retained generation
and the new in-progress generation. Cancellation keeps temporary backing charged
until the read settles; cursor restart releases only the abandoned range's charge.
These counters are separate from the shared main-process 64 MiB query-page pool.
They measure serialized-equivalent backing, not JavaScript heap size.

Each result still obeys 252 KiB. The counters do not claim that a decoded
JavaScript object occupies the same bytes. The isolated owner construction probe below measures generation allocation
separately. It does not measure every renderer or queued IPC decode; eight physical
reads alone are not a production-wide heap guarantee.
`navigation-metadata-budget.test.ts`, `read-navigation-query-range.test.ts`, and
`navigation-query-pool.test.ts` enforce the accounting and physical admission
boundaries. `navigation-query-write-budget.test.ts` exercises the real overlay
read path and records zero SQLite commits for navigation query reads.

### Viewer pin index admission

The compact persisted-pin reader iterates rows and admits at most 8 MiB of
serialized projected rows. Each row is limited to 252 KiB and 100 linked
directories. It preserves all admitted directory memberships; exceeding either
limit rejects the read instead of returning a silently truncated index. These
reads make zero SQLite commits. The limits cover the returned index, not SQLite's
internal JSON parsing or JavaScript heap overhead. `remote-thread-pins-store.test.ts`
and `navigation-query-write-budget.test.ts` enforce these boundaries.

### Main-window paged state

`NavigationWindowQueries` drives the main and remote renderer paged state. It schedules every explicitly demanded resource with four concurrent reads,
admits at most 1 MiB of request metadata, and retains at most 8 MiB of serialized-equivalent accepted page backing. Each incoming result is
checked against 252 KiB before it is merged. Collapsing a resource releases its
main-process lease and page backing; hiding the window releases transport leases
while retaining its accepted display ranges. Replacement lifetimes use distinct
consumer tokens so late release cannot cancel the successor. The main renderer uses these distinct query resources. Process-wide IPC decode
allocation accounting is outside the isolated heap measurement below.

### Owner directory read action

`markNavigationDirectorySeen` resolves directory membership and per-thread seen
watermarks on the owner. It returns only the directory key and changed count;
renderer rows do not authorize membership. Checking/degraded provider coverage
and unresolved members reject before writes. The checked-in 100-thread scenario
commits once for 100 watermark writes; an already-read directory commits zero
times. At a conservative 4 KiB per changed row, this fixture projects about
0.4 MB per explicit action, or 4 MB/day at ten such actions, with no idle writes.
The owner publishes one directory invalidation after acceptance.

### Attention view lifetimes

Remote Star Map row retention shares an 8 MiB serialized backing budget across
all peer clouds in a renderer. Each explicit continuation reserves its cumulative
page backing before publication; rejection preserves the prior rows. Rebaseline
replaces the old range, and owner removal or view teardown releases its charge.
This counts serialized page backing conservatively, including page metadata;
it is not a measurement of JavaScript heap or garbage-collection latency.

The owner initializes unread watermarks once per profile after complete provider
discovery. This startup baseline admits at most 8 MiB of serialized metadata and
uses one SQLite commit. Subsequent queries and restarts make no baseline writes,
so its recurring write cost is 0 MB/day. The checked-in 1,000-thread budget uses
an in-memory database; its zero observed WAL bytes are not a disk-volume
measurement. Existing legacy unread state and explicit seen watermarks survive
initialization, and later off-page updates remain unread across restart.

The main process qualifies renderer view IDs into unique owner-visible lifetimes.
Its lease directory admits at most 256 views and 256 KiB of serialized key/value
backing, separately from query pages. Window teardown and explicit view release
remove the matching owner order and generations. Owner lifetime fences retain
at most 256 records / 256 KiB; closed records expire after 60 seconds and prevent
late reads from recreating released ranks. These operations add no SQLite writes.
Hidden views retain their Attention lifetime without polling. Releasing a query
page or changing a lens does not release the view.

Observed turn identities remain with their Attention member to reject replayed
boundaries after a later turn finishes. They count toward the existing aggregate
owner Attention byte ceiling and disappear when membership ends or the view
closes; they do not create a persistent turn history or SQLite writes.

### Independent FIFO read assembly

Each renderer FIFO read admits at most 128 pages and 8 MiB of cumulative
serialized page bytes for one complete revision. Every page must fit 100 entries
and the 252 KiB application response limit. The owner includes its continuation
cursor in that wire-byte check. Entries append into one private array rather
than copying the accumulated array for every page; only a complete revision is
published. Duplicate entries, an unchanged response for another owner, an expired
deadline, or budget exhaustion reject the read and retain existing queue mirrors.
One cursor restart shares the original ten-second deadline.

These per-read limits complement aggregate renderer metadata accounting and the
shared exact-read admission below. They are not measurements of JavaScript heap.
FIFO IPC has explicit consumer release and final-reference cancellation. Assembly
and validation perform no persistence writes.

### Shared exact-read admission

Incoming Federation query, detail, launchpad, and FIFO reads use the same process
pool as native windows. Authenticated requester identity partitions deduplication
and cursor ownership; two peers cannot share a retained result. Each RPC releases
its consumer on completion or cancellation. The final consumer aborts the shared
owner read, and a provider that ignores cancellation retains its physical slot
until it settles.

Main-process navigation admission now covers exact selected detail, launchpad
configuration, and FIFO pages as distinct result types. They share the collection
pool's eight physical owner-read slots, 256 consumer/pending-read limits, ten-second
deadline and 64 MiB serialized backing ceiling. Up to 32 exact identities are
admitted separately from the eight collection queries, so retained sidebar pages
cannot occupy every selected-configuration slot. Only the latest exact result is
retained for each identity; historical conditional revisions and queue cursors do
not accumulate. A released identity drops its backing as soon as its physical
read settles.

Consumer tokens are qualified by native-window identity. Closing one window does
not cancel another window's shared read; the final release aborts the owner read.
An owner that ignores cancellation retains its physical slot until completion.
Canonical navigation events invalidate matching owner/thread exact reads before
renderer refresh; streamed text does not invalidate them. A refresh never rejoins
an already-aborted read. Selected detail and launchpad configuration release on
selection change, hiding and unmount; FIFO assembly releases on completion or
unmount, independently of visible navigation. Completed exact results share only the current owned identity; final release
drops backing. Process-wide decoded heap is not inferred from byte accounting.

### Star Map owner readiness

Remote Attention rows, restored/open card identities, and complete compact
geometry have independent backing and readiness. A slow geometry read does not
block rows or cards. Geometry errors retain prior descriptors and offer retry;
camera restoration waits for both row and geometry operations to settle.
Connection generations belong to each owner, so reconnecting one owner does not
restart another owner's pages or pending cards. Query leases release on close,
hide, disconnect and completion; card leases also release when demand changes.

Modern facet totals come only from owner responses with complete coverage.
Loading, degraded, unauthorized and disconnected owners remain unknown in the
filter controls, including accessible names and hover cards. Known local counts
remain visible when remote counts are unavailable. Unknown counts do not cause
zero-count filters to disappear. Complete metadata range reads reject incomplete
coverage, uncertified unchanged replies, oversized wire pages and responses that
arrive after their original deadline.

### Compact event and scheduled projection cutover

Broad remote navigation subscriptions now carry `navigation/invalidated` with
bounded identity fields. Turn output, queue input and configuration payloads
remain in exact transcript/scheduled-action subscriptions. The direct/gateway
regression sends a multi-megabyte off-page turn and verifies a sub-1-KiB
navigation frame, then verifies the selected thread receives its full result.
Native remote windows retain navigation demand only. Each mounted FIFO reader
owns a distinct event consumer, including off-page queued scope owners, and
releases it on unmount. FIFO baselines share 8 MiB retained and 8 MiB transient
serialized-equivalent budgets per renderer process.

Scheduled renderer projections request protocol 2 pages: at most 100 actions
and 252 KiB per response, 128 pages and 8 MiB per complete generation. Owner
reads stream a metadata digest, admit at most 8 MiB of metadata before payload
hydration, and stat immutable payload files before decoding them. A changed
revision expires the cursor; a renderer rebaselines once within its original
10-second deadline and publishes only a complete generation. Concurrent
refreshes coalesce. Failed/partial reads retain existing mirrors. Scheduled
projections share an 8 MiB retained/transient renderer budget; retained failed
actions remain charged across terminal-watermark windows.

The renderer no longer polls scheduled payload lists every five seconds.
Canonical events refresh demand. The scheduler's existing ten-second owner
heartbeat observes SQLite `data_version` for cross-process changes, compares
compact scheduled metadata only after a version change, and emits a compact
invalidation when needed. This observation does not write SQLite or load
scheduled input files. The 205-action paging and observation regression records
zero commits, or 0 MB/day added WAL. These are serialized backing budgets, not
an assertion about the JavaScript engine's total heap usage. Legacy explicit
control-plane list callers remain separate from renderer projection reads.

### Scheduled projection transport ownership

V2 scheduled pages bypass the legacy outage cache. A cached final page can never
be returned as a fresh complete generation after disconnect. Renderer mirrors
remain authoritative until another complete generation has been read.

Scheduled projections now share the main-process query pool's eight physical
read slots, 32 exact resources, 256 consumers and 64 MiB result backing budget.
Consumer identities include the native window. Closing a hook or window releases
its interest; another window keeps a shared read alive. The final release aborts
the RPC, and non-cooperative work retains its physical slot until settlement.
The original ten-second transaction deadline crosses IPC, owner RPC and page
continuations. The renderer also rejects a hung transport at that deadline.
No additional SQLite writes are introduced.

### Owner generation allocation measurement

Generation fingerprints stream canonical JSON one record at a time. They retain
the same SHA-256 revision and serialized-equivalent backing count without a
whole-collection JSON string. A regression rejects serializing a collection while
fingerprinting it.

An isolated Node 24 probe on 2026-09-07 traversed 10,000 contrived threads in 100
pages. The largest response and largest single serialization were 53,199 bytes.
After GC, the retained heap increase was 7,519,176 bytes; heap sampled around
serialization peaked 28,423,584 bytes above the seeded baseline. Process peak
RSS was 105,968 KiB. Before streaming, the same probe made a 5,254,635-byte
serialization, sampled a 37,321,528-byte heap increase and reached 133,776 KiB RSS.
These measurements are distinct from enforced serialized-backing admission
budgets. Sampling does not establish a bound on all V8 allocations or all
simultaneously mounted application resources.

### Star Map project continuation and transcript hydration regressions

The orbit renderer now seeds every project cloud from the owner's complete compact
geometry, including projects with no card rows loaded yet. Card discovery uses
`star-map` queries scoped by primary `projectKey`: ten rows per project initially,
then explicit continuation for that project. The window query controller schedules
four reads at a time and admits 8 MiB of retained project-page backing and 1 MiB
of request metadata across owners. It uses the existing shared main-process pool;
each response still fits 100 records / 252 KiB. No transcript or image is fetched
for a closed card. These are serialized backing limits, not a heap measurement.

The first displayed card anchors recovery after owner cursor eviction, so loading
another page does not discard earlier cards or prematurely exhaust continuation.
A remote owner that returns rows outside the requested project produces an upgrade
error instead of an incorrectly populated project. Participating owners must run
the project-selector implementation for acceptance.

The 15-project, 23-card-per-project regressions cover local and remote renderer
paging and owner projection/stamping. The Electron regression exercises the real
eight-generation cursor pool, three pages, and retention of all project clouds.
These query and renderer changes introduce no SQLite writes: 0 MB/day added WAL.

Transcript regressions cover exact bottom-follow through asynchronous layout and
intentional scrolled-up restoration. A contrived partial GIF-only echo exposed a
separate reconciliation defect: a submitted GIF+PNG presentation now survives
until the complete authoritative image set arrives. Real Electron decoding tests
verify both in-view thumbnails before completion and afterward. This does not
establish that partial echo caused the operator's live missing-PNG observation;
that live cause remains an acceptance question.

Selected-child reveal uses the exact owner's ancestry, not directory membership
in partially loaded summaries. Exact selection can supplement the displayed
child and its pinned ancestor without replacing pin or sibling cursors. A
supplemented pinned parent has the same bounded child-page demand as a parent
in the loaded pin range; collapsed or unrelated collections remain excluded.

Canonical collection events update the retained selected-detail collection cache
before configuration revalidation. This prevents a fresh Token Miser subagent
from appearing on its turn card and then being erased by the older cache while
replacement history pages load. The isolated regression reproduces the rollback
without HMR and verifies retention through authoritative collection completion.
The existing collection budgets and persistence behavior are unchanged.

### Star Map foreground demand

Star Map is active only when its document is visible **and** has window focus.
Blur pauses local/remote navigation, per-project pages, geometry/exact reads,
open-chat detail/queue demand, federation health refreshes, and load-card polling.
Cached cards and geometry remain mounted. Returning to the foreground refreshes
retained demand once; duplicate focus/visibility events do not start extra reads.
Query consumer tokens change across suspended lifetimes so a delayed response or
release cannot resurrect or cancel a successor query. Load polling schedules its
next eight-second sample after completion and ignores samples from old lifetimes.

Project invalidation uses the event owner, then an explicit directory key or a
known card's project where available. Membership changes and unknown thread IDs
refresh that owner's projects. A local event never refreshes remote projects.
The sixty-second reconciliation timer runs only while the map is active.

The isolated request-count fixture measures only Star Map demand, excluding
heartbeat and ordinary navigation. With two remote owners and three projects,
initial admission and focus restoration each make seven navigation reads (three
project pages, two row pages, two geometry pages) plus one open load-card read.
Thirty events during two minutes blurred-but-visible, followed by one minute
hidden, produce zero additional map reads. Twenty coalesced events for a known
card produce one project read plus that owner's two metadata reads; unrelated
owners produce zero. Pending project and remote geometry responses cannot restore
old continuations after blur/resume. These are application read counts, not live
wire-byte measurements, and do not attribute the operator's aggregate traffic.
No persistence was added: 0 SQLite commits and 0 MB/day additional WAL.
