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
or environment reaches the change. The plan adds four rules.

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
  read a file that nothing imports. Every plan includes those tests (77 of
  2,276 files on 2026-11-20).

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
  or names.
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
| Median share of test files, narrowed plans | | 11% |
| Commits selecting at most 10% of test files | | 92 (31%) |
| Commits selecting at most 20% of test files | | 134 (45%) |
| Median share of test files, all commits | | 31% |
| Commits with a narrowed Playwright plan | | 37 (12%) |
| Of those, commits selecting no spec | | 31 |

This replay measures selection size. It cannot measure misses, because the
commits it replays passed. The artifact fixture
`scripts/ci/fixtures/pr-test-impact-red-runs.json` holds two archived red PR
runs; both exercise full-suite fallback, so recall for narrowed plans is not
yet established.
[OpenClaw's reported figures](https://vincent.build/openclaw-ci-cost-reduction/)
come from a different workload and are not a controlled test of a selector.
