# Rendering diagnostics

Use this capture when a PwrAgent Chromium GPU helper stays busy. CPU profiles
alone can miss compositor animations: CSS transforms and opacity can keep
submitting frames without React commits or JavaScript animation callbacks.
The capture uses Chromium CDP tracing through a managed Electron debugger connection.
It works in release builds and requires no restart or graphics setting changes.

## Collect

In **Settings → Troubleshooting → Rendering diagnostics**, select **Capture
Rendering (10s)**. This works without Developer Mode or a restart. It waits five
seconds before calling the existing capture API for a ten-second sample. Close
Settings and DevTools during the delay, then leave the scene undisturbed until
the capture finishes. You can cancel during staging. Leaving Settings does not
cancel the delay or capture; keep the requesting window open during staging.
Renderer throttling can extend the staging delay, but the main process still
owns the ten-second capture deadline once tracing starts.

A completion notice shows the sanitized summary path. Return to the same
window's Troubleshooting pane to copy the path and see the recorded duration;
open `summary.json` in a local editor. A failure appears both in the notice and
the pane, where you can retry after resolving it. Status and the last result are
in memory for that window only, with no settings or SQLite writes. The control
does not run a countdown or poll while capturing.

### Console alternative

1. Open Developer Tools in the PwrAgent instance to investigate. In its console:

   ```js
   window.renderingCapture = new Promise(resolve => setTimeout(resolve, 3000))
     .then(() => window.pwragent.captureRenderingDiagnostics(10));
   ```

2. Close Developer Tools within three seconds, leave the window undisturbed,
   then reopen it after the ten-second capture. Read the result:

   ```js
   await window.renderingCapture
   ```

   The result gives `summaryPath` and `durationMs`. The JSON lives in the active
   PwrAgent profile's `state/diagnostics/rendering-*/summary.json`. The three-second
   staging delay is optional; `await window.pwragent.captureRenderingDiagnostics(10)`
   starts immediately. DevTools itself causes rendering, so keep its state the
   same when comparing captures.

3. To finish early from any window in the same instance:

   ```js
   await window.pwragent.stopRenderingDiagnostics()
   ```

Only one capture can run per instance. Duration must be 1–30 seconds (default
10). The main-process deadline survives a hidden or stalled requesting renderer.
App shutdown also stops an active capture. The first live window hosts the CDP
connection; destroying that host or replacing its debugger aborts the capture
with a sanitized failure. No replacement connection is detached or stopped.

Acquisition uses CDP `Tracing.start`, which rejects an existing Chromium trace,
including a session started through Electron `contentTracing`. The capture sends
`Tracing.end` only after its own start succeeds, and never retries an end command.
Electron 44.9.3's [`contentTracing.startRecording` documentation](https://github.com/electron/electron/blob/v44.9.3/docs/api/content-tracing.md#contenttracingstartrecordingoptions)
explicitly says it resolves when a recording already exists; that API cannot
establish ownership and is no longer used by this capture.

Rendering and HotCpuProfiler acquire separate exclusive CDP domain leases on
one managed debugger attachment. Either can stop first; only the last lease
releases the connection. A rejected trace start releases only its own lease.
An unknown debugger attachment or open DevTools on the host causes capture to
fail without attaching, detaching, or sending trace commands. Close DevTools
before starting a capture. This does not interrupt an existing CPU recorder.

## Read the evidence

`samples` contains at most one sample per second, up to 16 windows and 64
processes per sample. Join `trace[].pid` to `samples[].state.windows[].pid` or
`processes[].pid`. Windows have numeric native and WebContents IDs, visibility,
minimized/focused state, and a fixed view label. This includes background windows.
Renderer reads time out after 750 ms; `renderer: null` means unavailable, not idle.

Each trace event has a count and `activeSeconds`: zero-based one-second buckets
relative to the first non-metadata event in the trace. Event availability varies
with Chromium and platform. Compare repeated captures of the same scene:

