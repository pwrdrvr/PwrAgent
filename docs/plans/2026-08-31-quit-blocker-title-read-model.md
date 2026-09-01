# Thread Information Store

Originally scoped as "Quit Blocker Title Read Model". The quit card's blinking
titles were the symptom that was easiest to see; the cause was that this
product had no place to keep what it knows about a thread. The scope below is
the whole read model, and the quit path is one of its callers.

## Decision

Thread *information* — what a thread is called, what project it belongs to,
whether it is archived — is held in a store of its own, separate from every
cache that answers a query. `ThreadInfoStore` (`app-server/thread-info-store.ts`)
is that store. Callers that need a fact about one known thread read it
synchronously; callers that need to know which threads match a question keep
using the list caches, which stay free to be discarded.

Quit blocker membership remains owned by the live runtime registries. Quit
blocker display titles come from the store. Building or polling the quit queue
never starts or awaits a provider thread-list request, a peer request, or
directory/Git enrichment.

### Why a second structure rather than a better cache

A query cache answers *"which threads match Q, in what order"*. That answer
expires: a new turn, a rename, or an archive can change it, so throwing it away
on mutation is correct.

An information store answers *"what is thread X called"*. That answer does not
expire the same way. A rename supersedes it; nothing else does. Discarding it
is never right, because the alternative to a slightly stale name is not a
fresher name — it is a raw UUID on screen.

The defect was that one structure was being asked both questions. Four
consequences followed, each of which the store removes:

1. **Invalidation was amnesia.** Roughly forty-six call sites clear the list
   cache. Every one of them was also erasing the only record of what threads
   were called.
2. **Point queries were answered by full-collection walks.** Sixteen sites
   wanted one row and rebuilt every row to get it. The measured case:
   `turn/started` invalidated the cache, and `active-turn-branch-adoption` then
   drove a complete paged provider `thread/list` to read a single field — one
   full listing per turn boundary.
3. **Query-shaped keys fragmented identical reads.** Six concurrent callers
   asking the same question produced more than one provider call.
4. **Absence was conflated with unknown.** `title: undefined` meant both "this
   thread has no title" and "we knew the title and this particular lookup did
   not return it", so the second case overwrote the first.

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
- Invalidating a query cache never removes thread information. Only the thread
  or the peer going away does.
- A read-only caller never drives a provider round trip to learn a fact the
  store already holds.
- Two threads that share a backend and id, on different instances, never share
  an entry.

## Data Ownership and Identity

`ThreadInfoStore` holds one entry per thread, and each *field* in that entry
carries its own observation sequence and source. Fields are graded
independently because observations are partial: a lifecycle notification
teaches a title and nothing else, a listing row teaches a project label, and
neither should have to arrive with the other to be believed.

Tracked fields are `title`, `titleSource`, `projectLabel`, `archived`, and
`updatedAt`. Sources are `lifecycle-notification`, `local-rename`,
`provider-list`, `remote-navigation`, and `remote-pin`.

Identity is `instanceId::backend:threadId`, with the instance segment omitted
for local threads. Backend is part of the key even when two providers reuse a
thread id, and instance is part of it because thread ids are only unique within
the instance that minted them. A local thread and two peers' threads numbered
alike cannot answer for each other.

`DesktopBackendRegistry` owns one store for locally-owned threads.
`RemoteThreadSummaryCache` owns a second for threads owned by peers, keyed by
instance; `forgetInstanceThreadNames` drops a peer's names when it unmounts and
can no longer be asked. Persisted remote pins remain a local fallback. Quit
never contacts a peer to learn a label.

No new persistent state is introduced. Both stores are process-local, so there
are no new SQLite writes or write budgets.

### Merging rule: positive facts only

An observation states what it saw. It does not state what it did not see.

- An omitted field is not a deletion.
- An empty or whitespace title is not news.
- A `fallback` title source means the title *is* the thread id; recording it
  would overwrite a real name with nothing.
- Title and title source are validated together, so a `fallback` source cannot
  arrive without its title and downgrade a name already held.
- Re-observing the same value at a newer sequence advances the sequence without
  reporting a change, so a confirmation does not read as an edit.

`forget` and `forgetInstance` are the only ways an entry leaves the store, and
both are driven by the thread or the peer actually going away — never by cache
invalidation.

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
store returns no title and the existing UI falls back to the thread id. It
never guesses from another backend or instance.

### Callers declare the freshness they need

`findThreadForWorkspaceHandoff` takes a `freshness` argument, and the caller
answers one question: *am I about to act on this, or only display it?*

- `"provider"` (the default) keeps the existing behavior — consult the
  provider, because the caller is about to mutate something and a stale answer
  would be acted upon.
- `"last-known"` answers from the store when it has the thread, and falls
  through to a provider read only when it does not.

Four read-only callers now pass `"last-known"`: `transcript-image-roots`,
`branch-drift`, `active-turn-branch-adoption`, and `turn-cwd`. This is where
the largest measured win came from. `turn/started` invalidates the list cache,
so `active-turn-branch-adoption` was rebuilding the entire thread list on every
turn boundary to read one row from it.

