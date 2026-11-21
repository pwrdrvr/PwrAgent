import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

function unitSteps(workflow, job) {
  const source = readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), "utf8");
  const jobs = source.split(/^ {2}(?=[\w-]+:\n)/m);
  const steps = jobs.find((section) => section.startsWith(`${job}:\n`)).split(/^ {6}- /m);
  return steps.filter((step) => /^ {8}id: unit-(?:tests|completion|retry)$/m.test(step))
    .map((step) => step.split("\n").filter((line) => !/^\s*(?:#|PWRAGENT_NATIVE_ORACLE_PROFILE:)/.test(line)).join("\n").trim());
}

test("release macOS lanes verify completion and retry failures just like regular CI", () => {
  // Regular macOS CI is the oracle for the reporter, step outcomes, and retry environment.
  const ci = unitSteps("ci.yml", "test-macos");
  expect(ci).toHaveLength(3);
  expect(unitSteps("release.yml", "test")).toEqual(ci);
});
