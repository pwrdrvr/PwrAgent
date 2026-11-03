# Waiting for projections

The Waiting for tab combines existing wake sources. It owns no registrations,
scheduler, timers that poll sources, or persistent copy of a source's state.
Stopping a row calls the source's existing cancellation method. Auto-fix uses
the thread's existing setting. Reading the list must not start the scheduler.

Local windows list through `thread:pendingWakes`. Selected-detail reads omit
the projection by default. The federation backend bridge opts in through an
owner-internal service option; the signed request is unchanged. It supplies
the active PR watches already read for selected detail.

## Read scope and admission

The badge requests active wakes with `endedLimit: 0`. Opening the Waiting for
panel requests up to eight ended rows. Each source reads the selected thread:

| Source | Read boundary |
| --- | --- |
| PR watches | The thread's active watches; ended rows only on panel demand. |
| Auto-fix | The selected thread's PRs, using existing election indexes. Each election stops at its first eligible owner; later competitors are not read. Candidate eligibility is hydrated once per owner per build. |
| Dependencies | Active waiting/ready registrations; ended rows ordered by update time only on panel demand. |
| Scheduled actions | Up to 100 active metadata rows and the requested ended rows. No execution input or attachment leaves the source reader. |
| Monitors | Live delegations from memory; ended monitor summaries from an index ordered by completion time, independently of other sub-agent cards. |
| Claude tasks | Background tasks from the thread's live session; no provider history read. |

Scheduled preview decoding admits payload files up to 256 KiB. The source
keeps at most 128 text previews, each at most 600 characters, keyed by immutable
payload reference. Edits replace the reference. Oversized or unreadable text
leaves the scheduled wake visible and marks the response incomplete. Reading
previews creates no database or payload-file writes.

The pending projection retains at most 128 rows and 64 KiB of JSON. Text is
clipped for display. Omitted rows mark the list incomplete. Peer detail further
reduces the wake projection to fit the space remaining in the existing detail
byte budget; wake data cannot make an otherwise valid configuration unreadable.
An incomplete empty list must not claim that nothing will wake the thread.

## Refresh and ownership

The owner's IPC list and federation detail projector share a process-owned
cache. Repeated requests reuse a completed result for 200 milliseconds; each
resident thread has one build in flight and at least 200 milliseconds between
build starts. Changing history limits shares that admission interval. A richer
history result can answer a smaller request without exposing unwanted history.
Events invalidate only the affected thread (or all entries for project changes).
An invalidated build cannot publish a current cached result; its callers share
one replacement. Invalidation storms cannot bypass the minimum interval.

The cache retains at most 64 thread entries, evicts idle entries in access order,
and rejects new identities while all entries are occupied. At most 512 callers
can wait on one thread. Each retained result
is at most 128 KiB; an oversized result is answered without retention and remains
subject to the rebuild interval. There is no background cache-refresh timer.
Closing the owner clears cached state and cancels delayed reads. Cancellation
also invalidates the affected entry so the following read confirms current state.

The local hook admits at most one list request per selection. Source events
invalidate its generation immediately. Events arriving during a read cause
one trailing read, and the invalidated response is not published. Idle bursts
coalesce for 200 milliseconds. Changing selection fences late reads and stops;
the previous selection's state is not displayed under the next thread.

History demand changes use the same admission path. A badge never reads
history merely because another source changed. Accounting-only sub-agent events
do not refresh wakes. No periodic refresh timer is installed.

Peer viewers use selected detail. Existing source events and compact federation
navigation invalidations refresh that projection. Dependency and scheduled-action
invalidations name the affected thread and do not change directory membership.
Monitor activity is absent from local detail revisions. A successful peer Stop
is hidden only for that owner, thread, and projection until fresh owner data arrives.

## Regression checks

Read-count tests cover unrelated Auto-fix candidates and repeated scheduled
previews. Deferred-response tests cover source bursts, selection changes, and
history demand. Detail tests exercise the peer-serving bridge and byte budget.
`pending-wake-read-budgets.json` records actual projection builds, source calls,
executed SQLite SELECTs, consumed rows, overlay payload bytes, and scheduled
payload-file reads/bytes. Identical budgets run with zero and 160 unrelated
threads, including later candidates on the selected PR. Query-plan assertions
require indexed candidate lookups. Repeated local IPC and peer detail reads
also have path-specific budgets. Re-record deliberate changes with
`UPDATE_PENDING_WAKE_READ_BUDGETS=1` and review the fixture diff.

The deterministic burst fixture sends 1,280 mixed local/peer requests in 32
batches over 800 milliseconds. These are operation counts, not latency timings:

| Measured work | Cache bypassed | Owner cache |
| --- | ---: | ---: |
| Projection builds | 1,280 | 4 |
| Source calls | 9,600 | 32 |
| SQLite SELECTs | 10,880 | 36 |
| Returned SQLite rows | 8,320 | 28 |
| Overlay payload bytes | 805,120 | 2,992 |
| Scheduled payload-file reads | 1 | 1 |

Both columns use the same indexed queries and source preview cache. A follow-on
invalidation storm adds five builds, including one trailing read, for nine total
builds across 2,560 requests. The same counts hold with 160 unrelated threads
and later competing candidates. Separate detail-path budgets record zero wake
builds for 96 local detail reads and one build for 96 peer detail reads.

The `thread-pending-wakes-list` SQLite budget measures repeated reads over real
stores: zero commits and 0 MB/day. Keep query and payload bounds alongside that
write budget; zero writes alone does not establish a cheap read path.

The monitor-completion fixture records one existing transaction and 24,752 WAL
bytes, including the ended-history index. At 100 completions per day that is
about 2.5 MB/day for the completion writes. The index adds one empty database
page (4,120 WAL bytes) to the storage-maintenance VACUUM fixture. Listing wakes
still adds zero commits and 0 MB/day.
