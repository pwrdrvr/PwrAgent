# Token Miser storage and accounting review

Reviewed September 5, 2026 after repeated `spawn EBADF` failures in the default
profile. This review covers retained output, metadata, Code Mode observations,
accounting reads, replay updates, and retention. It does not change the reducer's
decision policy or the model used to summarize output.

## What is stored

The profile owns `state/token-miser/objects/`:

| File | Purpose | Write trigger |
| --- | --- | --- |
| `<objectId>.txt` | Exact retained tool output, including grouped output, for authorized retrieval | Output staging |
| `<objectId>.json` | Thread/turn/tool ownership, summary, byte/token estimates, helper usage, parent model, retrieval and replay counters | Accepted result; retrieval; observed model request; replay retirement |
| `code-mode-observations/<observationId>.json` | Call identity, command/patch/poll counts, output size, up to 4,000 script characters and 5,000 preview characters | Code Mode observation, including direct and retrieval calls |

These are PwrAgent-owned records, not Codex session files. Raw output supports
retrieval after replacement by a summary. The other records support accounting,
the Pricing rail, and the Token Miser explorer. Metadata and observations are
therefore not merely filesystem paths or Git information. They contain text.

The store originated in PR #1733; PR #1942 subsequently changed its model-boundary
accounting. Current code, rather than earlier design records, was reviewed here.

## Incident evidence

At inspection the profile contained 3,257 retained outputs (36.0 MB), 3,257
metadata records (5.0 MB), and 10,641 observations (41.3 MB). These counts are a
point-in-time measurement, not a size limit. No operator content is included here.

The live Electron main process reached 18,531 open descriptors; another sample
contained descriptor numbers up to 25,945. Most of the observed file pressure
came from Token Miser JSON reads. In an isolated local process, Git succeeded
before opening 11,000 descriptors, failed with EBADF while they were open, and
succeeded after they closed. macOS's spawn file actions can reject stdio
descriptors above 10,239: <https://github.com/libuv/libuv/issues/5204>.

## Findings

1. `listMetadata` and `listCodeModeObservations` used `Promise.all` over every
   JSON file. One observation scan could exceed the macOS spawn threshold.
   Several scans could overlap in the same process.
2. A thread accounting refresh read the entire profile's result and observation
   record, then filtered for one thread. Savings calculation read all result
   records again. Grouped retrieval also scanned all result records.
3. Every Code Mode observation schedules accounting publication. Model-request
   replay accounting also publishes it. These routine events made total
   retained profile history part of the cost of each active thread update.
4. Replay accounting rewrites each affected gate's JSON atomically. Per-object
   update locks protect local updates, but do not impose an aggregate I/O bound.
   Limiting reads alone leaves concurrent metadata writes outside that budget.
5. Startup reconciliation and retention legitimately need profile-wide data.
   Settings also requests a profile-wide usage summary. They need bounded scans
   even after thread-specific callers stop reading unrelated records.
6. Retention runs at startup, with a seven-day age and 512 MiB payload budget.
   This is not a continuous disk quota. It currently counts output and
   observation bytes, but omits result JSON bytes. Script/preview collection and
   the boot-only retention schedule are existing product behavior; this repair
   should not silently redefine them.

## Selected design

- Apply one process-wide budget to Token Miser file reads and atomic writes.
  Hold a slot through completion, including rejection and rename. Do not retry
  failed Git launches or increase file-descriptor limits to hide the pressure.
- Use bounded scan workers, rather than allocating an active read for every
  retained file. Share concurrent discovery within a store, guarded by directory identity and
  timestamps so a query after an external atomic commit cannot join an older scan.
- Maintain an in-memory index of immutable filename-to-thread ownership. Learn
  existing ownership once, and register locally committed records immediately.
  Keep the existing on-disk layout and retrieval identifiers.
- Enumerate directory names to discover external additions and removals. Read
  newly discovered records to learn their owners, then read only the requested
  thread's known records. Do not cache mutable counters, scripts, or previews:
  edits by another process must be visible on the next completed query.
- Reuse newly discovered records within that query. Warm queries may enumerate
  profile filenames, but must not reopen unrelated JSON files. Startup and
  explicit global queries may read all records under the shared I/O budget.
- Build accounting and savings from the same thread metadata snapshot, removing
  the duplicate result-record read. Use the thread index for grouped retrieval.
- Preserve direct-object authorization and accepted-write ordering. Do not add
  SQLite writes, durable secondary indexes, watchers, background polling, or a
  cache TTL that can silently hide another process's changes.

The remaining filename enumeration is O(profile file count); content I/O after
discovery is O(requested thread record count plus newly discovered records).
The ownership index retains identifiers only, not the 41 MB observation payload.
This deliberately avoids a file-format migration or another persistent database.

## Validation requirements

- Concurrent cold scans and writes across store instances stay within the
  process-wide file-operation budget, including failed operations.
- Overlapping discovery reads each unknown record once per store.
- Warm thread accounting and grouped retrieval do not open another thread's
  records, even if the unrelated record later becomes unreadable or malformed.
- A second store's additions, counter updates, observations, and removals become
  visible; rebuilding the store retains the same behavior for legacy files.
- A local write during discovery is not omitted from a subsequent query.
- Thread accounting reads result metadata once for both counts and savings.
- Failed atomic writes release their slots and remove their temporary files.
- Existing retention, retrieval authorization, replay, and accounting tests pass.

## Write costs and remaining limits

This design adds no persistent index, SQLite statement, commit, or periodic
write: incremental SQLite cost is 0 MB/day. Existing gate counters still require
one JSON replacement per affected gate at a new model-request boundary. That
cost scales with active gates; this change bounds its concurrency without
changing the counters' durability or arithmetic. Cross-process counter
read/modify/write is not made transactional by a process-local queue. It must
not be described as such; concurrent ownership of one gate would need a separate
durability design.

Accounting for a single exceptionally long thread still grows with that
thread's retained records. A future queryable store or thread-level aggregates
would need explicit persistence, consistency, and write-budget review. Neither
that redesign nor a retention-policy change is required to stop this incident.

## Regression evidence

Five focused tests fail against the original implementation: unrelated-thread
reads, duplicate cold discovery, the mixed read/write budget, duplicate
accounting/savings reads, and failed-rename temporary-file cleanup. The original
mixed workload reaches 42 simultaneous operations against a budget of 16.
The corrected implementation also covers local/external commits during discovery
and live cross-instance changes without a persistent content cache.
