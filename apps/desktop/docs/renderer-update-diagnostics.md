# Renderer Update Diagnostics

Moved verbatim from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps
a summary and says when to read this document.

## Renderer update diagnostics in release builds

For continuous compositor/GPU work, use the opt-in, bounded
[rendering capture](../../../docs/rendering-diagnostics.md). It associates native
Chromium frame counters with numeric window IDs, visibility and known animation
sources, without enabling continuous profiling.

The renderer keeps a 64-entry in-memory history of selected composer, Tiptap,
context-card, and tooltip update requests. Consecutive identical requests
coalesce; counters retain totals since renderer startup. These are requests,
including no-ops, rather than React render or commit counts. Scope labels are
static composer modes or React-generated tooltip IDs. No draft text, document
contents, thread IDs, paths, or token usage enter the recorder.

In the Electron DevTools console, inspect:

```js
window.__pwragentRendererUpdates.snapshot()
window.__pwragentRendererUpdates.lastError()
window.__pwragentRendererUpdates.eventNames
```

`eventNames[event.event]` decodes an event code; `counts` uses the same order.
`firstMs`, `lastMs`, and `capturedAtMs` are renderer `performance.now()` times.
Snapshots are detached copies. `lastError()` retains the latest reported
failure through automatic recovery; a renderer reload clears this history.
The error boundary captures before failed-tree teardown. The first identical
global error or unhandled rejection in a one-minute window captures at notification
time; further notifications increment a count without capture or IPC. One trailing
timeout, eviction, or teardown flushes the repeat count and timestamps without
replacing the retained snapshot. Renderer and main summary tables each have 64
slots with bounded summary strings and fixed-size keys. Explicit recovery reports
remain immediate. Each admitted renderer window has its own fixed-size ID, used
by main for summary and detail admission so IPC latency cannot suppress the next
window's snapshot. Merged repeat batches retain their earliest/latest occurrence
timestamps. See [../../docs/renderer-recovery.md](../../../docs/renderer-recovery.md)
for the delivery and eviction limits.

Normal recording has no timers, IPC, logging, or database writes. Fixed arrays
use 1,944 bytes for numeric storage and scope-reference slots, plus JavaScript
object/string overhead. A reported error also retains one bounded snapshot.
Main logs `report update diagnostics` as a separate JSON string, capped at
8 KiB, associated with the existing `stackId`. Identical fault details are
budgeted by their renderer reporting window; reports without window metadata use
main's one-minute interval. The log includes event names and the number of
entries omitted to meet the limit. This history covers the instrumented edges;
it does not identify every React setter or prove which request caused a loop.