| Evidence | Interpretation |
| --- | --- |
| Repeated `DrawFrame` / `SubmitCompositorFrame`, few `Paint` / `Layout` / `FireAnimationFrame` events | Consistent with compositor-only work, including CSS animations. |
| Repeated `FireAnimationFrame` and `Paint` / `Layout` | Inspect JS animation or canvas work with existing CPU / React DevTools profiling. |
| `TimerFire`, `FunctionCall`, and increasing `updateCounts` | Inspect polling, IPC subscribers, and the named update edges. Counts are requests, including no-ops, not React commits. |
| Frames associated with a hidden window | Compare its renderer visibility and animation samples; window visibility alone does not prove that Chromium stopped work. |

`renderer.animations[].state` is `[name, source, playState, infinite, inViewport]`;
`count` groups identical states. Names and source selectors use a fixed allowlist.
For example, `pwragent-thinking-scanner-sweep` with `.thinking-scanner` identifies
the running-turn beam; `pending-spinner-spin` identifies the shared spinner.
Unknown names and selectors become `other`. Only the first 128 animations per
window are examined, with an omission count. Geometric viewport intersection
does not establish whether an element is occluded or actually drawn.

`updateEventNames` decodes each renderer's numeric `updateCounts`. Compare counts
between samples. These cover selected composer, Tiptap, context-card and tooltip
edges, not every React component. `processes[].cpuPercent` is Electron CPU usage,
not GPU usage. Trace counts cannot be converted to machine GPU percentages.
GPU-process events can serve several windows; only renderer-process events join
directly to a window. Correlation is a lead, not proof of causality.

The native buffer is 8 MiB and stops accepting events when full. Inspect
`bufferUsage.percentage`, the largest CDP `Tracing.bufferUsage.percentFull`
report received during capture (reported every 250 ms). `value` is the largest
reported event count. These are periodic observations, not a final buffer query. Near 1, treat trace event counts as lower bounds:
native `activeSeconds` buckets can stop before the capture ends, even while
snapshots continue. The earlier contentTracing-based v1.3.5 ten-second capture returned
`{percentage: 0.9853219985961914, value: 0}`; its native event buckets stopped
before the capture ended. Missing later buckets do not establish idle rendering.
Use a shorter capture to avoid saturation. A JSON expansion above 64 MiB is
rejected.

## Controlled comparison

`pnpm test:desktop-e2e e2e/rendering-diagnostics.spec.ts` runs the checked-in
comparison (use Sandboxer when connected, per repository guidance). It creates a
contrived window with no React, polling or rAF. It captures the same spinner
first paused, then running, and compares native `DrawFrame` counts for that
renderer PID. The animation snapshot identifies the spinner in the running
capture. This tests the capture in the built, minified app too. The same spec starts an
external `contentTracing` recording, verifies the rendering request fails, and
then successfully stops the original recording through its owner. It also checks
that a real HotCpuProfiler recording survives rendering collection on the shared
connection.

Observed on Ubuntu x64 in Sandboxer with Electron 44.9.3 (2026-10-28):

| Same fixture renderer, two-second capture | `DrawFrame` events |
| --- | ---: |
| Spinner paused | 0 |
| Spinner running | 121 |

This validates the collection and source attribution on a controlled scene. It
does not identify the component behind an operator's live GPU activity or measure
hardware GPU utilization.

For an investigation, compare idle, active, and paused captures in an isolated
instance before changing live state. Pause only the animation under investigation
and repeat the same collection. Existing React DevTools and hot-CPU diagnostics
can then locate a JS/component source when native timeline counters warrant it.

## Cost and privacy

There are no timers, debugger attachments, trace sessions, IPC samples, or SQLite
writes from this feature until requested. While capturing, snapshots read existing
update counters and browser animation state; they do not change animations or
schedule animation frames. The native trace is instance-wide and briefly adds
tracing overhead, so compare against the same collection conditions.

The exported summary contains fixed event/animation/view labels, numeric IDs,
counts and window state. It excludes window titles, URLs, paths inside pages,
DOM text, animation keyframes, custom class names, React props, JS stacks, trace
arguments, and screenshots. Chromium's argument filter remains enabled. The returned CDP stream is read in
64 KiB chunks into a mode-0600 raw file inside a private capture directory. The
stream is closed and the raw file removed before the result resolves or rejects. A process crash or cleanup failure can leave that temporary file: treat it as
private and delete it locally. Raw traces and logs must stay out of Git and PR
attachments. Share only the relevant sanitized counts and conditions.
