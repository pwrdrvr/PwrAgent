import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { BaseSequencer } from "vitest/node";
import LinuxUnitSequencer from "./linux-unit-sequencer.mjs";
import CiRetryReporter from "./vitest-ci-reporter.mjs";

const costs = JSON.parse(fs.readFileSync(new URL("./linux-unit-costs.json", import.meta.url), "utf8"));
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

it("partitions every selection exactly once with order- and checkout-independent ownership", async () => {
  await fc.assert(fc.asyncProperty(
    fc.uniqueArray(fc.integer({ min: 0, max: 2000 }), { minLength: 1, maxLength: 80, size: "max" }),
    fc.integer({ min: 1, max: 8 }),
    async (ids, count) => {
      const files = [...Object.keys(costs.files), ...ids.map((id) => `new/${id}.test.ts`)];
      const specs = files.map((file) => specification(file));
      const lanes = await Promise.all(Array.from({ length: count }, (_, i) => new LinuxUnitSequencer(context(i + 1, count)).shard(specs)));
      expect(lanes.flat().map((spec) => spec.moduleId).sort()).toEqual(specs.map((spec) => spec.moduleId).sort());
      const loads = lanes.map(load);
      expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(Math.max(...specs.map(weight)));
      for (let i = 0; i < count; i++) {
        const otherRoot = "/another/checkout";
        const relocated = files.toReversed().map((file) => specification(file, "desktop-main", otherRoot));
        const replay = await new LinuxUnitSequencer(context(i + 1, count, otherRoot)).shard(relocated);
        expect(replay.map((spec) => path.posix.relative(otherRoot, spec.moduleId)).sort())
          .toEqual(lanes[i].map((spec) => path.posix.relative(root, spec.moduleId)).sort());
      }
    },
  ));
});

it("preserves Vitest ownership of every other project, including a shared module path", async () => {
  const main = Object.keys(costs.files).map((file) => specification(file));
  const others = main.map((spec, index) => ({ ...spec, project: { name: index % 2 ? "desktop-renderer" : "shared" } }));
  const specs = [...main, ...others];
  for (const index of [1, 2]) {
    const ctx = context(index, 2);
    const expected = (await new BaseSequencer(ctx).shard(specs)).filter((spec) => spec.project.name !== "desktop-main");
    const actual = (await new LinuxUnitSequencer(ctx).shard(specs)).filter((spec) => spec.project.name !== "desktop-main");
    expect(actual).toEqual(expected);
  }
});

it("gives the completion reporter the same selection as the test pool", async () => {
  const specs = Object.keys(costs.files).map((file) => specification(file));
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
