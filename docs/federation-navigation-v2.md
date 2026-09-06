# Federation navigation read protocol: replacement contract

Status: implementation contract for the remaining work in #2001. The new
navigation API and renderer migration are **not implemented yet**. Existing
bounded project and descendant RPCs do not constitute this complete protocol.

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
| Directory index | Paged directory identities, labels, availability, authoritative membership/attention counts, directory ordering | Every thread ID, thread rows, launchpad environment output, transcript or queue payloads |
| Lens rows | Owner-filtered, ordered page of explicit navigation-row records, total/count revision, continuation | All rows for viewer-side filtering, detail-state spreads |
| Directory rows | Requested directory's pinned/root order and requested child disclosures, bounded continuation | Collapsed unrelated directories' membership or rows |
| Exact rows / descendants | Requested identities and owner-computed descendant closure, retaining foreign owner identity | An entire owner's navigation snapshot to discover children |
| Selected-thread detail | Requested thread's authoritative configuration and bounded detail collections | Other threads' details; treating a navigation placeholder as admission/configuration authority |
| History / large item | Existing provider-owned history cursor plus an explicit byte-aware item retrieval path | Silently discarded oversized text/images or synthetic cursors that cannot retrieve omitted data |

Use allowlisted row fields and a distinct row type, not a spread of an overlay
followed by deleting today's known large fields. A new overlay field must not
silently expand navigation traffic. Thread detail and history stay separate:
moving all overlay logs into one new unbounded detail response is not completion.

## Query and revision semantics

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
| Serialized page including wrapper | 256 KiB; reserve 4 KiB for its outer envelope |
| Rows per page | 100; detail/blob continuation for an individually oversized record |
| Immutable owner generation | 16 MiB serialized / 256 pages maximum; explicit budget error before publishing a partial replacement |
| Owner cursor pool | At most 8 generations and 32 MiB serialized backing, shared across readers rather than a history per filter string |
| Cursor lifetime | 60 seconds idle; eviction/expiry returns `cursor_expired`, never a substituted baseline |
| Viewer retained query pool | At most 8 materialized queries / 64 MiB serialized-equivalent per process; window owners reference the shared pool, not duplicate full baselines |
| Remote reads | At most 8 active peers; one in-flight read per canonical owner/query, coalesced across consumers |
| Operation deadline | One 10-second deadline across queueing, relay, pages and any single cursor restart; no per-page reset |
| Idle reconciliation | At most once per 60 seconds for an active query, coalesced; unchanged result at most 1 KiB; closed consumers do not poll |

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
- Keep Attention ordering per turn and owner membership changes, not per page
  arrival or `updatedAt`. Pagination must not reset ranks or remove an unread
  thread because its row has not arrived yet.
- Draft presence and draft text remain local. Local draft/queued-reply stores
  must expose the identities needed for exact row reads independently of the
  fetched navigation population. Do not label those requests as drafts on the
  wire or federate their content.
- Inbox and Recents retain access to all matching threads through continuation;
  a first-page limit is not a new maximum thread count. Preserve keyboard
  selection, directory pin ordering and foreign-child grouping across pages.
- Selected-thread actions wait for authoritative detail/admission state, rather
  than treating omitted fields in an index row as defaults or empty queues.
- Cold peers publish independently. Per-peer partial versus complete readiness
  is explicit. Last-known rows survive transient disconnects; removal/revocation
  is distinct from an incomplete or failed read.
- Early Star Map anchors remain relative/provisional until initial geometry
  converges. Explicit user movement takes ownership immediately. Unrelated
  subscription changes cannot cancel an ongoing Star Map bootstrap.

## Subscription and idle behavior

Source-wide subscriptions are not a substitute for window demand. Navigation
invalidation/version signals may be broad and coalesced; transcript, queued
content and detail updates must be selected by the threads actually in use.
An invisible/closed consumer releases its interest without cancelling another
consumer's interest in the same resource.

Star Map's periodic reconciliation must use its bounded query and revision,
not unconditional full navigation. Remote windows must not subscribe to every
event class merely because the peer authorizes those classes. Reconnect resumes
an owned baseline when valid, or starts one bounded replacement; it must not
launch duplicate cold reads for each renderer consumer.

Instrumentation should classify method, direction, physical hop versus logical
endpoint, fixed consumer class and full/page/delta/unchanged result kind. Its
cardinality and numeric storage must be bounded, including an overflow bucket.
Do not retain payloads or add per-message filesystem/log/SQLite writes.

## Legacy deprecation and the 1.1 beta gate

Deprecated collection contracts:

- `backend.getNavigationSnapshot`, including its opt-in v1 delta transport:
  an unchanged/delta path does not bound its complete baseline.
- Collection uses of `backend.listThreads`: replace enumeration with the
  appropriate bounded query; archive proof already has exact-ID lookup.
- `federation.peerDirectory` single-frame replacement: negotiated atomic pages
  exist in #2001; keep the compatibility branch only during alpha migration.

Deprecation is not removal. Existing alpha peers currently have legitimate
callers, and the new navigation contract is not yet available. Do not remove a
method before migrating and testing its callers. Equally, do not claim protocol
completion while a modern caller silently falls back to an unbounded method.

Before the first 1.1 beta/stable release:

1. Migrate local IPC, remote windows, Star Map, messaging browse/resolution,
   agent tools and pin caches to explicit read contracts. Review remaining
   skill/application/automation/control-plane collection methods for documented
   bounds; they are not implicitly exempt because they are not navigation.
2. Test the full direct/gateway matrix, including a reconnect during paging,
   changed permissions, stale routes, cursor eviction, owner restart and
   cancellation. Unsupported old alpha peers get an actionable upgrade result,
   not an unbounded fallback or a misleading empty collection.
3. Remove deprecated collection handlers and modern-client compatibility
   fallbacks once the matrix passes. Add a release check that fails if the
   retired methods are still registered for beta/stable. Do not manufacture a
   passing gate while replacements remain unimplemented.

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
the implementation-status record. This contract is not evidence that those
acceptance tests or migrations have been completed.