Because a listing row that has not been enriched can lack `worktreePath`,
`getSummary` accepts `requireEnriched`. A caller whose reason implies directory
enrichment declines an unenriched cached row rather than answering with a field
it knows may be missing. The store grades what it holds; it does not pretend an
unenriched row is an enriched one.

### Archival is an observation, not a refetch

`thread/archived` and `thread/unarchived` notifications are recorded as
observations of the `archived` field, at the sequence the notification is
processed. The alternative — invalidating and re-listing to discover a fact the
notification already stated — is the same round trip this design exists to
remove. The recording happens in the event fan-out rather than in the client
subscription, so locally published events take the same path as provider ones.

## Read Path

`DesktopBackendRegistry.getThreadInfo(identity)` is the synchronous read.
Quit snapshot creation uses it for every active-turn owner after sub-agent
ownership has been collapsed, and the quit title resolver uses it for local
terminal rows. Neither calls `listThreads({ callerReason:
"quit-confirmation" })` any more.

The same read serves every other caller that wants one fact about one known
thread, which is what removes the full-collection walk described above.

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

Provider reads are budgeted the way SQLite writes already are in this
repository: a checked-in JSON file of exact counts per named scenario, asserted
by tests. `apps/desktop/src/main/__tests__/fixtures/thread-read-budgets.json`
records `providerListCalls` and `directoryEnrichments` for each scenario, and
`expectThreadReadBudget` fails when either count deviates **in either
direction**. A count that drops is as much a change to review as one that
rises: it usually means a read stopped happening that something still depends
on. Re-record with `UPDATE_THREAD_READ_BUDGETS=1`.

Current recorded budget:

| Scenario | Provider lists | Directory enrichments |
|---|---|---|
| Ten complete turns on a thread the navigation refresh already observed | 0 | 0 |
| Five turns with label reads between every lifecycle event | 0 | 0 |
| Five turns on an already-enriched worktree thread | 0 | 0 |
| Twenty quit-dialog polls against an in-progress turn | 0 | 0 |
| Fifty synchronous label lookups for a thread observed once | 0 | 0 |
| A second window's navigation refresh against a warm list cache | 0 | 0 |
| Six concurrent callers asking for the same unenriched listing | 1 | 0 |
| Eight terminal notifications across two never-listed threads | 1 | 0 |
| One navigation refresh over a single worktree-backed thread | 1 | 1 |

The three nonzero rows are the shape the design intends: a thread nobody has
ever listed costs exactly one listing however many callers ask at once, and
enrichment happens once per worktree thread rather than per read.

For quit snapshot construction and repeated live-queue polls specifically:

- full provider thread-list refreshes: **0**
- directory/Git enrichment calls for labels: **0**
- peer/network title requests: **0**
- SQLite writes: **0**

Local title work is O(number of blockers) map lookup. An unresolved remote
batch may perform one existing read of persisted remote pins; it performs no
write.

The budget is enforced with deterministic call-count assertions, not elapsed
time. The enrichment counter is exercised with worktree-shaped fixtures so it
provably can move — a budget that cannot move proves nothing.

## Compatibility With PR #1896

PR #1896's `getCachedThreadSummary()` serves targeted messaging admission and
is broader than a title read. Its current cache scan does not cover names
observed from lifecycle/name notifications.

This change does not cherry-pick or duplicate PR #1896's messaging work. On a
later rebase, `getCachedThreadSummary()` can retain its admission contract and
thread-list cache scan; where it needs a display title, it can read the store.
Quit continues to call `getThreadInfo` and never treats title-only knowledge as
a complete navigation/admission summary. Keeping the responsibilities separate makes the
backend-registry overlap mechanical rather than architectural.

## Test Matrix

| Contract | Focused coverage |
|---|---|
| Ordinary local active turn is named | Seed an already-observed non-fallback title, start/observe a normal turn, and assert the first synchronous quit snapshot carries it. |
| Sub-agent ownership remains named | Preserve the existing owner-collapse case and verify it reads the same store. |
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
| Store contract | `thread-info-store.test.ts` covers per-field sequencing, positive-facts-only merging, fallback rejection, enrichment grading, identity keying, and forget/forgetInstance. |
| Read budgets | `thread-read-budget.test.ts` drives each named scenario against a counting backend client and asserts the checked-in counts exactly. |
| Remote ordering | A peer snapshot that started earlier but finished later cannot revert a newer name; a rename recorded afterwards still wins. |
| Remote isolation | Two peers reusing one thread id keep separate names, and unmounting one peer drops only that peer's names. |
| Reservation ordering at the IPC seam | The navigation-snapshot handler reserves its observation sequence strictly before the peer round trip begins. |

Every test in the last four rows was falsified before being kept: the fix was
reverted, the test was watched to fail, and the fix restored. A test that
passes against the defect it names is not coverage.

No new desktop E2E is planned because this change introduces no renderer,
dialog, IPC-shape, or interaction contract — it changes where the main process
keeps what it already knew. The main-process unit tests can
deterministically prove the provider-call budget and freshness ordering, while
PR #1903's component tests already exercise the live-poll presentation seam.
Adding a headed replay would duplicate those contracts without exposing a new
failure mode.
