# Bounded native Chromium CPU diagnostics

This instrumentation complements the hot-CPU V8 profiler. A V8 `(program)`
sample does not identify layout, paint, IPC, or another renderer thread. The
native summary records Chromium synchronous activity and thread timing where
available. It does not establish the cause of an application CPU incident.

## Explicit capture

The preload diagnostics API exposes `window.pwragent.captureNativeCpuDiagnostics()`
and `window.pwragent.stopNativeCpuDiagnostics()`. A request captures three seconds
in the existing instance and saves a private `state/diagnostics/native-cpu-*/summary.json`
in the active PwrAgent profile. For a staged manual experiment, schedule the
request in DevTools, then close DevTools before it starts:

```js
setTimeout(() => { void window.pwragent.captureNativeCpuDiagnostics(); }, 5000);
```

There is no persistent enable setting, pretrigger arm, automatic hot-CPU trigger,
or background capture. With no request, this feature creates no timers, trace
sessions, process samples, renderer polling, files, or SQLite writes (0 MB/day).
Calling stop while idle performs no work. The renderer is only the requester;
main owns the stop timer and sends `Tracing.end` before any awaited sampling or
stream operation. Summary anchors distinguish requested stop from completed
drain and decoding, and report deadline overrun.

## Bounds and ownership

- One native/rendering diagnostics capture per instance, enforced before start.
- CDP `Tracing.start` rejects an existing external trace. A rejected start grants
  no ownership and never sends `Tracing.end`.
- Native capture shares a managed WebContents debugger connection through an
  exclusive `Tracing` lease, alongside the V8 profiler's `Profiler` lease. It
  sends no `Profiler` commands. The last lease releases the connection after
  cleanup, so profile saving and resuming cannot detach an active native trace.
  An unmanaged attachment (including DevTools) is refused without commands or
  detach.
- Three seconds, 8 MiB `recordUntilFull` buffer. No overwriting or continuous ring.
  This is an instance-wide Chromium trace, including its renderer workers, main,
  GPU and utility processes. `rendererPid` identifies the requesting renderer.
- Only `toplevel`, `devtools.timeline`, `ipc`, `mojom`, and `v8.execute` categories;
  argument filtering on, sampling off. No screenshots, user timing, JS stacks,
  DOM text, or arbitrary arguments are exported.
- Two cumulative process-CPU snapshots, with numeric PID and process creation
  time for lifetime joins. CPU seconds include all threads in that process.
  Missing/exited processes and failed reads must remain missing; normalized
  Electron CPU percentages are not the measurement.
- Buffer reports every 250 ms while active; no buffer query blocks shutdown.
  Peak observed fill and Chromium's `dataLossOccurred` flag are retained. Reports
  are periodic observations, not a final high-water guarantee. Full buffers may
  lose the tail; unknown loss is reported conservatively.
- At most 64 MiB decoded JSON, 65 reads of at most 1 MiB, 250,000 input events,
  100,000 exported spans. Stream drain/read has a five-second budget after
  completion; completion has a five-second grace after the recording deadline.
  Saturation and span omissions are visible, not treated as complete attribution.
- Raw JSON exists only in transient memory and the Chromium CDP stream. No raw
  trace file is created. The handle is closed before saving, and on failures.
  Failed captures leave no partial summary. Capture directories are mode 0700
  and summaries mode 0600 on POSIX. Windows uses the profile's filesystem ACLs.

## Interpretation

Trace timestamps, duration, thread timestamp (`tts`), and thread duration
(`tdur`) are microseconds. Numeric PID/TID values and static thread roles support
joins. All event names and thread roles are allowlisted or replaced with static
fallback labels. No raw metadata names, event IDs, URLs, paths, payloads, or args
cross the trace boundary.

Spans are **inclusive**. `parent` indexes refer to the enclosing exported span
on the same thread. B/E spans are paired, incomplete boundaries are counted,
and crossing spans are reported. Per-thread wall and thread-CPU interval unions
avoid adding a task/IPC parent to its JS or layout children. Thread-CPU unions
only include spans with both `tts` and `tdur`; missing timing is `null`, never
zero CPU and never wall duration relabeled as CPU. These are measured activity
subsets, not an exclusive native CPU partition or a replacement for process CPU.

Coverage includes the first/last observed nonmetadata trace timestamp and actual
range. It is not inferred from the requested three seconds. Capture wall,
Node monotonic, and hrtime anchors are saved at start request/acknowledgment,
stop request, and decode completion. Chromium's trace clock is recorded in its
own coordinates; equality to Node's clock is not assumed. Use process lifetime
and capture boundaries when correlating with V8 recordings. A debugger detach,
renderer destruction, invalid trace, or transfer failure produces a fixed error,
not a partial attribution claim.

## Contrived controls and verification

`pnpm --filter @pwragent/desktop probe:native-cpu` runs a standalone Electron
fixture with temporary user data, without launching PwrAgent or opening operator
state. Run under `xvfb-run -a` in Sandboxer, or in the dedicated macOS lab using
the current lab skill. It compares baseline, V8-only, native-only, and concurrent
V8/native capture for idle, 700 ms JS, repeated forced layout, 1,000 IPC calls,
and 700 ms dedicated-worker work. The fixture checks conflict rejection, V8
survival, main-owned deadline, unsaturated buffers, worker/layout visibility,
raw cleanup, and records process CPU and trace coverage in
`apps/desktop/.local/native-cpu-controls.json`. Do not run CPU controls alongside
unit tests or builds when measuring instrumentation overhead.

Unit tests cover privacy, permissions, nesting/unions, missing timing, bounded
output/decoding, zero off-state work, active operation budgets, deadline,
shutdown, detach ownership, conflicts, target destruction, and raw stream cleanup.
Linux observations do not establish macOS thread-clock availability. Report
macOS results separately before drawing a macOS CPU conclusion. Measurements
are instrumentation controls, not evidence of a particular operator incident.
