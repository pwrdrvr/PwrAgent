// Plans which tests a pull request affects. The test lanes in ci.yml run
// that plan, or the full suite when it says `full`.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { getPrDiff, harnessReferences, listAffectedE2eFiles, listE2eFiles, planImpact, separateA11y, unitGroupFiles, unitGroups, unitLaneCount } from "./pr-test-impact.mjs";
import { withVitestImpact } from "./pr-test-impact-vitest.mjs";

const directory = ".local/ci/pr-test-impact";
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const root = process.cwd();
const size = (suite) => suite.mode === "full"
  ? `full — ${suite.reason}${suite.file ? ` (\`${suite.file}\`)` : ""}`
  : `${suite.selected.length} of ${suite.total} files`;
const range = (count) => Array.from({ length: count }, (_, index) => index + 1);

const event = read(process.env.GITHUB_EVENT_PATH).pull_request;
const started = performance.now();
let diff;
try {
  diff = getPrDiff(root, { base: event.base.sha, head: event.head.sha, changedFiles: event.changed_files },
    read(".local/ci/pr-test-impact-files.json"));
} catch (error) {
  diff = { fallback: "could not read or verify PR diff", detail: error.message };
}
let plan;
let plannerError;
try {
  await withVitestImpact(root, async (unit) => {
    let inventory;
    plan = await planImpact(diff.mergeFiles ?? [], {
      unit,
      e2e: {
        inventory: () => inventory ??= listE2eFiles(root),
        affected: () => listAffectedE2eFiles(root, diff.stacked ? diff.testedBase : diff.base),
        testOnly: unit.testOnly,
        harness: harnessReferences(root),
      },
      fallback: diff.fallback,
    });
  });
} catch (error) {
  plannerError = String(error.stack ?? error);
  plan = await planImpact([], { fallback: "Vitest or inventory initialization error" });
}

// The accessibility audit has its own job; a lane never runs it.
const { e2e: laneE2e, a11y: e2eA11y } = separateA11y(plan.e2e);
plan = { ...plan, e2e: laneE2e };

// The lanes each job runs. A full plan runs every lane of the full suite.
const lanes = Object.fromEntries(Object.keys(unitGroups).map((group) => [group, range(plan.unit.mode === "selected"
  ? unitLaneCount(unitGroupFiles(plan.unit.selected, group).length, group) : unitGroups[group].lanes)]));
// The required `Test` check needs a Linux lane to report.
if (!lanes.linux.length) lanes.linux = [1];
// A narrowed Playwright plan is a handful of specs, so one lane runs it.
lanes.e2e = range(plan.e2e.mode === "selected" ? Math.min(1, plan.e2e.selected.length) : 5);

mkdirSync(directory, { recursive: true });
writeFileSync(`${directory}/plan.json`, `${JSON.stringify({
  schemaVersion: 3, diff, plan, lanes, plannerError, plannerWallMs: Math.round(performance.now() - started),
}, null, 2)}\n`);
const outputs = {
  unit_mode: plan.unit.mode,
  e2e_mode: plan.e2e.mode,
  unit_linux_lanes: JSON.stringify(lanes.linux),
  unit_windows_main_lanes: JSON.stringify(lanes["windows-main"]),
  unit_windows_renderer_lanes: JSON.stringify(lanes["windows-renderer"]),
  e2e_lanes: JSON.stringify(lanes.e2e),
  e2e_a11y: String(e2eA11y),
};
// The job publishes these after it uploads the plan, so that a lane narrows
// only when the plan is there to download.
writeFileSync(`${directory}/outputs`, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${[
    "### Test plan for this pull request",
    "",
    `- Unit tests: ${size(plan.unit)}`,
    `- Linux Desktop E2E: ${size(plan.e2e)}`,
    `- Accessibility audit: ${e2eA11y ? "selected; its own job runs it" : "not selected by this plan"}`,
    "- The `ci:full` label runs every test on every platform.",
    ...(plannerError ? ["", "Planner error:", "", "```", plannerError, "```"] : []),
  ].join("\n")}\n`);
}
