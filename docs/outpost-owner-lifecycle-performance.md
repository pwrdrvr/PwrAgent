# Outpost owner lifecycle performance

Constructing the backend registry previously called
`DesktopSettingsService.resolveCodexSpawnEnv()`. That synchronous read returned
its cached environment immediately, but also started an interactive login-shell
probe in the background. An owner that never used a provider still ran its
shell startup files and remained alive until that child closed.

Registry construction now reads `readCodexSpawnEnvSnapshot()`. This returns the
same base/cached environment without starting the default shell probe. Existing
injected synchronous resolvers retain their behavior. Actual Codex launches,
discovery, Token Miser preparation and migration already await
`resolveCodexSpawnEnvAsync()`; first use still hydrates through the real shell,
shares concurrent requests and updates the cached environment. The legacy
synchronous resolver retains its existing behavior for other callers.

## Measurements

The investigation used a new worktree with its own `pnpm install`, on macOS
arm64, kernel 27.0.0, Node 24.22.1, with ten available CPUs. The baseline is
`01b0a1d37`, the implementation of PR #3871, including native-helper reuse and
parallel Git/helper preparation. This change is separate from that work.

The exact measured command was unchanged:

```sh
pnpm test apps/desktop/src/main/__tests__/headless-host.boot.oracle.test.ts apps/desktop/src/main/__tests__/headless-concurrency.oracle.test.ts
```

All seven tests, normal global setup, map-free test builds, native preparation
and Git inventory/architecture/signature/runtime verification remained enabled.
Each sample started a fresh process and performed the normal full command;
fixtures and daemon processes were not shared across tests. No assertions,
timeouts, retries, worker counts or serial lanes changed.

Seven alternating before/after pairs, excluding setup pair 0:

| Full focused owner command | Median | Min–max |
| --- | --- | --- |
| Before | 5.584 s | 5.501–5.629 s |
| After | 3.130 s | 3.103–3.268 s |
| Paired reduction | 2.449 s | 2.316–2.526 s |

All seven pairs improved. The median-to-median reduction is 43.9%. This is an
actual full-command timing improvement on this host, not an inference from a
smaller artifact. It is not a cross-platform performance claim, or a prediction
for owners that immediately need a login shell. First-use shell work is deferred,
not removed from a provider launch that needs it.

A separate initial unchanged series measured setup at 8.314 s, then seven warm
commands at median 5.556 s [5.533–5.681]. The matched setup pair took
5.675/3.093 s before/after and is excluded from the table. Dependency installation
and initial staging were not timed as warm samples. Dependencies, staged Git
and OS caches stayed warm; these are not fresh-install/download or controlled
OS cold-cache measurements.

## Profiling evidence

Temporary instrumentation timed actual driver require, service startup,
shutdown phases and process exit. One unchanged diagnostic command measured
seven drivers: module load median 139 ms, startup 58 ms, explicit shutdown 10 ms,
then a further 410 ms [387–446] from database/service disposal to process exit.
The CPU profiles mostly sampled idle time during that final gap.

A separate async-resource trace identified a referenced 2,500 ms `execFile`
timer belonging to `resolveInteractiveLoginShellEnvAsync`; its child was still
running after owner state disposal. The timer's configured deadline is not the
observed delay: the actual shell generally finished in roughly half a second.
With the change, the same diagnostic measured post-disposal retirement at
0.1 ms [0.1–0.2] across seven drivers. These per-driver diagnostics are mechanism
evidence from one command per variant, not independent benchmark repetitions.
All temporary production instrumentation was removed before matched timings.

## Reproduction and evidence

Use an idle native checkout with isolated installed dependencies. On macOS run
the normal command outside the restricted Codex sandbox or in native CI so Git
signature verification can succeed. Commit both production files before using
the driver; it refuses to overwrite uncommitted edits to them.

```sh
node scripts/benchmark-outpost-owner-lifecycle.mjs \
  --baseline-ref 01b0a1d37 --phase repeat --samples 7
```

The driver alternates order per pair and swaps exactly two source files from
the baseline: `settings/desktop-settings-service.ts` and
`app-server/backend-registry-wiring.ts` under `apps/desktop/src/main/`. The C
source, native preparation, tests, dependency tree, environment and all safety
checks are identical. It restores the implementation in `finally`, saves source
hashes and backups, and records exact argv, host, status, load and elapsed time.
Run 0 is a separate setup pair. A lock prevents two drivers from modifying the
same outputs. A killed driver can leave swapped files and a lock: verify the
owner and its children are gone, then restore the saved source bytes and remove
the lock. There is no automatic stale-lock recovery.

Ignored `.local/owner-lifecycle/` retains `before-timings.json`,
`before-environment.json`, `paired-timings.json`, `paired-environment.json` and
per-command logs bounded to 120,000 characters. The seven-pair run used the
retained `paired.mjs` driver at implementation `ac69a530f`; the committed driver
implements the same commands/order and adds argument validation, a clean-source
guard and a summary. `profile.mjs`, `profile-timers.mjs`, `profile-after.mjs`,
`profile-events.jsonl`, `timer-events.jsonl`, `after-profile-events.jsonl`, bounded
diagnostic logs and CPU profiles retain the mechanism evidence.

## Runtime oracle

`headless-shell-environment.oracle.test.ts` builds the real desktop and Outpost
composition roots and runs each in a fresh process under the existing CLI spawn
guard. It records actual `execFile` admission synchronously while forwarding to
the native implementation, then uses an executable shell fixture to return a
marker environment. Startup must admit zero shell probes. Two concurrent first
uses must receive the marker through one probe, and the cached environment must
retain it. Windows verifies its supported no-login-shell behavior.

The test fails on the unchanged baseline because registry startup admits one
probe. It passes after the change. Its process group/Windows Job and stdio are
joined before fixture cleanup; it uses no timing threshold or sleep to establish
absence of a startup probe. Existing owner lifecycle assertions remain unchanged.

## Verification

The normal focused selection of shell laziness, settings/discovery, replay
isolation, owner boot/concurrency/profile/conformance, startup imports and
production-entry tests passed all 282 tests across 13 files. The original
seven-test command remained unchanged throughout timing. The Outpost package
suite passed all 42 tests with zero skips. The actual standalone tarball installed
away from the checkout and passed portable loader, worker/bridge/hook, native
module, PDF/WASM, sandbox, lock, durable acceptance and CLI probes (154 files;
14 startup chunks and 22 optional chunks).

`pnpm lint` passed syntax lint, typed lint, typecheck, license checks and dependency
boundaries. `pnpm check:main-bytecode` passed the 25,600-byte per-function budget
(maximum 23,834 bytes across the measured transforms). The benchmark driver
passed syntax checking and a real one-sample paired smoke run, which measured
5.598/3.135 s before/after and restored its source files. That single pair is not
included in the seven-pair table.

Logs are retained as `focused.log`, `package-tests.log`, `lint.log`,
`main-bytecode.log`, `pack-check.log`, and `driver-smoke-*` in the ignored evidence directory.
Native CI is required for Linux/Windows behavior and is not replaced by the
local macOS results. Already-admitted shell hydration's shutdown ownership is
unchanged; that existing gap is tracked separately from deferring unused probes.
