# Per-thread item identity profiling

Measured on 2026-11-16 from isolated origin/main
`32692f0e831d62b37b1ea7e8040fe89e221097fe`, after #3718 and the separate draft
projection change. This continues [the freshness measurement](operator-wait-chip-profiling.md).
The draft store, lens, ThreadRow, RecentsList and DirectoriesList are unchanged.

## Provenance and rule

A changed item on one thread must not replace another thread's unchanged chip
inputs. Keep the owner-qualified keys, item order, current data and actions.

`useOperatorRequests` already treats request contents as immutable: its full-list
equality compares ordered item keys and owner-cached thread titles. Async question
storage preserves the first message record with `INSERT OR IGNORE`; answering or
dismissing removes it from the open list. Pending server requests remain owned by
the registry. The new per-thread sharing uses the same existing key/title rule;
a thread title update still replaces that thread's wait and action payload.

To-do cards are mutable. Their groups compare actual card references, retaining
no changed card merely because its id, timestamp or title matches. Feed deltas
replace upserted objects. Selected remote cards continue to override the feed
for the selected owner; the grouping runs after that merge, using its existing
owner key. Done-list revision advances and selected-card reload rules are intact.

Dependency summaries already compare count, alert, merge-held state, label and
tooltip. Sharing reuses each equal indicator, using those same fields. The
Continue After action now depends on the dialog setter independently of the
indicator map, and still follows capability and setter changes.

The grouping helper retains owner order, copies only changed groups and never
mutates a previous map or list. Its cache advances in a layout effect after
commit, so a suspended speculative render cannot replace the committed cache.
No owner state, storage write, transport or refresh schedule was added.

## Method

Darwin arm64; Node 24.22.1, Electron 44.10.1, React 19.3.1, standalone React
DevTools 8.0.0 (`1d34f91dfd`). Development StrictMode, renderer viewport
1440×939 CSS pixels at devicePixelRatio 2. DevTools used an 800×600 CSS-pixel
window. Development durations are not reported as production cost.

The app used a private PwrAgent root and replay backend. A temporary route
mounted the real three producer hooks and ThreadMetaChips under memoized rows
with stable thread objects. Every visible row had a question, card and active
dependency, with branch/provider metadata fixed and tooltips closed. All 20 or
40 rows were mounted; there was no virtualization, selection or lens change.

For a testable dependency-action seam, the original App context memo was moved
unchanged into `useThreadDependencyIndicatorsValue` before baseline capture.
The baseline retained its original map-dependent inline action. The fixture
and App use that same hook; the fix makes its action independent of the map.

Computer Use failed to start its native pipe and browser host. Playwright/CDP
therefore operated only this task's isolated app and standalone DevTools.
Bridge 8107 and CDP 9361/9362 were task-owned; the occupied 8097 endpoint was
not used. The renderer console named this checkout and bridge, and the renderer
URL matched the task's main-process launch log. Why-rendered recording was
enabled in DevTools. Actual frontend inspection and exports showed the named
changed props below. Raw files stay in ignored `.local/item-identities/`.

Each recording applied 20 sequential updates after all producers and row counts
settled. Different-thread changes touched an offscreen item; own-row controls
changed one visible question/card/dependency. Warmup, seeding and mounts are
excluded. A control run inconsistent across HMR was discarded; final after
recordings and samples were repeated from a cold reload with no HMR during them.

## Attributed renders

Counts are committed ThreadMetaChipsContent updates, not adapter function calls.
There were no mounts in the measured recordings.

| 20 updates | 20 rows before → after | 40 rows before → after | Before changed props / necessary after props |
| --- | ---: | ---: | --- |
| Offscreen wait change | 400 → 0 | 800 → 0 | waits |
| Offscreen to-do upsert | 400 → 0 | 800 → 0 | openTodos |
| Offscreen dependency change | 400 → 0 | 800 → 0 | dependency, openContinueAfter |
| Visible question change | 400 → 20 | 800 → 20 | waits |
| Visible card change | 400 → 20 | 800 → 20 | openTodos |
| Visible dependency change | 400 → 20 | 800 → 20 | after: dependency only |
| Equal wait snapshot | 0 → 0 | 0 → 0 | identities retained |
| Empty to-do delta | 0 → 0 | 0 → 0 | revision advances without chip work |
| Equal dependency summary | 0 → 0 | 0 → 0 | identities retained |

Adapters still subscribe to the maps and commit 400/800 updates on changed
contexts. Wait scenarios still perform 20 owner list reads; dependency scenarios
perform 20 active-list reads through the existing debounce. To-do deltas perform
zero additional snapshot/list reads. These operation counts did not change.

## Short-lived allocations

Samples were separate from React recordings: three repeats of each offscreen
scenario/size/revision, 20 updates per sample, after warmup. CDP sampled at
16,384-byte intervals with `includeObjectsCollectedByMinorGC` and
`includeObjectsCollectedByMajorGC`, with an explicit GC before each sample.
The table sums sampled allocation weights, including collected objects.

| Offscreen scenario | Rows | Before MB: median (range) | After MB: median (range) |
| --- | ---: | ---: | ---: |
| wait | 20 | 41.84 (22.11–43.99) | 5.19 (5.08–5.21) |
| todo | 20 | 40.42 (21.87–44.14) | 4.96 (4.60–5.07) |
| dependency | 20 | 54.56 (54.09–55.71) | 5.53 (5.14–5.56) |
| wait | 40 | 62.59 (43.01–64.18) | 8.90 (8.46–9.00) |
| todo | 40 | 60.50 (42.44–61.66) | 7.63 (7.28–8.25) |
| dependency | 40 | 107.00 (104.51–110.04) | 8.84 (8.48–8.95) |

MB means 1,000,000 bytes. Sampling is stochastic, baseline spread is material,
and React development/DevTools overhead is included. These are not retained-heap
measurements or exact production savings. They establish neither a leak nor
causality for the original hot-0003 GC interval.

## Regressions and budgets

Before the fix, all three mounted identity properties failed and shrank to one
local/remote pair and one offscreen update. The N/2N budgets, wait-title namesake
check, dialog-action identity check and selected-overlay model also failed.
Real-row tooltip and action controls passed before and after.

The filter oracle generates grouped snapshots with inserts, removals, reordered
items, empty groups and owner collisions. It checks values, order, unchanged
identities and previous-input immutability. The selected-owner model generates
feed changes, owner changes, offscreen changes and selection changes, checking
that the selected owner remains authoritative and offscreen deltas cost no
selected-card read. UI controls check current question payloads, renamed owner
titles, to-do/dependency tooltips and actions; replacement dialog setters and
capability removal are also covered.

Mounted budgets run under StrictMode. For 20 offscreen updates at 20/40 rows,
they allow exactly 800/1,600 adapter function calls (development double render),
zero chip tooltip-hook calls, and 20 changed published groups. Read budgets are
20/0/20 for wait/todo/dependency scenarios, with zero additional to-do snapshots.
A pure grouping budget alternates 20 changed and 20 equal projections: only 20
changed arrays, at most 840/1,640 key reads and 839/1,639 comparisons.
Lowering the operation limits by one fails both size tests.

A generated Suspense regression verifies that speculative projections retain
committed identities. A temporary render-time cache mutation makes it fail;
the committed-effect implementation passes. Only the committed implementation
and reviewed budget values are retained. No test depends on sampled heap bytes
or development durations.

All profiling processes were closed, and temporary route/debug changes removed.
Raw exports, heap samples, screenshots and the harness remain private. No live
operator app/profile was used, and no request was sent to the #3715 thread.
