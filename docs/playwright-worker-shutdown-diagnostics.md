# Playwright worker shutdown diagnostics

Desktop E2E installs this recorder in each Playwright worker. A worker cleanup
timeout still fails the run. This change captures evidence; it does not fix or
suppress cleanup failures, increase timeouts, or retry tests.

The config also runs in Playwright's controller and loader processes. An
inherited `TEST_WORKER_INDEX` does not identify a worker; the recorder starts
only after Playwright marks the process as a worker. Thus `worker-start` is a
worker-readiness marker, not merely evidence that the config was evaluated.

The normal path records a small JSONL lifecycle timeline. When one worker
cleanup phase takes five seconds, it captures a snapshot before Playwright's
30-second default timeout. It also captures on worker cleanup failure (at most
three snapshots per worker). The existing CI artifact upload includes these
files under `test-results/worker-shutdown/worker-<index>-<pid>/`.

If cancellation skips that upload, search the job log for
`[worker-shutdown-evidence]`. Each failure snapshot synchronously emits a compact
JSON record with pending process owners, exit/close and stdio state, and
referenced native handles. The ancestry query also logs its result or explicit
failure/interruption. Each record is capped at 16 KiB of JSON; snapshots include
at most 16 pending processes, eight stdio entries per process and 32 handles;
trees include at most 64 processes. Total counts expose omitted entries, and
`byteLimitReached` marks further clipping to the byte cap. There are at most
three snapshots and one query result per worker. Full artifacts retain their
existing detail. This adds no wait or cancellation handler and cannot preserve
evidence if the worker never reaches capture or the runner stops forwarding its
output.

## Reading a failure

Start with `snapshot-1.json`, then use `timeline.jsonl` to reconstruct events:

- `phase` identifies worker fixture cleanup versus Playwright's remaining
  registered process cleanup. `registeredClosers` lists callbacks still in
  Playwright's close registry, with PIDs where they belong to a tracked process.
- `processes` gives the originating test, launch stack, PID, close stage, exit
  status, and each stdio stream's state. `attempt-to-gracefully-close` means the
  graceful-close callback has not resolved. `wait-for-process-close-and-cleanup`
  means it is waiting for the process `close` event and directory cleanup.
- `exitObserved: true` with `closeObserved: false` distinguishes process exit
  from completion of its stdio lifecycle. A descendant retaining an inherited
  pipe can produce this state. It does not, by itself, prove which process owns
  the pipe. Correlate with `process-tree.json`, which records the worker,
  tracked children and discoverable descendants (Windows CIM; POSIX `ps`).
  If the query failed, that file has `error` instead. `killed: true` with
  `signal` set means the query reached its bound. A `code` means the command
  exited on its own; read `stderr` for the reason. Node gives both failures
  the same `error` message, so use these fields, not the message.
- `resources` contains creation stacks and test ownership for tracked live
  async resources. `report.libuv` and `report.nativeStack` come from Node's
  diagnostic report. A live handle is supporting evidence, not proof of a leak.
- `timeline.jsonl` starts with `worker-start` once the worker has loaded this
  recorder, then distinguishes process exit, stdio close, temporary-directory
  cleanup, and entry into each worker cleanup phase. It includes healthy
  launches so an earlier test's leftover process can be identified.

Windows native Electron executables launch directly, so Playwright owns the
Electron main process and its stdio. Explicit `.cmd` or `.bat` executable
wrappers still use `cmd.exe`; that shell's exit is not the Electron tree's
completion. Fixture teardown treats an unresolved `electronApp.close()`
as abnormal even after that launcher exits. It captures the Electron main PID
before quit and, on the abnormal path, checks process creation times before
terminating that process or its direct surviving children. It rejects a
snapshot with a reused main PID. The owning test fails if the close remains
unresolved or fixture teardown exceeds its 20-second deadline. The process-tree
snapshot cannot follow an orphan once its tracked launcher and intermediate
parents have exited.

