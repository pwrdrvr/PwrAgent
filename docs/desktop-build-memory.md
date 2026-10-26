# Desktop build heap investigation — 2026-10-26

The desktop build's large heap comes from Rollup's module graphs and the
generation, decoding, and composition of source maps. Main and renderer each
need substantial memory independently. Building them in fresh, sequential Node
processes reduces the peak without changing their generated files.

Measurements below used macOS arm64, Node 24.22.1, electron-vite 5.0.0,
Vite 7.3.7, Rollup 4.61.1, and `--max-old-space-size=4096`, starting from
commit `15ee2f13303ffaec0440957e85b2fed44be8b1ec`. All experiments ran in this
checkout with its own installed dependencies. These are local macOS results;
Linux and Windows were not measured.

## Measurements and attribution

Peak heap is the largest **used** heap immediately before a collection in
`--trace-gc` output, supplemented by a 10 ms `process.memoryUsage()` sampler.
It is not heap capacity or the old-space limit. RSS is per-process maximum RSS
from `process.resourceUsage()`. Times include process startup and all targets,
but exclude the unchanged postbuild boundary check. Profiling runs were
sequential. GC timing and machine load cause variation.

Main transformed 2,528 modules, containing approximately 23.1 MiB of module
code, including virtual/transformed modules. Its largest dependency groups
were the Feishu SDK (one 5.57 MiB module), undici (225 modules, 2.60 MiB), and
discord.js (413 modules, 1.68 MiB). Renderer had 3,481 nonexternal module IDs
and approximately 20.2 MiB of module code. Its larger groups included mermaid
(2.69 MiB), its parser (1.31 MiB), react-dom (1.17 MiB), and cytoscape
(1.06 MiB). These source sizes describe the graph; they are not retained-heap
measurements or shipped bundle sizes.

In an instrumented baseline, heap at main's `buildEnd` was 1,588 MiB and at
`writeBundle` was 2,169 MiB. Preload started on that heap; it was only about
85 MiB when built alone. The renderer later reached 2,607 MiB before GC.
Forcing a collection inside main's `closeBundle` still left 1,220 MiB, while
a collection after preload fell to 66 MiB. The previous graph is eventually
collectible, but memory is not promptly released at the target boundary.

An Inspector allocation-sampling run, with 128 KiB sampling and collection of
allocations reclaimed by both minor and major GC, identified these costs:

| Allocation site | Sampled cumulative allocations |
| --- | ---: |
| Rollup source-map `decode` | 2,215 MiB |
| electron-vite `vite:esm-shim` → MagicString `generateMap` / `addUneditedChunk` | 1,242 MiB |
| Rollup `Link.traceMappings` | 545 MiB |
| Rollup `NodeBase` construction | 490 MiB |

These are allocations over the whole build, **not simultaneous live memory**.
The shim inserts CommonJS compatibility code and produces a boundary-resolution
identity map; Rollup then decodes and composes it with other maps. Vite's asset
rewriting also generates intermediate maps. Source-map strings on disk are
small compared with their decoded arrays and the graph held during rendering.
The main entry's map alone was about 17.6 MiB on disk.

## Controlled configuration experiments

Each row below changes one setting from the same instrumented baseline.
These are single runs, useful for attribution rather than precise timing
comparisons. All retained hidden maps unless the row explicitly disables them.
The Feishu and Discord rows explicitly externalized only that SDK; workspace
providers and `ws` kept their existing policy.

| Experiment | Peak heap (MiB) | Build time (s) | Decision |
| --- | ---: | ---: | --- |
| Baseline | 2,607 | 20.48 | Reference |
| Sourcemaps disabled on all targets | 1,656 | 17.53 | Reject: removes required debug artifacts |
| Minification disabled on all targets | 2,706 | 34.13 | Reject: no memory improvement |
| Feishu SDK externalized | 2,560 | 22.48 | Reject: little whole-build benefit; changes runtime dependency loading |
| Discord SDK externalized | 2,505 | 21.20 | Reject: modest whole-build benefit; changes runtime dependency loading |
| Explicit GC at each `closeBundle` | 2,303 | 23.88 | Reject: still inside the graph's lifecycle; requires exposed GC |
| Rollup compact output | 2,707 | 24.72 | Reject: no improvement |
| esbuild syntax transform for main JS dependencies | 2,601 | 30.45 | Reject: no meaningful improvement |
| Compressed-size reporting disabled | 2,612 | 24.56 | Reject: no meaningful improvement |
| CommonJS shim render hook moved before other render hooks | 2,810 | 23.25 | Reject: higher peak |

