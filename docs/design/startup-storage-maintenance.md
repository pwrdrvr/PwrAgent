# Startup storage maintenance

Implementation following the operator's review of
[the real-copy investigation](archived-thread-retention.md). This change has
not been run against the live default profile or released.

## Product behavior

- The setup wizard takes priority. New databases, incomplete onboarding, and
  databases below 100 MiB skip maintenance. Eligible profiles check at startup
  at most once in 24 hours, including unsuccessful or cancelled attempts.
- First use asks for a saved, initially unchecked preference: remove archived
  tool inspection history after seven days. Declining history removal still
  permits existing expiry policies and compaction. “Not now” skips the attempt.
- Hovering or keyboard focus keeps the window open until Close, including
  interaction during the four-second completion grace period. Startup waits for
  the job, not dismissal. The retained window can change the next run's
  preference while the rest of the app runs.
- Progress reports discovery, eligible-thread progress, compaction, recovered
  bytes, cancellation and deferral. Stop kills the isolated worker; committed
  slices remain, and SQLite recovers any interrupted transaction. Remaining work
  is reconsidered at a later eligible startup.
- Retention preserves thread restoration metadata, relationships, worktree
  snapshots, settings, drafts, usage/accounting, search and routing records.
  Only local tool invocation/alert/analysis records and Codex Token Miser
  objects/observations are eligible for optional history deletion. Existing
  expiry policies continue to apply independently.

## Eligibility and ownership

Schema 65 adds an empty `thread_storage_retention` table. There is no historical
backfill, table scan, index rebuild or VACUUM in this migration. Positive archive
events record a receipt; unarchive events remove it. Fresh provider listings
reconcile receipts in the worker. A trustworthy provider archive timestamp can
establish age or move a receipt forward after rearchive. Without one, age begins
at first positive observation. Absence or a disconnected provider never means
deletion. A positive active observation wins over a conflicting archived result.

The combined provider listing now forwards `forceRefresh` to its Codex child
request; otherwise a fresh outer request could reuse stale inner results.
No Codex-owned files are accessed.

Admission checks existing profile runtime markers and registered live process
IDs. A transactional metadata claim prevents two maintenance workers from
owning the same profile. A 250 ms read-only ownership check stops work if another
instance appears. There is no heartbeat write or new database lock file.
Archive/unarchive events interrupt maintenance before updating the receipt.
Old writers keep their tables and Token Miser generation fences; an already
running old instance causes deferral. This is conservative process detection,
not a cooperative lock enforced by old binaries: a newly arriving old process
can contend briefly until detected. SQLite still serializes writers, and the
worker uses a 100 ms busy timeout and aborts rather than waiting indefinitely.

For providers without archive timestamps, continuity depends on observed
lifecycle events. An external unarchive/rearchive entirely while PwrAgent is
offline cannot be reconstructed from an unchanged timestamp-free archive
listing. The UI therefore explicitly describes the first-confirmation rule.

## Work and disk bounds

`storage-maintenance-worker.ts` runs in an Electron utility process. Each delete
transaction touches one thread and one artifact family, with at most 128 indexed
candidate rows and 256 KiB of logical content plus a fixed row allowance. This
is deliberately below the discussed 10–20-thread ceiling. Statements enumerate
their columns explicitly; schema changes must keep byte accounting current.
Individual oversized records are retained, and a candidate window containing
only oversized rows ends that family for this run. This can retain later small
rows as well; it trades completeness for bounded candidate inspection.

After an 8 ms transaction or 1 MiB observed WAL growth, the worker halves its
row limit, down to one. It yields five milliseconds between slices. These are
adaptive targets, not guaranteed page/latency limits: indexes, secure-delete,
cache spill and a single record can still exceed a target. If the WAL exceeds
64 MiB, checkpointing either catches up or the job defers behind a pinned reader.
No progress heartbeat is persisted. Atomic, idempotent deletion is the resume
record; the daily attempt and completion markers are stored separately.

