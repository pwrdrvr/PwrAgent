# Electron main function bytecode budget

Every first-party main-process function has a chosen early operational budget
of **25,600 bytes (25 KiB)**. This is not V8's hard cutoff, a universal latency
threshold, or a benchmark. No runtime speed improvement is claimed. A speed
claim requires three plain-Node and three no-Sparkplug measurements, with the
machine and runtimes reported.

## Audit before choosing refactors

The application sources at main commit
`8f9e937d52f7694a76a977bf22843bed13a3f2b9` already fit this budget. The audit
made no application-source changes. There was no over-budget controller to
refactor, and no failing application baseline to claim. IPC, effects,
references, process/queue ownership, shutdown, and production function
separation therefore retain their existing implementations.

Measured on 2026-11-17:

- Apple M2 Max, 12 logical CPUs, 32 GiB RAM, arm64.
- macOS 27.2, build 26B123; Darwin 27.2.0.
- Test/host Node 24.22.1, V8 `13.6.233.17-node.58`.
- Electron 44.10.2, embedded Node 24.22.2, V8
  `15.2.124.45-electron.0`.
- Vitest 5.0.5, Vite 8.3.7, Rolldown 1.2.18 and its Oxc compressor.

| Compilation | First-party compiler records | Maximum first-party function | Bytes |
| --- | ---: | --- | ---: |
| Node, actual Vitest SSR | 34,787 | `desktopSettingsPatchToEdits` | 23,437 |
| Node, shipped Oxc output | 27,791 | `desktopSettingsPatchToEdits` (`kDe`) | 23,691 |
| Electron, shipped Oxc output | 27,790 | `desktopSettingsPatchToEdits` (`kDe`) | 23,595 |

The maximum belongs to
`apps/desktop/src/main/settings/desktop-config.ts:595`. The next two largest
functions are `readSettingsProjection` (20,143 / 19,269 / 19,266 bytes) and
`handleBackendEventNow` (18,013 / 17,314 / 17,217 bytes), in the same table's
compilation order. These values are compiler/runtime/architecture specific.
Records include generated constructors, initializers, closures, and duplicate
compilations across runtime variants; they are not a count of distinct source
function declarations.

There are **1,292 source modules**: 935 roots under `src/main` and 357
first-party helpers outside it. All **22 emitted main JavaScript files** are
compiled, including the five configured entries and their shared/lazy chunks.
The report contains 120,583 compiler records. The complete source inventory,
source and compilation SHA-256 hashes, runtime versions, every function size,
generated positions, source-map locations, provenance and classifications are
written by `--report`.

## Reproduce and retain measurements

```sh
mkdir -p .local/main-bytecode
pnpm check:main-bytecode --report .local/main-bytecode/main-bytecode.json
pnpm check:renderer-bytecode
pnpm test scripts/main-bytecode.property.test.mjs apps/desktop/src/main/__tests__/composer-bytecode.property.test.ts
```

The main command always rebuilds main using the shipped
`electron.vite.config.ts`, production definitions, externalization, code
splitting, hidden maps and Oxc compression. It cannot accidentally check an
old `out/main`. CI's Lint job runs the default scope and uploads the complete
`main-bytecode.json` as the `main-bytecode` artifact, including on a budget
failure (seven-day retention). Save the JSON to retain an audit beyond that
period; the checked-in maxima above preserve the initial result.

`check-main-bytecode.mjs --scope <json>` is a low-level oracle/audit interface
for alternate `roots` and `productionFiles`. CI never supplies alternate
scope. The build command is the normal contributor entry point.

## Coverage and attribution

- Every non-test main implementation module is a root, including modules not
  currently reachable from `index.ts`. Declaration files and test/fixture
  directories are not roots; a reachable implementation is still followed.
- Literal relative imports, reexports, lazy imports and CommonJS imports are
  followed through TypeScript's package-export resolution and physical
  workspace symlinks. Shipped source maps also seed first-party helpers.
  There is no first-party helper boundary/exemption list. Nonliteral module
  imports fail closed; ordinary locally defined functions named `require`
  are not mistaken for Node's module loader. Raw assets are not JavaScript.
- Tests use the **desktop-main Vitest SSR environment** and Vitest 5's actual
  async module-evaluator wrapper, including its CJS globals. SSR's inline
  maps are adjusted for that wrapper's prefix. Production uses the actual
  emitted ESM and `vm.SourceTextModule`, with no SSR or CJS wrapper added.
- The shared disposable compiler uses `--no-lazy` to compile nested,
  anonymous, arrow, object/class methods and field initializers. Application
  modules are never executed or linked. Disassembly is reduced as it streams;
  the report retains sizes and locations, not disassembly. The application
  and test workers keep their existing V8 tier flags; Sparkplug is not disabled.
- Native ESM/script and Vitest evaluator frames are labeled
  `synthetic-module-wrapper`. Callbacks to the generated Rolldown runtime's
  module-initializer helpers are `synthetic-bundler-wrapper`; only inventory
  entries without maps are eligible to be the synthetic runtime itself.
  Nested first-party functions retain their own records and full budget.
  A similarly named first-party helper with a map is not exempt.
- Bundled third-party functions are measured and labeled `third-party` using
  source maps, separately from first-party code. Any first-party contribution
  to a compressed mixed-source frame keeps the **whole frame** budgeted.
  External third-party dependencies are outside this first-party policy.
- Unmapped functions are conservatively budgeted, with generated file and
  positions retained. The initial report has 264 Node and 261 Electron
  production records in this category; their largest is 331 bytes.
  Missing maps fail except for the generated runtime inventory.

The large native ESM initialization frame in `out/main/index.js` is measured
separately: **207,384 bytes on Node and 207,058 on Electron**. It is a
synthetic module frame, not an excluded first-party controller. This policy
places no size limit on synthetic module frames or bundler glue and does not
promise fast module initialization. No wrapper refactor is proposed without
runtime evidence. Dynamically generated source strings, native code, external
agent processes and the separate preload/renderer targets are outside main's
function budget. The renderer retains its existing separate guard.

## Failure and extraction oracles

The property/oracle suite covers cyclic helper graphs, reexports, literal lazy
imports, workspace package extraction, nested/anonymous functions, object and
class functions, field initializers, synthetic wrapper boundaries, mixed
first/third-party provenance, and missing source-map attribution.

A new helper containing an anonymous callback with 4,000 observable property
updates fails the real SSR and Oxc-production checks on Node and Electron.
Moving those same updates into four named function frames passes, including
production compression. A separate oversized function with an empty source
map also fails. The fixtures cross the bytecode bound rather than infer size
from source length or elapsed time. Compiler subprocess integrations have a
30-second test-harness timeout; no test asserts a runtime latency threshold.
