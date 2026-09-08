# Federation navigation read protocol: replacement contract

Status: the V2 query and independent detail APIs and renderer migration are
implemented in #2001. The bounded read budgets and lifecycle regressions are implemented.
Operator acceptance and CI completion are tracked separately from implementation;
this document defines the protocol contract.

Local snapshot IPC rejects both raw and V1 transport requests. Incoming Federation
snapshot methods reject, and the outgoing runtime no longer fetches full snapshots
or retains their revision caches. New instances do not advertise snapshot-delta
support. Navigation requires protocol 2 on the owner and each serving route;
unsupported peers receive an upgrade error. V2 event selection is negotiated
independently of the retired snapshot capability.

The measured 115 MB/hour incident used pre-#2001 code. Thresholded logs attribute
81,950,662 uncompressed bytes to 41 locally sourced navigation responses; they
do not identify their consumers or distinguish full responses from deltas.
This motivates fixing remaining broad readers, not attributing the incident to
code that was not running.

## Separate the data contracts

`NavigationThreadSummary` is not an acceptable wire index contract. In addition
to row metadata it carries optimistic message text/images, queued-turn summaries,
questionnaire and failure logs, permission/binding logs, and other detail state.
Optional TypeScript fields do not make those fields inexpensive or safe to omit
without migrating their consumers.

| Read | Owner response | Must not include |
| --- | --- | --- |
| Directory index | Paged directory identities, labels, availability, authoritative membership/attention counts, directory ordering, launchpad existence/backend | Every thread ID, thread rows, launchpad environment output, transcript or queue payloads |
| Lens rows | Owner-filtered, ordered page of explicit navigation-row records, total/count revision, continuation | All rows for viewer-side filtering, detail-state spreads |
| Directory rows | Requested directory's pinned/root order (all, pinned, or unpinned), ten roots initially, bounded continuation; children use an independent parent query in owner tray order | Collapsed unrelated directories' membership or rows |
| Exact rows / descendants | Requested identities and owner-computed descendant closure, retaining foreign owner identity | An entire owner's navigation snapshot to discover children |
| Model inventory | Paged owner/backend model and migration-revision groups with thread/Fast counts | Thread rows, titles, transcripts, prompts or launchpad contents |
| Selected-thread detail | Requested thread's authoritative configuration and bounded detail collections | Other threads' details; treating a navigation placeholder as admission/configuration authority |
| History / large item | Existing provider-owned history cursor plus an explicit byte-aware item retrieval path | Silently discarded oversized text/images or synthetic cursors that cannot retrieve omitted data |

Use allowlisted row fields and a distinct row type, not a spread of an overlay
followed by deleting today's known large fields. A new overlay field must not
silently expand navigation traffic. Thread detail and history stay separate:
moving all overlay logs into one new unbounded detail response is not completion.

## Query and revision semantics

`NavigationQueryRequest.inventory` defaults to `owner`. The local main viewer
uses `viewer` to include its own mounted remote-thread membership and pin ranks.
Inventory is part of the canonical query identity. Federation rejects viewer
inventory; an exact remote row or selected-detail read always uses its owner's
inventory. Visible mounts acquire bounded owner-row queries, while an off-page
selection independently resolves its local viewer mount and remote configuration.


- An explicit read version identifies this contract. Keep it separate from
  Noise framing, invitation versions, and authorization capabilities. Wire
  support negotiation must not require changing existing permission grants.
- Every read identifies its resource/query, fixed consumer class, bounded page
  size, and optional complete-baseline revision or opaque continuation. Consumer
  classes are a finite enum, not thread IDs or free-form strings.
- Filtering, sorting, pin order and descendant selection run on the owner. A
  gateway forwards the request and original deadline; it does not enumerate,
  filter, or rank another owner's collection.
- A continuation is bound to the authorized requester, resource and canonical
  query, and identifies an immutable read generation. Concurrent owner activity
  cannot shift offsets between pages, duplicate rows, or skip rows. Cursor
  expiry is explicit; it never silently substitutes a different generation.
