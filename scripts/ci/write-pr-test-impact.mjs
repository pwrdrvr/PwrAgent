import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { compareFailures, describeLinuxEvidence, getPrDiff, harnessReferences, listAffectedE2eFiles, listE2eFiles, planImpact } from "./pr-test-impact.mjs";
import { withVitestImpact } from "./pr-test-impact-vitest.mjs";

const directory = ".local/ci/pr-test-impact";
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const root = process.cwd();
const summary = (rows) => process.env.GITHUB_STEP_SUMMARY && appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${rows.join("\n")}\n`);
const size = (suite) => suite.mode === "full"
  ? `full — ${suite.reason}${suite.file ? ` (\`${suite.file}\`)` : ""}`
  : `${suite.selected.length}/${suite.total} files`;

// Replayed change sets give the narrowed runner a typical product diff.
const calibration = [
  { name: "replay-3932", pr: 3932, files: [
    { status: "M", file: "apps/desktop/src/renderer/src/lib/useThreadSessionState.ts" },
    { status: "M", file: "apps/desktop/src/renderer/src/lib/__tests__/useThreadSessionState.property.test.tsx" },
  ] },
  { name: "replay-3889", pr: 3889, files: [
    { status: "M", file: "packages/shared/src/token-usage-pricing.ts" },
    { status: "A", file: "packages/shared/src/__tests__/token-usage-pricing-gpt61-terra.property.test.ts" },
  ] },
];

async function plan() {
  const event = read(process.env.GITHUB_EVENT_PATH).pull_request;
  const started = performance.now();
  const wallMs = (since) => Math.round(performance.now() - since);
  let diff;
  try {
    diff = getPrDiff(root, { base: event.base.sha, head: event.head.sha, changedFiles: event.changed_files },
      read(".local/ci/pr-test-impact-files.json"));
  } catch (error) {
    diff = { fallback: "could not read or verify PR diff", detail: error.message };
  }
  let inventory;
  const configure = (unit, affected) => ({
    unit,
    e2e: {
      inventory: () => inventory ??= listE2eFiles(root),
      affected,
      testOnly: unit.testOnly,
      harness: harnessReferences(root),
    },
  });
  let live;
  const samples = [];
  let plannerError;
  try {
    await withVitestImpact(root, async (unit) => {
      const tested = diff.stacked ? diff.testedBase : diff.base;
      live = await planImpact(diff.branchFiles ?? [], {
        ...configure(unit, () => listAffectedE2eFiles(root, tested)), fallback: diff.fallback,
      });
      for (const sample of calibration) {
        const start = performance.now();
        // A replay has no commit range for Playwright to diff.
        const result = await planImpact(sample.files, configure(unit, () => { throw new Error("Replay has no Git range"); }));
        samples.push({ ...sample, plannerWallMs: wallMs(start), ...result });
      }
    });
  } catch (error) {
    plannerError = String(error.stack ?? error);
    live = await planImpact([], { fallback: "Vitest or inventory initialization error" });
  }
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/plan.json`, `${JSON.stringify({
    schemaVersion: 2, scope: "Vitest projects and Linux Desktop E2E", diff, plan: live,
    calibration: samples, plannerError, plannerWallMs: wallMs(started),
  }, null, 2)}\n`);

  // Job outputs. A narrowed job runs only for a selected plan with tests.
  const count = (suite) => suite.mode === "selected" ? suite.selected.length : -1;
  const targets = [];
  if (count(live.unit) > 0) targets.push({ name: "live", os: "ubuntu-latest" }, { name: "live", os: "windows-latest" });
  for (const sample of samples) if (count(sample.unit) > 0) targets.push({ name: sample.name, os: "ubuntu-latest" });
  const outputs = {
    unit_mode: live.unit.mode, unit_count: count(live.unit),
    e2e_mode: live.e2e.mode, e2e_count: count(live.e2e),
    unit_targets: JSON.stringify(targets),
  };
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(""));
  }
  summary([
    "### PR test impact plan",
    "",
    `- Vitest: ${size(live.unit)}`,
    `- Linux Desktop E2E: ${size(live.e2e)}`,
    ...samples.map((sample) => `- Replay #${sample.pr} on this checkout: ${size(sample.unit)} (${sample.plannerWallMs} ms)`),
    `- Planning took ${(wallMs(started) / 1000).toFixed(1)} s.`,
    ...(plannerError ? ["", "Planner error:", "", "```", plannerError, "```"] : []),
  ]);
}

const seconds = (ms) => `${(ms / 1000).toFixed(0)} s`;
const jobMs = ({ started_at: start, completed_at: end }) => Date.parse(end) - Date.parse(start);

