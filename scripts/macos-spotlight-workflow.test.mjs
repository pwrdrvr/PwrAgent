import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test.each(["ci.yml", "release.yml"])("%s cannot gate tests on optional Spotlight tuning", (name) => {
  const workflow = readFileSync(new URL(`../.github/workflows/${name}`, import.meta.url), "utf8");
  const spotlightSteps = workflow.split("\n      - ").slice(1).filter((step) => /\bmdutil\b/.test(step));
  expect(spotlightSteps.length).toBeGreaterThan(0);
  // Hosted volumes can be in kMDConfigSearchLevelTransitioning. Indexing is
  // only a performance optimization: every such step must be advisory and
  // bounded, as the unit-test and release lanes already require.
  for (const step of spotlightSteps) {
    expect(step).toMatch(/^ {8}continue-on-error: true$/m);
    const timeout = step.match(/^ {8}timeout-minutes: (\d+)$/m);
    expect(timeout).not.toBeNull();
    expect(Number(timeout[1])).toBeGreaterThan(0);
    expect(Number(timeout[1])).toBeLessThanOrEqual(2);
  }
});
