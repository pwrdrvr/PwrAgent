# Outpost native preparation measurements

`packages/pwragent/scripts/build.mjs` copies the native sources and installer
scripts, then runs `install.mjs`. The installer rebuilds the IPC relay and calls
`stageRuntime`. An existing Git payload is reused only after the full inventory,
architecture, signature and executable probes pass. These measurements leave
that verification intact.

## Reproduction

Use an otherwise idle checkout with its own installed dependencies and an
already staged Git runtime. Run on the native macOS or Linux host; do not share
`node_modules` with another worktree. On macOS the normal Git signature checks
must run outside the restricted Codex sandbox or in native CI.

```sh
node scripts/benchmark-outpost-native-preparation.mjs --phase before --samples 5
node scripts/benchmark-outpost-native-preparation.mjs --phase repeat --samples 5 \
  --compiler "$(xcrun --find clang)"
```

`--compiler` is optional and identifies the actual compiler executable to hash
for the validation-cost probe. The example uses Xcode's compiler rather than
only hashing Apple's small `/usr/bin/cc` dispatcher. On Linux pass the actual
compiler executable for that toolchain.

The driver records the commit, Node executable/version, platform, architecture,
OS kernel and available CPUs in `.local/native-helper-cache/`. Each run starts
fresh processes and performs full builds. Run 0 is retained separately; the
summary uses the following five samples. Each cold/warm pair uses these commands:

- Helper: import `buildMcpIpcRelay` from the desktop script and call it with
  `{ outputRoot: "<checkout>/packages/pwragent", packaged: true }`.
- Package: `node packages/pwragent/scripts/build.mjs` with normal source maps.
- Owner: `pnpm test apps/desktop/src/main/__tests__/headless-host.boot.oracle.test.ts apps/desktop/src/main/__tests__/headless-concurrency.oracle.test.ts`.

“Cold” removes only `packages/pwragent/build/mcp-ipc-relay/packaged` before the
command. “Warm” repeats the same command without deleting it. Dependencies,
Git archives and the staged Git inventory are already present. These are not
controlled OS cold-cache, fresh-install or download measurements. The owner
command retains all global setup, including the map-free test package build,
and includes seven tests plus their startup and preparation costs.

Logs are capped at 120,000 characters per command. A benchmark lock prevents
multiple measurement drivers from deleting the same outputs. If a driver is
killed, inspect its `benchmark.lock/owner.json`, verify that it and its children
are gone, and only then remove that lock before repeating the measurements.

## macOS arm64 investigation

The initial series used commit `c71b9a793`, macOS arm64 and Node 24.22.1. No
production builder, installer, C source, native verification or test timeout was
changed during this investigation. Independent repeat measurements therefore
serve as a control for timing drift, not as a claimed optimization.

The initial helper process took 451 ms, the initial package build 1.498 s and
the initial owner command 8.012 s. Subsequent measurements were substantially
faster. The earlier diagnostic observation of a 479 ms compiler process is not
a representative warm median.

A separate unchanged-build profile took 1.044 s and attributed 105 ms to `cc`,
97 ms to 12 `lipo` calls, 206 ms to 12 `codesign` calls, 29 ms to four Git probes,
and 11 ms to source/notice copying. This profile is diagnostic, not a median or
an assertion that those costs can safely be removed.

The conservative validation-cost probe expands the C source through `cc -E`,
hashes that expanded input, hashes the actual compiler executable, and hashes
the helper output. Its warm median was 67.34 ms [66.09–71.69], including a
46.03 ms compiler hash and 20.61 ms preprocessing. It excludes Node startup,
full toolchain/linker/SDK identity checks, cache metadata and ownership work.
This is a lower bound for that particular content-validation design, not a
proof that every possible cache design has the same cost.

The matched experiment used five alternating control/reuse pairs after a
separate setup pair. Both modes loaded the same instrumentation; only native
build commands initialized its probe. It observed 18 cache hits and 18 misses
including setup, with all commands passing. No concurrent checks ran during
timed commands.

