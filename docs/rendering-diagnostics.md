# Rendering diagnostics

Use this capture when a PwrAgent Chromium GPU helper stays busy. CPU profiles
alone can miss compositor animations: CSS transforms and opacity can keep
submitting frames without React commits or JavaScript animation callbacks.
The capture uses a dedicated Chromium CDP tracing session.
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
10). The main-process deadline survives a hidden, closed, or stalled requesting
renderer. App shutdown also stops an active capture. A conflicting Chromium
CDP tracing session fails the request; it is not taken over. Rendering and native
CPU captures use the same internal Chromium trace lease contract. A hidden, blank
window owns rendering's debugger connection, independently of DevTools and the
requesting window; it is excluded from window samples and destroyed on cleanup.
The standalone fixture also verifies existing Electron `contentTracing` ownership.
Rendering never calls its global start or stop methods.

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
Chromium 152 scopes page tracing to its debugger session tree. Rendering attaches
application pages as child sessions of its blank target and discovers new pages
during the capture. Chromium admits those renderers, their process replacements,
the browser and GPU. Cleanup removes only these child sessions; existing
DevTools or V8 profiler connections remain owned by their callers.

The native buffer is 8 MiB and stops accepting events when full. Inspect
`bufferUsage.percentage`, the peak of CDP's buffer reports at 250 ms intervals;
`bufferUsage.value` is the peak reported event count. The final interval may be
missing. `dataLossOccurred` comes from the completion event (`null` if unavailable).
Near 1 or when data loss is reported, treat trace event counts as lower bounds:
native `activeSeconds` buckets can stop before the capture ends, even while
snapshots continue. The earlier contentTracing-based v1.3.5 ten-second capture returned
`{percentage: 0.9853219985961914, value: 0}`; its native event buckets stopped
before the capture ended. Missing later buckets do not establish idle rendering.
Use a shorter capture to avoid saturation. A JSON expansion above 64 MiB is
rejected. Start acknowledgement, stop completion, and stream transfer each have
a five-second budget. Shutdown sends `Tracing.end` before awaiting renderer
samples or transfer. A failed or stalled capture destroys its own CDP target;
an unclosed stream gets at most one additional second for cleanup.

## Controlled comparison

`pnpm test:desktop-e2e e2e/rendering-diagnostics.spec.ts` runs the checked-in
comparison (use Sandboxer when connected, per repository guidance). It creates a
contrived window with no React, polling or rAF. It captures the same spinner
first paused, then running, and compares native `DrawFrame` counts for that
renderer PID. The animation snapshot identifies the spinner in the running
capture. This tests the capture in the built, minified app too. The same spec starts an
external `contentTracing` recording, verifies the rendering request fails, and
then successfully stops the original recording through its owner. It also checks
that a real HotCpuProfiler recording survives rendering collection on its
independent connection.

Observed on Ubuntu x64 in Sandboxer with Electron 44.9.3 (2026-10-28):

| Same fixture renderer, two-second capture | `DrawFrame` events |
| --- | ---: |
| Spinner paused | 0 |
| Spinner running | 121 |

This validates the collection and source attribution on a controlled scene. It
does not identify the component behind an operator's live GPU activity or measure
hardware GPU utilization.

### Trace ownership fixture

`node apps/desktop/scripts/probe-rendering-trace-ownership.mjs` runs standalone
Electron processes with temporary user data and invented page content. It does
not boot PwrAgent. On Linux, run it under `xvfb-run -a`. It starts an external
CDP trace, requires rendering to reject without a global stop or output, verifies
the external owner still holds its recording, then checks a fresh rendering
capture. A second process verifies that an external `contentTracing` recording
can still be stopped by its original owner. Temporary data and traces are
deleted by the runner. Only sanitized booleans, counts, versions and timings
are printed.