- An unchanged response is valid only against the viewer's complete baseline
  for that exact query. A partial cold page, optimistic edit, or different lens
  cannot authorize unchanged. Volatile fetch/probe clocks are not row changes.
- Counts and pages identify their generation. Do not combine counts from one
  generation with rows from another and call the result complete.
- The per-message application budget is 100 records / 256 KiB, including its
  result wrapper with reserved envelope space. A socket ceiling or a row count
  alone is not a pagination/memory budget. The implementation must enforce the
  following budgets, not merely document them:
- Oversized individual records have an explicit retrievable detail/blob path or
  a typed error. Never silently truncate identity, instructions needed for an
  action, queued input, or history to satisfy a byte ceiling.

| Resource | Required bound / terminal behavior |
| --- | --- |
| Serialized page including wrapper | Result at most 252 KiB; 4 KiB outer envelope reserve is inside the 256 KiB total, not additional |
| Rows per page | 100; detail/blob continuation for an individually oversized record |
| Request selectors / nested row records | At most 100 exact identities/disclosures per request; nested chip arrays and UTF-8 strings count against the same page bytes and expose continuation/detail availability |
| Immutable owner generation | Stable owner-backed range/membership metadata, not a serialized copy of the whole collection. The existing 16 MiB/256-page replacement cap is not a cap on reachable Inbox/Recents threads |
| Owner cursor pool | At most 8 retained generations and 32 MiB backing, process-wide. Evict superseded generations first, then least-recently-used cursor backing. An evicted cursor returns a typed expiry; fresh query admission is not blocked by abandoned cursors |
| Cursor lifetime | 60 seconds idle; eviction/expiry returns `cursor_expired`. Resume via explicit rebaseline and seek around the visible anchor; deep browsing must remain reachable after human pauses |
| Viewer retained query pool | At most 8 materialized queries / 64 MiB serialized-equivalent per process, shared across windows/owners. Queue additional active reads. After a read settles, its duplicate process-cache copy may be evicted; the renderer retains its displayed pages and owner cursors. Mounted consumer leases remain charged separately and do not pin idle duplicate backing. Never evict an in-flight read. Exact detail, FIFO, Attention order lifetime and user-owned drag state are separate resources |
| Geometry / Attention metadata | Separate measured process-wide retained and transient budgets required before enabling these resources; page-cache limits do not bound their membership/order backing |
| Remote reads | At most 8 active peers; one in-flight read per canonical owner/query, coalesced across consumers |
| Operation deadline | One 10-second deadline per fetch transaction/page batch across queueing, relay and at most one cursor restart. Not a deadline for an entire human scrolling session |
| Idle reconciliation | At most once per 60 seconds for an active query, coalesced; unchanged result at most 1 KiB. Preserve slower existing cadences (including five minutes); this ceiling does not require more polling. Hidden/closed UI consumers do not poll |

A partial viewer can send `retainedRange` with its owner epoch, query revision,
start and retained count. `rangeUnchanged` acknowledges only that exact range;
it never sets the complete-baseline `unchanged` flag. The owner issues a fresh
continuation after cursor expiry when the same generation content still exists.
Changed content or an owner restart returns a normal bounded rebaseline. The
renderer keeps its existing range only after validating the acknowledgment.
This keeps idle reconciliation below 1 KiB without transferring unchanged rows
or requiring the viewer to load the whole collection first.

`NavigationQueryRequest.anchor` identifies a thread or directory for an explicit
rebaseline after cursor expiry. It cannot be combined with a cursor or an
unchanged-baseline revision. Owners seek within the new immutable generation;
a removed anchor returns `navigation_anchor_missing` instead of silently
returning the first page. `NavigationQueryPage.rangeStart` distinguishes a tail
from a complete collection baseline. The window query controller retains a
displayed range while rebuilding its admitted rows around the visible anchor.
An explicit Load more includes one additional page in that replacement. A
removed anchor requires an explicit restart; consumers must supply their visible
anchor when wiring the controller. Routine refresh rebuilds the displayed range
atomically rather than replacing a multi-page list with only its first page.

