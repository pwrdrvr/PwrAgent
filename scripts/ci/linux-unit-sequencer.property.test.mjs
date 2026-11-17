import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { BaseSequencer } from "vitest/node";
import LinuxUnitSequencer from "./linux-unit-sequencer.mjs";
import CiRetryReporter from "./vitest-ci-reporter.mjs";

const costs = JSON.parse(fs.readFileSync(new URL("./linux-unit-costs.json", import.meta.url), "utf8"));
const rendererCosts = JSON.parse(fs.readFileSync(new URL("./linux-renderer-unit-costs.json", import.meta.url), "utf8"));
const root = "/fixture/repository";
const specification = (file, project = "desktop-main", directory = root) => ({
  moduleId: `${directory}/${file}`,
  project: { name: project },
});
const context = (index, count, directory = root) => ({
  config: { root: directory, shard: { index, count } },
});
const weight = (spec) => costs.files[path.posix.relative(root, spec.moduleId)] ?? costs.fallbackMs;
const load = (specs) => specs.reduce((sum, spec) => sum + weight(spec), 0);

// Rule: no lane may have more than one indivisible file's estimated work
// above another lane. File-count/hash allocation violates this on the actual
// Linux outliers even though it gives each lane roughly the same file count.
it("balances the measured Linux main-process outliers within one file's cost", async () => {
  const specs = Object.keys(costs.files).map((file) => specification(file));
  const lanes = await Promise.all([1, 2].map((index) => new LinuxUnitSequencer(context(index, 2)).shard(specs)));
  expect(Math.abs(load(lanes[0]) - load(lanes[1]))).toBeLessThanOrEqual(Math.max(...specs.map(weight)));
});

it("balances the measured renderer outliers within one file's cost", async () => {
  const specs = Object.keys(rendererCosts.files).map((file) => specification(file, "desktop-renderer"));
  const weight = (spec) => rendererCosts.files[path.posix.relative(root, spec.moduleId)] ?? rendererCosts.fallbackMs;
  const load = (specs) => specs.reduce((sum, spec) => sum + weight(spec), 0);
  const lanes = await Promise.all([1, 2].map((index) => new LinuxUnitSequencer(context(index, 2)).shard(specs)));
  expect(Math.abs(load(lanes[0]) - load(lanes[1]))).toBeLessThanOrEqual(Math.max(...specs.map(weight)));
});

it.each([[2, 6], [4, 1]])("balances renderer outliers across %i lanes with %i new files", async (count, newFiles) => {
  const specs = [...Object.keys(rendererCosts.files), ...Array.from({ length: newFiles }, (_, index) => `new/${index}.test.ts`)]
    .map((file) => specification(file, "desktop-renderer"));
  const weight = (spec) => rendererCosts.files[path.posix.relative(root, spec.moduleId)] ?? rendererCosts.fallbackMs;
  const lanes = await Promise.all(Array.from({ length: count }, (_, index) => new LinuxUnitSequencer(context(index + 1, count)).shard(specs)));
  const loads = lanes.map((lane) => lane.reduce((sum, spec) => sum + weight(spec), 0));
  expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(Math.max(...specs.map(weight)));
});

it("partitions every selection exactly once with order- and checkout-independent ownership", async () => {
  await fc.assert(fc.asyncProperty(
    fc.constantFrom("desktop-main", "desktop-renderer"),
    fc.uniqueArray(fc.integer({ min: 0, max: 2000 }), { minLength: 1, maxLength: 80, size: "max" }),
    fc.integer({ min: 1, max: 8 }),
    async (project, ids, count) => {
      const measured = project === "desktop-main" ? costs : rendererCosts;
      const weight = (spec) => measured.files[path.posix.relative(root, spec.moduleId)] ?? measured.fallbackMs;
      const load = (specs) => specs.reduce((sum, spec) => sum + weight(spec), 0);
      const files = [...Object.keys(measured.files), ...ids.map((id) => `new/${id}.test.ts`)];
      const specs = files.map((file) => specification(file, project));
      const lanes = await Promise.all(Array.from({ length: count }, (_, i) => new LinuxUnitSequencer(context(i + 1, count)).shard(specs)));
      expect(lanes.flat().map((spec) => spec.moduleId).sort()).toEqual(specs.map((spec) => spec.moduleId).sort());
      const loads = lanes.map(load);
      expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(Math.max(...specs.map(weight)));
      for (let i = 0; i < count; i++) {
        const otherRoot = "/another/checkout";
        const relocated = files.toReversed().map((file) => specification(file, project, otherRoot));
        const replay = await new LinuxUnitSequencer(context(i + 1, count, otherRoot)).shard(relocated);
        expect(replay.map((spec) => path.posix.relative(otherRoot, spec.moduleId)).sort())
          .toEqual(lanes[i].map((spec) => path.posix.relative(root, spec.moduleId)).sort());
      }
    },
  ));
});