Externalizing Feishu lowered heap at main's `buildEnd` to 1,158 MiB, but main
still reached about 2,286 MiB while rendering. Its module size contributes to
the graph without explaining the entire peak. A fresh-process main build
peaked at 2,328 MiB; a fresh renderer peaked at 2,323 MiB. Process separation
therefore helps with memory carried between targets, but cannot remove each
target's intrinsic working set. Externalizing Discord reduced main's peak to
2,078 MiB, while renderer still reached 2,505 MiB.

## Adopted change

`pnpm --filter @pwragent/desktop build` now runs `scripts/build.mjs`, which
starts the existing electron-vite CLI sequentially for main, preload, and
renderer using the same Node executable. The build-only
`PWRAGENT_BUILD_TARGET` selector filters the existing configuration. Each child
inherits `NODE_OPTIONS` and exits before the next starts. A failed or
signal-terminated child stops the build. The ordinary CLI remains available
for a one-process comparison; development ignores target selection.

Three alternating comparisons used the actual CLI and wrapper, without the
diagnostic Vite hooks used in the earlier experiments:

| Run | Before heap (MiB) | After heap (MiB) | Before time (s) | After time (s) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 2,851 | 2,348 | 23.34 | 25.55 |
| 2 | 2,668 | 2,320 | 24.73 | 25.62 |
| 3 | 2,921 | 2,481 | 23.15 | 24.54 |
| Median | 2,851 | 2,348 | 23.34 | 25.55 |

Median peak heap fell **17.6% (503 MiB)**, with a **9.5% (2.21 s)** increase
in build time. Median maximum child RSS fell from 3,503 to 3,095 MiB (11.6%).
The wrapper itself used about 48 MiB RSS, additional to the active child's RSS.
This trades a small startup/build cost for an explicit lifetime boundary.

SHA-256 comparisons found **all 344 output files byte-for-byte identical** in
each before/after pair, including JavaScript, CSS, HTML, assets, worker debug
companions, and hidden maps. Bundling, externalization, minification, embedded
map sources, and packaging exclusions are unchanged. The main/preload bundle
boundary and debug-output inspection must still pass. ASAR verifier tests
exercise required runtime files and forbidden contents; no packaging rule was
weakened.

Verification of the initial process-isolation change passed: the normal `pnpm --filter @pwragent/desktop build`
and its postbuild boundary check; 27 focused tests across the launcher,
configuration, debug artifacts, and ASAR verifier; syntax and typed Oxlint;
workspace typecheck; and dependency boundaries. Debug-output inspection
validated 238 debug files, including 115 maps with embedded sources. The final
normal package build also matched the baseline's 344 file hashes. A full
packaged application and desktop E2E were not run for this build-only change.

Keep the CI heap allowance from PR #2924. Individual targets still exceed
2 GiB at a 4 GiB old-space allowance. Both layouts also completed a separate
2 GiB diagnostic locally, with much more GC and variable timings; that does
not reproduce or invalidate the original CI failure, or establish safe
headroom for code growth.

## Reproducing the comparison

From `apps/desktop`, on macOS, with no inherited `PWRAGENT_BUILD_TARGET`:

```sh
mkdir -p ../../.local/build-heap
/usr/bin/time -l node --max-old-space-size=4096 --trace-gc \
  node_modules/electron-vite/bin/electron-vite.js build \
  > ../../.local/build-heap/one-process.log 2>&1
```

To profile the isolated targets with the same V8 tracing, run the following
command once for each of `main`, `preload`, and `renderer`, changing both the
selector and log name. The package wrapper runs these in that order:

```sh
PWRAGENT_BUILD_TARGET=main /usr/bin/time -l \
  node --max-old-space-size=4096 --trace-gc \
  node_modules/electron-vite/bin/electron-vite.js build --ignoreConfigWarning \
  > ../../.local/build-heap/main.log 2>&1
```

