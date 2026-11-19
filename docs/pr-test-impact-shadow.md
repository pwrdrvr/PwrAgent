# PR test impact shadow

The prototype runs on code-impacting PRs from branches starting with
`prototype/pr-test-impact`. Its advisory job reads the existing full Linux
Vitest and Linux Desktop E2E results. Required jobs and their four-lane
assignments continue to run under the existing classifier. Windows, macOS,
standalone Outpost tests, and pushes to `main` or release branches have no
selection plan.

The report verifies the GitHub file list against an immutable three-dot Git
diff, verifies the tested merge's parents, and checks its diff against the
event base. A stale branch or ambiguous merge falls back to the full suite.
An edit that landed on main after the fork can affect the tested merge even
though the PR file list omits it.

Linux Vitest uses the pinned runner's static related-file graph and records
why each project and file was selected. It requires a graph witness for every
supported changed path. An empty result, unresolved static import or transform,
or opaque import in changed source falls back to the full suite. References
to Node's `createRequire` also widen the plan. Other full-suite inputs
include deletes and renames, configuration, dependencies, fixtures, snapshots,
generated inputs, platform-specific paths, and large or unfamiliar diffs.
For spec-only diffs, Playwright lists tests using the desktop CI config.
An edited spec must contain at least one collected test to enter a narrower
plan. Collection errors also trigger the full plan.
Product code has no complete map to Playwright spec owners, so those changes
keep the full E2E plan.

The graph cannot see every filesystem read, programmatic import in an
unchanged importer, generated output, or subprocess dependency. An opaque
consumer can still be absent when some other consumer gives the same file
a static graph witness. The report has no job-selection output.

## Evidence

The `pr-test-impact-<attempt>` artifact includes file counts, reasons, PR and
merge diffs, and comparisons with individually observed Linux failures.
Missing, incomplete, or errored slices limit recall evidence even when the
observed miss count is zero. Initial failures that recover still count.

The artifact replays two historical change sets on the current graph (#3932
and #3889) and two archived red PR diffs against their recorded Linux failures.
Both red runs exercise full-suite fallback. This small sample leaves
narrowed-plan recall and population false negatives unknown.
[Run 44553042565](https://github.com/pwrdrvr/PwrAgent/actions/runs/44553042565)
predates explicit Playwright file paths. Its two case paths came from the
unique spec name in the diff.
[Run 44423477690](https://github.com/pwrdrvr/PwrAgent/actions/runs/44423477690)
has two initial Linux unit failures.
The synthetic oracle uses real Git for rename and merge semantics and native
Node execution for planted dependency failures.

Planner elapsed time and archived CI durations are measurements. Selected
files and modeled lane work estimate the candidate scope. Modeled milliseconds
use sparse timing tables for desktop-main and desktop-renderer. The report
records how many files have measured weight entries and leaves other projects
unweighted. These sums exclude startup and parallel execution effects and
cannot establish elapsed time or runner-hour savings.
[OpenClaw's reported figures](https://vincent.build/openclaw-ci-cost-reduction/)
come from a different workload.

The same artifact contains `benchmark.json`. The advisory job executes the
exact Vitest project/file pairs from a narrowed PR plan. On the prototype PR,
changes to CI force its own plan to full. In that case the benchmark replays
the one shared test file observed on #4006 and labels it as a replay.
The benchmark compares the measured selected command with the same workflow
attempt's four full Linux Vitest Test steps. It reports both their elapsed
span and their summed runner-minutes. These timings exclude dependency
installation, planning and retries. Required jobs still run in full, so the
benchmark measures Linux unit execution only.
