# PR test impact

On a pull request, the `Test plan` job decides which unit tests and Linux
Desktop E2E specs the change affects, and the test lanes run that selection
in place of the full suite. The required checks are the same jobs as before:
`Test` and `Desktop E2E`.

Every test runs when:

- the event is a push, including every push to `main` and `releases/**`;
- the pull request has the `ci:full` label;
- the pull request changes a platform-specific path, which also starts the
  macOS and Windows Desktop E2E lanes;
- the plan says `full` for the reasons listed below;
- the `Test plan` job fails or does not run.

Documentation-only pull requests still skip the test jobs.

## Jobs

- `Test plan` runs as soon as dependencies are installed, and the lanes wait
  for it. It writes `plan.json` to the `pr-test-impact-plan` artifact, a
  summary of the selection, and the lane list of each job.
- `Test (lane N of 4)` runs the selected Vitest files on Linux. A lane holds
  about 150 selected files, so a typical plan runs one lane and a wide one
  runs four. The lane uses the same reporter, completion check and retry step
  as a full lane.
- `Windows desktop-main` and `Windows renderer + packages` run the selected
  files of their projects, in at most two lanes each. A job with no selected
  file does not start.
- `Linux Desktop E2E (lane 1 of 4)` runs the selected specs. When the plan
  selects no spec, no lane starts and `Desktop E2E` reports the skip.

A lane that the plan leaves out is not reported as a missing slice in the
consolidated retry report.

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
or environment reaches the change. The plan adds four rules.

- **String references.** A changed file with no import edge selects the tests
  that reach a module naming it: by basename, such as a budget JSON or a
  script that a test spawns, and for code also by module path. A changed
  module also selects the tests behind any file that names it and contains a
  computed `import()` or `require()`.
- **Type-only modules.** A module that emits no JavaScript has no runtime
  edge and selects nothing. Typecheck still covers it in `Lint`.
- **Always-run tests.** A test, or test helper, that lists directories can
  read a file that nothing imports. Every plan includes those tests (79 of
  2,308 files on 2026-11-20).
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

- dependency metadata, package-manager configuration, patches, CI, and test
  or build configuration;
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
Playwright config names, a deleted harness file, a harness file that no file
names, and a non-module input such as an image or recorded fixture select the
full suite. So does a selection of more than a quarter of the specs, because
one lane runs a narrowed plan.

## Known blind spots

- A test that launches a subprocess can execute a file that nothing imports
  or names. The plan recognizes bundlers, workers and TypeScript loaders by
  their text; a test that reaches source another way is not recognized.
- A narrowed run does not exercise how the full suite is sharded. PR #4004
  split a large test file, and one full Linux lane then failed 22 tests, 21
  of them on the 5-second timeout, until the lane costs were rebalanced.
- A computed import in an unchanged file is found only when that file names
  the changed module in a string.
- The plan is computed on Linux. A Windows lane reports, and skips, a
  selected file that Windows does not collect; it cannot add a test that only
  Windows collects.
- A pull request no longer runs the tests its plan leaves out, so a miss
  shows first on the push to `main`, where every test runs.
- Application code reached only through Electron, such as the preload entry,
  has no unit owner, and any change to product code runs every spec.

## Evidence

Replaying the 297 code-impacting commits that reached `main` before
2026-11-20 against the graph of that day, with files since removed left out:

| | Count |
| --- | --- |
| Commits with a narrowed Vitest plan | 208 (70%) |
| Median share of test files, narrowed plans | 12% |
| Commits selecting at most 10% of test files | 80 (27%) |
| Commits selecting at most 20% of test files | 134 (45%) |
| Median share of test files, all commits | 31% |
| Commits with a narrowed Playwright plan | 37 (12%) |
| Of those, commits selecting no spec | 31 |

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

The graph is that day's, not each run's, so a dependency that has since
changed can hide or invent a miss.
[OpenClaw's reported figures](https://vincent.build/openclaw-ci-cost-reduction/)
come from a different workload and are not a controlled test of a selector.
