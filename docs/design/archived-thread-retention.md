# Archived-thread retention: measured design recommendation

Status: **investigation complete**. The operator subsequently authorized the
[startup implementation](startup-storage-maintenance.md), including one-time
opt-in and a seven-day archive grace period. The measurements below describe
the original independent-copy experiments; they are not production benchmarks.
Measured 2026-09-27 at `9dddfffbe067622815df55f65bf7663db468384a` (current
`origin/main`, including squash-merged #2357). Measurements use a consistent
online backup of the operator's long-lived default PwrAgent database. Only
aggregate results are published.

**Recommendation:** keep archive restorable. Preserve overlays, relationships,
worktree restoration records, usage/accounting and retention generations by
default. Offer explicit removal of selected local tool-detail history as a
separate action. Run it in a separate database process, normally with a
five-thread ceiling, indexed table-by-table deletes, inter-batch yielding and
row slices for large threads. Permit ten threads only after measured feedback;
twenty is an upper limit for demonstrably small work, not the default. Treat
file shrinking and a fresh-database rebuild as separate maintenance operations.

The data supports that distinction: expiring archived search entries alone
freed **0.70 MiB**, whereas the explicit tool-detail experiment freed **79.04 MiB**
of pages while preserving overlays and accounting. A more destructive
owner-history experiment freed about **101 MiB**, but would break historical
accounting and restoration expectations. It is a cost envelope, not a proposed
deletion policy.

## Evidence, scope and reproducibility

The [aggregate measurements](archived-thread-retention-measurements.json) contain
52 independent-copy runs, table/index page inventory, discovery, migration,
concurrency, crash recovery, reclamation, startup and rebuild results.
[The harness](../../scripts/archive-retention-lab/README.md) gives exact commands.
During the investigation, no PR, production code change, live checkpoint, live vacuum, live migration,
file replacement or application shutdown was performed.

The source SQLite connection used `mode=ro` and `Connection.backup`, with 256-page
steps; it was closed immediately afterward. This captures committed WAL state,
unlike copying `state.db` alone. The backup took **0.52 s** and passed
`integrity_check`. Independent trials copied the closed, checkpointed prepared
backup, never the live database. The snapshot, IDs, logs and intermediate databases
remain in ignored, mode-0700 `.local/archive-retention/`; they must not be attached
to issues or PRs. No Codex-owned file was inspected. Codex discovery used only
`initialize` and paginated `thread/list` through App Server.

An initial PwrAgent metadata-search/status query preceded provider discovery.
Such application read APIs can refresh their own projections; this study cannot
certify that no ordinary application/cache write occurred. All **direct** access
to the live SQLite source was read-only backup access. The reproducible harness
avoids that preliminary PwrAgent search and sends no mutation API requests.

| Assumption or observation | Evidence / consequence |
|---|---|
| Snapshot size | 78,261 × 4,096-byte pages = **305.71 MiB**; only 2 free pages; schema 63; `auto_vacuum=INCREMENTAL` |
| Runtime used for deletion measurements | Node 24.18.0, repository `better-sqlite3` 12.11.1 / SQLite **3.53.2**, local macOS; not an Electron performance recording |
| Connection settings | WAL, synchronous NORMAL, foreign keys ON, **16,000 KiB cache**, cache spill enabled, secure-delete OFF; 32 KiB and secure-delete ON sensitivity runs included |
| Python backup/inventory SQLite | 3.53.4. Its default 2,000 KiB cache is **not** the benchmark runtime's 16,000 KiB default. Connection-local pragmas cannot be inferred from the DB header |
| WAL accounting | Actual frame headers, page numbers and commit markers; 4,096-byte page + 24-byte frame header. Repeated frames counted, not inferred from rows or commits |
| Checkpoint policy in deletion trials | Autocheckpoint disabled to retain complete WAL evidence; explicit checkpoint measured afterward. Current app normally autocheckpoints at 1,000 pages. These trials are an accumulated-write/lock comparison, not its normal steady WAL-file-size prediction |
| Timing | Wall time; writer lock measured from successful `BEGIN IMMEDIATE` to completed COMMIT. Acquisition wait recorded separately. p50/p95/max are across transactions, including no-op transactions |
| Physical interpretation | WAL bytes are actual SQLite write volume, not measured SSD NAND writes or fsync latency. Checkpoint writes to the main DB and vacuum writes are additional. OS cache/storage and load affect time |
| Repeatability | All trials start with byte-identical prepared database files. Matrix has one run per cell; preferred indexed 5/10/20-thread cases have three runs each. Cold/warm cache and host contention were not controlled; page counts were identical across those repeats |
| Limits | One real profile and one machine. ACP and unknown identities are inventoried but excluded from deletion cohorts. The 123 confirmed archived provider IDs without overlays are outside the 911-overlay cohort, not assumed empty |

### Eligibility and discovery cost

`thread/list` with `archived=true`, all source kinds, `useStateDbOnly=true` and
complete cursor traversal positively returned **1,034** archived Codex threads
in 11 pages / 0.122 s / 2.36 MB response JSON. The active scan returned **521**
in 6 pages / 0.055 s / 2.12 MB. Initialization plus both scans took 0.445 s.
Only IDs, archive state and timestamps were saved privately, not thread text.
The configured CLI environment used the default Codex home. Completeness refers
to that API/account scope, not every provider or historical storage location.

Of 2,499 Codex overlays, **911** matched positive archived evidence, **415**
matched active evidence, and **1,173** matched neither. There were no active/
archived conflicts. The last group is **unknown**, not deleted and not eligible.
There are 96 other overlays, including 21 legacy `grok` identities, and 104 ACP
sessions, 49 with a stored archive timestamp. ACP's authoritative PwrAgent session
API needs its own discovery path; stored counts here do not authorize cleanup.
All 2,595 overlay payloads were valid JSON and contained backend/thread IDs.

Only two Codex overlays carried archive tombstones. Search documents recorded
49 archived timestamps among 1,500 entries; search is a cache, not an archive
registry. Provider `updatedAt` is **not** an archive date. None of these facts
supports retroactively declaring the 911 threads older than a grace window.
Start a grace clock on the first positive observation when archive time is
unknown. Do not treat a capped listing, disconnected backend, changed account,
missing rollout, or search-cache eviction as proof of deletion.

Scanning overlay identities and computing owned-row logical sizes took 184 ms
off the main process. Optimized deletion also preloads FTS rowids/document keys
and enumerates accounting providers; its `lookupMs` is reported per trial.
These scans and provider discovery belong in a visible background job and must
be paginated/cancellable at larger scales.

### Where the pages are

These are table **plus index** allocations from `dbstat`, not JSON text sizes.
The full inventory includes all 75 snapshot tables, including five FTS shadow
tables. #2357 adds the 76th table.

| Table family | MiB, including its indexes |
|---|---:|
| `thread_tool_invocations` | 122.23 |
| `threads` | 39.44 |
| `thread_usage_lines` | 35.38 |
| `composer_draft_journal` | 24.70 |
| `token_miser_observations` | 22.57 |
| `token_miser_objects` | 21.66 |
| `thread_usage_turns` | 11.32 |
| `backends` | 11.15 |
| `thread_message_origins` | 2.73 |
| `thread_usage_boundaries` | 1.99 |

The 911 candidates own 59,654 tool invocations, 2,907 usage lines, 2,905 usage
turns, 2,299 usage boundaries, 3,083 Token Miser objects and 9,677 observations.
Estimated logical bytes per candidate: p50 **16,662**, p95 **307,228**, max
**1,720,124**. This estimate sums field byte lengths; it excludes SQLite record
headers and indexes and is not a physical-write estimate. Largest overlay across
the whole snapshot is 801,267 bytes. The ten largest eligible logical totals are
published without identities in the aggregate file.

The `backends` rows are also an outlier: three `lastSnapshotHash` values account
for nearly all 11.15 MiB despite only 16/275/241 known keys. These are retained
as existing snapshot state; this study does not opportunistically change them.
Draft history is another substantial allocation whose existing age/cap policy
is independent of archive.

## Existing lifecycle and retained-data dependency closure

Current entry points are
[IPC archive/restore](../../apps/desktop/src/main/ipc/app-server.ts),
[BackendRegistry](../../apps/desktop/src/main/app-server/backend-registry.ts),
[StateDb](../../apps/desktop/src/main/state/state-db.ts),
[the overlay store](../../apps/desktop/src/main/state/overlay-store-sqlite.ts),
[Token Miser](../../apps/desktop/src/main/token-miser/token-miser-store.ts), and
[thread search](../../apps/desktop/src/main/thread-search/thread-search-service.ts).

1. `BackendRegistry.archiveThread` calls the provider, invalidates listings,
   marks/flushes Token Miser retention, removes pending messaging intents and
   revokes bindings, ungroups active ordinary children using individual
   `setThreadParent` transactions, then handles worktree snapshots/cleanup.
   Missing-rollout handling records a local tombstone; it does not establish
   provider deletion. ACP archive stores `archivedAt` and emits archive events.
2. `restoreThread` calls provider unarchive, restores Token Miser availability,
   clears the archive tombstone and messaging-cleanup cache, and restores
   worktrees. ACP restore removes `archivedAt`. Neither path can reconstruct
   discarded user overlays, immutable accounting history, or deleted local
   tool-output evidence merely by listing the provider again.
3. #2357's `thread_navigation_relationships` projection is populated and maintained
   from overlay JSON by built-in SQLite triggers. Deleting an overlay deletes its
   **owned** projection; it does not remove incoming references in other parents.
   Rewriting every parent to remove a shared child would have very different cost
   and semantics. Mixed-version writers still author the payload.
4. Search upserts documents/FTS and prunes missing entries. That pruning is cache
   maintenance, not evidence that historical data is disposable. FTS and documents
   require explicit paired deletes; there is no FTS delete trigger here.
5. `initializeAppState` calls `StateDb.startGc` synchronously. GC runs immediately
   and hourly, in one transaction, then an **uncapped** `incremental_vacuum`.
   It does not purge general archived overlays/accounting. Legacy conversion to
   incremental auto-vacuum performs a full synchronous VACUUM after the sweep.
   Token Miser's present `prune(_params)` migrates legacy metadata into SQLite;
   its max-age/max-byte parameters do not provide ongoing SQLite retention.

The following closure covers every non-shadow table in this snapshot plus
#2357's projection. A new table must acquire an explicit classification before
selective rebuilding is allowed. Foreign-key validation alone is insufficient:
most dependencies are JSON, encoded keys or provider references.

| Tables | Classification and retention/dependency rule |
|---|---|
| `meta`, `secrets`, `desktop_config_snapshots` | Preserve all. Profile/version/migration markers and secrets are not thread garbage. Never copy secrets into diagnostics. Preserve migration sentinels to prevent old files being reimported |
| `threads`, `acp_sessions` | Durable restoration roots. Retain model/settings, pins, parents, managed children, handoff/fork provenance, PR associations, user reactions, worktree snapshots and archive receipts. ACP session payload is PwrAgent's source of truth. Keep `(instance, backend, thread)` identity boundaries and legacy storage encoding |
| `thread_navigation_relationships` | Rebuildable projection **only from retained complete overlays**, including incoming parent references. Retain projection and its view/triggers, or rebuild and validate equivalence before cutover |
| `backends`, `provider_thread_snapshots`, `provider_discovery_snapshots` | Provider/snapshot caches and compatibility state. Retain for offline availability or explicitly invalidate/rebuild through APIs. A missing provider must not erase the durable roots these caches mention |
| `launchpad_defaults`, `directory_launchpads`, `directory_overlay`, `remote_directory_overlay` | Durable user preferences and shared directory relationships. Preserve independently of any one thread |
| `composer_draft_latest`, `composer_draft_journal` | Durable recovery data keyed by scope, including thread scopes. Existing latest retention 180 days; journal 30 days / 300 rows after prefix-chain collapse. Archive is not permission to discard unsent drafts |
| `thread_search_documents`, `thread_search_fts` and its five shadow tables | Rebuildable metadata search. Delete paired docs/FTS entries or rebuild FTS from retained docs; never manually copy/prune FTS shadow tables. Lost providers make recovery incomplete, so expose unavailable results rather than infer deletion |
| `directory_git_status`, `thread_git_working_state`, `pr_status_cache`, `pr_lookup_cache` | Rebuildable, shared path/PR caches. `thread_git_working_state` is keyed by **worktree path**, not thread ID. Retain or invalidate by actual shared key, not archive joins |
| `acp_registry_cache`, `acp_installed_agents`, `acp_available_commands` | Registry/command cache and installed-agent state. Preserve installed-agent settings; available commands already expire after 90 days and empty payloads are removed |
| `thread_usage_turns`, `thread_usage_lines`, `thread_usage_boundaries`, `thread_pricing_summaries`, `pricing_catalog_versions`, `pricing_rates` | Durable historical usage/pricing and finalization guards. Keep the family, parent/child attribution and referenced catalog versions. Boundaries FK to usage lines with CASCADE; rates FK to catalog/version. A summary alone does not preserve turn detail or prevent older writers from re-attributing tokens |
| `thread_compactions`, `thread_message_origins` | Durable interpretation/provenance of transcript and accounting. Retain with history; neither is a disposable navigation cache |
| `thread_tool_invocations`, `thread_tool_invocation_alerts`, `thread_tool_analysis` | Historical diagnostic evidence. Analysis is only rebuildable while its inputs remain. Optional **explicit** tool-detail removal applies to the family and must handle overlay incident references/notice state and unavailable historical links |
| `token_miser_objects`, `token_miser_observations`, `token_miser_retention` | Objects/observations back replay/accounting inspection; historical links can reference them. Retain generation/archive fences even when detail removal is approved. Mark removed content unavailable. Do not clear fences and allow pending/older writers to resurrect data. This study does not reclaim external output files |
| `bindings`, `pending_intents`, `browse_sessions`, `callback_handles`, `deliveries` | Messaging dependency chain, not ownership by thread alone. Archive already revokes/deletes selected rows. GC expires browse/intents/callbacks, deletes deliveries after 30 days and revoked bindings after 90 days. Preserve active bindings and reachable callbacks/deliveries until their own policy permits removal |
| `messaging_managed_topics`, `messaging_thread_topic_links`, `messaging_topic_cleanup_proposals`, `messaging_default_agent_assignments`, `messaging_observed_surfaces` | Durable external routing and cleanup decisions. Archive cleanup must use messaging services. Keep records for other local/remote threads sharing a surface; DB deletion cannot remove an external topic safely |
| `messaging_activity_log`, `messaging_activity_summary`, `messaging_pairing_tokens` | Activity/audit and authorization state. Log cap 500 per platform; expired pending/observed tokens become expired, not thread-purged. Summary has its own lifecycle |
| `app_runtime_instances`, `messaging_runtime_lease`, `monitor_subscriptions` | Runtime ownership/subscription state. Preserve living owners and their fences. GC removes exited instances older than one hour and expires eligible leases. Do not steal ownership because a timer elapsed |
| `automations`, `automation_runs`, `automation_run_artifacts`, `scheduled_thread_actions` | Durable scheduled work/history. Runs FK to automation; artifacts FK to run. Live scheduled work blocks destructive cleanup until separately resolved. Preserve run/artifact closure and any referenced thread stub |
| `pr_auto_dispatch_claims`, `pr_auto_dispatch_incidents`, `pr_auto_dispatch_candidates`, `pr_status_watches`, `pr_auto_dispatch_budget`, `pr_auto_dispatch_budget_reservations` | Deduplication, authorization, spend limits and active PR work. Do not delete these with an archived overlay and accidentally reauthorize work. Terminal watch history expires after 30 days; active watching/dispatching rows survive |
| `federation_peers`, `federation_enrollment_tokens`, `federation_session_audit` | Federation authorization and audit. Preserve peer/enrollment state; session audit has a 500-row cap independent of archive |
| `remote_thread_pins`, `remote_thread_targets`, `star_map_arrangement`, `star_map_workspace` | Durable user arrangement, remembered remote identities and navigation references. Retain across disconnects. A local archive cannot authorize deleting a remote target |

For any explicit whole-thread erasure, first traverse **incoming** parent/group,
managed-child, fork/handoff, accounting-parent, automation, messaging, PR and
remote navigation references. Retain a minimal identity/tombstone for any retained
referencer, or obtain separate authorization to detach it through its owning
service. Do not delete parent history to make a foreign-key check green. Worktree
snapshot references also require validating their external files; a SQLite backup
alone is not a backup of those files or of provider transcripts.

## Deletion comparisons

The broad `owner-history` envelope removes only the selected thread's overlays,
navigation projection (trigger), search pair, usage family, tool family,
compactions, message origins, pricing summaries and Token Miser objects/
observations. It preserves Token Miser fences and shared/unrelated tables.
**It is deliberately not a complete permanent-erasure implementation:** incoming
references, drafts, routing, provider snapshots and external files remain. It is
not eligible to ship as-is. Every result passed SQLite integrity and FK checks,
which do not certify those application-level dependencies.

Initially, `(backend,thread_id)` deletes scanned provider-leading accounting
indexes; the partial usage read index excludes superseded rows and cannot serve
an all-status purge. The optimized version enumerates **all providers present**
and supplies the provider prefix, uses search document primary keys, and loads
FTS rowids once. It does not assume every Codex record is priced by one provider.
No production index was added. Candidate ordering, table ordering and cache
locality still affect both lock time and page reuse.

| Threads/transaction | Table-major, unoptimized, no yield: elapsed / p95 / max lock | WAL frames / unique pages | WAL MiB / commits |
|---:|---|---:|---:|
| 1 | 6.487 s / 9.6 / 16.6 ms | 90,914 / 26,226 | 357.2 / 911 |
| 5 | 3.032 s / 21.6 / 32.3 ms | 54,415 / 26,217 | 213.8 / 183 |
| 10 | 2.494 s / 35.5 / 41.7 ms | 44,820 / 26,213 | 176.1 / 92 |
| 20 | 2.190 s / 63.3 / 75.0 ms | 37,662 / 26,231 | 148.0 / 46 |

Thread-major interleaving at 20 had p95/max **126/145 ms**, with nearly the same
WAL. At 10, ordering candidates by overlay rowid increased WAL to **213.7 MiB**
from 176.1 MiB: overlay locality does not imply locality in the larger history
indexes. The 1-thread/thread-order run had a 217 ms outlier; since that ordering
is structurally identical to table-order for a single candidate, do not attribute
that outlier to the SQL order. Host/cache effects matter. Full 1/5/10/20 × three
orders × 0/5 ms yield matrix is in the aggregate JSON.

| Indexed table-major, 5 ms yield | Elapsed across repeats | p50 lock range | p95 lock range | Largest observed lock | Frames / unique / repeated | WAL MiB |
|---:|---:|---:|---:|---:|---:|---:|
| 1 thread (one run) | 6.375 s | 0.84 ms | 3.9 ms | 12.9 ms | 90,914 / 26,226 / 64,688 | 357.2 |
| 5 threads (three runs) | 1.522–1.584 s | 1.31–2.28 ms | 8.32–9.50 ms | 23.88 ms | 54,368 / 26,248 / 28,120 | 213.6 |
| 10 threads (three runs) | 0.972–1.013 s | 1.71–1.79 ms | 18.12–18.33 ms | 29.88 ms | 44,775 / 26,228 / 18,547 | 175.9 |
| 20 threads (three runs) | 0.636–0.650 s | 2.76–3.03 ms | 20.97–23.50 ms | 45.93 ms | 37,674 / 26,265 / 11,409 | 148.0 |

| Retention variant, indexed 10 / 5 ms yield | Elapsed | p95 / max lock | WAL MiB | Free pages MiB | Actual WAL commits |
|---|---:|---:|---:|---:|---:|
| Search cache pair only | 0.595 s | 1.4 / 6.9 ms | 10.77 | 0.70 | 92 |
| Retain overlays, remove broad owned history | 0.949 s | 16.2 / 21.5 ms | 166.56 | 85.74 | 92 |
| Explicit tool-detail family only, preserve search/metadata/accounting | 0.802 s | 13.1 / 18.5 ms | 126.52 | 79.04 | 49 |

The last case attempted 92 batches but only 49 wrote anything. A resumable
production ledger may make otherwise-empty progress batches write; commit counts
must include it. These trials do not hide that distinction.

### Giant threads, cache spill and secure-delete

The largest eligible logical thread alone wrote **1,392 frames / 5.47 MiB** with
secure-delete OFF, or **1,618 frames / 6.36 MiB** ON. Max lock was respectively
10.68/12.17 ms at 16,000 KiB cache and 25.82/32.26 ms at 32 KiB. A 20-thread,
32 KiB indexed run reached **99 ms** max lock. Neither row count nor transaction
count gives a safe physical budget. No extra repeated frames happened within the
single-thread cases; the full small-cache run wrote **37,702 frames / 26,265
unique pages** (11,437 repeats), versus 37,674 / 26,265 at the normal cache.
The extra 28 frames are measured, rather than presumed from cache settings.

An indexed **128-row-per-table** slice of that same largest thread, with one
progress-page update per committed slice, took 27 commits / 181 ms including
5 ms yields. Lock p50/p95/max was **0.90/2.00/2.58 ms**; largest slice wrote
213 frames (0.84 MiB). Total became **2,473 frames, 1,390 unique pages, 1,083
repeats, 9.72 MiB WAL**. That is a useful responsiveness/write-volume tradeoff,
not a proof that every 128 rows will fit. A single large overlay, long indexed
value or overflow chain can exceed the budget even at one row.

### Concurrent connections and crash behavior

Separate Node workers read the thread count or update one synthetic metadata
key every ~2 ms on the **copy**, with a 1 ms writer busy timeout. This intentionally
tests writer opportunity, not a model of user typing. Without yielding, the
writer achieved only 2–3 commits per run, with 104–191 busy failures. With 5 ms
yield, it achieved 479/239/125 commits for 5/10/20-thread batches; respective busy
counts were 126/103/102. Successful writer max latency was about 1.5 ms. Readers
had no busy failures; worst observed reader latency across these trials was
2.9 ms. Contended WAL totals include the probe's commits and cannot be attributed
entirely to cleanup.

A separately pinned read transaction prevented TRUNCATE checkpoint: 44,775 log
frames, zero checkpointed, busy=1 after 61 ms. Releasing it allowed checkpoint in
117 ms. Do not turn checkpoint starvation into synchronous retry loops or
unbounded disk growth. Pause new cleanup batches when the WAL budget is reached.

On another copy, SIGKILL before COMMIT left 24 spilled frames but **zero commit
markers**: reopening restored all owned-table counts and progress=0. SIGKILL
after COMMIT retained data deletion and progress=10 together (27 frames / one
commit). Resume processed the next ten and cancellation stopped at progress=20.
Integrity and FK checks passed. Recovery plus full integrity verification took
~0.40 s each; that figure is not SQLite recovery alone. This demonstrates process
crash atomicity, not power-loss durability, disk-full behavior or the correctness
of a future production ownership protocol. Cancellation was exercised at a
transaction boundary, not as a mid-statement IPC interrupt.

## Checkpoint, reclamation and rebuild are separate costs

For the initial broad 10-thread run:

| Phase | Time | WAL / effect |
|---|---:|---|
| Deletion | 2.527 s | 176.10 MiB WAL; 100.75 MiB free pages |
| TRUNCATE checkpoint | 100.6 ms | WAL transferred/reset, no further deletion |
| `incremental_vacuum(256)` | 1.42 ms | 279 frames / 1.10 MiB WAL; 256 free pages reclaimed |
| Remaining uncapped incremental vacuum | 180.9 ms | 26,436 frames / 103.87 MiB WAL |
| Subsequent full VACUUM | 488.0 ms | 48,509 frames / 190.60 MiB WAL; final 189.49 MiB file |

Freelist reuse usually benefits future writes without shrinking the file. Do not
run incremental vacuum after every deletion batch. A 256-page reclaim request
can write more than 256 pages because of relocation and pointer-map/index work.
Use a separately paced job and measure its own WAL/lock budgets.

The selective fresh-DB experiment applies the **tool-detail-only** policy to the
original prepared copy. It keeps every row of every other table, including
overlays, accounting, references, Token Miser fences and user configuration.
It recreates ordinary tables and the FTS virtual table, copies retained rows
including rowids/sequence high-water marks, then builds explicit indexes, views
and triggers. SQLite necessarily maintains primary-key/unique indexes during
row insertion; their cost is in the copy phase, not the later index phase.

| Fresh-copy phase | Measured cost |
|---|---|
| Schema | 3.0 ms; 157 frames |
| Retained rows | 546.9 ms; 45,732 frames / 179.69 MiB WAL |
| Explicit indexes, views, triggers | 228.0 ms; 9,229 frames / 36.26 MiB WAL |
| Checkpoints across phases | 242.4 ms total |
| Validation | 1.836 s; retained-table digests plus SQLite integrity and FK checks |
| Result | **307.23 → 214.48 MiB**; 92.76 MiB smaller; 71 table digests matched the exact retained source selection; integrity OK; zero FK errors |

This copy is a measured prototype, not a cutover tool. It does not validate
external files, open application caches, unavailable-link UX, or all possible
future JSON schemas. Before shipping, define each table's retention transform
and its semantic closure in code; reject an unclassified table/schema version.
If any retained reference requires removed detail, retain that detail or retain
an explicit unavailable-content record and obtain the corresponding user choice.

For production rebuilding: make a validated online backup; estimate disk from
source DB + current WAL + backup + new DB + new WAL + index-sort/temp files +
rollback copy + margin. This experiment can need over a GiB despite a 307 MiB
source; use a conservative **at least 4× DB + current WAL + measured temp margin**
admission estimate and monitor available space continuously, not a fixed 4×
guarantee. Never delete the rollback copy to make a failing rebuild fit.
Establish a final write barrier across **all** profile processes, close every
connection, and either rebuild from the final snapshot while visibly offline or
implement a separately proven change-capture catch-up protocol. This proposal
chooses the simpler visible offline final stage. Validate retained digests,
schema/version, FK/FTS/projection/application invariants and backup readability
before cutover. Only with all handles closed may the profile switch files;
flush files/directory appropriately, preserve original DB/WAL as one recoverable
generation and record an atomic cutover manifest. Reopen and smoke-check before
resuming writers. Rollback requires another coordinated stop; do not silently
discard writes accepted after cutover. **No live file swap with open handles.**

## Retention contract and upgrade experience

| Policy | Semantics and restore behavior |
|---|---|
| Archive, default | Provider thread remains restorable; PwrAgent metadata, relationships, worktree snapshots, drafts and accounting survive. No automatic historical purge |
| Rebuildable-cache retention | Evict only explicitly classified derived data after a proposed 30-day confirmed-archive grace period; preserve offline metadata where the provider cannot rebuild it. Restore lazily rehydrates search/git/provider views. The measured space benefit is small |
| Optional tool-detail retention | Proposed **opt-in** 90-day confirmed-archive grace plus explicit scope/size preview. Remove approved tool/Token Miser detail; preserve accounting and metadata. Restore works, but removed inspection/output links show “Removed by storage cleanup” and are not promised to regenerate |
| Explicit permanent local cleanup | Separate confirmation naming lost local history and provider transcript exclusion. Resolve active work and incoming references; retain necessary identity/audit/finalization stubs or separately approved aggregates. A later provider unarchive cannot recreate erased local history |
| Unknown/missing/legacy/disconnected | Keep and show unknown eligibility. Begin grace at first positive authoritative observation. A user may separately authorize specifically identified local-data destruction; absence from a list alone cannot do so |

The 30/90-day values are **proposed product choices**, not measured correctness
thresholds or authorization to delete. Even opt-in deletion of raw usage needs a
separate accounting retention decision; this recommendation preserves it.

On upgrade, render the main window first. Do not add a retention sweep, index
rebuild, full JSON scan, vacuum or bulk candidate backfill to `StateDb.open`.
Install only small empty bookkeeping schema if needed. After the app is usable,
show a storage task such as “Checking archived thread storage”; report discovery
pages, positively classified/unknown counts and recoverable space estimate.
Explain that archive is restorable and that history removal is optional. Offer
Pause, Cancel and run-later controls; cancellation keeps completed removals and
stops at the next safe boundary rather than promising an undo.

For this snapshot, #2357's isolated schema-64 projection migration took **193 ms /
403 WAL frames / one commit**, building 1,155 projection rows. The actual current
`StateDb.open` test took **462 ms**; current startup GC took another **42 ms**.
A copy deliberately converted to legacy `auto_vacuum=NONE` spent **1.326 s** in
startup GC, including **1.280 s** full conversion and **294.47 MiB WAL**. The
fixture setup conversion is excluded from those timings. That existing
synchronous startup behavior should move to visible deferred maintenance; this
small profile does not justify assuming it is safe for much larger profiles.

The measured 911-thread backlog took ~1.0 s at indexed ten-thread/5 ms yield, or
~1.6 s at five-thread/5 ms yield, excluding provider discovery, backup, checkpoint,
vacuum and full validation. That is not a five-minute backlog on this machine,
but scaling, giant records and active writers invalidate a fixed startup time
promise. First upgrade should **observe**, not silently erase an accumulated
backlog. Legacy archive ages start their grace clock now. Initial upgrade
destructive backlog is therefore zero unless the user explicitly selects it.
Use progress/ETA from completed chunks and pause under foreground load or WAL/
disk pressure. Across restart, resume the persisted policy/version and cursor;
never restart the whole scan or pretend a cancelled job completed.

## Proposed execution architecture and budgets

Use a dedicated Node/Electron utility process owning a separate SQLite
connection, not synchronous calls from Electron main. It performs discovery,
estimation, deletion and reclaim phases with bounded IPC progress updates.
Main sends start/pause/cancel and invalidates affected views after commit.
The process choice makes crash isolation and forced shutdown explicit. It does
not eliminate SQLite's single-writer contention.

Start with **5 threads, 128 detail rows per statement, ~8 ms target lock time,
256-frame (~1 MiB) target batch budget**, and at least 5 ms yield. These are
feedback/admission targets, not hard SQLite guarantees. Adjust downward from
measured pages/time; permit ten only for small candidates. Preflight giant rows,
shared references, active jobs and estimated overflow/index cost. A single row
too large to slice is skipped to explicit maintenance, not forced through to
finish the queue. Separate detail-table phases can survive a crash because each
slice is idempotent and atomically advances its progress.

`better-sqlite3` calls are synchronous even in a worker, and a cancellation IPC
message cannot interrupt an already-running native statement by itself. Check
cancel between short statements/transactions; use an actual SQLite interrupt/
progress mechanism if a later implementation offers hard in-statement deadlines.
A worker process can be terminated as a last resort, leaving an uncommitted
transaction to recover. Do not claim a hard 8 ms abort with the present API.
Main's existing synchronous writes can still wait behind the cleanup writer;
test foreground latency explicitly, use a short cleanup busy timeout/backoff,
and never execute a giant unsliced statement that can hold that writer lock.

Persist a sparse job/policy version, candidate identity and archive evidence
generation, authorized scope, phase/keyset cursor, completed counts and owner
fence. Advance deletion and progress in the **same** transaction. Store only
necessary IDs/timestamps/size estimates, not duplicate payloads. No idle
heartbeat or timer-driven progress writes; events and bounded page observations
can share one transaction. Do not make one bookkeeping commit per deleted row.

Acquire ownership with a short `BEGIN IMMEDIATE` compare-and-set against the
profile job and existing PID/boot/runtime-instance identity. Only a demonstrably
dead owner can be reclaimed; every write verifies its owner generation.
Use existing runtime-instance ownership conventions, not an unrequested profile
lock file or a periodic SQLite lease heartbeat. A competing app leaves the job
alone. Restore cancels/fences outstanding candidates, rechecks archive generation
and removes them from future batches. Provider/archive checks occur outside the
writer transaction, with local generation validation immediately inside it.

There is no distributed atomic transaction between provider unarchive and a
local SQLite delete. Out-of-band provider changes remain a race. Automatic cache
eviction must tolerate that race through rehydration. Destructive cleanup needs
explicit authorization for the selected local detail's loss, a coordinated local
restore barrier and revalidation; do not promise that a last-minute provider
restore can undo committed cleanup.

For older writers, keep overlays and payload-driven navigation triggers intact.
Detect live process capabilities before destructive history maintenance. If an
older/unregistered writer cannot participate in ownership/restore fencing, defer
destructive maintenance or require coordinated offline mode. A cleanup marker
unknown to an old writer cannot prevent repopulation, stale Token Miser updates
or accounting re-attribution. Avoid changing existing columns/JSON shape in the
first release; preserve guards and migration markers. Do not implement silent
triggers rejecting older legitimate restore writes just to enforce retention.

Checked-in [prototype write budgets](../../scripts/archive-retention-lab/write-budgets.json)
assert that 64 progress-only boundaries write **64 commits, 64 frames, one unique
page, 263,712 WAL bytes**, and cancellation before work writes nothing. In a real
delete transaction that page should add no extra commit. This is a minimal
ledger budget, not a budget for a future indexed production queue.

For scale, assuming **100 cleaned threads/day**, this cohort's indexed ten-thread
envelope projects **20.25 MB/day WAL** (19.31 MiB), before checkpoint/reclaim;
single-thread transactions project about **41.12 MB/day**. Ten progress-page
updates add ~0.041 MB/day if co-committed. An idle cleanup service must write
**0 MB/day**. At 1,000 threads/day the broad envelope becomes ~202 MB/day WAL,
which warrants review of retention scope and batching. Whole-cohort main-file
checkpoint payload is at least the ~107.4 MB of unique touched pages in this
controlled run; multiple checkpoints may rewrite a page again. The cost model is
work rate × measured per-batch commits/pages × duration, with separately measured
checkpoint/reclaim phases—not a row-count or commit-only estimate.

## Implementation and validation plan after design review

1. Agree on retention semantics first: metadata/accounting preservation, opt-in
   detail family, grace windows, unknown state and restoration text. Confirm
   whether any external Token Miser files are in scope; they are not measured here.
2. Add an authoritative archive-observation service keyed by full instance/backend
   identity, complete paginated discovery with cancellation, missing/partial-scan
   states and first-observed grace clocks. Test provider disconnects, capped pages,
   legacy aliases, native subagents, archive/unarchive races and wrong-account scopes.
3. Implement the worker/owner/progress protocol with foreground priority and no
   startup backlog work. Add a table classification manifest that fails closed on
   new tables. Test two processes, dead-owner reclamation, live old writers,
   restore cancellation, no-op candidates and main-loop latency under contention.
4. Implement explicit table-phase/keyset cleanup, reusing provider-leading indexes
   and FTS rowids. Preserve accounting and retention fences. Test giant overlay
   overflow, superseded usage, multiple providers, shared children/incoming parents,
   FTS consistency, Token Miser stale deliveries, worktree restore and unsent drafts.
5. Put feature-level commits in the repository's
   `apps/desktop/src/main/__tests__/fixtures/sqlite-write-budgets.json` using
   `measureSqliteWrites`, excluding setup. Add WAL-frame/unique-page/max-batch
   assertions separately: existing commit instrumentation alone is insufficient.
   Include one/five/ten/twenty candidates, row slices, cache spill, secure-delete,
   no-op ticks, progress overhead, retries and cancellation. Use fully synthetic
   fixtures in CI, never this operator's database.
6. Add process-kill tests at pre-commit/post-commit/ack boundaries, disk-full and
   I/O failure injection, restart midway through each table, provider reappearance,
   restore during pending cleanup, pinned readers, checkpoint starvation and
   continuous foreground writers. Verify both no-loss closure and bounded latency,
   not just successful SQL and foreign keys.
7. Implement optional reclaim/rebuild only after the routine path is validated.
   Test spare-disk admission, backup integrity, full retained-table digests,
   FTS/projection equivalence, mixed-version exclusion, final offline barrier,
   power-loss-safe cutover manifest and rollback after reopening. Index build and
   validation need their own visible progress and cancellation phases.

The prototype's two synthetic budget/WAL tests, actual-copy startup test and
repository ESLint command passed. All 52 deletion scenarios, sliced and recovery
trials, and retained-data copy passed their stated integrity checks. The full
workspace unit/E2E suite was not run for this investigation. Production changes
and their separate validation are documented in the startup implementation.

SQLite's [online backup](https://sqlite.org/backup.html) documents consistent
incremental snapshots. Its [WAL documentation](https://sqlite.org/wal.html)
explains reader end marks, checkpoint starvation and the single-writer boundary.
[VACUUM](https://sqlite.org/lang_vacuum.html) and
[incremental-vacuum pragmas](https://sqlite.org/pragma.html#pragma_incremental_vacuum)
describe rewriting/reclamation as separate operations. Those semantics support
the architecture; all timing and volume numbers above come from the local trials.
