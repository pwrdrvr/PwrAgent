# Outpost native preparation

The Outpost installer now reuses an unchanged, verified IPC relay on macOS and
Linux. It prepares that helper in a Node worker while the main thread stages
and verifies Git. Both owners finish before the installer reports success or
failure. Every existing Git inventory, architecture, signature and executable
probe still runs; peer verification in the helper is unchanged.

## Reuse rules

Reuse is opt-in for Outpost. Ordinary desktop helper builds still compile.
Windows retains its existing compiler path; Outpost supports macOS and Linux.
No dependency or native source changed.

The local reuse key includes preprocessed C and included headers, complete
compiler arguments and effective compiler/linker commands, build-script bytes,
platform, requested architecture, kernel identity and the sorted environment.
Compiler, assembler, linker, plugins, SDK settings, search directories and
actual linked inputs are recorded. Toolchain and library identity uses resolved
paths, filesystem device/inode, size, mode, and nanosecond modification/change
timestamps. Search-directory entries and dynamic loader inputs also invalidate
reuse. This avoids rereading a large compiler executable on every build.

The emitted helper's SHA-256 and permissions are checked on every hit. Toolchain
wrappers, uninspectable dependencies and dynamic library injection settings
fall back to compilation. Compilation records real linker inputs; a changed
pre/post-build plan refuses publication, and newly changed dependencies do not
get sealed for reuse on an ambiguous first build. This is a local build cache,
not an authenticity boundary against the checkout owner or privileged changes
to filesystem identity. Cache metadata is not shipped in the npm package.

One atomic directory lock owns compilation, invalidation and publication,
including the installed resource copy. A competing builder fails without
removing the owner's files. Rebuilds remove the old helper; failed owned builds
also remove the installed copy. Successful outputs and copies publish through
renames. An interrupted owner can leave its lock: inspect `owner.json`, verify
that the process and its compiler are gone, then remove the stale lock manually.
There is no unsafe PID-only automatic lock reclamation.

## Measurements

Seven alternating before/after pairs ran on macOS arm64, kernel 27.0.0, Node
24.22.1, with ten available CPUs. Each command used a fresh process. Run 0 was
retained separately as setup; the table summarizes runs 1–7. No other checks
ran concurrently with timed commands.

| Operation | State | Before median [min–max] | After median [min–max] |
| --- | --- | --- | --- |
| Helper process | cold | 86.8 [82.8–88.9] ms | 306.3 [287.0–319.8] ms |
| Helper process | warm | 87.3 [83.9–89.5] ms | 74.1 [70.6–78.6] ms |
| Full portable package build | cold | 1.011 [0.963–1.065] s | 0.983 [0.940–1.011] s |
| Full portable package build | warm | 1.003 [0.972–1.051] s | 0.958 [0.908–0.978] s |
| Focused owner command | cold | 6.076 [5.673–6.246] s | 6.041 [5.652–6.202] s |
| Focused owner command | warm | 6.022 [5.776–6.082] s | 5.963 [5.604–6.284] s |

Warm helper preparation improved in all seven pairs (median paired reduction
12.9 ms). Warm package builds improved in all seven pairs (52.3 ms; paired
range 29.2–108.1 ms). Cold package builds also improved in all seven pairs
(14.5 ms median paired reduction), despite the cold helper's extra toolchain
inspection costing about 220 ms. Parallel Git verification overlaps that cost.

Owner commands improved in only four of seven pairs in each state. Their warm
median paired reduction was 52.6 ms, with changes ranging from 171.7 ms faster
to 352.6 ms slower. These results do **not** establish a repeatable owner-test
speedup. The measured relay saving is small relative to the remaining roughly
six-second test command. A separate diagnostic run timed the two checkout
fixture builds at 229 and 232 ms; concurrency lifecycle cases took 606–718 ms
each and the boot case took 965 ms, including its build. The diagnostic is not
a median or an attribution of all wall time. It points toward owner process
startup/retirement and test bootstrap as the next profiling targets, rather
than further compiler caching. The temporary timing instrumentation was removed;
its driver and bounded log are `profile-owner.mjs` and
`v2-owner-build-profile.log` in the evidence directory. This change does not
remove other test bootstrap or owner work. The initial 479 ms compiler diagnostic was not a warm median.

Setup run 0 took 441/290 ms for the cold before/after helper, 1.480/0.953 s for
the cold package, and 6.633/5.605 s for the cold owner command. It is excluded
from the table. An earlier independent baseline series was slower than the
matched control, which is why the comparison uses alternating pairs rather
than subtracting independently collected medians.

## Reproduction

Use an otherwise idle native host and this worktree's own installed dependencies.
On macOS run outside the restricted Codex sandbox or in native CI so the normal
Git signature verification can succeed. Do not share `node_modules`.

