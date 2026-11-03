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
| Auto-fix | The selected thread's PRs and their competing candidates, using existing election indexes. Each candidate thread is hydrated once per read. |
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
The `thread-pending-wakes-list` SQLite budget measures repeated reads over real
stores: zero commits and 0 MB/day. Keep query and payload bounds alongside that
write budget; zero writes alone does not establish a cheap read path.

The monitor-completion fixture records one existing transaction and 24,752 WAL
bytes, including the ended-history index. At 100 completions per day that is
about 2.5 MB/day for the completion writes. The index adds one empty database
page (4,120 WAL bytes) to the storage-maintenance VACUUM fixture. Listing wakes
still adds zero commits and 0 MB/day.
