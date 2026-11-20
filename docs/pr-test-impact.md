# PR test impact

This prototype plans which tests a pull request affects, then executes that
plan on hosted runners beside the required jobs. It runs on code-impacting PRs
from branches starting with `prototype/pr-test-impact`. Required jobs, their
lanes and the classifier are unchanged, and no job depends on the narrowed
jobs. Windows and macOS Desktop E2E, the standalone Outpost tests, and pushes
to `main` or release branches have no plan.

## Jobs

- `PR test impact plan` runs as soon as dependencies are installed. It writes
  `plan.json` and the outputs that start the narrowed jobs.
- `PR test impact unit` executes the selected Vitest files on Linux and
  Windows. It also executes two recorded change sets (#3932 and #3889) on
  Linux, so every run times a typical product diff.
- `PR test impact E2E` executes the selected Playwright specs on Linux.
- `PR test impact report` runs after the full lanes. It compares the narrowed
  jobs with the full lanes of the same attempt and lists every failure the
  full Linux lanes observed that the plan did not select.

A selected plan with no tests starts no job. A full plan starts no narrowed
job either: the required lanes are that run.

## Diff provenance

The plan verifies the GitHub file list against an immutable three-dot Git diff
and requires the checkout to be the merge of the event's base and head. It
then plans from that merge's first-parent diff: what the PR changes on top of
the base tip. A branch behind its base still narrows, because a test that
reaches none of those files runs the same code as on the base tip, where
`main`'s own full run covers it. Of 94 failed PR runs between 2026-11-16 and
2026-11-20, 58 tested a branch behind its base.

For a GitHub stack that first merges the declared PR base into trunk, the plan
compares the tested child patch against that synthetic parent and requires an
exact match to the PR patch. An ambiguous merge, or a stack whose base moved,
selects the full suite.

## Vitest selection

Vitest's related-file resolver decides which test files a changed module
affects. It follows static imports and literal dynamic imports, honors
`vi.mock`, and selects a whole project when a setup file, snapshot serializer
or environment reaches the change. The plan adds five rules.

- **Barrels.** `packages/shared` declares `"sideEffects": false`, and its
  index only re-exports. A test that reaches a changed module only through
  that index, without importing one of the module's names, is not selected.
  A namespace import, dynamic import, `require` or mock of the index keeps
  every edge. An edit to the index itself selects every importer.
- **String references.** A changed file with no import edge selects the tests
  that reach a module naming it: by basename for data such as a budget JSON,
  and by module path for code. A changed module also selects the tests behind
  any file that names it and contains a computed `import()` or `require()`.
- **Type-only modules.** A module that emits no JavaScript has no runtime
  edge and selects nothing. Typecheck still covers it in `Lint`.
- **Always-run tests.** A test, or test helper, that lists directories can
  read a file that nothing imports. Every plan includes those tests (79 of
  2,307 files on 2026-11-20).
- **Tests that run source outside the graph.** A test that bundles source
  with esbuild or Vite, starts a worker, or runs a TypeScript loader executes
  modules that Vitest never links to it. Those tests, and the tests behind a
  helper that imports a bundler, run whenever a file that is not a test input
  changes (36 files on 2026-11-20). `headless-host.boot.oracle.test.ts`
  bundles the headless entry this way. PR #3809 changed main-process modules
  and had to update that test, which no import edge linked to them.

A deleted file selects nothing by itself: an unchanged importer fails
resolution, and a changed importer is in the diff. Deletion selects the full
suite when another file can now answer the same import (`name.js` beside a
deleted `name.ts`, an `index` file, or a `__mocks__` entry).

The full suite runs for:

- dependency metadata, patches, CI, and test or build configuration;
- native or platform-only inputs;
- a changed file that contains a computed import or `createRequire`;
- an unresolved static import or a transform error anywhere in the graph;
- a changed module that no test reaches, and a data or script file that no
  module names;
- a planner error.

## Playwright selection

Playwright launches the built application. No recorded map says which specs
execute a given product module, so a diff that touches product code selects
the full suite. A diff confined to unit-test inputs and `apps/desktop/e2e/`
narrows to:

- each edited spec;
- the specs that Playwright's `--only-changed` reports, from the imports it
  tracks while loading test files;
- the specs that name a changed file in a string, directly or through other
  harness files. Several queue drivers are bundled or spawned by path, which
  Playwright does not record. Changing
  `src/main/__tests__/fixtures/owner-conformance-codex-transport.ts` affects
  four queue specs this way and none through tracked imports.

A unit-test input narrows only when everything that imports it, through any
chain, is itself a test input. Global setup and teardown, any helper that the
Playwright config names, a deleted harness file, and a non-module input such
as an image or recorded fixture select the full suite.

## Known blind spots

- A test that launches a subprocess can execute a file that nothing imports
  or names. The plan recognizes bundlers, workers and TypeScript loaders by
  their text; a test that reaches source another way is not recognized.
- A narrowed run does not exercise how the full suite is sharded. PR #4004
  split a large test file, and one full Linux lane then failed 22 tests, 21
  of them on the 5-second timeout, until the lane costs were rebalanced.
- A computed import in an unchanged file is found only when that file names
  the changed module in a string.
- Global state that one module of a side-effect-free package sets up for
  another is not an import edge. The barrel rule relies on the package's own
  declaration.
- The plan is computed on Linux. The Windows job skips, and reports, a
  selected file that Windows does not collect; it cannot add a test that only
  Windows collects.
- Application code reached only through Electron, such as the preload entry,
  has no unit owner, and any change to product code runs every spec.

## Evidence

Each run's `pr-test-impact-<attempt>` artifact holds `plan.json`, the result
of every narrowed job, and `report.json`. The report records test files and
test cases executed, the elapsed span and summed runner time of the narrowed
and full jobs from the Actions API, and each failure the full Linux lanes
observed as covered, missed or unknown. Missing, incomplete or errored slices
limit that evidence even when the miss count is zero. Initial failures that
recover on retry still count.

Job durations include checkout and dependency installation. The narrowed
jobs do not shorten the workflow while the required lanes still run.

Replaying the 297 code-impacting commits that reached `main` before
2026-11-20 against the graph of that day, with files since removed left out:

| | Before | Now |
| --- | --- | --- |
| Commits with a narrowed Vitest plan | 71 (24%) | 208 (70%) |
| Median share of test files, narrowed plans | | 12% |
| Commits selecting at most 10% of test files | | 79 (27%) |
| Commits selecting at most 20% of test files | | 132 (44%) |
| Median share of test files, all commits | | 32% |
| Commits with a narrowed Playwright plan | | 37 (12%) |
| Of those, commits selecting no spec | | 31 |

This replay measures selection size. It cannot measure misses, because the
commits it replays passed.

Misses were measured against the 77 red PR runs with a Linux test failure
between 2026-11-16 and 2026-11-20: 750 failure records, planned from each
run's changed files on the graph of 2026-11-20.

| Failure records | Count | Full plan | Narrowed, selected | Narrowed, not selected |
| --- | --- | --- | --- | --- |
| Unit, failed again on retry | 92 | 18 | 74 | 0 |
| Unit, no retry result | 606 | 359 | 228 | 19 |
| Unit, passed on retry | 34 | 10 | 9 | 15 |
| E2E, failed again on retry | 13 | 13 | 0 | 0 |
| E2E, passed on retry | 5 | 5 | 0 | 0 |

The 19 records with no retry result come from two runs. Eighteen are from
the PR #4004 lane described above. One is a renderer test that timed out
on a diff of two main-process tests and was fixed in the test itself. Before
the rule for tests that run source outside the graph, a twentieth record was
a real miss: the PR #3809 failure. Ten of the 15 that passed on retry are one
case in `build-mcp-ipc-relay.oracle.test.mjs`, in ten different runs.

The graph is today's, not each run's, so a dependency that has since changed
can hide or invent a miss. The artifact fixture
`scripts/ci/fixtures/pr-test-impact-red-runs.json` holds two archived red PR
runs; both exercise full-suite fallback.
[OpenClaw's reported figures](https://vincent.build/openclaw-ci-cost-reduction/)
come from a different workload and are not a controlled test of a selector.
