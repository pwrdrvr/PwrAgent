import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { aggregateSlices, createSlice } from "./flake-report.mjs";

const read = (file) => existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null;
const write = (file, value) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
};

if (process.argv[2] === "slice") {
  const directory = ".local/ci/retry";
  const kind = process.env.FLAKE_KIND;
  const first = read(path.join(directory, `${kind}-first.json`));
  const files = existsSync(directory) ? readdirSync(directory) : [];
  const retryFiles = files.filter((name) => kind === "unit" ? /^unit-retry-\d+\.json$/.test(name) : name === "e2e-retry.json").sort();
  const slice = createSlice({ kind, platform: process.env.FLAKE_PLATFORM, lane: process.env.FLAKE_LANE,
    sample: process.env.FLAKE_SAMPLE, workspace: process.env.GITHUB_WORKSPACE, first,
    retries: retryFiles.map((file) => read(path.join(directory, file))), jobStatus: process.env.FLAKE_JOB_STATUS,
    firstOutcome: process.env.FLAKE_FIRST_OUTCOME, retryOutcome: process.env.FLAKE_RETRY_OUTCOME });
  write(".local/ci/flake-slice.json", slice);
} else if (process.argv[2] === "aggregate") {
  const directory = ".local/ci/flake-slices";
  const slices = [];
  const warnings = [];
  for (const entry of existsSync(directory) ? readdirSync(directory, { withFileTypes: true }) : []) {
    // download-artifact extracts one matching artifact directly into the root;
    // with multiple matches it creates one named directory per artifact.
    if (!entry.isDirectory() && entry.name !== "flake-slice.json") continue;
    const file = entry.isDirectory() ? path.join(directory, entry.name, "flake-slice.json") : path.join(directory, entry.name);
    try {
      const slice = read(file);
      if (slice) slices.push(slice);
      else warnings.push(`${entry.name}: missing slice file`);
    } catch (error) {
      warnings.push(`${entry.name}: ${error.message}`);
    }
  }
  const report = aggregateSlices({ slices, samples: Number(process.env.FLAKE_SAMPLES), runId: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT, sha: process.env.GITHUB_SHA, headSha: process.env.FLAKE_HEAD_SHA, warnings });
  write(".local/ci/flake-report/flake-report.json", report);
  const incomplete = report.slices.filter((slice) => !slice.first.available || !slice.first.complete).length;
  const lines = ["### Consolidated test retry report", "", `Initial failures: ${report.totals.initialFailures}; recovered: ${report.totals.recovered}; failed: ${report.totals.failed}; unknown: ${report.totals.unknown}.`,
    `Slices received: ${report.slices.length}/${report.expectedSlices}; missing: ${report.missingSlices.length}.`,
    `First reports unavailable or incomplete: ${incomplete}.`,
    ...((incomplete || report.missingSlices.length) ? ["Failure counts may be incomplete."] : []),
    `Download the \`ci-flake-report-${report.attempt}\` artifact for per-test and per-slice details.`];
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  console.log(lines.join("\n"));
} else throw new Error("Expected slice or aggregate");
