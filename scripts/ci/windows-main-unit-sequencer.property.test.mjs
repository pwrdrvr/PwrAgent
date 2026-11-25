import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { unitGroups } from "./pr-test-impact.mjs";
import CiRetryReporter from "./vitest-ci-reporter.mjs";
import WindowsMainUnitSequencer from "./windows-main-unit-sequencer.mjs";

const costs = JSON.parse(readFileSync(new URL("./windows-main-unit-costs.json", import.meta.url), "utf8"));
const root = path.resolve("fixture", "repository");
const otherRoot = path.resolve("another checkout");
const specification = (file, directory = root) => ({
  moduleId: path.resolve(directory, file),
  project: { name: "desktop-main" },
});
const context = (index, count, directory = root) => ({
  config: { root: directory, shard: { index, count }, sequence: { sequencer: WindowsMainUnitSequencer } },
});
const relative = (spec, directory = root) => path.relative(directory, spec.moduleId).split(path.sep).join("/");
const weight = (spec) => costs.files[relative(spec)] ?? costs.fallbackMs;
const load = (specs) => specs.reduce((sum, spec) => sum + weight(spec), 0);

it("balances the measured Windows desktop-main outliers across four lanes", async () => {
  const specs = Object.keys(costs.files).map((file) => specification(file));
  const lanes = await Promise.all([1, 2, 3, 4].map((index) => new WindowsMainUnitSequencer(context(index, 4)).shard(specs)));
  const loads = lanes.map(load);
  expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(Math.max(...specs.map(weight)));
});

it("separates two selected archive and lock suites when a second lane is available", async () => {
  // The hash placed both expensive files together in this narrowed input.
  const archive = specification("apps/desktop/src/main/__tests__/worktree-archive-git.property.test.ts");
  const lock = specification("apps/desktop/src/main/__tests__/worktree-lock-approval.property.test.ts");
  const specs = [archive, lock, specification("new/64.test.ts")];
  const lane = await new WindowsMainUnitSequencer(context(1, 2)).shard(specs);
  expect(lane.filter((spec) => spec === archive || spec === lock)).toHaveLength(1);
});

it("uses the same Windows desktop-main config for full and selected CI runs", () => {
  const workflow = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  const job = workflow.split("\n  windows-desktop-main:\n")[1].split("\n  windows-renderer-packages:\n")[0];
  const { config, lanes } = unitGroups["windows-main"];
  expect(job).toContain("run-pr-test-impact.mjs unit windows-main {0}");
  expect(job).toContain(`--config ${config} --project desktop-main --shard={0}/${lanes}`);
});

it("partitions every input exactly once, with stable ownership and bounded imbalance", async () => {
  await fc.assert(fc.asyncProperty(
    fc.subarray(Object.keys(costs.files)),
    fc.uniqueArray(fc.integer({ min: 0, max: 2000 }), { minLength: 1, maxLength: 120, size: "max" }),
    fc.integer({ min: 1, max: 4 }),
    async (measured, ids, count) => {
      const files = [...measured, ...ids.map((id) => `new/${id}.test.ts`)];
      const specs = files.map((file) => specification(file));
      const indices = Array.from({ length: count }, (_, i) => i + 1);
      const lanes = await Promise.all(indices.map((index) => new WindowsMainUnitSequencer(context(index, count)).shard(specs)));
      expect(lanes.flat().map((spec) => relative(spec)).sort()).toEqual([...files].sort());
      const loads = lanes.map(load);
      expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(Math.max(...specs.map(weight)));

      const relocated = files.toReversed().map((file) => specification(file, otherRoot));
      for (const index of indices) {
        const selected = lanes[index - 1];
        const replay = await new WindowsMainUnitSequencer(context(index, count, otherRoot)).shard(relocated);
        expect(replay.map((spec) => relative(spec, otherRoot))).toEqual(selected.map((spec) => relative(spec)));

        const reporter = new CiRetryReporter();
        reporter.onInit(context(index, count));
        await reporter.onTestRunStart(specs);
        expect(reporter.planned).toEqual(selected.map((spec) => JSON.stringify([spec.project.name, spec.moduleId])));
      }
    },
  ));
});