For a before/after comparison, point `PWRAGENT_RENDERING_CAPTURE_SOURCE` to the
capture module in a separate committed baseline worktree and set
`PWRAGENT_RENDERING_EXPECT_BASELINE=1` to report the old behavior without requiring
the new assertions. Electron 44.9.3's
[documentation](https://github.com/electron/electron/blob/v44.9.3/docs/api/content-tracing.md#contenttracingstartrecordingoptions)
and [implementation](https://github.com/electron/electron/blob/v44.9.3/shell/browser/api/electron_api_content_tracing.cc#L214-L235)
show why a resolved `contentTracing.startRecording()` promise does not establish
ownership: the binding resolves even when Chromium refuses to start recording.

### Pending spinner visibility

The same spec bundles the production `pendingSpinnerRef` and its shared
IntersectionObserver into a contrived window with six rings and the built app's
spinner CSS. It compares three-second captures with an explicit paused baseline,
the former always-running behavior, and the visibility ref. It checks viewport
exclusion, clipping by a scroll container, scrolling back into view, and a
`display: none` pane. Unit tests cover document visibility changes and ref
cleanup. Read the built CSS bytes:
Chromium's CSSOM serialization drops the variable `border` shorthand after its
`border-top-color` override, leaving an invisible animated box in a copied rule.

Observed on Ubuntu x64 in Sandboxer with Electron 44.9.3 (2026-10-31):

| Six rings, same renderer | `DrawFrame`/s | `BeginFrame`/s |
| --- | ---: | ---: |
| Offscreen, explicitly paused | 0.3 | 0.7 |
| Onscreen, former loop / visibility ref | 60 / 60 | 60 / 60 |
| Offscreen, former loop / visibility ref | 0 / 0 | 60.3 / 0 |
| Scroll-clipped, former loop / visibility ref | 0 / 0 | 60 / 0 |
| Hidden pane, former loop / visibility ref | 0 / 0 | 0 / 0 |

The mount audit found fourteen rings in eight components. Review cards can keep
one mounted for the whole turn (`sending || working`, where `working` includes
`threadRunning`), inside a scrollable rail. Usage analysis can span a model call,
with its tab ring inside a scrollable inspector. To-do dispatch, queued operator
answers, provider refresh, and remote uploads can also outlast a short request.
Settings saves, archive loading, composer preparation, and PDF previews normally
mount for the pending operation only; they still use the same ref so scrolling
or hiding a pane cannot leave a ring running. These are source-based lifetime
observations, not measurements of how often operators scroll them away.

For an investigation, compare idle, active, and paused captures in an isolated
instance before changing live state. Pause only the animation under investigation
and repeat the same collection. Existing React DevTools and hot-CPU diagnostics
can then locate a JS/component source when native timeline counters warrant it.

### Status dot pulses

`.status-dot--blink`, `.rail-chip__dot--blink` and a checks-running PR chip's
dot pulse from one shared timer (`lib/status-pulse.ts`), not a CSS loop. The
snapshot names a pulse `status-blink` by its script animation `id`, with source
`.status-dot`, `.rail-chip` or `.pr-chip`, and `infinite` false. A pulse runs
1.6s of every 4.5s, so a one-second sample can correctly find none.

The spec's status pulse test seeds six running sub-agents in the main window
and hides the strip's thinking scanner, so only the dots move. It captures the
dots at rest under reduced motion, pulsing, under the former infinite rule, and
then offscreen under the former rule and under the pulse. Observed on Ubuntu
x64 in Sandboxer with Electron 44.9.3 (2026-10-31, two runs), per second:

| Main window, six dots | `DrawFrame`/s | `BeginFrame`/s |
| --- | ---: | ---: |
| At rest (reduced motion) | 2.4–2.8 | 4.2–4.6 |
| Shared-timer pulses | 23.8–23.9 | 25.3–25.7 |
| Former infinite loop | 60.3 | 60.0–60.3 |
| Former loop, every dot offscreen | 1.0 | 60.0 |
| Shared-timer pulses, every dot offscreen | 1.2 | 2.6–3.0 |

The offscreen row is what a live v1.3.7 capture found: six `status-blink`
loops drawing nothing and waking the compositor on every refresh. The resting
frames come from the rows' once-a-second elapsed counters.

## Cost and privacy

There are no timers, debugger attachments, trace sessions, IPC samples, or SQLite
writes from this feature until requested. While capturing, snapshots read existing
update counters and browser animation state; they do not change animations or
schedule animation frames. The native trace is instance-wide and briefly adds
tracing overhead, so compare against the same collection conditions.

The exported summary contains fixed event/animation/view labels, numeric IDs,
counts and window state. It excludes window titles, URLs, paths inside pages,
DOM text, animation keyframes, custom class names, React props, JS stacks, trace
arguments, and screenshots. Chromium's argument filter is enabled. PwrAgent reads
raw chunks into bounded main-process memory through a CDP stream; Chromium backs
that stream with a temporary file (unlinked immediately on macOS/Linux and
deleted on close on Windows). PwrAgent closes the stream and destroys its owned
target on cleanup. Only the sanitized summary is written inside a private capture directory;
failed capture directories are removed. Raw traces and logs must stay out of Git and PR
attachments. Share only the relevant sanitized counts and conditions.