| Operation | State | Control median [range] | Optimistic reuse median [range] |
| --- | --- | --- | --- |
| Helper process | cold | 90.3 [88.3–115.3] ms | 177.8 [165.4–185.2] ms |
| Helper process | warm | 92.4 [85.8–108.0] ms | 102.8 [101.7–112.0] ms |
| Full package build | cold | 1.018 [1.002–1.137] s | 1.165 [1.062–1.243] s |
| Full package build | warm | 1.010 [0.990–1.071] s | 1.025 [1.002–1.131] s |
| Focused owner command | cold | 5.916 [5.827–8.298] s | 5.919 [5.882–6.533] s |
| Focused owner command | warm | 6.146 [5.832–6.503] s | 5.880 [5.819–6.248] s |

The experiment restores previously compiled bytes only after checking expanded
C input, compiler bytes, arguments, build-script bytes, platform/architecture,
the process environment and cached-output integrity. It retains the original
stale-output removal and all Git verification. It intentionally omits complete
linker/SDK/toolchain validation and a general concurrent cache publication
protocol; it is an optimistic performance bound, **not a safe production cache**.
Cold experiment runs also remove its cached binary.

Warm helper preparation got slower in every paired sample (median paired
increase 13.94 ms). The full warm package build got slower in four of five
pairs (median paired increase 12.58 ms). Owner command medians moved faster,
but their ranges overlap substantially and the change exceeds the entire
measured relay step. These samples do not establish an owner-test speedup.

No production cache is enabled. The measured design provides no package-build
saving even before completing its safety checks. The evidence does not rule
out a different, cheaper toolchain-identity design or a benefit on another
native platform; it does not justify adding that complexity to this security
helper on the measured host.

The ignored experiment and its exact commands are retained at
`.local/native-helper-cache/optimistic-reuse.cjs` and `paired-reuse.mjs`.
Reproduce the paired experiment with `node .local/native-helper-cache/paired-reuse.mjs`
in this investigation workspace. The driver sets the same absolute
`NODE_OPTIONS=--require=<checkout>/.local/native-helper-cache/optimistic-reuse.cjs`
for each measured command and selects `PWRAGENT_REUSE_EXPERIMENT=control` or
`reuse`. Results, environment, per-command logs and cache-hit events are in
`paired-reuse.json`, `paired-summary.json`, `paired-environment.json` and
`experiment-events.jsonl`. Interrupted samples are retained with an
`interrupted-` prefix and excluded. The committed benchmark driver reproduces
the unmodified-build baselines and validation-cost probe without this experiment.

## Safety oracles

`apps/desktop/scripts/build-mcp-ipc-relay.oracle.test.mjs` copies the actual
builder and native source tree into owned temporary fixtures. A small C wrapper
preserves the production entry and adds a query identifying the source, included
header and compiler flag that actually reached the emitted executable.

The tests execute the helper, inspect its native machine header, change source,
included headers and build-script flags at the same output path, corrupt the
output, and remove the compiler from the build environment. They check that a
failed rebuild leaves no old usable helper and that the rebuilt production
entry rejects an absent peer without writing protocol data. They also exercise
independent concurrent output roots and a shared packaged filename across
requested architectures. Cross-architecture execution is not assumed.

An intentionally invalid candidate that returned an existing helper before
compiling failed four of the five oracles. The normal builder passed all five.
The candidate was removed; no cache or alternate production build path ships.
The separate existing MCP IPC suite supplies real connected-peer, HTTP and
platform-specific identity tests.

The independent-root test does not establish a same-output concurrent cache
publication protocol. A future cache would need that ownership protocol as well
as complete invalidation for source and includes, every relevant build script
and flag, platform/architecture, toolchain and SDK/linker inputs, environment and
output bytes. Failed validation/rebuilds must remove stale usable outputs, and
helper reuse must not replace any Git verification or runtime peer checks.

## Verification

The normal native build/output oracles and existing helper-path/peer-verification
suites passed on native macOS arm64: 21 passed, with three existing
platform/privilege-dependent skips in the peer suite. All five new oracles
passed without skips. After rebasing onto current main, the combined native
and owner boot/concurrency selection passed 28 tests with the same three
existing skips. The package suite passed all 42 tests. The normal standalone
packed installation passed its
portable loader, workers, bridge/hook, native modules, PDF/WASM, sandbox, lock,
durable acceptance and CLI probes. Syntax lint, typed lint, native typecheck,
license checks and dependency boundaries passed.

The new tests belong to the existing `desktop-main` project and run with native
compilers on Linux, macOS and Windows CI. Request `ci:full` for the macOS PR
lanes. These tests verify native output and runtime paths; the timings above
remain macOS measurements, not Linux or Windows performance claims.
