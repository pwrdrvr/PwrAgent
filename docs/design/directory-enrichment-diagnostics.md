# Directory enrichment diagnostics

Main-process hot CPU captures write a sibling `main-hot-NNNN.diagnostics.json`
and register it in the session manifest. Its `directoryEnrichment` section
explains which enrichment requests launched Git. The existing `.cpuprofile`
format is unchanged. Auxiliary diagnostics failure does not discard the CPU
capture. Renderer and startup profiles do not collect this summary.

The collector runs in memory before profiling starts, with no timer, filesystem
probe, per-call log entry, or SQLite write. It retains at most 60 two-second
buckets. Each bucket keeps the first 32 distinct directory / enricher instance /
caller / reason combinations. Directory text is clipped to 1,024 characters.
Older buckets expire on the next observation or snapshot, so idle operation
needs no cleanup timer. SQLite write projection: **0 MB/day**.

## Reading a capture

Each bucket has its epoch `startMs`, exact `totals`, attributed `rows`, and
`overflow` counters for combinations beyond its row limit. Use bucket times
alongside the profile's trigger and pre-trigger duration. Buckets overlap
capture boundaries by up to two seconds, and the final bucket can be partial.
The snapshot covers recent history, not exactly the profile interval; long
captures can extend beyond the two-minute retention. Do not label these counts
as exact counts within an arbitrary five-second CPU slice.

Sum `gitStarted` by directory, caller and reason to find the retained rows
responsible for probes. Inspect `overflow.gitStarted` before treating this as a
complete ranking. Overflow contributes to `totals` even when its paths cannot
be retained. These are bounded samples of directory attribution, not an
approximate heavy-hitter algorithm. Clipped directory names can share a row.

Caller labels distinguish `thread-list`, `selected-thread`,
`missing-worktree-backfill`, `explicit-enrichment` and standalone `direct`
requests. A client listing already coalesces duplicate directory rows before
calling the enricher, so these counters measure enricher requests, not threads.
Injected replacement enrichers/resolvers are outside this collector.

Each enricher receives a process-local increasing `enricherId`; repeated cold
probes for one path under different IDs point to cache-owner recreation rather
than invalidation in one cache. `enricherInstancesCreated` is a process-lifetime
counter, while the bucket counters cover only retained history.

| Reason | Meaning |
|---|---|
| `empty-path` | No requested directory |
| `pending-reuse` | Another request already owns validation/probes for this path |
| `cache-hit` | Filesystem relationship and HEAD evidence still match |
| `observation-unavailable` | Missing path, incomplete metadata, or failed observation |
| `unversioned` | Observation found no repository |
| `cold` | Valid repository observation with no retained result |
| `relationship-changed` | Existing mapping invalidated by filesystem relationship evidence |
| `head-changed` | Stable relationship with changed HEAD evidence |

`requests` counts one decision per call. Pending reuse belongs to the joining
caller; actual commands belong to the caller that initiated the work.
`observationErrors` distinguishes thrown filesystem observations from missing
or incomplete evidence. `cacheStored`, `resultNotCached` and
`observationChangedDuringProbe` explain publication or rejection of new results.
A failed probe is intentionally not cached; its next request can be `cold`.

Command counters distinguish top-level, worktree-list and branch probes.
`gitSucceeded` and `gitFailed` count command completions, including the failures
that enrichment catches to return a fallback. Starts and completions belong to
the buckets in which they occur; commands crossing a boundary need not balance
inside one bucket or capture. `gitDurationMs` is summed monotonic elapsed time
at completion, **not CPU time**. Concurrent commands overlap, so summed duration
can exceed the bucket width. No command output, error text, branch names or
thread text is collected.

This instrumentation does not change probing, cache retention, invalidation,
process ownership, retry behavior or timeouts. Its purpose is to distinguish
cold discovery, owner churn, failed probes and actual invalidations before
changing any of those contracts.