Chromium's native shutdown runs after the application's reported quit phases.
The E2E bootstrap gives each process its own `userData` and `sessionData`
directory under the fixture's temporary root before importing the app. Detached
profile helpers inherit that root and select a separate process directory.
`HOME` and `PWRAGENT_HOME` alone do not redirect Chromium's default storage on
Windows. Sharing it can leave native shutdown waiting in
`leveldb_env::ChromiumEnv::LockFile` → `leveldb::DestroyDB` while another instance
holds `Local Storage/leveldb/LOCK`; the Electron main process then keeps the
launcher alive after `quit`. The fixture removes the Chromium directories only
after closing the app and cleaning up its profile helpers.

On Windows, fixture close also drains each live Electron session before asking
Playwright to quit: it closes connections, awaits the cookie store flush, and
disposes the fixture session cache with `clearData({ dataTypes: ["cache"] })`.
This preparation shares the existing six-second graceful-close deadline.
Chromium's native `BrowserProcessIOThread::ProcessHostCleanUp` otherwise waits
for the network service to flush cookies and cache after JavaScript quit has
finished. That service can retain the launcher's pipes while native storage
work is still pending. The fixture must await that work while the sessions
are still reachable over RPC; storage isolation alone does not drain it.

The cache operation also waits for Chromium's network-history completion.
Unlike `clearCache()`, this reaches `HttpServerProperties::Clear` and the
`Network/Network Persistent State` preference write. A matching Electron native
snapshot retained that write and its initial preference read as queued
`BLOCK_SHUTDOWN` work after the network service entered shutdown. Awaiting the
cache completion keeps its RPC owner alive until the write finishes. Cache
disposal applies only to the Playwright-owned fixture sessions. A failed or
stalled completion still fails teardown under the existing close deadline.

The Windows reproduction left a suspended no-op `cmd.exe` from the startup
Job-wrapper prewarm alive after the app exited. The app no longer starts this
fire-and-forget prewarm. Vitest's separate prewarm setup still awaits its
completion before tests begin.

The recorder does not collect application output, environment variables, or
process command lines. It selects useful sections from Node's report rather
than uploading its credential-bearing raw report. Paths, test titles and local
socket endpoints can appear in diagnostic stacks and handles.

For a Windows pipe-holder investigation, run the inspect-only
`e2e/windows-pipe-holder.inspect.spec.ts` with `PWRAGENT_PIPE_HOLDER_PROBE=1`.
Its local JSON files preserve descendant ancestry across parent exit and report
survivors and the launcher's close delay. Review and sanitize command lines
before sharing results.

## Verification and upgrades

Run from the repository root:

```sh
pnpm test apps/desktop/scripts/playwright-shutdown-diagnostics.test.mjs
```

This starts the actual installed Playwright runner in disposable directories.
It verifies two failures with passing test bodies on every platform: a stuck
graceful-close callback and a stuck worker fixture. On POSIX it also verifies
an exited parent with inherited pipes held by its descendant. That reproduction
is skipped on Windows: its inherited-stdio fixture exits cleanly there instead
of holding the worker open. This does not disable Windows diagnostic capture;
the two other failure probes run there. It also verifies healthy cleanup exits
zero without a snapshot and that a planted environment secret is absent from
artifacts. No Electron window, display server, or browser download is needed.
The suite also runs Playwright's `--list` mode with an inherited worker index
to verify that a controller cannot emit a false readiness marker.

Two versioned pnpm patches emit observations from Playwright's worker and
process launcher. The core patch also bypasses the Windows shell for native
Electron executables, preserving shell launch only for `.cmd` and `.bat`
wrappers. The original close promises, cleanup, error handling and deadlines
remain in place. Diagnostic hooks are inert outside instrumented E2E workers.
When upgrading Playwright, port both patches and run the real-worker tests and
`e2e/electron-launcher-ownership.spec.ts` on Windows. A green ordinary E2E run
does not validate failure capture or native launcher ownership.

## Controlled native Windows pipe inheritance

To reproduce an exited native Electron process whose launcher pipes remain open,
run this manual probe from the repository root on Windows:

```powershell
node apps/desktop/scripts/probe-windows-electron-pipe-inheritance.mjs
```

It loads a minimal Electron entry, without the product or a user profile. Electron
starts a Node intermediate, which starts a detached Node retainer. Both launches
request ignored stdio. The probe records all three Windows creation times and
parent PIDs while they are alive, lets the intermediate exit, and quits Electron.
The retainer exits on its own after twelve seconds. No surviving descendant is
terminated by PID. On an error, only the exact Playwright-owned Electron process
handle may be stopped.

