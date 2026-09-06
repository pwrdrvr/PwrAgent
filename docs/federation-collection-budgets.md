# Federation collection reads and completion criteria

This describes current code after the bounded-search work in #1982 and the
collection/browse follow-through. It is not a claim that all Federation traffic
is bounded to one small response, or that navigation is now a lazy directory API.

## Implemented boundaries

| Initiator / owner operation | Transfer boundary | Cold / warm behavior | Completion |
| --- | --- | --- | --- |
| Agent `list_instance_projects`, `create_instance_thread` → collection client → `backend.getProjectPage` | At most 100 projects and 256 KiB JSON result per page; no thread rows or directory thread membership | Owner uses #1982's cached read-only provider inventory and a non-persisting overlay projection. Pages still rebuild the metadata projection. Viewer requests successive keys; creation requests its exact project key. | One 10-second deadline across pages. Repeated cursors fail explicitly. No silent truncation of one oversized project. |
| Known thread / missing remote pin → `backend.lookupArchivedThreads` | Exact backend and at most 100 IDs per request; response at most 256 KiB, explicit summary fields only | Owner uses the read-only archived candidate inventory. Pin cache records which IDs a negative answer actually covered. Positive archive evidence is revalidated before pruning a re-added pin. | Shared RPC deadline across batches. Absence/failure is not proof of archival. |
| Messaging `/resume` and `/agent` → desktop navigation bridge | At most three publications: local, one early peer aggregate, final. Slow provider edits coalesce arrivals. | Eight concurrent peer reads; existing remote navigation full/delta cache remains in use. Next admitted conversation action invalidates late publications. | One 10-second remote deadline, pending/failed counts shown. Non-progressive callers still await the complete result. |
| Unknown thread owner discovery → target service | Exact active lookup, then exact archive lookup; eight concurrent peers | Explicit/remembered owner bypasses fan-out. Only unknown-owner discovery contacts all eligible connected peers. | One 10-second deadline covers active/archive and queued peers. Discovery must finish to detect duplicate owners; first response is not sufficient authority to route an action. |
| Selected remote thread / open Star Map chat card → `backend.readThread` | Optional opaque revision of the complete response; matching responses are tiny unchanged markers | First read still sends the complete bounded page. Unchanged catch-up reads reuse the viewer's exact owner baseline, not its optimistically edited live session. No additional owner replay cache. | Status, approval/input requests, pricing, text, and pagination participate in the hash. Existing provider cursors and full-page semantics are preserved. Older peers return ordinary full pages. |
| Star Map arrangement subscription / updates → existing merge notification | At most 100 entries per message, 256 KiB JSON budget with 4 KiB envelope reserve | Complete bootstrap is split; subsequent updates use the same partitioner. Tombstones are preserved. Identical reconnect pages make no row changes. | All partitions are constructed before sending, so an oversized entry fails explicitly. Receiver uses existing merge semantics; no protocol upgrade is needed. |

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
| High | Full remote navigation is metadata, but still a complete cold baseline. Pinned parents currently need a full owner projection to discover cross-instance descendants. New project pages do not make renderer navigation lazy. | A resumable, owner-filtered directory/descendant protocol must preserve attention/unread counts, pins, drafts locality, queued state, and cross-instance grouping. Add `cold_navigation_fetches_only_visible_membership` and `sparse_parent_selection_preserves_remote_descendants` regressions before changing those semantics. |
| High | Gateway `peerDirectory` is an atomic replacement snapshot broadcast to connections. Work is O(peers²); it must **not** use the merge-only arrangement partitioner. Its safety ceiling is the existing 16 MiB frame limit, not a 256 KiB application budget. | Introduce negotiated paged replacement with generation, bounded staging, expiry, and atomic commit, or a documented maximum supported directory. Test `incomplete_peer_directory_pages_preserve_previous_routes` and old-peer fallback explicitly. |
| Medium | Star Map arrangements now have a per-message bound, but complete history/tombstone bootstrap remains O(entries) in total bytes and owner memory. | A resumable acknowledged bootstrap or versioned delta baseline must retain offline tombstone correctness. Add `reconnect_after_tombstone_history_gap_does_not_resurrect_placement`. Do not prune old tombstones solely to meet a byte target. |
| Medium | Star Map layout/card restoration has readiness constraints beyond messaging's progressive picker. New messaging callbacks do not make every renderer consumer progressive. | Add `fast_peer_nodes_render_before_slow_peer_timeout` with saved layout/card restoration, stable identity, no disappearing nodes, and reconnect coverage before changing readiness gates. |
| Medium | A first selected-thread history page can still be multi-megabyte, and conditional reads still build/hash the owner response. | Measure actual card attribution first. Any byte-aware history API must preserve provider cursor ownership and access to oversized individual entries. Test large entry retrieval rather than dropping text. |

These are acceptance criteria for the same consolidated performance work, not a
proposal for twelve stacked PRs. They distinguish small wire-shape fixes from
protocol/readiness changes that should not be called complete merely because a
socket has a maximum frame size.

## Regression map

- `federation-collection-reads.test.ts`: page rows/UTF-8 bytes, exact selection,
  oversized item failure, batching, original relay deadlines, failure fallback.
- `federation-runtime.test.ts`: real owner project path (zero-write budget),
  arrangement subscriber isolation and lossless partitioning.
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