it("preserves Vitest ownership of every other project, including a shared module path", async () => {
  const main = Object.keys(costs.files).map((file) => specification(file));
  const renderer = Object.keys(rendererCosts.files).map((file) => specification(file, "desktop-renderer"));
  const others = main.map((spec, index) => ({ ...spec, project: { name: index % 2 ? "desktop-renderer-node" : "shared" } }));
  const specs = [...main, ...renderer, ...others];
  for (const index of [1, 2]) {
    const ctx = context(index, 2);
    const retained = (spec) => spec.project.name !== "desktop-main" && spec.project.name !== "desktop-renderer";
    const expected = (await new BaseSequencer(ctx).shard(specs)).filter(retained);
    const actual = (await new LinuxUnitSequencer(ctx).shard(specs)).filter(retained);
    expect(actual).toEqual(expected);
  }
});

it("gives the completion reporter the same selection as the test pool", async () => {
  const specs = [...Object.keys(costs.files).map((file) => specification(file)),
    ...Object.keys(rendererCosts.files).map((file) => specification(file, "desktop-renderer"))];
  for (const index of [1, 2]) {
    const ctx = context(index, 2);
    ctx.config.sequence = { sequencer: LinuxUnitSequencer };
    const reporter = new CiRetryReporter();
    reporter.onInit(ctx);
    await reporter.onTestRunStart(specs);
    const selected = await new LinuxUnitSequencer(ctx).shard(specs);
    expect(reporter.planned).toEqual(selected.map((spec) => JSON.stringify([spec.project.name, spec.moduleId])));
  }
});

// Rule: every Linux lane finishes inside its 10-minute step with a 25%
// reserve on the slowest runner measured. Main runs 44021057434,
// 44102962515, 44107691727, 44108073103 and 44114042498, with PR run
// 44111357566, gave 1,761s of median per-file work across the suite. The
// largest file took 108s. Per-file medians showed runner speed from 0.69x to
// 1.22x, and vitest's Duration was at most 0.608 of the summed file time.
// Allocation was balanced within 7% in every run; two lanes failed only
// because a 1.22x runner turned 831s of work into 609.86s.
it("gives every Linux CI lane deadline headroom on the slowest measured runner", () => {
  const workflow = fs.readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const job = workflow.split("\n  test:\n")[1].split("\n  test-result:\n")[0];
  const lanes = job.match(/lane: \[([\d, ]+)\]/)[1].split(",").map(Number);
  const shards = Number(job.match(/--config vitest\.linux-ci\.ts --shard=\$\{\{ matrix\.lane \}\}\/(\d+) /)[1]);
  const deadlineSeconds = Number(job.match(/name: Test\n\s+id: unit-tests\n(?:\s+.*\n)*?\s+timeout-minutes: (\d+)\n/)[1]) * 60;
  expect(lanes).toEqual(Array.from({ length: shards }, (_, index) => index + 1));
  const suiteWorkSeconds = 1761;
  const largestFileSeconds = 108;
  const slowestRunner = 1.22;
  const durationPerWork = 0.608;
  const heaviestLaneSeconds = (suiteWorkSeconds / shards + largestFileSeconds) * slowestRunner * durationPerWork;
  expect(heaviestLaneSeconds).toBeLessThanOrEqual(deadlineSeconds * 0.75);
});