Use the greatest pre-GC used-heap value across the isolated logs, rather than
adding their peaks. Time the wrapper as well to include its startup overhead.
`/usr/bin/time -l` is macOS-specific. Pass `--trace-gc` directly to Node;
`NODE_OPTIONS` rejects it. The alternating comparisons used a preload sampler
that enabled the equivalent V8 tracing in every child and recorded per-PID
RSS, heap samples, and elapsed time; all six runs used the same instrumentation.

## Rolldown and Oxc follow-up

The next experiment migrated to electron-vite 6.0.0, Vite 8.3.4,
`@vitejs/plugin-react` 6.1.2, and Rolldown 1.2.14. Vite 8 uses Rolldown's
Rust bundler and Oxc transforms/minification. These replace the large
JavaScript Rollup graph, rather than replacing TypeScript typechecking.

A fresh three-run Rollup baseline and three-run samples of each corrected
native configuration used the same Node 24.22.1 and 4 GiB old-space limit.
This series also sampled **all processes descended from the build command**
every 50 ms, including esbuild and the wrapper. Unlike V8 heap, that RSS
includes Rolldown's native allocations. These timings include the sampling
overhead and must be compared within this series, rather than with the
earlier 23-second baseline. Build times exclude the postbuild boundary check.

| Configuration | Median used heap (MiB) | Median process-tree RSS (MiB) | Median time (s) |
| --- | ---: | ---: | ---: |
| Vite 7 / Rollup / esbuild, one process | 2,702 | 3,283 | 30.55 |
| Vite 8 / Rolldown / Oxc, one process | 902 | 1,815 | 7.09 |
| Vite 8 / Rolldown / Oxc, sequential target processes | 655 | 1,629 | 6.87 |

The selected native configuration retains process isolation. Against the
fresh original baseline, it reduced measured heap by **75.8%**, process-tree
RSS by **50.4%**, and build time by **77.5% (4.45× faster)**. The isolated
native runs took 8.25, 6.87, and 6.62 seconds; RSS peaks were 1,670, 1,629,
and 1,523 MiB. Timing differences between the two native layouts are small
relative to run variability; the memory reduction is the reason to retain
separate processes. RSS was more variable without process isolation
(1,213–2,293 MiB), so these are local measurements, not cross-platform promises.
Keep the existing CI heap allowance.

Two additional isolated native experiments kept all hidden maps:

| Minifier | Used heap (MiB) | Process-tree RSS (MiB) | Time (s) | Generated JS (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Oxc, three-run median | 655 | 1,629 | 6.87 | 15.54 |
| esbuild, one run | 664 | 1,882 | 7.46 | 15.78 |
| No minification, one run | 659 | 1,667 | 9.25 | 31.00 |

Generated JS includes entries, chunks, and the retained inline-worker debug
companion. The original Rollup output totaled 15.72 MiB. Removing
minification did not reduce memory and nearly doubled JavaScript size. Oxc
keeps the supported Vite 8 pipeline and avoids the additional esbuild process.

Compatibility changes and checks:

- Use `rolldownOptions`, native `codeSplitting.groups`, and the Rolldown
  optimizer options. Preserve the existing vendor-group matching rules,
  hidden maps, workspace/SDK externalization policy, and profiling alias.
  Vite 8 handles mixed CommonJS/ES modules natively; its former
  `commonjsOptions` option is a no-op.
- electron-vite's shim declares `require`. Rolldown initially emitted the
  same name for an application's `createRequire` binding. With esbuild this
  failed the build; Oxc initially reported success while emitting duplicate
  declarations. Give the three application resolvers distinct names, with
  the same resolution behavior. The invalid initial builds are excluded
  from the corrected native comparisons above.
- Strengthen the postbuild check to syntax-check emitted main and preload
  JavaScript, visit nested chunks, and recognize literal template strings in
  `require` calls. The original flat check missed the invalid declaration
  and could miss dependencies in Rolldown's nested chunks.
- Retain the exact worker/map companion. Manual source-map probes resolve
  generated main and inline-worker positions to the expected original
  TypeScript files and lines. Debug inspection still requires hidden maps
  with embedded sources. New chunk names and generated code are expected
  when changing bundlers; the earlier byte-identity result applies only to
  process isolation within Rollup.

The normal native package build and expanded main/preload boundary check pass
locally. Broader lint, unit, platform E2E, and packaging checks are delegated
to repository CI: Sandboxer rejected a new verification VM with
`daily_limit_reached` (100 machine starts per day). No repository unit tests,
lint, or typecheck were run locally during this follow-up.
