// Runs one lane of a narrowed plan from `write-pr-test-impact.mjs`.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { createVitest } from "vitest/node";
import { unitGroupFiles, unitGroups, unitLaneCount } from "./pr-test-impact.mjs";

const [kind, group, lane] = process.argv.slice(2);
const { plan } = JSON.parse(readFileSync(".local/ci/pr-test-impact/plan.json", "utf8"));
const posix = (file) => file.split(path.sep).join("/");
const summary = (line) => {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
};

if (kind === "unit") {
  if (plan.unit.mode !== "selected") throw new Error("The plan does not narrow the unit tests");
  const selected = unitGroupFiles(plan.unit.selected, group);
  const lanes = unitLaneCount(selected.length, group);
  const key = ({ project, file }) => JSON.stringify([project, file]);
  const expected = new Set(selected.map(key));
  // The pool applies the shard with the configured sequencer, as a full lane
  // does, and the CI reporter writes the report that the retry step reads.
  const ctx = await createVitest("test", {
    config: unitGroups[group].config, watch: false, run: true,
    reporters: ["default", "./scripts/ci/vitest-ci-reporter.mjs"],
    ...(lanes > 1 ? { shard: `${lane}/${lanes}` } : {}),
  });
  try {
    const identify = ({ project, moduleId }) => ({ project: project.name, file: posix(path.relative(process.cwd(), moduleId)) });
    const specs = (await ctx.globTestSpecifications()).filter((spec) => expected.has(key(identify(spec))));
    if (!selected.length || specs.length !== selected.length) {
      throw new Error(`Narrowed plan for ${group} expected ${selected.length} files; Vitest collected ${specs.length}`);
    }
    summary(`Narrowed plan: ${specs.length} of ${plan.unit.total} test files in ${lanes} lane(s).`);
    await ctx.standalone();
    const { testModules, unhandledErrors } = await ctx.runTestSpecifications(specs);
    // Preserve the CI reporter's distinct test failure code until close.
    if (unhandledErrors.length || testModules.some((module) => !module.ok())) process.exitCode ||= 1;
  } finally {
    await ctx.close();
  }
} else {
  throw new Error(`Unknown narrowed run: ${kind}`);
}
