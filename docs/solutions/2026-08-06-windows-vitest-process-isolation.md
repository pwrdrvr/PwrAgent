---
title: "Windows Vitest stability: process ownership and lifecycle truth"
type: solution
status: shipped
date: 2026-08-06
tags: [desktop, windows, vitest, git-bash, process-lifecycle, electron, flake]
related_prs: [#1259]
---

# Windows Vitest stability: process ownership and lifecycle truth

> **TL;DR.** Three unrelated Windows Vitest tests timed out in one CI run, but
> the evidence did not support SQLite contention, serial test lanes, fewer
> workers, retries, or larger timeouts. Repeated runs instead found orphaned
> Git-for-Windows Bash process trees in 4/10 focused runs and 4/10 full-suite
> runs, plus independent renderer tests synchronized to state that was not yet
> lifecycle-ready. [PR #1259](https://github.com/pwrdrvr/PwrAgent/pull/1259)
> introduced an opt-in Windows stress diagnostic, atomic Job Object ownership
> for detached Bash work, and readiness-based renderer tests. Read this before
> changing those boundaries: the failures looked local, but the causes crossed
> processes and tests.

## What failed, and what did not

The original CI signal was three 30-second timeouts in the Windows **Vitest**
workspace suite:

- `ScheduledThreadActionStore` legacy SQLite payload migration
- state database migration for `source_event_key`
- `WorktreeArchiveService` snapshot/remove/restore

These were not headed Electron E2Es. Playwright entered the investigation only
as an outer Windows stress harness that could repeat Vitest, retain each
iteration's log, and compare native process snapshots before and after the
suite.

The three reported tests use isolated temporary roots, and repeated Windows
runs did not reproduce them as a stable group. That made a shared SQLite test
database, a database-reset hook, or a serial "database lane" speculative. Such
changes could reduce visible contention while leaving the real leak alive to
hurt a different test later.

The reproducible signal was process residue. Before the fix, 4/10 focused runs
and 4/10 full-workspace runs left new Bash or shell descendants alive after the
test command had exited. Some were infinite shell/sleep loops created by tests
that intentionally exercise cancellation. Those leftovers competed with later
tests and made whichever test was slowest at the time appear guilty.

## The Windows process boundary

The durable ownership chain is:

```text
Node owner
  -> PowerShell wrapper
     -> CreateProcess(CREATE_SUSPENDED)
        -> assign process to KILL_ON_JOB_CLOSE Job Object
           -> resume Git-for-Windows usr/bin/bash.exe
              -> Bash/MSYS/Git/Node descendants
```

The order is load-bearing. Assigning the initial process before it resumes
closes the fork window in which an MSYS descendant can escape ownership. The
wrapper waits for the Job Object's active-process count to reach zero, and
closing the job handle terminates every remaining owned descendant.

### `bin/bash.exe` is not the stable process boundary

Git for Windows commonly exposes both `bin\bash.exe` and
`usr\bin\bash.exe`. The former may act as a launcher: it can start another
MSYS Bash process with a different PID and then exit. Code that owns or kills
only that launcher PID no longer owns the command it believes it started.

`windows-shell.ts` therefore prefers the stable `usr\bin\bash.exe` path when
it can derive one. This reduces launcher handoff, but it is not sufficient by
itself; Bash can still fork descendants, so the Job Object remains the actual
ownership boundary.

### A process tree is not an ownership primitive

The previous cleanup used `taskkill /T` after a timeout. That is a snapshot and
kill operation, not an atomic ownership contract. MSYS can fork between tree
enumeration and termination, leaving a descendant behind. The same problem
applies to killing only Node's immediate child.

Do not replace the Job Object with a PID-tree cleanup loop. If a new Windows
path launches detached or timeout-bound Bash, Git, Node, or helper processes,
route it through the shared wrapper and keep its job alive until the owning
operation settles or shuts down.

### Bash and PowerShell do not share path syntax or exit semantics

The native wrapper and the POSIX shell straddle an MSYS boundary. Two details
matter:

1. The PID returned by a Git Bash launcher is not always the process whose exit
   status represents the `-lc` script. The Bash script reports its own `$?`
   through a small exit-status side channel, which PowerShell reads before it
   exits.
2. A native path placed in an environment variable is not automatically
   converted when Git Bash later uses that value as a shell redirection target.
   The Bash-facing copy must be converted to POSIX form (for example with
   `cygpath -u`), while PowerShell retains the native path it reads afterward.

The second issue was found in review after PR #1259 was squash-merged. Treat
the raw native-path redirection in that merge as a known defect, not a pattern
to copy. The regression test for its correction must run a deliberately
failing Bash command and assert the exact nonzero status as well as stdout;
success-only coverage cannot prove the side channel works.

## Where ownership is required

PR #1259 applied the shared Windows Job Object boundary to the two production
areas that had detached or timeout-bound Git Bash work:

- Codex environment discovery and environment actions
- automation gate commands

Both owners also wait for their active jobs during shutdown. Teardown must not
return while an owned job can still create work. Any new caller with the same
lifecycle should use the common wrapper rather than adding a caller-specific
`taskkill`, timer, or process registry.

## Independent renderer races found by the same stress run

Once process leakage became observable, broad repetition exposed two separate
test synchronization bugs. They were real flakes, but they were not evidence
that the process fix had failed:

- Queue terminal events could update the durable draft store before React had
  committed the corresponding queued-turn state. Queue-action tests also
  clicked before the owning peer had supplied the stable backend queue-entry
  ID. The fix waits for the durable identity and lifecycle transition that the
  action actually requires.
- The App shell test treated a short DOM query as proof that lazy Settings code
  had imported and React had committed. Under Windows load, that optimistic
  probe could win the race. The test now waits for the lazy-rendered Settings
  surface itself.

The general rule is to wait on the state that owns the next action. DOM
presence, native window existence, a store write, and a renderer commit are
different milestones. A wider timeout around the wrong milestone only makes
the race less frequent.

## Invariants to preserve

- Prefer Git-for-Windows `usr\bin\bash.exe`; do not assume
  `bin\bash.exe` remains the long-lived command process.
- Create the target suspended, assign it to the Job Object, and only then
  resume it. Post-launch assignment reopens the escape race.
- Keep `KILL_ON_JOB_CLOSE` and wait for the job's active-process count. Killing
  only the immediate child or a sampled process tree is insufficient.
- Keep native and MSYS path handling explicit. Environment variables do not
  make an arbitrary Windows path safe for Bash redirection.
- Preserve the script's exact exit status, including nonzero exits. Do not rely
  solely on the native launcher status.
- During app/test teardown, wait for owned jobs before disposing the owner.
- In renderer tests, synchronize to stable backend identity and actual lazy
  render/React readiness, not an optimistic proxy.
- Do not add retries, broad timeout increases, worker reductions, or serial
  lanes until a repeated diagnostic identifies the contended resource and the
  proposed isolation removes it.

## Diagnostic contract

`apps/desktop/e2e/windows-vitest-stress.inspect.spec.ts` is an opt-in,
Windows-only diagnostic. It:

- runs one focused Vitest target or the complete workspace;
- retains the Vitest log for every Playwright repetition;
- snapshots relevant Bash, Git, Node, shell, and sleep processes before the
  run, immediately after it, and after a two-second settle window;
- fails if Vitest fails or a new relevant process remains after settling.

Run it only in an operator-provided off-desktop Windows environment (ask for a
lab repository or skill). A generic invocation from a prepared Windows
checkout is:

```text
pnpm test:desktop-e2e e2e/windows-vitest-stress.inspect.spec.ts --repeat-each 10 --retries 0 -- --pwragent-vitest-stress
```

Add a validated repository-relative target with
`--pwragent-vitest-target=<path>`. Keep retries at zero during diagnosis: a
retry can make the aggregate green while erasing the iteration that contains
the evidence.

## The actual cost of this fix

This was not a three-test timeout adjustment. The recorded work before the
post-merge review follow-up included:

- 20 pre-fix Windows repetitions to separate focused residue from full-suite
  residue;
- 10 consecutive final full-workspace repetitions: 62,940 passing tests, 210
  skips, and 4,800 test-file executions, with no residual process after any
  iteration;
- 20 focused post-rebase repetitions (10 Composer and 10 App shell), followed
  by another complete workspace run;
- 310 focused local tests, plus ESLint, workspace typecheck, dependency
  boundaries, and the production build;
- four merged implementation commits across 12 files, with 1,184 additions
  and 42 deletions.

That is at least 51 recorded Windows repetitions, including 21 complete
workspace runs, and roughly 1,200 changed lines. It occupied most of a workday
because the first task was not "make the timeout go away"; it was proving which
failures shared a cause, building a diagnostic that preserved the evidence,
and then demonstrating that the cleanup held without retries or reduced
parallelism. The later exit-path review finding is another reminder that every
native/MSYS boundary needs a Windows-executed regression, even after the broad
stress suite is green.

## Code and test map

| Concern | Location |
|---|---|
| Stable Git Bash resolution | `apps/desktop/src/main/windows-shell.ts` |
| Suspended launch, Job Object ownership, and exit propagation | `apps/desktop/src/main/windows-job-wrapper.ts` |
| Native + Bash integration and exit-status regression | `apps/desktop/src/main/__tests__/windows-job-wrapper.test.ts` |
| Environment-action ownership and shutdown | `apps/desktop/src/main/app-server/codex-environment-runtime.ts` |
| Automation-gate ownership and shutdown | `apps/desktop/src/main/automations/automation-gate-runner.ts` |
| Queue lifecycle synchronization | `apps/desktop/src/renderer/src/features/composer/Composer.tsx` and its tests |
| Lazy Settings readiness | `apps/desktop/src/renderer/src/__tests__/app-shell.test.tsx` |
| Repeated Windows process-residue diagnostic | `apps/desktop/e2e/windows-vitest-stress.inspect.spec.ts` |

## Source

- [PR #1259: `fix(desktop): harden Windows test process isolation`](https://github.com/pwrdrvr/PwrAgent/pull/1259)
