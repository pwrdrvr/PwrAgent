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

On Windows, fixture close also drains each live Electron session during
graceful close: it closes connections, awaits the cookie store flush, and
disposes the fixture session cache with `clearData({ dataTypes: ["cache"] })`.
This preparation shares the existing six-second graceful-close deadline.
An app-owned `before-quit` barrier retains Chromium's native session contexts until
every callback finishes, including after Playwright detaches its inspector.
Session preparation starts on the product's final allowed quit pass, after the
application closes its renderer windows and finishes resource disposal. A pass
already prevented by the product cannot start the drain. Flushing before renderer closure misses final
storage writes from unload. The callback runs inside the app, without retaining
an inspector RPC or requiring a live renderer. After completion, a macrotask
reenters quit once native dispatch has reset its quit state. Holding `will-quit`
is too late for reliable cache callbacks on Windows: CI run 42046887012 recorded
nine pending cache completions at that boundary. In CI run
41482286163, the stalled-close snapshot verified that Electron main PID 7876
still held all four launcher pipe names while cache cleanup was pending; its
two observed Chromium children held none of them. An unfinished drain still
fails under the same deadline and is cleaned up by the owning test.
Chromium's native `BrowserProcessIOThread::ProcessHostCleanUp` otherwise waits
for the network service to flush cookies and cache after JavaScript quit has
finished. That service can retain the launcher's pipes while native storage
work is still pending. The fixture must await that work while the session
contexts remain alive; storage isolation alone does not drain it.

The cache operation also waits for Chromium's network-history completion.
Unlike `clearCache()`, this reaches `HttpServerProperties::Clear` and the
`Network/Network Persistent State` preference write. A matching Electron native
snapshot retained that write and its initial preference read as queued
`BLOCK_SHUTDOWN` work after the network service entered shutdown. Awaiting the
cache completion keeps its main-process owner alive until the write finishes. Cache
disposal applies only to the Playwright-owned fixture sessions. A failed or
stalled completion still fails teardown under the existing close deadline.

The three full Windows samples in CI run 41491462986 passed their jobs but
retained two forced closes through test retries. Both roots reached `quit`;
native exit and pipe close then occurred together, with no surviving-pipe gap.
The barrier alone therefore does not establish complete ownership of native
shutdown. For further attribution, the controller samples a root still alive
five seconds into close using CDB's noninvasive, non-suspending `-pvr` mode.
It omits `-pd`: the controlled Windows probe found that combining it with
`-pvr` exits before readiness with "The system does not support detach on exit".
Frames are attributed only when live native creation FILETIMEs match the
original launch before and after capture, and every debugger thread's process
ID matches that root. A changed or exited identity omits the frames. Capture
start/end and result are recorded. A running target can change during unwind;
these stacks are best-effort observations, not atomic snapshots or unbiased
shutdown-rate measurements.

Opt-in CI verifies the installed Microsoft CDB signature. Live capture uses an
empty local symbol directory with network symbols disabled. It retains bounded
module-relative code offsets and the Electron image SHA-256 for separate offline
symbolization against the matching image and PDB. CI does not download PDBs or
perform post-test symbolization. A controlled child probe must produce frames and keep its
heartbeat advancing while attached and after debugger cancellation before
sampling is enabled. The controller never creates minidumps or clones the
target. Artifacts retain only bounded thread IDs and parsed call-site offsets,
plus explicit missing-symbol/capture status. Raw debugger output, arguments,
memory and environment are never uploaded. At most four roots are
sampled per lane; the owning close's deadline remains unchanged.

### Symbolizing captured stacks

Electron publishes Breakpad symbols with each release
(`electron-v<version>-win32-x64-symbols.zip`, about 60 MB). Its
`electron.exe.sym` maps the retained `electron+0x…` offsets to functions and
source lines without the multi-gigabyte PDB. Check `electronSha256` in
`native-stack-setup.json` against the version the run installed.

Symbolized, the 67 stacks retained by the November 2026 diagnostics runs
included 32 verified captures. 30 of those had a thread blocked in disk I/O on
fixture storage: `CreateFile`, `WriteFile` or `FlushFileBuffers` from the
application (the profile runtime heartbeat's `writeFileSync`, better-sqlite3's
close at process exit) and from Chromium (`BtmDatabase`, `QuotaDatabase`,
`ImportantFileWriter`). Failed lanes show the same thing as windows of two to
three minutes in which every close stalls in `clearData` or native quit, then
recovers. In those closes, the application's own appends to a diagnostics file
on the D: workspace volume completed in a median of 61 ms. The stalled storage
was under `os.tmpdir()`, on the OS volume (C:). The Windows Desktop E2E step
therefore sets `TEMP` and `TMP` to `runner.temp`, and
`scripts/windows-e2e-temp-volume-workflow.test.mjs` holds that rule.

### Controlled native debugger setup failures

When that controlled probe fails, `native-stack-setup.json` also reports whether
CDB emitted its banner, started and completed Extension Gallery initialization,
reached a command prompt, and emitted the readiness marker. `outputBytes` counts
the retained debugger text inspected for those flags; it is not a total stream
byte count. These observations help locate startup progress within the existing
deadline. They do not establish which operation caused a timeout, and a flag
alone does not satisfy the positive control.

Run from `C:\Program Files (x86)`, 30 of 227 hosted startups missed the
readiness check, each stopped at a different stage: no output, inside
Extension Gallery initialization, or after it but before the prompt. That is
the OS-volume stall described under "Symbolizing captured stacks", not one
hung step. Both diagnostics workflows therefore copy the Debuggers directory
into `RUNNER_TEMP`, verify `cdb.exe` and `dbgeng.dll` there, and point
`PWRAGENT_WINDOWS_CDB_EXE` at the copy.

