import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { compareFailures, getPrDiff, listE2eFiles, planImpact } from "./pr-test-impact.mjs";
import { withVitestImpact } from "./pr-test-impact-vitest.mjs";

const directory = ".local/ci/pr-test-impact";
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const root = process.cwd();
const event = read(process.env.GITHUB_EVENT_PATH).pull_request;
const started = performance.now();
let diff;
try {
  diff = getPrDiff(root, { base: event.base.sha, head: event.head.sha, changedFiles: event.changed_files },
    read(".local/ci/pr-test-impact-files.json"));
} catch (error) {
  diff = { fallback: "could not read or verify PR diff", detail: error.message };
}
const e2eFiles = listE2eFiles(root);
const wallMs = (since) => Math.round(performance.now() - since);
const configure = (unit) => ({ unit, e2eFiles });
let plan;
const samples = [];
let plannerError;
try {
  await withVitestImpact(root, async (unit) => {
    plan = await planImpact(diff.branchFiles ?? [], { ...configure(unit), fallback: diff.fallback });
    const calibration = [
      { pr: 3932, files: [
        { status: "M", file: "apps/desktop/src/renderer/src/lib/useThreadSessionState.ts" },
        { status: "M", file: "apps/desktop/src/renderer/src/lib/__tests__/useThreadSessionState.property.test.tsx" },
      ] },
      { pr: 3889, files: [
        { status: "M", file: "packages/shared/src/token-usage-pricing.ts" },
        { status: "A", file: "packages/shared/src/__tests__/token-usage-pricing-gpt61-terra.property.test.ts" },
      ] },
    ];
    for (const sample of calibration) {
      const start = performance.now();
      const result = await planImpact(sample.files, configure(unit));
      samples.push({ ...sample, plannerWallMs: wallMs(start), ...result });
    }
  });
} catch (error) {
  plannerError = error.message;
  plan = await planImpact([], { fallback: "Vitest or inventory initialization error" });
}
const history = read(new URL("./fixtures/pr-test-impact-red-runs.json", import.meta.url));
const historical = await Promise.all(history.map(async ({ report, ...sample }) => {
  const replay = await planImpact(sample.files, { e2eFiles, unit: () => { throw new Error("Historical graph unavailable"); } });
  return { ...sample, plan: replay, observed: compareFailures(replay, report) };
}));

let observed;
try {
  const report = read(".local/ci/pr-test-impact-observed/flake-report.json");
  if (report.sha !== diff.merge || report.headSha !== diff.head || report.runId !== process.env.GITHUB_RUN_ID
    || report.attempt !== Number(process.env.GITHUB_RUN_ATTEMPT)) throw new Error("Full-suite evidence is for a different checkout or attempt");
  observed = compareFailures(plan, report);
} catch (error) {
  observed = { unavailable: error.message };
}

mkdirSync(directory, { recursive: true });
writeFileSync(`${directory}/report.json`, `${JSON.stringify({
  schemaVersion: 1, scope: "Linux Vitest projects and Linux Desktop E2E", diff, plan, observed,
  calibration: samples, historical, plannerError, plannerWallMs: wallMs(started),
}, null, 2)}\n`);

const size = (suite) => suite.mode === "full" ? `full — ${suite.reason}` : `${suite.selected.length}/${suite.total} files`;
const rows = [
  "### PR test impact shadow",
  "",
  `- Linux Vitest: ${size(plan.unit)}`,
  `- Linux Desktop E2E: ${size(plan.e2e)}`,
  `- Observed Linux failures covered/missed/unknown: ${observed.unavailable ? "evidence unavailable" : `${observed.covered}/${observed.missed}/${observed.unknown}`}`,
  ...samples.map((sample) => `- Replay #${sample.pr} on this checkout: ${size(sample.unit)} (${sample.plannerWallMs} ms)`),
  ...historical.map((sample) => `- Red run ${sample.runId}: ${sample.observed.covered}/${sample.observed.cases.length} observed Linux failures covered`),
  "",
  "See the artifact for diff provenance, Linux slice completeness, and modeled work.",
];
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${rows.join("\n")}\n`);
