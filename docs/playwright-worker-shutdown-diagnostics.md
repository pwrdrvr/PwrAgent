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
- `resources` contains creation stacks and test ownership for tracked live
  async resources. `report.libuv` and `report.nativeStack` come from Node's
  diagnostic report. A live handle is supporting evidence, not proof of a leak.
- `timeline.jsonl` starts with `worker-start` once the worker has loaded this
  recorder, then distinguishes process exit, stdio close, temporary-directory
  cleanup, and entry into each worker cleanup phase. It includes healthy
  launches so an earlier test's leftover process can be identified.

The recorder does not collect application output, environment variables, or
process command lines. It selects useful sections from Node's report rather
than uploading its credential-bearing raw report. Paths, test titles and local
socket endpoints can appear in diagnostic stacks and handles.

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

Two small versioned pnpm patches emit observations from Playwright's worker
and process launcher. They leave the original promises, cleanup, error handling
and deadlines in place. The hooks are inert outside the instrumented E2E
workers. When upgrading Playwright, port both patches and run the real-worker
tests: a green ordinary E2E run does not validate failure capture.

## Limits

The watchdog runs on the worker's event loop. A native deadlock that blocks that
loop cannot trigger it; investigating that needs an external process dump. A
process-tree query is bounded to three seconds and reports query failures in
its artifact; abrupt worker termination may interrupt it. POSIX can reparent
orphans before the query, making ancestry incomplete. Async-resource tracking
starts when the worker loads the config and keeps at most 512 live records;
`droppedResources` reports overflow. Records use weak references so diagnostics
do not themselves retain native handles. Completed process history is bounded
to approximately twenty launches; pending launches remain tracked.

Set `PWRAGENT_E2E_WORKER_DIAGNOSTICS=0` only to compare instrumentation overhead.
Failure semantics stay unchanged when capture is disabled.