```sh
node scripts/benchmark-outpost-native-preparation.mjs --phase before --samples 7
node scripts/benchmark-outpost-native-preparation.mjs --phase after --samples 7 --native-reuse
```

Run the first command against the original preparation scripts at `d31d8e3e9`,
and the second against the implementation. The driver itself is present at
that baseline; `--native-reuse` opts the direct helper measurement into reuse.
The package and owner commands use their installer normally. These independent
series reproduce the commands, but alternating pairs better control host drift.

The matched driver is retained at `.local/native-helper-cache/paired-v2.mjs`.
Run `node .local/native-helper-cache/paired-v2.mjs` in this investigation
workspace. It saves and restores the working copies of exactly three files:
`apps/desktop/scripts/build-mcp-ipc-relay.mjs`,
`packages/pwragent/scripts/build.mjs`, and
`packages/pwragent/scripts/install.mjs`. For each control it installs those
bytes from `d31d8e3e9`; for each after run it restores the implementation bytes
measured at `09a4af4a0`. C and runtime sources, dependencies and environment stay
identical. The script alternates order per pair, makes no preload instrumentation
or verification omissions, and uses these exact commands:

```sh
node --input-type=module -e 'import {buildMcpIpcRelay} from "./apps/desktop/scripts/build-mcp-ipc-relay.mjs"; buildMcpIpcRelay({outputRoot:process.cwd()+"/packages/pwragent",packaged:true,reuse:true});'
node packages/pwragent/scripts/build.mjs
pnpm test apps/desktop/src/main/__tests__/headless-host.boot.oracle.test.ts apps/desktop/src/main/__tests__/headless-concurrency.oracle.test.ts
```

The direct helper control passes `reuse:false`. Package builds include normal
source maps. Owner commands retain all global setup, including the existing
map-free package build, and execute seven tests. “Cold” removes only
`packages/pwragent/build/mcp-ipc-relay/packaged`; “warm” repeats without deletion.
Git payload, dependencies and OS caches remain warm. These are neither clean
installation/download measurements nor incremental JavaScript builds.

The ignored evidence directory contains `v2-paired-environment.json` (source
hashes and host), `v2-paired.json` (exact argv, status and timing for all 96
commands), `v2-paired-summary.json`, and per-command logs bounded to 120,000
characters. Separate `v2-before-*` files retain the pre-edit baseline. The
benchmark lock prevents concurrent deletion of shared outputs; an interrupted
driver requires the same ownership inspection before removing its lock.

The earlier investigation tried hashing the full compiler executable each time;
that optimistic design made warm preparation slower and was not shipped. Its
ignored `paired-reuse.*` evidence remains available, separate from these actual
implementation measurements.

## Output, runtime and ownership oracles

The native build oracle copies the real builder/cache module and C sources into
owned fixtures. It executes emitted code after source, included-header, build
flag and real linked-archive changes. Corruption with preserved size/mtime must
rebuild. Missing compilers and failed rebuilds must remove stale canonical and
installed helpers. Architecture changes inspect actual native headers; foreign
slices are not assumed executable. Fail-closed peer behavior remains exercised.
A positive reuse oracle proves that an unchanged executable was not replaced;
it fails against the original unconditional builder.

Independent output roots use process groups/Windows Jobs and join owners before
cleanup. A held same-output lock must preserve the owner's helper and installed
copy. The installer coordination model runs the real installer and Worker,
gates both preparations, and proves that a failure in either joins the other
before exit. It fails against the previous sequential installer. It also covers
npm-style ESM evaluation and inherited Node memory flags.

Native CI must verify Linux/macOS reuse and the unchanged Windows native
compiler/runtime path. The existing desktop-main lanes include these tests;
`ci:full` requests macOS as well. Local macOS measurements make no Linux or
Windows performance claim. Standalone packed-install probes cover the portable
loader, worker/bridge/hook entries, native modules, PDF/WASM, sandbox, private
lock, durable acceptance and CLI behavior.

## Local verification

After rebasing onto current main, the native build and installation coordination
oracles, helper-path and peer suites, owner boot/concurrency/conformance,
production entry and startup-import selection passed 131 tests. Three existing
platform/privilege cases in the peer suite were skipped; none of the new
oracles were skipped. All 42 Outpost package tests passed.

`pnpm --filter pwragent pack:check` installed the actual 154-file tarball away
from the checkout and passed the native, asset, daemon and loader checks above
(14 startup chunks, 22 optional chunks). `pnpm lint` passed syntax and typed
lint, typecheck, license checks and dependency boundaries. Normal Git signature
verification ran outside the restricted macOS sandbox. Logs are
`v2-final-focused.log`, `v2-final-package-tests.log`, `v2-final-pack-check.log` and
`v2-final-lint.log` in the ignored evidence directory. Native CI for the new
implementation is still required; the earlier green CI covered only the
investigation tests.
