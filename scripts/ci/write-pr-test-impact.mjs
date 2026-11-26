// Plans which tests a pull request affects. The test lanes in ci.yml run
// that plan, or the full suite when it says `full`.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { getPrDiff, getPushDiff, harnessReferences, listAffectedE2eFiles, listE2eFiles, planImpact, playwrightListPath, scheduleImpact, wholeSuiteReason } from "./pr-test-impact.mjs";
import { withVitestImpact } from "./pr-test-impact-vitest.mjs";

const directory = ".local/ci/pr-test-impact";
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const root = process.cwd();
const size = (suite) => suite.mode === "full"
  ? `full — ${suite.reason}${suite.file ? ` (\`${suite.file}\`)` : ""}`
  : `${suite.selected.length} of ${suite.total} files`;

const event = read(process.env.GITHUB_EVENT_PATH);
const started = performance.now();
let diff;
try {
  const pr = event.pull_request;
  diff = pr
    ? getPrDiff(root, { base: pr.base.sha, head: pr.head.sha, changedFiles: pr.changed_files },
      read(".local/ci/pr-test-impact-files.json"))
    : getPushDiff(root, event);
} catch (error) {
  diff = { fallback: "could not read or verify changed files", detail: error.message };
}
let plan;
let plannerError;
try {
  const files = diff.mergeFiles ?? [];
  const fallback = diff.fallback ?? wholeSuiteReason(files);
  if (fallback) {
    plan = await planImpact(files, { fallback });
  } else {
    await withVitestImpact(root, async (unit) => {
      let inventory;
      plan = await planImpact(files, {
        unit,
        e2e: {
          inventory: () => inventory ??= listE2eFiles(root),
          affected: () => listAffectedE2eFiles(root, diff.testedBase ?? diff.before),
          testOnly: unit.testOnly,
          harness: harnessReferences(root),
        },
      });
    });
  }
} catch (error) {
  plannerError = String(error.stack ?? error);
  plan = await planImpact([], { fallback: "Vitest or inventory initialization error" });
}

const allPlatforms = process.env.FULL_PLATFORMS === "true";
const { e2e, nativeE2e, windowsMode, lanes } = scheduleImpact(plan, {
  allPlatforms,
  windowsFull: process.env.WINDOWS_E2E_REQUESTED === "true" || process.env.WINDOWS_DIAGNOSTICS === "true",
  auditRequested: process.env.A11Y_REQUESTED === "true",
  e2eOnly: process.env.E2E_ONLY === "true",
});
mkdirSync(directory, { recursive: true });
for (const [name, suite] of [["linux", e2e], ["native", nativeE2e]]) {
  if (suite.mode === "selected" && suite.selected.length) {
    writeFileSync(`${directory}/${name}-e2e.txt`, `${suite.selected.map(({ file }) => playwrightListPath(file)).join("\n")}\n`);
  }
}
writeFileSync(`${directory}/plan.json`, `${JSON.stringify({
  schemaVersion: 4, diff, plan, lanes, plannerError, plannerWallMs: Math.round(performance.now() - started),
}, null, 2)}\n`);
const outputs = {
  unit_mode: plan.unit.mode,
  e2e_mode: e2e.mode,
  e2e_windows_mode: windowsMode,
  e2e_a11y: String(lanes["e2e-linux-a11y"].length > 0),
  lane_inventory: JSON.stringify(lanes),
  ...Object.fromEntries(Object.entries(lanes).map(([name, values]) => [`${name.replaceAll("-", "_")}_lanes`, JSON.stringify(values)])),
  // Keep the workflow's existing Linux Desktop E2E output name.
  e2e_lanes: JSON.stringify(lanes["e2e-linux"]),
};
// The job publishes these after it uploads the plan, so that a lane narrows
// only when the plan is there to download.
writeFileSync(`${directory}/outputs`, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${[
    "### Test plan for this revision",
    "",
    `- Unit tests: ${size(plan.unit)}`,
    `- Linux Desktop E2E: ${size(e2e)}`,
    `- Windows Desktop E2E: ${windowsMode === "off" ? "skipped" : windowsMode === "selected" ? size(nativeE2e) : "full"}`,
    `- macOS Desktop E2E: ${allPlatforms ? size(nativeE2e) : "skipped"}`,
    `- Accessibility audit: ${outputs.e2e_a11y === "true" ? "selected; its own job runs it" : "not selected by this plan"}`,
    "- The `ci:full` label runs every test on every platform; `ci:windows-e2e` runs the full Windows Desktop E2E suite.",
    ...(plannerError ? ["", "Planner error:", "", "```", plannerError, "```"] : []),
  ].join("\n")}\n`);
}
