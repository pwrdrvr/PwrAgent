# Federation collection reads and completion criteria

This describes current code after the bounded-search work in #1982 and the
collection/browse follow-through. It is not a claim that all Federation traffic
is bounded to one small response, or that navigation is now a lazy directory API.

The remaining replacement contracts and pre-beta deprecation gates are defined
in [Federation navigation v2](federation-navigation-v2.md). They remain
implementation requirements, not completed migrations.

## Implemented boundaries

| Initiator / owner operation | Transfer boundary | Cold / warm behavior | Completion |
| --- | --- | --- | --- |
| Renderer/event consumers → desired subscriptions → direct owner or gateway | Per-event-class selectors prevent broad navigation from widening transcript/pending-request interest. Renderer IPC also checks each window's selection. | Reconnect replays the matrix; duplicate consumers merge within a class. Closing a consumer retains other demand. No per-event aggregate sorting or persistence. | Modern direct/gateway regression covers all-navigation + selected A, B transcript rejection, B navigation delivery, selection change, replay and cleanup. Old alpha gateways/owners may ignore the additive field and over-send; delivery filtering is not a mixed-version wire-byte guarantee. Remote windows still retain broad legacy navigation/scheduled-action demand. |
| Agent `list_instance_projects`, `create_instance_thread` → collection client → `backend.getProjectPage` | At most 100 projects and 256 KiB JSON result per page; no thread rows or directory thread membership | Owner uses #1982's cached read-only provider inventory and a non-persisting overlay projection. Pages still rebuild the metadata projection. Viewer requests successive keys; creation requests its exact project key. | One 10-second deadline across pages. Repeated cursors fail explicitly. No silent truncation of one oversized project. |
| Known thread / missing remote pin → `backend.lookupArchivedThreads` | Exact backend and at most 100 IDs per request; response at most 256 KiB, explicit summary fields only | Owner uses the read-only archived candidate inventory. Pin cache records which IDs a negative answer actually covered. Positive archive evidence is revalidated before pruning a re-added pin. | Shared RPC deadline across batches. Absence/failure is not proof of archival. |
| Messaging `/resume` and `/agent` → desktop navigation bridge | At most three publications: local, one early peer aggregate, final. Slow provider edits coalesce arrivals. | Eight concurrent peer reads; existing remote navigation full/delta cache remains in use. Next admitted conversation action invalidates late publications. | One 10-second remote deadline, pending/failed counts shown. Non-progressive callers still await the complete result. |
| Unknown thread owner discovery → target service | Exact active lookup, then exact archive lookup; eight concurrent peers | Explicit/remembered owner bypasses fan-out. Only unknown-owner discovery contacts all eligible connected peers. | One 10-second deadline covers active/archive and queued peers. Discovery must finish to detect duplicate owners; first response is not sufficient authority to route an action. |
| Selected remote thread / open Star Map chat card → `backend.readThread` | Optional opaque revision of the complete response; matching responses are tiny unchanged markers | First read still sends the complete bounded page. Unchanged catch-up reads reuse the viewer's exact owner baseline, not its optimistically edited live session. No additional owner replay cache. | Status, approval/input requests, pricing, text, and pagination participate in the hash. Existing provider cursors and full-page semantics are preserved. Older peers return ordinary full pages. |
| Cold remote pins → `backend.getNavigationDescendantPage` | At most 100 root IDs requested; at most 100 rows and 256 KiB per response. Owner computes descendant closure, including foreign-owned children, before transmission. | Shares the owner's canonical navigation revision. Viewer caches only the selected closure; owner still builds its existing full metadata projection. | One 10-second deadline, at most 256 pages / 16 MiB total. A revision change or non-advancing cursor fails without installing partial results or falling back to a full collection. Only method-not-found permits legacy full navigation. New-child discovery notifications remain source-wide. |
| Gateway peer directory → negotiated replacement pages | At most 100 peers / 256 KiB per page; at most 256 pages / 16 MiB per complete replacement | Receivers stage privately by source/generation and keep the old routes until every page arrives. Staging accepts no pages after its 10-second expiry; disconnect drops that source's staging. At most four staging sources. | Ordered pages, duplicate suppression, aggregate bounds, atomic route installation. Authenticated optional wire-format negotiation is independent of capability grants; old peers retain the complete legacy snapshot and its existing 16 MiB socket ceiling. Total broadcast work is still O(peers²). |
| Star Map arrangement subscription / updates → existing merge notification | At most 100 entries per message, 256 KiB JSON budget with 4 KiB envelope reserve; bootstrap at most 256 pages / 16 MiB | Owner reads SQLite in 100-row pages and shares one cached baseline for up to 60 seconds, invalidated by observed changes. Opted-in receivers retain a process-local cursor only after merging a page. Tombstones are preserved. | Reconnect resumes an unchanged baseline; changed/expired generations restart completely. Sends await backpressure; unrelated subscription changes preserve bootstrap ownership, while Star Map removal/route change cancels it. Old peers/gateways retain lossless merge-page fallback. Oversized history fails explicitly; tombstones are never pruned for the budget. |
| Star Map saved chat-card restoration | Per-owner readiness, not an all-peer barrier | A card appears after its owner's layout; its relative anchor remains provisional as slower peers change geometry. Explicit drag takes ownership immediately. Canvas anchors restore independently. | Camera restoration retains its separate final-geometry gate; this is not a claim that every layout operation is progressive. |

