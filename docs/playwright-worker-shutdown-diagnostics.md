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

## Reading a failure

First inspect `electron-shutdown-diagnostics.jsonl` for an
`owning-test-close-deadline` record. The Electron fixture writes this at its
six-second close deadline (or a rejected close), before sending any forced
signal. Worker cleanup can happen after the useful processes have disappeared.
The record shares the app's `launchId` with its phase events and close summary;
the worker timeline maps its launcher PID to the owning test.

The fixture observes launcher `exit` and `close` separately from launch onward,
and records exit status and each stdio stream's closed, destroyed and completion
flags. A late observation cannot establish an earlier `close` event; use
`observationStartedAt` and the stream flags together. A close timeout alone
does not establish an open pipe or its holder.

On Linux, launch-time sampling retains only `pipe:[inode]` and `socket:[inode]`
identities for the launcher's stdio and the worker endpoints. Node's Unix
socketpair endpoints have different inodes: the launcher's endpoint must be
sampled while it still exists to find a descendant's inherited copy after exit.
The deadline scan reports numeric process identities (PID, parent, process
group, session and start ticks), group members, and descriptors matching those
sampled endpoints across visible `/proc` processes, including outside the
original group. Executables are classified using a fixed allowlist (`node`,
`electron`, shells and a few helpers); all other names become `other`, and
unreadable executable links become `unavailable`.
`holders` distinguishes `launcher` from `worker` endpoints;
`accessMode` is the fdinfo access mode (0 read, 1 write, 2 read/write). A worker
endpoint match is expected and is not proof of a writer keeping the other end
open. A group member without a matching descriptor is not a proven holder.

The scan has a 750 ms work budget, at most 4,096 processes, 32,768 descriptors,
512 descriptors per process, 256 reported group members and 128 holder matches.
It scans group members first and checks process start ticks again before
attributing matches. `partial`, permission/race counts, visited counts and
`launcher-endpoints-unavailable` make missing coverage explicit. `/proc` reads
and the final file write are synchronous local operations; the work budget is
checked between reads, not an OS I/O cancellation deadline. The scan is not an
atomic OS snapshot: fd changes, inode reuse and inaccessible processes limit
what a match or absence can establish. Other platforms retain launcher/stream
evidence and mark the Linux scan unsupported. No command lines, process names,
environment, application output, file targets or raw OS error messages are
collected. Only the allowlisted executable classes are retained. The existing
teardown ceiling and failure policy remain in place.

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

A Windows Electron launcher can be `cmd.exe`; its exit is not the Electron
tree's completion. Fixture teardown treats an unresolved `electronApp.close()`
as abnormal even after that launcher exits. It captures the Electron main PID
before quit and, on the abnormal path, checks process creation times before
terminating that process or its direct surviving children. It rejects a
snapshot with a reused main PID. The owning test fails if the close remains
unresolved or fixture teardown exceeds its 20-second deadline. The process-tree
snapshot cannot follow an orphan once its tracked launcher and intermediate
parents have exited.

On POSIX, Playwright launches Electron as a dedicated process-group leader.
The abnormal-close fallback signals that group even if the launcher has already
exited or been signalled. A parent-PID walk after exit cannot recover orphaned
descendants holding inherited stdio. `electron-app-close.test.ts` checks real
inherited pipes with running, exited, and signalled launchers on Linux and macOS.
An abnormal close still fails the owning test after cleanup.

The intermittent Linux failure in PR #2927 at `34839ebe` completed every app
shutdown phase in 15 ms, then timed out in both close waits. The preceding
commit and the instrumented reviewed commit each passed all 11 tests on fresh
runs; their teardown fixture blobs were identical. The real-process regression
at `367d837e9` and group cleanup repair at `4ad3cb78d` establish an existing
cleanup defect after launcher exit, but do not identify the natural holder or
attribute it to Markdown. The preserved artifacts are in
`/home/user/pwragent/teardown-investigation` in Sandboxer `sb_midvi1lqdt`.

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

`apps/desktop/src/main/__tests__/electron-close-evidence.test.ts` exercises the
owning-test deadline with real Linux processes and inherited sockets. It checks
holders both inside and outside the launcher's group after exit, sanitized
bounded artifacts, and capture before group termination while the owning test
still fails. It needs no Electron window or display server. Follow repository
Sandboxer guidance for these checks.

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

Two small versioned pnpm patches emit observations from Playwright's worker
and process launcher. They leave the original promises, cleanup, error handling
and deadlines in place. The hooks are inert outside the instrumented E2E
workers. When upgrading Playwright, port both patches and run the real-worker
tests: a green ordinary E2E run does not validate failure capture.

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
