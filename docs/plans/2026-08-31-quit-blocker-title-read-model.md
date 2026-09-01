# Quit Blocker Title Read Model

## Decision

Quit blocker membership remains owned by the live runtime registries. Quit
blocker display titles come from a separate, process-local projection of
thread metadata that has already been observed. Building or polling the quit
queue never starts or awaits a provider thread-list request, a peer request,
or directory/Git enrichment.

This is a scoped correction to the existing quit path. It does not change
thread-list ownership, navigation refresh policy, lifecycle membership, or
quit confirmation behavior.

## Invariants

- Runtime blocker membership and counts are authoritative on every snapshot.
- A blocker that resolves disappears on the next snapshot, even when its
  display title remains cached.
- An observed nonempty, non-fallback title is retained until a newer nonempty,
  non-fallback observation replaces it.
- Absence, a rejected read, an unavailable provider, and a fallback title are
  not title-deletion events.
- Ordinary active turns and sub-agent-owned turns use the same title lookup.
- Quit title lookup is synchronous for local threads and cache-only for remote
  threads. Persisted remote pins remain a local fallback; quit never contacts
  a peer to learn a label.
- PR #1903's renderer-side monotonic retention remains in place as a second
  presentation-layer defense. It does not own membership.

## Data Ownership and Identity

`DesktopBackendRegistry` owns a volatile display-metadata projection for
threads owned by this process. Each entry contains the latest accepted title,
its title source, and a monotonic observation sequence. Entries are keyed by
`buildThreadIdentityKey(backend, threadId)`; backend is therefore part of the
identity even when two providers reuse the same thread id.

Mounted remote titles remain owned by the federation runtime's already-seen
thread summaries, with persisted remote pins as a local fallback. The quit
resolver keys those results with
`instanceId::buildThreadIdentityKey(backend, threadId)`. A local thread and a
remote thread, or two remote instances, cannot share a title entry merely
because backend and thread id collide.

No new persistent state is introduced. Live blockers and the local title
projection are process-local, so there are no new SQLite writes or write
budgets.

## Freshness Semantics

The registry allocates observation sequences from a monotonic counter; it does
not use wall-clock time.

- A lifecycle/name notification receives a sequence when the notification is
  processed.
- A provider thread-list miss reserves its sequence before the asynchronous
  list begins. The resulting rows retain that sequence when they complete.
- A cache hit does not create a new observation.
- A title is accepted only when its sequence is at least as new as the entry's
  sequence and its trimmed value is nonempty and not marked `fallback`.

Reserving a list's sequence before awaiting is the critical ordering rule. If
an old list starts, a rename notification arrives, and the old list completes
later, the rename has the higher sequence and the stale completion cannot
erase or replace it. A list started after the rename is a newer observation
and may reconcile the title.

Unknown metadata is explicit: when no usable title has ever been observed, the
projection returns no title and the existing UI falls back to the thread id.
It never guesses from another backend or instance.

## Read Path

The registry exposes a narrow synchronous cached-display-metadata read. Quit
snapshot creation uses it for every active-turn owner after sub-agent ownership
has been collapsed. The quit title resolver uses the same read for local
terminal rows. It no longer calls `listThreads({ callerReason:
"quit-confirmation" })`.

Remote terminal rows continue to consult only already-observed federation
summaries and local pinned summaries. Automation rows keep their automation
name, and environment-action rows keep their action name, so neither requires
thread enrichment.

## Failure Semantics

- Slow, hanging, rejected, or unavailable provider lists cannot delay quit or
  a live-queue poll because quit never invokes them.
- A failed optional remote-pin read yields no title and preserves the stable
  thread-id fallback.
- The existing bounded title-resolution wrapper remains a final degradation
  boundary for optional asynchronous local-store work; failure changes labels,
  never membership, routing, or the Quit/Wait/Stay Open decision.
- Cache invalidation removes list reuse, not the last observed display title.
  A later valid observation can still supersede it.

## Performance Budget

For quit snapshot construction and repeated live-queue polls:

- full provider thread-list refreshes: **0**
- directory/Git enrichment calls for labels: **0**
- peer/network title requests: **0**
- SQLite writes: **0**

Local title work is O(number of blockers) map lookup. An unresolved remote
batch may perform one existing read of persisted remote pins; it performs no
write.

The budget is enforced with deterministic call-count assertions, not elapsed
time.

## Compatibility With PR #1896

PR #1896's `getCachedThreadSummary()` serves targeted messaging admission and
is broader than the title-only projection. Its current cache scan does not
cover names observed from lifecycle/name notifications.

This change does not cherry-pick or duplicate PR #1896's messaging work. On a
later rebase, `getCachedThreadSummary()` can retain its admission contract and
thread-list cache scan; where it needs a display title, it can merge the narrow
projection into the cached summary. Quit continues to call the narrow
display-metadata read and never treats title-only knowledge as a complete
navigation/admission summary. Keeping the responsibilities separate makes the
backend-registry overlap mechanical rather than architectural.

## Test Matrix

| Contract | Focused coverage |
|---|---|
| Ordinary local active turn is named | Seed an already-observed non-fallback title, start/observe a normal turn, and assert the first synchronous quit snapshot carries it. |
| Sub-agent ownership remains named | Preserve the existing owner-collapse case and verify it reads the same projection. |
| Rename wins | Observe an initial title, then a nonempty explicit rename, and assert subsequent snapshots use the rename. |
| Missing/fallback cannot downgrade | Feed empty/fallback observations after a known title and assert the title remains. With no prior title, assert the stable thread-id fallback. |
| Late old list cannot erase | Start a delayed list, observe a newer rename and active turn, release the old list, and assert the rename remains after completion and invalidation. |
| Provider failure does not affect first snapshot | Exercise hanging/rejected/unavailable list conditions and prove snapshot creation neither calls nor awaits provider listing. |
| Polling performance budget | Build the snapshot repeatedly and drive repeated queue reads; assert zero provider `listThreads` and zero directory-enrichment calls. |
| Membership stays authoritative | Complete/remove blockers and assert they disappear immediately and the empty snapshot is reachable. |
| Qualified local identities | Reuse a thread id across two backends and assert titles do not cross. |
| Qualified remote identities | Reuse backend/thread id locally and on multiple mounted instances and assert only the owning instance's cached title is selected. |
| Other blocker kinds | Preserve focused snapshot/resolver coverage for integrated terminals, environment actions, and automations. |
| Renderer defense | Keep PR #1903 component tests proving absent titles cannot erase known titles, renames win, removals/counts remain authoritative, and empty state renders. |
| Quit decisions | Preserve existing main-process tests for Quit, Wait/countdown, and Stay Open. |

No new desktop E2E is planned because this change introduces no renderer,
dialog, IPC-shape, or interaction contract. The main-process unit tests can
deterministically prove the provider-call budget and freshness ordering, while
PR #1903's component tests already exercise the live-poll presentation seam.
Adding a headed replay would duplicate those contracts without exposing a new
failure mode.