Count retained serialized backing explicitly; document and measure transient
decoding/projection allocations separately rather than describing a JSON byte
limit as a JavaScript heap limit. These are navigation budgets, not permission
to lower the existing history/blob limits and lose large user data.

## Renderer demand and correctness

The directory sidebar cannot switch to a partial `NavigationSnapshot` while
its consumers still assume that snapshot is the complete population.

- Lift explicit expanded-directory, child-disclosure and visible-page demand
  out of `DirectoriesList` and into the navigation read controller. Request only
  what can render, including the selected thread and its required ancestry.
- Owner counts replace global counts derived by iterating fetched rows. A
  collapsed directory needs its counts, not its complete `threadKeys` array.
  Global totals deduplicate ordinary thread identities across directories and
  exclude native worker rows. `active` and `review` (unread and idle) are exclusive
  Sidebar counts; Star Map `active` and `unread` can overlap. Peer coverage is
  checking/degraded/complete: an unanswered peer is not an authoritative zero.
  Directory removal/Mark read and pin/group mutations use owner membership and
  revalidation, never loaded-row length. Relative pin moves preserve unloaded pins.
- Keep Attention ordering per turn and owner membership changes, not per page
  arrival or `updatedAt`. Pagination must not reset ranks or remove an unread
  thread because its row has not arrived yet.
  Preserve the current per-window ordering lifetime: the main-process query
  owner ranks complete eligible metadata for that view, seeds once with today's
  initial order, then consumes membership/turn transitions. Include the view
  lifetime and promote-on-turn-end policy in its scope. Do not compare rank
  numbers from different owners. Page eviction, lens changes and reconnect do
  not reset ranks; owner restart/lifetime eviction requires explicit rebaseline.
- Draft presence and draft text remain local. Local draft/queued-reply stores
  must expose the identities needed for exact row reads independently of the
  fetched navigation population. Do not label those requests as drafts on the
  wire or federate their content.
  Store hydration distinguishes loading, failed, complete-empty and nonempty.
  Legacy backend/thread scopes do not prove a remote owner; retain explicit owner
  metadata and resolve ambiguous legacy scopes rather than guessing. Preserve
  existing machine-wide persistence and window-local draft visibility.
- Inbox and Recents retain access to all matching threads through continuation;
  a first-page limit is not a new maximum thread count. Preserve keyboard
  selection, directory pin ordering and foreign-child grouping across pages.
- Selected-thread actions wait for authoritative detail/admission state, rather
  than treating omitted fields in an index row as defaults or empty queues.
  A row must never enter the legacy queue projector: its `queuedTurns ?? []`
  semantics prune mirrors. Complete FIFO projection has its own revision and
  readiness, independent of row fetchedAt, configuration and history readiness.
  Independently owned background queue release survives hidden/closed UI demand.
- Cold peers publish independently. Per-peer partial versus complete readiness
  is explicit. Last-known rows survive transient disconnects; removal/revocation
  is distinct from an incomplete or failed read.
- Early Star Map anchors remain relative/provisional until initial geometry
  converges. Explicit user movement takes ownership immediately. Unrelated
  subscription changes cannot cancel an ongoing Star Map bootstrap.
  Complete compact project/cluster descriptors determine geometry and mass;
  fetched-card length and first-page arrival do not certify geometry coverage.
  Query placement distinguishes roots/children even when the parent is off-page.
  Selected identities, range anchors, draft identities and history survive page
  eviction; archive/deletion/access denial require explicit owner evidence.

## Subscription and idle behavior

Source-wide subscriptions are not a substitute for window demand. Navigation
invalidation/version signals may be broad and coalesced; transcript, queued
content and detail updates must be selected by the threads actually in use.
An invisible/closed consumer releases its interest without cancelling another
consumer's interest in the same resource.