function timings(jobs, pattern) {
  const matched = jobs.filter(({ name, conclusion }) => pattern.test(name) && conclusion !== "skipped" && conclusion);
  if (!matched.length) return undefined;
  return {
    jobs: matched.map((job) => ({ name: job.name, conclusion: job.conclusion, ms: jobMs(job) })),
    runnerMs: matched.reduce((sum, job) => sum + jobMs(job), 0),
    wallSpanMs: Math.max(...matched.map(({ completed_at: end }) => Date.parse(end)))
      - Math.min(...matched.map(({ started_at: start }) => Date.parse(start))),
  };
}

function report() {
  const { diff, plan: live, calibration: samples, plannerWallMs } = read(`${directory}/plan.json`);
  let observed;
  try {
    const flake = read(".local/ci/pr-test-impact-observed/flake-report.json");
    if (flake.sha !== diff.merge || flake.headSha !== diff.head || flake.runId !== process.env.GITHUB_RUN_ID
      || flake.attempt !== Number(process.env.GITHUB_RUN_ATTEMPT)) throw new Error("Full-suite evidence is for a different checkout or attempt");
    observed = compareFailures(live, flake);
  } catch (error) {
    observed = { unavailable: error.message };
  }
  const history = read(new URL("./fixtures/pr-test-impact-red-runs.json", import.meta.url));
  const narrowed = [];
  for (const file of ["unit-live-Linux", "unit-live-Windows", ...samples.map(({ name }) => `unit-${name}-Linux`), "e2e-live-Linux"]) {
    try {
      narrowed.push({ target: file, ...read(`${directory}/results/${file}.json`) });
    } catch {}
  }
  let jobs = [];
  try {
    jobs = read(".local/ci/pr-test-impact-jobs.json");
  } catch {}
  const actual = {
    plan: timings(jobs, /^PR test impact plan$/),
    narrowedUnitLinux: timings(jobs, /^PR test impact unit \(live, ubuntu-latest\)$/),
    narrowedUnitWindows: timings(jobs, /^PR test impact unit \(live, windows-latest\)$/),
    replayedUnitLinux: timings(jobs, /^PR test impact unit \(replay-/),
    narrowedE2e: timings(jobs, /^PR test impact E2E$/),
    fullUnitLinux: timings(jobs, /^Test \(lane \d of 4\)$/),
    fullUnitWindows: timings(jobs, /^Windows (?:desktop-main|renderer \+ packages) \(lane \d of 2\)$/),
    fullE2eLinux: timings(jobs, /^Linux Desktop E2E \(lane \d of 4\)$/),
  };
  writeFileSync(`${directory}/report.json`, `${JSON.stringify({
    schemaVersion: 2, diff, plan: live, observed, narrowed, actual, calibration: samples, plannerWallMs,
    historical: history.map(({ report: recorded, ...sample }) => sample),
  }, null, 2)}\n`);

  const line = (label, timing) => timing
    ? `| ${label} | ${timing.jobs.length} | ${seconds(timing.wallSpanMs)} | ${seconds(timing.runnerMs)} |`
    : `| ${label} | 0 | — | — |`;
  const result = (entry) => `- \`${entry.target}\`: ${entry.executedFiles}/${entry.requestedFiles} files, `
    + `${entry.cases} tests (${entry.failed} failed), ${seconds(entry.wallMs)} in the runner`
    + `${entry.absent?.length ? `, ${entry.absent.length} not collected on this platform` : ""}`
    + ` — ${entry.passed ? "passed" : "failed or incomplete"}`;
  summary([
    "### PR test impact: narrowed execution",
    "",
    `- Vitest plan: ${size(live.unit)}`,
    `- Linux Desktop E2E plan: ${size(live.e2e)}`,
    `- Failures the full Linux lanes observed, covered/missed/unknown: ${describeLinuxEvidence(observed)}`,
    "",
    ...(narrowed.length ? narrowed.map(result) : ["- No narrowed job ran."]),
    "",
    "| Jobs in this run | Jobs | Elapsed span | Runner time |",
    "| --- | --- | --- | --- |",
    line("Plan", actual.plan),
    line("Narrowed Linux unit", actual.narrowedUnitLinux),
    line("Full Linux unit lanes", actual.fullUnitLinux),
    line("Narrowed Windows unit", actual.narrowedUnitWindows),
    line("Full Windows unit lanes", actual.fullUnitWindows),
    line("Replayed Linux unit plans", actual.replayedUnitLinux),
    line("Narrowed Linux E2E", actual.narrowedE2e),
    line("Full Linux E2E lanes", actual.fullE2eLinux),
    "",
    "Job durations include checkout and dependency installation. A selected plan with no tests starts no job.",
    "Required jobs still run in full; the narrowed jobs run beside them.",
  ]);
}

if (process.argv[2] === "report") report();
else await plan();
