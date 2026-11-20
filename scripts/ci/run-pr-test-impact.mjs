// Executes a narrowed plan from `write-pr-test-impact.mjs` and records what ran.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createVitest } from "vitest/node";

const directory = ".local/ci/pr-test-impact";
const [kind, name = "live"] = process.argv.slice(2);
const { plan, calibration } = JSON.parse(readFileSync(`${directory}/plan.json`, "utf8"));
const source = name === "live" ? plan : calibration.find((sample) => sample.name === name);
const target = `${kind}-${name}-${process.env.RUNNER_OS ?? process.platform}`;
const posix = (file) => file.split(path.sep).join("/");
const write = (result) => {
  mkdirSync(`${directory}/results`, { recursive: true });
  writeFileSync(`${directory}/results/${target}.json`, `${JSON.stringify({ name, ...result }, null, 2)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Narrowed ${kind} run (${name})\n\n`
      + `- ${result.executedFiles ?? 0}/${result.requestedFiles} files, ${result.cases ?? 0} tests, `
      + `${result.failed ?? 0} failed, ${(result.wallMs / 1000).toFixed(1)} s\n`
      + `- ${result.passed ? "Passed" : `Failed or incomplete${result.error ? `: ${result.error}` : ""}`}\n`);
  }
  if (!result.passed) process.exitCode = 1;
};

if (kind === "unit") {
  const selected = source.unit.selected;
  const key = ({ project, file }) => JSON.stringify([project, file]);
  const expected = new Map(selected.map((entry) => [key(entry), entry]));
  const result = { requestedFiles: selected.length };
  const start = performance.now();
  try {
    const ctx = await createVitest("test", { config: process.env.PR_TEST_IMPACT_VITEST_CONFIG ?? "vitest.linux-ci.ts", watch: false, run: true });
    try {
      const identify = ({ project, moduleId }) => ({ project: project.name, file: posix(path.relative(process.cwd(), moduleId)) });
      const specs = (await ctx.globTestSpecifications()).filter((spec) => expected.has(key(identify(spec))));
      const collected = new Set(specs.map((spec) => key(identify(spec))));
      // A platform can exclude a test file that the Linux plan names.
      result.absent = selected.filter((entry) => !collected.has(key(entry))).map(({ project, file }) => ({ project, file }));
      if (!specs.length) throw new Error("No selected test file is collected on this platform");
      await ctx.standalone();
      const { testModules, unhandledErrors } = await ctx.runTestSpecifications(specs);
      const ran = testModules.map((module) => key(identify(module)));
      const cases = testModules.flatMap((module) => [...module.children.allTests()]);
      const state = (wanted) => cases.filter((test) => test.result().state === wanted).length;
      result.executedFiles = ran.length;
      result.cases = cases.length;
      result.passedCases = state("passed");
      result.failed = state("failed");
      result.skipped = state("skipped");
      result.failures = testModules.filter((module) => !module.ok()).map(identify);
      result.unhandledErrors = unhandledErrors.length;
      result.complete = ran.length === collected.size && new Set(ran).size === ran.length
        && ran.every((id) => collected.has(id)) && result.passedCases > 0;
      result.passed = result.complete && !unhandledErrors.length && !result.failures.length;
    } finally {
      await ctx.close();
    }
  } catch (error) {
    result.error = String(error.message ?? error);
  }
  result.wallMs = Math.round(performance.now() - start);
  write(result);
} else if (kind === "e2e-files") {
  // Paths for the Playwright command, relative to the desktop package.
  process.stdout.write(source.e2e.selected.map(({ file }) => path.posix.relative("apps/desktop", file)).join("\n"));
} else if (kind === "e2e") {
  const selected = new Set(source.e2e.selected.map(({ file }) => file));
  const result = { requestedFiles: selected.size, wallMs: Number(process.env.PR_TEST_IMPACT_E2E_MS ?? 0) };
  try {
    const report = JSON.parse(readFileSync(process.env.PWRAGENT_CI_TEST_REPORT, "utf8"));
    const fileOf = (test) => posix(path.relative(process.cwd(), test.file));
    const ran = new Set(report.tests.map(fileOf));
    result.executedFiles = ran.size;
    result.cases = report.tests.length;
    result.failed = report.tests.filter(({ outcome }) => outcome === "unexpected").length;
    result.flaky = report.tests.filter(({ outcome }) => outcome === "flaky").length;
    result.skipped = report.tests.filter(({ outcome }) => outcome === "skipped").length;
    result.failures = [...new Set(report.tests.filter(({ outcome }) => outcome === "unexpected").map(fileOf))];
    result.complete = report.complete && ran.size === selected.size && [...ran].every((file) => selected.has(file));
    result.passed = result.complete && report.status === "passed" && !report.errors;
  } catch (error) {
    result.error = String(error.message ?? error);
  }
  write(result);
} else {
  throw new Error(`Unknown narrowed run: ${kind}`);
}