`summary.json`, `events.jsonl`, and process snapshots are retained under
`apps/desktop/test-results/windows-pipe-inheritance/<timestamp>/`. Use
`--output-dir <new-directory>` to preserve a run elsewhere. For native handle
evidence, optionally pass `--handle-exe <path-to-handle64.exe>` using Microsoft's
[Sysinternals Handle](https://learn.microsoft.com/en-us/sysinternals/downloads/handle).
The probe uses bounded, read-only queries for its identified PIDs and records
query errors. It does not download Handle or scan every process.

On Electron 44.9.3 (embedded Node 24.22.0, libuv 1.52.1), the control reproduced
exit code zero with fd 1–4 still open. The retainer held the same four launcher
pipe names before and after Electron exited; launcher close followed the
retainer's natural exit. Electron explicitly enables stdio inheritance in its
[browser process](https://github.com/electron/electron/blob/v44.9.3/shell/common/node_bindings.cc#L638),
and this runtime's libuv uses unrestricted handle inheritance when spawning a
[Windows child](https://github.com/nodejs/node/blob/v24.22.0/deps/uv/src/win/process.c).
Ignored stdio does not exclude inherited handles outside the child's new stdio
mapping. A grandchild can outlive both its intermediate parent and Electron.

This is a positive control for the failure mechanism. It does not identify the
historical retaining process in CI job 124557904187: that artifact has no earlier
ancestry trace or native handle inventory. A healthy natural run, a late process
tree, or this control alone cannot establish that process's identity. Preserve
creation-time ancestry from before quit and matching pipe handles in a natural
failure before changing product ownership or cleanup.

## Unit probe timeouts

The real-worker unit tests launch a separate Playwright CLI with a generated
config and spec. A Vitest deadline can expire before that CLI reports its
result. On failure, the harness copies the generated probe and its evidence to
`apps/desktop/test-results/unit-shutdown-probes/shutdown-probe-*/` before the
temporary root is deleted. The macOS unit lanes upload this directory as
`macos-unit-shutdown-probes-lane-<lane>`.

Read `before-cleanup.json` first for an outer timeout: it freezes the CLI PID,
exit and signal codes, observed lifecycle events, and each pipe's state and
bounded output tail before aborting the CLI. `before-stop.json`, `completed.json`
and `after-cleanup.json` describe later boundaries; cleanup-induced exit must
not be mistaken for the original stall. `parent.jsonl` timestamps the spawn
request, spawn event, observed readiness, exit, stdio end/close, and exec callback.

`milestones.jsonl` records Node entry from a preload, config evaluation, spec
evaluation and test-body progress, with PIDs and UTC timestamps. A spawn event
alone does not prove Node reached user code. Config evaluation also runs in the
controller; only `results/worker-shutdown/*/timeline.jsonl`'s `worker-start`
proves worker readiness. Compare that recorded readiness with the parent's
`worker-ready-observed` event to identify delayed filesystem notification.
Once ready, use the worker timeline and snapshots to locate test execution or
cleanup. A CLI `exit` without `close`, together with a pipe that has not ended,
identifies a pipe-lifetime wait; it does not identify the retaining descendant.
No exit event means the CLI itself has not been observed to exit.

Each probe has two named budgets. Cold start, from spawn to the worker's
`worker-start` record, has 30 seconds: it is two Node processes loading
Playwright and the generated config. On macOS that measured 0.5 seconds idle,
up to 3.2 seconds beside a full unit shard and 12.6 seconds at a load average
of 36 on ten cores. Shutdown has the original 20 seconds, measured from the
worker's own readiness record to CLI close. Playwright's generated five-second
teardown deadline measured 5.0-5.1 seconds under every load, so a hang there
still fails as before. Either expired budget names its phase in the error and
freezes `before-cleanup.json` first. The `--list` probe starts no worker and has
the cold-start budget alone. There is no retry, and cleanup is unchanged. The
retained data contains generated test fixtures, not the environment or an
unfiltered Node diagnostic report.

## Limits

The watchdog runs on the worker's event loop. A native deadlock that blocks that
loop cannot trigger it; investigating that needs an external process dump. A
process-tree query is bounded to three seconds and reports query failures in
its artifact; abrupt worker termination may interrupt it. Each result records
`elapsedMs`. On hosted Windows runners the query took 0.6-1.1 seconds from a
loaded worker. Most of that was PowerShell startup and the `CimCmdlets`
import; the WMI query took 50-75 ms. A narrower WQL projection saved about
40 ms, so a cheaper query does not remove the risk of reaching the bound.
The real-worker test therefore accepts a correctly classified kill at the
bound and fails on any other query failure. POSIX can reparent
orphans before the query, making ancestry incomplete. Async-resource tracking
starts when the worker loads the config and keeps at most 512 live records;
`droppedResources` reports overflow. Records use weak references so diagnostics
do not themselves retain native handles. Completed process history is bounded
to approximately twenty launches; pending launches remain tracked.

Set `PWRAGENT_E2E_WORKER_DIAGNOSTICS=0` only to compare instrumentation overhead.
Failure semantics stay unchanged when capture is disabled.

## Regular hosted Windows pipe evidence

The Windows E2E job uses `pnpm test:desktop-e2e:windows-diagnostics`. It forwards
the same desktop build, test arguments, shards, workers, retries and deadlines.
No Electron close promise or cleanup phase waits for this recorder.

An external controller starts native process observation before starting pnpm,
before Electron launcher pipes exist. Native x64 process snapshots are sampled
with a 50 ms pause. Identities use PID plus creation FILETIME; retained,
non-inheritable `PROCESS_QUERY_LIMITED_INFORMATION` handles supply native exit
FILETIMEs. These are 100 ns units since 1601, not CIM/DateTime ticks since year
0001. A process may begin and end between samples. Missing or ambiguous
ancestry remains explicit. A sampled disappearance time cannot substitute for
a native exit time. Executable paths are recorded; command lines are omitted.

The true Playwright worker guard remains. Each direct native Electron launch
gets a random `launchId` carried through exit, close and stage events. Only
launch generates a Node report, retaining pipe names rather than the raw
report. A worker-PID suffix supplies a candidate pool, not a per-launch mapping.
The controller narrows that pool against the exact live main's handle-name
inventory and requires four complete exact names. Creation identity is checked
before and after each scoped name inventory.

On a natural code-zero exit with all four launcher streams still open, the
worker captures callback-entry time and flags before reports or queries. It
immediately preserves the trigger. The controller inspects surviving processes
from the retained ancestry first, requiring all four exact endpoint names and
the same creation identity before and after inspection. A bounded global search
supplies fallback candidates; substring matches do not qualify. Query intervals,
access failures, timeouts, omissions and unavailable mappings remain explicit.
The result flags a launch inventory that overlaps the exit callback and marks
known diagnostic processes so their handles cannot be mistaken for an
uninstrumented holder.

Names come from the official [Sysinternals Handle utility](https://learn.microsoft.com/en-us/sysinternals/downloads/handle),
downloaded and checked for a valid Microsoft signature by the Windows job.
Queries use its File-only default and never request handle closure. The custom
native helper never duplicates remote handles or opens Job handles. Every
observer and scanner belongs to the controller, not a Playwright worker.
Diagnostic setup failure is logged and leaves the original test command running.

The normal `test-results/worker-shutdown/native-controller/` artifact contains
`native-processes.jsonl`, `launch-<launchId>.json`, `trigger-<launchId>.json`,
`match-<launchId>.json`, tool/source hashes and a summary. The native journal is
capped at 8 MiB and the observer at 32,768 starts. There are at most two concurrent
queries and four triggered captures per run; each capture considers at most
sixteen preserved descendants and eight global candidates within a five-second
query window after its main mapping is available. Requests, query outputs and
log records are bounded too. Raw tool output, environments and raw Node reports
are not uploaded. On cancellation, `[worker-shutdown-evidence]` retains the
trigger and `[windows-pipe-evidence]` retains bounded results when available.

Diagnostic work can affect scheduling. A source verified against all four exact
names is an observed holder during that query interval. It does not prove its
launch cause, missing Job assignment, or the cause of a separate live-main
native stall. A controlled probe validates instrumentation; a natural failure
must establish the holder for this investigation.
