# Operator wait chip context profiling

Measured on 2026-11-14 from isolated `origin/main`
`2e8898440c79914c6d7ddaeb12221bc59a308d81`, with contrived data only.
The earlier six-row, three-switch recording at `653a1208f` reported 15
context-only chip renders and three with context plus thread changes. That
recording motivated this experiment; its attribution does not establish that
all 18 renders were unnecessary. Selection can mark real items seen.

## Context paths and equality

`App` provides all three contexts around the renderer's main surfaces.

| Context | Consumers | Producer behavior |
| --- | --- | --- |
| `OperatorWaitsContext` | `ThreadMetaChips` through `useOperatorWaitsContext` | `useOperatorRequests` preserves the complete wait array when ordered keys and owner-cached thread titles match. Equal seen sets keep their identity. Any changed wait array rebuilds every per-thread array. App memoizes the context on readiness, map, seen set and `openOperatorWait`; selection can also change the action's identity. |
| `ThreadTodoCountsContext` | `ThreadMetaChips` through `useThreadTodosForKey` | `useThreadTodos` groups the owner feed plus selected remote cards. An empty delta retains the feed and map, while revision still advances for Done-list freshness. Upserts rebuild the feed and per-thread arrays, including content-equal upserts. Selected remote reads compare JSON before replacing cards. |
| `ThreadDependencyIndicatorsContext` | `ThreadMetaChips`, `Sidebar`, `ThreadContextPanel`, `ContinueAfterStatus` | `useThreadDependencyIndicators` compares map size and every indicator's count, alert, merge-held flag, label and tooltip. Equal summaries retain the map. Changed summaries replace it; App's map-dependent context memo also creates a new `open` action. Refresh failure retains the last list. |

The dependency reader preserves owner-qualified keys and the remote-window
fallback. Sidebar reads the full dependency collection for menu state;
the context panel uses it for dependency status, and the banner reads its
open action. The two item contexts have only the chip consumer. The separate
reveal context supplies the current to-do action.

## Method

Darwin arm64; Electron 44.10.1, React 19.3.1, standalone React DevTools 8.0.0
(build `1d34f91dfd`), Node 24.22.1. This is a development build under StrictMode,
with the same instrumentation before and after. No development duration is
reported as production cost.

An isolated PwrAgent root and replay backend were used. A temporary renderer
route mounted the real producer hooks and `ThreadMetaChips` under the same
context memo dependencies as App. Memoized rows retained their thread objects;
20 or 40 mounted rows each had a contrived question. The card scenarios seeded
one card per row. Provider, branch, viewport and tooltip state stayed fixed;
no virtualization or thread navigation occurred inside these recordings.
This deliberately separates item broadcasts from selection and session changes.

Computer Use was unavailable (native pipe and browser host startup failures).
Playwright/CDP operated the task's Electron and standalone DevTools windows.
The displayed bridge endpoint and checkout path matched the isolated target.
DevTools' **Record why each component rendered** setting was checked. Actual
exports include change descriptions; inspecting components in the frontend
showed **Context changed** before and **Props changed: unreadItemCount** for a
necessary own-row freshness update after the patch.

Each run applied 20 sequential updates after setup. Empty/equal controls were
also recorded. Card seeding is excluded from the table: the final 20 commits
are the measured deltas. No mounts are included. Wait scenarios issue 20 owner
list reads, to-do deltas issue zero additional snapshots/list reads, and
dependency markers issue 20 debounced active-list reads. Those operations are
unchanged by the patch. Equal wait/dependency controls have zero recorded
commits; empty to-do deltas update controller revision without chip renders.

## Render results

Counts are full chip-content executions, established by DevTools change
descriptions. Before the patch that function was `ThreadMetaChips`; afterward
it is `ThreadMetaChipsContent`. The exported `ThreadMetaChips` adapter still
subscribes to all three contexts and still executes on their broadcasts.

| 20 updates | 20 rows before → after | 40 rows before → after | Attribution |
| --- | ---: | ---: | --- |
| Different-thread seen keys; visible items unchanged | 400 → 0 | 800 → 0 | Before: context only. After: adapters only, 400/800 executions. |
| One displayed row's seen question toggles | 400 → 20 | 800 → 20 | After: `unreadItemCount` changes only on that row. |
| Equal owner wait snapshot | 0 → 0 | 0 → 0 | Producer retains identities. |
| Different-thread question changes | 400 → 400 | 800 → 800 | After: `waits` arrays change. |
| Empty to-do delta | 0 → 0 | 0 → 0 | Producer retains card-map identity. |
| Different-thread to-do upsert, with cards on visible rows | 400 → 400 | 800 → 800 | After: `openTodos` arrays change. |
| Equal dependency summary | 0 → 0 | 0 → 0 | Producer retains map identity. |
| Different-thread dependency changes | 400 → 400 | 800 → 800 | After: `openContinueAfter` action changes. |

## Short-lived allocation samples

Sampling was separate from React recordings. Each size/revision used three
runs of the same 20 different-thread seen updates, after a small warmup.
CDP `HeapProfiler.startSampling` used a 16,384-byte interval and both
`includeObjectsCollectedByMinorGC` and `includeObjectsCollectedByMajorGC`.
An explicit GC preceded each sample. These are summed sampled allocation
weights, including collected objects, not retained-heap measurements.

| Mounted rows | Before MB: median (range) | After MB: median (range) |
| --- | ---: | ---: |
| 20 | 35.77 (23.78–38.38) | 4.70 (4.64–4.92) |
| 40 | 55.91 (39.39–59.62) | 7.61 (7.15–7.91) |

MB means 1,000,000 bytes. Sampling is stochastic, baseline spread is material,
and development/DevTools overhead is included. The reduction agrees with the
render and operation budgets; it does not establish exact production savings,
a memory leak, or an attribution for the original `hot-0003` GC interval.

## Change and regression evidence

The context adapter projects only this thread's unread item count and passes
actual waits, cards, dependency indicator and current actions through a
standard React memo boundary. Chip contents keep their provider/reveal context
subscriptions and local tooltip state. Freshness projection uses counting
loops instead of allocating two filtered arrays on every broadcast. No custom
item equality, owner persistence, polling or refresh operation was introduced.

The generated owner-snapshot regression failed on baseline and shrank to one
row and one unrelated seen key (`[1, [0]]`). The 20/40-row budgets also failed
before the change: 2,400/4,800 tooltip-hook invocations and 400/800 filtered wait
arrays, against budgets of zero. After the patch the adapters still perform
400/800 projections and 20 owner reads; chip tooltip work and filtered wait
arrays are zero. A displayed row's actual freshness change still invokes its
chip contents.

A generated item model covers local and remote owners sharing a thread id,
questions, cards, monotonic seen facts, item resolution, dependency changes,
initial queue readiness, fallback input flags and replacement actions. Its
oracle checks displayed item/unread counts and invokes the current question,
card and dependency actions after each operation.

Only sanitized numerical findings are checked in. Raw React exports, sampling
profiles, temporary harness sources and screenshots remain in the ignored
checkout-local `.local/operator-waits/` directory. The temporary route, debug
switch and profiling processes were removed after measurement. The operator
app/profile was not used. Session-indicator identity work (#3715) and the
federation/pin refresh thread were notified; their implementation was untouched.