Normal expiry runs off main during maintenance. The ordinary hourly GC remains
on main but no longer runs synchronously at startup, and its incremental vacuum
is capped at 256 pages. Its existing expiry transaction is otherwise unchanged.

Full VACUUM is a separate visible phase, once per admitted day. Admission requires
free disk of at least three times the pre-cleanup logical database size. SQLite
performs the rewrite and index rebuild; there is no application file swap or
fresh-database cutover. Cancellation terminates the worker even during VACUUM.
A failed truncating checkpoint prevents reporting successful reclamation.

The real-copy investigation measured about 214 MiB of WAL for full VACUUM after
the tool-detail cleanup. Running that rewrite once daily at that retained size
therefore costs roughly **224 MB/day** of WAL, plus cleanup and checkpoint writes;
it does not become free on later days with little to reclaim. This is the
operator-requested daily-compaction policy, not a claim that VACUUM is always
necessary. The earlier 79 MiB free-page and 94 MiB post-VACUUM savings are from
the investigation's batch implementation, not a benchmark of this more
conservative row-sliced worker.

## Validation and repeatable checks

Checked-in regression coverage:

- Admission, daily throttling, seven-day boundary and rearchive reset.
- Restoration and unknown-thread preservation, byte/row slicing, oversized
  records, reopen/resume, live owner exclusion and deferred startup GC.
- Hover retention, completion grace period, editable completed preference,
  cancellation, application quit, a newly arriving profile instance, and IPC
  sender validation.
- Fresh combined-provider listing and existing StateDb creation/migration tests.

The feature has commit budgets in `sqlite-write-budgets.json` and direct WAL
frame budgets in `storage-maintenance-page-budgets.json`. On the synthetic
128 × 1 KiB object fixture, deletion plus its retention fence writes 29 frames
on 29 pages, one commit, 119,512 bytes. The subsequent compaction phase writes
255 frames on 254 pages, two WAL commit markers, 1,050,632 bytes (including its
auto-vacuum pragma). Direct frame measurement occurs before checkpointing;
the generic instrumentation alone cannot measure VACUUM or WAL truncation.
Daily admission/completion writes 12,360 bytes in two commits, about
**0.0124 MB/day**. One archive/repeat-observation/restore cycle writes 16,480
bytes; 100 such cycles/day projects **1.65 MB/day**. Deletion and VACUUM volume
depend on actual content and page layout and must be accounted for separately.

```sh
pnpm test apps/desktop/src/main/__tests__/storage-maintenance.test.ts apps/desktop/src/main/__tests__/storage-maintenance-window.test.ts apps/desktop/src/main/__tests__/state-db.test.ts apps/desktop/src/main/__tests__/state-db-creation.test.ts
pnpm test apps/desktop/src/main/__tests__/backend-registry.test.ts -t 'propagates an authoritative refresh'
pnpm test:sqlite-writes
pnpm typecheck
pnpm lint:eslint
pnpm lint:sql
pnpm lint:codex-storage
pnpm lint:colors
pnpm lint:boundaries
pnpm build
```

A local windowless Electron integration run executed the built utility process
on an entirely synthetic 107,941,888-byte database. It removed 200 eligible old
objects, preserved 200 each for recent/restored/unknown threads and all four
overlays, compacted to 2,297,856 bytes, and passed integrity checking. An immediate
second invocation deferred with no repeat cleanup. These figures are synthetic
validation, not expected operator savings. A headless Chromium check of the built
screen verified layout, hover, opt-in and preference changes after completion.
No live-profile mutation or headed desktop E2E was used for these checks.

The full SQLite write survey passed 972 test files / 14,429 tests (one file and
nine tests skipped). The additional queued-progress cancellation regression
passed in its focused window suite. Build, workspace typecheck, ESLint (zero
errors; existing warnings), SQL, Codex-storage boundary, renderer-color and
dependency-boundary checks passed. A real utility-process stop followed by a
simulated later eligible attempt also passed integrity and completed successfully
on the synthetic database.
