# Stock Electron native quit probe

This is an observation tool for separating Chromium context teardown from the
PwrAgent application's shutdown. A passing probe does not establish that the
remaining Desktop E2E failure is fixed or that every captured native wait has
the same owner.

The standalone app is
[`electron-native-quit.cjs`](../apps/desktop/scripts/fixtures/electron-native-quit.cjs).
It requires only Electron and Node builtins. It creates an isolated persistent
default session, opens a small visible window, waits for a driver-created quit
file, and calls `app.quit()`. It does not import PwrAgent or Playwright, load a
SQLite addon, or launch child commands. Chromium's own subprocesses are retained.

## Run

After this worktree's dependency installation, from the repository root:

```sh
pnpm probe:electron-native-quit --samples 3
```

Linux needs a working display, such as Xvfb in the desktop E2E CI job.
Windows and macOS need an interactive desktop. The probe opens visible windows.
Do not run it against an operator's application profile.

Every sample uses four fresh profiles: each storage location with ordinary quit and quit after
`closeAllConnections()`, `cookies.flushStore()`, and `clearData({dataTypes:
["cache"]})`. Profiles are placed beside the output artifacts and under
`os.tmpdir()`, matching the E2E fixture's placement. The order alternates.
On Windows the checkout and temp directory can reside on different volumes;
a fast close beside the checkout does not establish temp-volume behavior.
These are controlled probe cases, not a
different E2E worker or lane policy. The drain mode tests the existing preparation
calls; it does not claim they flush BTM.

Use `--profile-location workspace` for the original two-case sample, or
`--profile-location temp` for the fixture placement alone. The default `both`
records both locations on the same host. The setup and case results record
volume roots and device IDs; different path names alone do not prove separate
devices. A result establishes timing at that location, not a cause of disk
latency. Each profile path is retained in its case results and is never removed.

The driver preserves four launcher pipes using Chromium's remote-debugging pipe
transport, without sending DevTools commands. It records application lifecycle
markers, process exit, and all-pipes close separately. The six-second close
deadline includes session preparation. A timeout remains a failure and stops
the batch. No retries are performed. No profile is deleted, even on success.
Lifecycle records are buffered during the measured interval, then persisted
after closure or failure, so per-marker disk writes cannot stall the driver.

Windows places the entire experiment worker and its Electron descendants in
the existing atomic `KILL_ON_JOB_CLOSE` wrapper before execution. A failed
worker exits; closing that Job is containment, not a successful graceful close.
POSIX failures stop only the experiment's process group. Launcher readiness is
separate from the measured close deadline.

## Windows native observation

With signed Microsoft Handle and CDB paths supplied through the existing
`PWRAGENT_WINDOWS_HANDLE_EXE` and `PWRAGENT_WINDOWS_CDB_EXE` variables:

```sh
pnpm probe:windows-native-quit --samples 25
```

This requires successful native preflights and verification of all four exact
launcher pipe names before starting a measured quit. It uses the existing
creation-verified process watcher and capture policy: a stalled-close request
at three seconds, module-offset stack capture due at five seconds, and a
one-second debugger cap. The observer remains outside the experiment's Job.
No PDB is downloaded or loaded during measured cases. Resolve retained offsets
separately against the recorded Electron image hash and matching PDB.

The `ci:windows-shutdown-diagnostics` label enables this probe in a separate
Windows workflow. It does not change ordinary E2E lanes, workers, retries,
deadlines, or isolation. The workflow uploads parsed evidence and lifecycle
records, excluding profiles and database contents.

## Interpret evidence

Output is retained under `apps/desktop/.local/native-quit-probe/` for a direct
run or `apps/desktop/.local/windows-pipe-diagnostics/` for native observation.

- `setup.json` records the actual Electron image hash, storage locations and
  observation budget.
- Each case has `events.jsonl` and `result.json`. Application timestamps and
  driver observations are distinct. The quit-file delivery delay is visible.
  Failed cases also retain a bounded Chromium stderr tail.
- `summary.json` contains completed cases; a missing case result or incomplete
  batch is not a pass.
- `btmFiles` reports DIPS file names and sizes after natural launcher closure.
  Missing DIPS files do not prove that a BTM shutdown path was exercised.
- `native-controller/` contains creation-verified process lifetimes, exact pipe
  inventories, tool preflight results, and verified stacks when a stall occurs.

Join native observations by PID and creation FILETIME, then align them with the
application quit markers and launcher close. A JavaScript `quit` event alone
does not establish native process exit. A PID-only descendant observation does
not establish an orphan. Do not assign a native stack from one launch to a
handoff or queue timeout in another launch.
