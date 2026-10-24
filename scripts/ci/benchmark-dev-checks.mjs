import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, loadavg, totalmem } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const [baselinePath, candidatePath, outputPath] = process.argv.slice(2).map((path) => resolve(path));
if (!baselinePath || !candidatePath || !outputPath || process.platform !== "darwin") {
  throw new Error("Usage on macOS: node benchmark-dev-checks.mjs BASELINE CANDIDATE OUTPUT");
}
mkdirSync(outputPath, { recursive: true });
const env = { ...process.env, NODE_OPTIONS: "--max-old-space-size=6144" };
const gitRevision = (cwd) => {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("Cannot identify benchmark revision");
  return result.stdout.trim();
};
const metadata = {
  runner: process.env.RUNNER_NAME,
  runId: process.env.GITHUB_RUN_ID,
  processor: cpus()[0]?.model,
  logicalCpus: cpus().length,
  ramBytes: totalmem(),
  node: process.version,
  baseline: gitRevision(baselinePath),
  candidate: gitRevision(candidatePath),
  nodeOptions: env.NODE_OPTIONS,
  method: "Three alternating baseline/candidate samples on one runner; warm filesystem caches. Cold syntax lint deletes only ESLint's content cache. time -l peak RSS is not agent-session memory.",
};
const samples = [];
function measure(slice, variant, iteration, cwd, script) {
  const loadBefore = loadavg();
  const result = spawnSync("/usr/bin/time", ["-l", "pnpm", script], {
    cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 10 * 60 * 1000,
  });
  const label = `${slice}-${variant}-${iteration}`;
  writeFileSync(join(outputPath, `${label}.log`), `${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  const seconds = /([\d.]+)\s+real\b/.exec(result.stderr ?? "");
  const rss = /(\d+)\s+maximum resident set size/.exec(result.stderr ?? "");
  const sample = { slice, variant, iteration, script, exitCode: result.status,
    seconds: seconds ? Number(seconds[1]) : null,
    peakRssMiB: rss ? Number(rss[1]) / 1048576 : null,
    loadBefore, loadAfter: loadavg(), error: result.error?.message };
  samples.push(sample);
  writeFileSync(join(outputPath, "samples.json"), JSON.stringify({ metadata, samples }, null, 2));
  console.log(JSON.stringify(sample));
}

for (const [slice, baselineScript, candidateScript] of [
  ["syntax-cold", "lint:eslint:cached", "lint:oxlint"],
  ["typed", "lint:eslint:typed", "lint:oxlint:typed"],
  ["typecheck", "typecheck", "typecheck"],
]) {
  for (let iteration = 1; iteration <= 3; iteration += 1) {
    if (slice === "syntax-cold") rmSync(join(baselinePath, ".eslintcache-untyped"), { force: true });
    measure(slice, "baseline", iteration, baselinePath, baselineScript);
    measure(slice, "candidate", iteration, candidatePath, candidateScript);
    if (slice === "syntax-cold") {
      measure("syntax-warm", "baseline", iteration, baselinePath, baselineScript);
    }
  }
}
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const comparisons = ["syntax-cold", "typed", "typecheck"].map((slice) => {
  const rows = samples.filter((sample) => sample.slice === slice);
  const baseline = rows.filter((sample) => sample.variant === "baseline");
  const candidate = rows.filter((sample) => sample.variant === "candidate");
  const passes = rows.every((sample) => sample.exitCode === 0 && sample.seconds !== null);
  const before = passes ? median(baseline.map((sample) => sample.seconds)) : null;
  const after = passes ? median(candidate.map((sample) => sample.seconds)) : null;
  return { slice, passes, baselineSeconds: before, candidateSeconds: after,
    reductionPercent: passes ? 100 * (1 - after / before) : null,
    baselinePeakRssMiB: passes ? median(baseline.map((sample) => sample.peakRssMiB)) : null,
    candidatePeakRssMiB: passes ? median(candidate.map((sample) => sample.peakRssMiB)) : null };
});
writeFileSync(join(outputPath, "summary.json"), JSON.stringify({ metadata, comparisons, samples }, null, 2));
const summary = [
  `Runner: **${metadata.runner}** (${metadata.processor}, ${metadata.logicalCpus} CPUs).`,
  `Baseline: \`${metadata.baseline}\`; candidate: \`${metadata.candidate}\`.`,
  "Same-runner paired medians; load samples and raw logs are in the artifact. Failed checks have no speedup claim.",
  "", "| Slice | Baseline | Candidate | Reduction |", "|---|---:|---:|---:|",
  ...comparisons.map((row) => row.passes
    ? `| ${row.slice} | ${row.baselineSeconds.toFixed(2)}s | ${row.candidateSeconds.toFixed(2)}s | ${row.reductionPercent.toFixed(1)}% |`
    : `| ${row.slice} | Failed comparison | — | — |`),
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${summary}\n`);
}
console.log(summary);
if (samples.some((sample) => sample.exitCode !== 0 || sample.seconds === null)) process.exitCode = 1;
