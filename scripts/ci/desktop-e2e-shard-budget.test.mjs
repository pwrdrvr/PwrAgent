import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(resolve(root, ".github/workflows/ci.yml"), "utf8");
const data = JSON.parse(readFileSync(resolve(root, "docs/desktop-e2e-shard-durations.json"), "utf8"));
const jobSection = (job) => workflow.split(`\n  ${job}:\n`)[1]?.split(/\n {2}[a-z][a-z0-9-]*:\n/)[0];
const linux = data.platforms.indexOf("linux");
const a11ySpec = "a11y.spec.ts";

// Playwright 1.63's weighted sharding, as scripts/ci/fit-desktop-e2e-shards.py
// models it: floor each weighted share of the collected count, give the
// remainder to the earliest lanes, and place each indivisible group by the
// position of its first test.
function laneSeconds(groups, weights) {
  const count = groups.reduce((sum, group) => sum + group.count, 0);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const sizes = weights.map((weight) => Math.floor((weight * count) / total));
  const remainder = count - sizes.reduce((sum, size) => sum + size, 0);
  for (let index = 0; index < remainder; index++) sizes[index] += 1;
  const ends = sizes.map((_, index) => sizes.slice(0, index + 1).reduce((sum, size) => sum + size, 0));
  const seconds = weights.map(() => 0);
  let position = 0;
  for (const group of groups) {
    seconds[ends.findIndex((end) => position < end)] += group.seconds[linux];
    position += group.count;
  }
  return seconds;
}

// Rule: on a GitHub-hosted runner 1.4 times slower than the median, which
// main run 45525513730 hit, every Linux lane that runs desktop E2E tests
// still finishes them within 8 of its step's 10 minutes. The remainder covers
// the build, reporting and further runner variance.
const slowRunner = 1.4;
const testBudgetSeconds = 8 * 60;

it("keeps every Linux Desktop E2E and accessibility lane inside its step on a 1.4x slower runner", () => {
  expect(linux).toBeGreaterThanOrEqual(0);
  const e2e = jobSection("desktop-e2e");
  const weights = e2e.match(/export PWTEST_SHARD_WEIGHTS="([\d:]+)"/)?.[1].split(":").map(Number);
  expect(weights, "Linux E2E weights").toBeDefined();
  const fallbackLanes = JSON.stringify(weights.map((_, index) => index + 1)).replaceAll(",", ", ");
  expect(e2e).toContain(`outputs.e2e_lanes || '${fallbackLanes}'`);
  expect(e2e).toContain(`--shard=\${{ matrix.lane }}/${weights.length}`);
  const skipsA11y = e2e.includes("export PWRAGENT_E2E_SKIP_A11Y=1\n");
  const lanes = { "Linux Desktop E2E": laneSeconds(
    data.groups.filter((group) => !skipsA11y || group.spec !== a11ySpec), weights) };

  const a11y = jobSection("desktop-a11y");
  if (a11y) {
    const shards = Number(a11y.match(/e2e\/a11y\.spec\.ts --shard=\$\{\{ matrix\.lane \}\}\/(\d+)/)?.[1]);
    expect(a11y).toContain(`lane: [${Array.from({ length: shards }, (_, index) => index + 1).join(", ")}]`);
    lanes["Linux Desktop a11y"] = laneSeconds(
      data.groups.filter((group) => group.spec === a11ySpec), Array.from({ length: shards }, () => 1));
  } else {
    expect(skipsA11y, "a11y.spec.ts runs somewhere on Linux").toBe(false);
  }

  for (const [job, seconds] of Object.entries(lanes)) {
    seconds.forEach((median, index) => {
      expect(median * slowRunner, `${job} lane ${index + 1}: ${median.toFixed(1)}s median`)
        .toBeLessThanOrEqual(testBudgetSeconds);
    });
  }
});
