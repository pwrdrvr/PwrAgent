import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

function unitSteps(workflow, job) {
  const source = readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), "utf8");
  const jobs = source.split(/^ {2}(?=[\w-]+:\n)/m);
  const steps = jobs.find((section) => section.startsWith(`${job}:\n`)).split(/^ {6}- /m);
  return steps.filter((step) => /^ {8}id: unit-(?:tests|completion|retry)$/m.test(step))
    .map((step) => step.split("\n").filter((line) => !/^\s*(?:#|PWRAGENT_NATIVE_ORACLE_PROFILE:)/.test(line)).join("\n").trim());
}

test("release and full macOS CI use the same reporters, completion checks, and retry environment", () => {
  const ci = unitSteps("ci.yml", "test-macos");
  const release = unitSteps("release.yml", "test");
  expect(ci).toHaveLength(3);
  expect(release).toHaveLength(3);
  const full = ci[0].replace(/\n\s+UNIT_MODE: [^\n]+/, "").replace(
    /run: \|\n\s+if [^\n]+\n\s+pnpm exec node scripts\/ci\/run-pr-test-impact\.mjs unit macos [^\n]+\n\s+else\n\s+([^\n]+)\n\s+fi$/,
    "run: $1",
  );
  expect([full, ...ci.slice(1)]).toEqual(release);
});