The artifact's `probeFailure.triageGuide` points to this section. The controller
also emits a bounded `[windows-pipe-evidence]` record with
`kind: "native-stack-setup-failed"`, the sanitized failure fields, and that guide
path, so the context remains discoverable when artifact upload is interrupted.

For a new failure:

1. Read `native-stack-setup.json`, `tools.json`, and the controller's
   `summary.json` at the failed run's exact head. Compare tool and Electron
   hashes, the Node version, and the runner OS image before comparing results.
   With `--electron-only`, failed setup prevents Electron samples from starting.
   Ordinary E2E may continue with native stack capture disabled. A setup failure
   is not evidence of an Electron shutdown failure.
2. Read `probeFailure.reason` with the startup observations. No readiness marker
   means the marker was not found in the retained text within the control's
   deadline. Extension initialization starting without observed completion does
   not prove that extensions, networking, or symbol loading caused the delay.
   The booleans describe retained text, not a complete event timeline; earlier
   text can leave the bounded buffer. `outputBytes: 0` means no text was retained.
   Flags describe the debugger session that failed. The later ordinary capture
   and quit session does not emit the readiness marker. If the `debugger` object
   is absent, inspect the probe's preceding setup and cleanup steps rather than
   treating missing flags as a debugger observation.
3. Trace the corresponding stage in `windows-pipe-diagnostics-probe.mjs`,
   `windows-native-stack.mjs`, and
   `run-windows-e2e-with-pipe-diagnostics.mjs`. Use owned Windows processes to
   establish a lifecycle/readiness oracle that fails on unchanged code before
   changing behavior. Keep creation identity, noninvasive nonsuspending attach,
   heartbeat, cancellation, debugger quit, and the positive control intact. Do
   not increase timeouts or retries, bypass the control, or persist raw debugger
   output to obtain a passing run. Follow the repository's current Windows lab
   ownership and authorization guidance before native lab work.

The motivating failure was [run 41925366134](https://github.com/pwrdrvr/PwrAgent/actions/runs/41925366134),
head `57606a017ad103325d7d69863f51f0a98b5978c0`, job `126908239121`.
Artifact `windows-native-quit-evidence` (`13368224053`) recorded
`debugger-readiness-timeout`, neither detach nor network-path rejection, and zero
requests or captures. The same CDB, Handle, helper, and Electron hashes later
passed unchanged in [run 42125556092](https://github.com/pwrdrvr/PwrAgent/actions/runs/42125556092),
including all 12 fresh-profile Electron cases. An owned Windows Server 2022
control also passed unchanged, but used an older CDB build. Those passes do not
identify the timeout's cause. This is a separate diagnostic setup problem from
PR #3367's handoff-dialog native shutdown failure; a passing control does not
establish reproduction or repair of that failure.

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

## Opt-in hosted Windows pipe evidence

By default, Windows CI runs `pnpm test:desktop-e2e` once across four lanes.
The ordinary shutdown reports remain available without native observation.
For an ownership investigation, add `ci:windows-shutdown-diagnostics` before
opening the PR, pushing a commit, or rerunning CI. Adding the label alone does
not start CI. The label runs three complete samples across the usual four lanes
(12 jobs) using `pnpm test:desktop-e2e:windows-diagnostics`. It prepares signed
Handle/CDB tools and enables the external controller described below. Removing
the label restores the default on the next CI run.

The diagnostic entry point forwards the same desktop build, test arguments,
shards, workers, retries and deadlines. No Electron close promise or cleanup
phase waits for this recorder. PDBs are not downloaded in either mode.

The controller also enables `worker-shutdown/main-children.jsonl` in each
Electron main process. Node's child-process constructor channel captures up to
128 launch call sites per main, with at most eight app-relative frames each.
The record omits arguments, environment, output and absolute call-site paths.
Only a fixed set of diagnostic executable names is retained; others are `other`.
Synchronous launches and children created outside Node's child-process API are
not covered by this trace; the native journal remains the process-tree source.

Each main has an `ownerPid` and fixture `launchId`. A local `childId` joins the
synchronous `launch` record to the later `spawn` event, when Node has assigned
the child's PID. Separate `exit` and `close` events distinguish process exit
from final stdio closure. Snapshots at shutdown start/completion, `will-quit`
and the JavaScript process-exit hook retain children whose `close` callback has
not run, plus an omitted-launch count. These observations do not delay shutdown
or stop children.

The exit hook also records synchronous-cleanup start, state-database close
start, and state-database close completion. Join a native capture's interval to
these markers to distinguish final SQLite closure from the preceding cleanup;
a missing completion marker alone does not identify a blocked operation.

Join those records to native PID **and creation FILETIME**, using the verified
root lifetime and parent creation. A PID or missing JavaScript `close` event
alone does not establish a surviving process. Native and fixture launch UUIDs
are different namespaces. Call-site and Node event times identify the launch
path and callback timing; they do not replace the native identity/exit checks.

After tests and observation finish, `native-controller/main-child-locations.json`
resolves observed minified positions through the same build's hidden JavaScript
source maps. It retains only app-relative source locations and bundle, source-map
and journal hashes. Raw maps, source contents and external source paths are not
copied. Resolution reads files capped at 32 MiB and retains at most 4,096 unique
positions, with explicit unavailable/unmapped results and an omission count.

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