`eventClassSelections` preserves class/selector pairs through aggregation, direct
owner delivery, gateway relays and renderer IPC. Missing classes in an explicit
map have no thread interest. Protocol 2 negotiation gates owners and routes;
unsupported alpha peers receive an upgrade error. Broad navigation notifications
carry compact invalidation metadata. Transcript, pending requests and selected
scheduled-action content belong to mounted consumers. Closing a card or hiding a
window releases its leases without cancelling another consumer's shared read.

`ComposerDraftStore.getDraftScopeKeys` and `getQueuedScopeKeys` enumerate local
scopes independently of navigation rows. Hydration distinguishes loading, ready
(including successful empty reads), and failed. Explicit owner identity and exact
resolution connect these scopes to complete independent FIFO projections;
background accepted queue release does not depend on visible navigation. Failed
or partial projections preserve mirrors. Draft text never crosses Federation.

Star Map's periodic reconciliation must use its bounded query and revision,
not unconditional full navigation. Remote windows must not subscribe to every
event class merely because the peer authorizes those classes. Reconnect resumes
an owned baseline when valid, or starts one bounded replacement; it must not
launch duplicate cold reads for each renderer consumer.

Instrumentation should classify method, direction, physical hop versus logical
endpoint, fixed consumer class and full/page/delta/unchanged result kind. Its
cardinality and numeric storage must be bounded, including an overflow bucket.
Do not retain payloads or add per-message filesystem/log/SQLite writes.
Read-only query/order state must add zero SQLite commits; no query-access or
event timestamp persistence. Existing measured placement writes are unchanged.

## Legacy deprecation and the 1.1 beta gate

Retired collection contracts:

- `backend.getNavigationSnapshot` and its v1 delta transport.
- `backend.getNavigationDescendantPage`; query pages now own membership reads.
- Remote `backend.listThreads`; search and exact resolution never fall back to it.
- Single-frame `federation.peerDirectory`; routes install from atomic bounded pages.

Rejecting handlers remain to give old callers an actionable upgrade error; they
never call the former collection implementation. Local owner inventory access is
still available for bounded projection and search. It is not a remote full-list API.

All participating viewers, owners and gateways must run this cutover before
operator acceptance across the Federation. Mixed alpha versions cannot provide
these guarantees and must fail explicitly rather than appear as empty inventories.

Regression coverage includes direct/gateway selection, reconnect and cancellation,
changed permissions, stale routes, cursor expiry/eviction, owner restart and
late canonical overlays. The source guard prevents modern renderer and exact
lookup consumers from restoring deprecated calls; RPC tests assert retired
handlers reject without invoking collection loaders. A future beta/stable release
must preserve these gates. Passing these tests does not replace live operator
acceptance or the PR's CI checks.

Required regressions include:

- `cold_navigation_fetches_only_visible_membership`
- `index_never_serializes_thread_detail_or_payload_fields`
- `directory_counts_do_not_depend_on_loaded_pages`
- `draft_and_queue_identity_survive_a_partial_cold_index`
- `selected_action_waits_for_authoritative_detail`
- `cursor_preserves_generation_during_owner_activity`
- `unchanged_requires_a_complete_matching_query_baseline`
- `idle_reconciliation_does_not_transfer_unchanged_rows`
- `reconnect_deduplicates_consumer_cold_reads`
- `modern_consumers_never_call_deprecated_collection_methods`

The existing [collection budget report](federation-collection-budgets.md) remains
the measured implementation and validation record. Operator acceptance is a
separate approval step; this PR must not be merged automatically.

### Selected historical collections

Exact configuration carries a count/revision manifest for historical arrays;
sub-agent records, native children, audit logs, worktree snapshots, branch-drift
pairs and child order are independently paged through selected-detail collection
requests. Each response remains at most 100 records / 252 KiB. The renderer keeps
configuration ready while these collections load under a separate lease, fences
late results by owner/selection sequence, and admits at most 8 MiB of retained
collection values. Collection failure is reported independently and does not
disable Send. No collection is silently truncated.