The new project/archive methods use the existing `thread_navigation` capability.
Requests go directly to a connected owner, or through the existing gateway relay;
the gateway does not perform project/archive filtering. It preserves the request
deadline. Neither collection method itself fans out. Unknown-owner discovery and
messaging aggregation own their fan-out in the initiating desktop process.

Only `method_not_found` triggers the old project-navigation/archive-list fallback.
Timeout, denial, malformed data, and ordinary handler failures must not expand
into a full collection read. Legacy fallback can still transfer a full collection:
mixed-version compatibility is explicitly not a small-payload guarantee.

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

## Remaining boundaries: do not mark these complete

| Priority | Current evidence / remaining work | Completion gate |
| --- | --- | --- |
| High | Main and remote directory sidebars still receive complete cold navigation metadata. Sparse remote pins no longer require that transfer, but their owner still builds its full projection. New project/descendant pages do not make renderer navigation lazy. | Introduce explicit window demand for expanded directories and visible rows, with authoritative counts and paging. Preserve attention/unread counts, pins, drafts locality, queued state, selected-thread ancestry, and cross-instance grouping. Add `cold_navigation_fetches_only_visible_membership` before switching the renderer to a partial population. The sparse-parent regression now exists independently. |
| Medium | A first selected-thread history page can still be multi-megabyte, and conditional reads still build/hash the owner response. | Measure actual card attribution first. Any byte-aware history API must preserve provider cursor ownership and access to oversized individual entries. Test large entry retrieval rather than dropping text. |

These are acceptance criteria for the same consolidated performance work, not a
proposal for twelve stacked PRs. They distinguish small wire-shape fixes from
protocol/readiness changes that should not be called complete merely because a
socket has a maximum frame size.

## Regression map

- `federation-collection-reads.test.ts`: page rows/UTF-8 bytes, exact selection,
  oversized item failure, batching, original relay deadlines, failure fallback.
- `federation-runtime.test.ts`: real owner project path (zero-write budget),
  arrangement subscriber isolation, resumed/completed bootstrap and cancellation,
  negotiated versus legacy peer-directory sends, atomic route publication.
- `federation-replacement-pages.test.ts`: incomplete, expired, duplicate,
  superseded and oversized replacements; disconnect cleanup.
- `federation-merge-bootstrap.test.ts`: warm resume, changed/expired baseline,
  retained tombstones and invalidated in-flight cache.
- `federation-navigation-selection.test.ts`: foreign descendant closure,
  cycles, UTF-8/row limits, revision consistency, and legacy-only fallback.
- `StarMapScreen.test.tsx`: saved card restores after its owner is ready while
  an unrelated connected peer remains unresolved.
- `remote-thread-summary-cache.test.ts`: sparse negative coverage, re-added pins,
  non-blocking archive proof and failure retention.
- `federated-thread-target-service.test.ts`: bounded discovery concurrency,
  duplicate-owner rejection, shared active/archive deadline, legacy fallback.
- `desktop-messaging-backend-bridge.test.ts` / `messaging-controller.test.ts`:
  local/fast results ahead of slow peers, same picker, failed-peer disclosure,
  invalidated late updates, SQLite publication budget.
- `conditional-thread-read.test.ts` / `useThreadSessionState.test.tsx`:
  multi-megabyte unchanged marker, changed state invalidation, preserved contents
  and opaque pagination cursor.
- `sqlite-write-metrics.test.ts`: changed and identical Star Map bootstraps.

The common collection client owns deadline/fallback rules for project/archive
consumers, and the merge partitioner owns arrangement page bounds. Replacement
snapshots, history pages, and progressive UI publication have different semantics;
do not collapse them into a generic helper that silently changes those contracts.
