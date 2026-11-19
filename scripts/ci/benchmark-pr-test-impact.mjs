import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createVitest } from "vitest/node";

const directory = ".local/ci/pr-test-impact";
const plan = JSON.parse(readFileSync(`${directory}/report.json`, "utf8"));
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")).pull_request;
const replay = {
  project: "shared",
  file: "packages/shared/src/__tests__/token-usage-pricing-gpt61-terra.property.test.ts",
};
const live = plan.plan.unit.mode === "selected";
const selected = live ? plan.plan.unit.selected : event.number === 4002 ? [replay] : [];
const key = ({ project, file }) => JSON.stringify([project, file]);
const fromSpec = ({ project, moduleId }) => ({ project: project.name, file: path.relative(process.cwd(), moduleId) });
const expected = new Set(selected.map(key));
const result = { scenario: live ? "current PR selection" : "replay of #4006's observed selection", selected };

if (selected.length) {
  const start = performance.now();
  try {
    const ctx = await createVitest("test", { config: "vitest.linux-ci.ts", watch: false, run: true });
    try {
      const specs = (await ctx.globTestSpecifications()).filter((spec) => expected.has(key(fromSpec(spec))));
      if (specs.length !== expected.size) throw new Error("Vitest inventory does not match the requested project/file pairs");
      await ctx.standalone();
      const { testModules, unhandledErrors } = await ctx.runTestSpecifications(specs);
      const actual = testModules.map((module) => key(fromSpec(module)));
      const cases = testModules.flatMap((module) => [...module.children.allTests()]);
      result.executedFiles = actual.length;
      result.reportedCases = cases.length;
      result.passedCases = cases.filter((test) => test.result().state === "passed").length;
      result.failedCases = cases.filter((test) => test.result().state === "failed").length;
      result.complete = actual.length === expected.size && actual.every((id) => expected.has(id))
        && actual.length === new Set(actual).size && result.passedCases > 0;
      result.passed = result.complete && !unhandledErrors.length && testModules.every((module) => module.ok());
    } finally {
      await ctx.close();
    }
  } catch (error) {
    result.error = error.message;
  } finally {
    result.selectedWallMs = Math.round(performance.now() - start);
  }
} else {
  result.skip = plan.plan.unit.reason;
}

try {
  const jobs = JSON.parse(readFileSync(".local/ci/pr-test-impact-baseline.json", "utf8"));
  const lanes = jobs.map(({ name, steps }) => {
    const step = steps.find((entry) => entry.name === "Test");
    return { name, start: Date.parse(step?.started_at), end: Date.parse(step?.completed_at), conclusion: step?.conclusion };
  });
  if (lanes.length !== 4 || new Set(lanes.map(({ name }) => name)).size !== 4
    || lanes.some(({ start, end }) => !(end > start))) throw new Error("Incomplete Linux unit timings");
  result.full = {
    lanes,
    wallSpanMs: Math.max(...lanes.map(({ end }) => end)) - Math.min(...lanes.map(({ start }) => start)),
    runnerMs: lanes.reduce((sum, { start, end }) => sum + end - start, 0),
  };
} catch (error) {
  result.baselineError = error.message;
}
writeFileSync(`${directory}/benchmark.json`, `${JSON.stringify(result, null, 2)}\n`);
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const lines = ["", "### Linux Vitest execution benchmark", ""];
if (result.selectedWallMs !== undefined) {
  lines.push(`- ${result.scenario}: ${result.executedFiles ?? 0}/${selected.length} files, ${seconds(result.selectedWallMs)}, ${result.passed ? "passed" : "failed or incomplete"}.`);
} else {
  lines.push(`- No narrowed execution: ${result.skip}.`);
}
if (result.full) {
  lines.push(`- Full Linux Vitest Test steps: ${seconds(result.full.wallSpanMs)} elapsed across four lanes, ${(result.full.runnerMs / 60000).toFixed(2)} runner-minutes.`);
}
lines.push("", "The selected timer includes Vitest startup and shutdown. Both measurements exclude dependency installation, planning, and retries. The advisory job does not shorten the workflow.");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
if (selected.length && !result.passed) process.exitCode = 1;
