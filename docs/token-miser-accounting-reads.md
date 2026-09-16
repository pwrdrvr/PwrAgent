# Token Miser accounting reads

Investigation against origin/main `1668d0c0b`, 2026-09-16.

## Evidence and limits

The operator supplied `main-hot-0003.cpuprofile` and `main-hot-0004.cpuprofile`
from `hot-cpu-2026-09-16-0651-deb3ab`. The reported pre-trigger samples include
metadata JSON reads/parsing and file-system callbacks. They establish file
activity, not its asynchronous caller or its share of total process CPU. No
controlled before/after process CPU capture was taken here.

Temporary-store regressions reproduced these paths. Counts below describe the
fixtures, not the operator captures.

| Scenario | Before | After this change |
| --- | --- | --- |
| One accounting notification, one retained gate | One metadata JSON read and one retention-generation read | Zero Token Miser content reads |
| Ordinary Pricing, Sub-agents, or accounting display, one retained gate | Each reads metadata JSON and retention generation | Unchanged; separate projection work required |
| Two ordinary Settings projections | Two unscoped `listMetadata()` calls | Zero accounting scans, including after an unrelated config write |
| Unknown-thread or wrong-owner remote event with local and remote Pricing mounted | No extra read | Preserved |
| Matching remote event with colliding local/remote thread IDs | Only remote Pricing rereads | Preserved |

The notification regression failed before removing enrichment. The Settings regression also failed before decoupling usage reads and now passes.
The separate display regressions still fail; local reproductions were retained
under `.local/` rather than disabled in the test suite.

## Confirmed paths before fixes

- `DesktopSettingsService.readSettingsProjection` constructs a fresh
  `TokenMiserStore` and calls unscoped `summarizeUsage`. Every projection
  discovers retained threads and reads their metadata. `useDesktopSettings`
  mounts at App level, even with Settings closed, and rereads on Settings runtime
  events. Main and federation windows subscribe to that channel. This can
  multiply local work without misidentifying any remote thread.
- `DesktopBackendRegistry.readThread` enriches ordinary display resources through
  `withTokenMiserAccounting`: thread metadata, retention state, Code Mode
  observations, and savings reconstruction.
- `onCodeModeObservationUpdated` calls `emitThreadToolAccountingUpdated` even
  without UI demand. That method previously performed detailed enrichment before
  publishing. The display-event projector then discarded it and sent an
  invalidation. Incident summaries use SQLite invocations and alerts, not Token
  Miser metadata.
- Startup reconciliation has a separate purpose: migrate legacy accounting,
  restore active replay gates, retire gates compacted while closed, and reconcile
  the SQLite gate ledger. It does not justify discovery on every UI read.
  Original output bodies live in the bounded in-memory output cache; these
  metadata scans are not reads of retained original output bodies.

## Focused change

Accounting notifications now read only existing SQLite tool accounting. They
retain alerts, incident disposition, backend, and thread identity. Explicit
thread reads and detailed explorer requests retain enrichment. This removes a
redundant background scan without adding caching, polling, writes, or a new
freshness boundary.

## Settings decoupling

Settings snapshots now contain configuration and Token Miser activation status,
not accounting totals. `readTokenMiserUsage` is a separate IPC operation backed
by a lazily retained store. Only opening the Experimental pane requests the
usage aggregate. Ordinary Settings reads, runtime notifications, and unrelated
configuration writes do not scan or replace that accounting state. The pane
retains its usage across Settings snapshot refreshes. Explicit usage reads
reread mutable records, preserving visibility of another process's commits.
There is no TTL cache, periodic scan, or added database write.

## Ownership

`useThreadDisplayResource` matches instance, backend, and thread before
invalidating. `DesktopAppServerService.readThread` returns the remote backend
request directly for an explicit remote target; that branch has no local
fallback. Scoped metadata queries hash the requested thread into its own
directory; an unknown scoped thread does not widen to global discovery.

The regression covers another owner, an unknown remote thread, another backend,
and colliding local/remote IDs. This does not prove every upstream producer
labels every event correctly, but these read/subscription paths do not support
the proposed remote-to-local fallback.

## Remaining SQLite work

SQLite owns billed usage and priced per-gate sub-agent accounting. JSON still
supplies unpriced interceptions, exact pass-through/helper counts, Code Mode
observations, and retrieval/replay evidence. Using the current ledger alone
would lose fields or report incomplete counts. Indefinitely caching mutable
JSON would conceal another process's writes.

A complete fix needs a versioned accounting projection keyed by local
backend/thread identity, with object/observation identities for idempotence.
The explicit usage aggregate and ordinary Pricing should query it; detailed evidence
and output retrieval should have explicit demand. Migration must be restartable
and establish when SQLite becomes authoritative. Updates must cover accepted
gates, retrieval delivery, replay flush/retirement, Code Mode observations,
archive/restore, and startup reconciliation. Cross-process reads must observe
committed changes without stale in-memory gate projections overwriting them.

Do not add a commit per streamed event or scan on a timer. Design transaction
boundaries and the live overlay together, then measure commits and WAL growth
for gates, observations, retrievals, and replay batches. Piggybacking on existing
turn-boundary writes avoids new commits but does not by itself preserve
cross-process visibility of newly accepted gates during a turn. This focused
change adds no persistence, so its incremental SQLite write cost is zero.
