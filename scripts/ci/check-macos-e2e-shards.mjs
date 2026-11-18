import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { expectedSlices } from "./flake-report.mjs";
import { sameTestIds } from "./retry-failures.mjs";

function collectTests(...args) {
  // Match the default count weights used by the macOS job.
  const output = execFileSync("pnpm", [
    "--filter", "@pwragent/desktop", "exec", "playwright", "test",
    "-c", "playwright.config.ts", "--list", "--reporter=json", ...args,
  ], { encoding: "utf8", env: { ...process.env, PWTEST_SHARD_WEIGHTS: "" } });
  const report = JSON.parse(output);
  assert.deepEqual(report.errors, []);
  function collectSuite(suite) {
    return [...(suite.specs ?? []), ...(suite.suites ?? []).flatMap(collectSuite)];
  }
  return report.suites.flatMap(collectSuite);
}

// Playwright owns grouping, ordering and test IDs. Ask it for the inventory
// both ways so changes to its grouping or to the specs are exercised here.
const lanes = expectedSlices().filter(({ kind, platform }) => kind === "e2e" && platform === "macos");
const full = collectTests();
const sharded = lanes.map(({ lane }) => {
  const tests = collectTests(`--shard=${lane}/${lanes.length}`);
  assert.ok(tests.length > 0, `macOS E2E lane ${lane} collected no tests`);
  return tests;
});
assert.ok(sameTestIds(full.map(({ id }) => id), sharded.flat().map(({ id }) => id)),
  "macOS shards must cover every collected test exactly once");
const a11yCounts = sharded.map((tests) => tests.filter(({ file }) => file === "a11y.spec.ts").length);
assert.ok(a11yCounts.filter(Boolean).length > 1, "macOS a11y tests must span multiple lanes");
console.log(`macOS Desktop E2E collection: ${full.length} total, ${sharded.map((tests) => tests.length).join(" / ")} by lane.`);
console.log(`Accessibility collection by lane: ${a11yCounts.join(" / ")}.`);
