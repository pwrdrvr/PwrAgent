import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";

const result = spawnSync(
  "vale",
  [
    "--config=.vale.ini",
    "--minAlertLevel=suggestion",
    "--output=JSON",
    ".vale/tests/clean.md",
    ".vale/tests/violations.md",
  ],
  { encoding: "utf8" },
);

if (result.error?.code === "ENOENT") {
  console.error(
    "Vale is required for prose tests. Install it from https://vale.sh/docs/ or use the CI workflow.",
  );
  process.exit(1);
}

if (result.error) {
  throw result.error;
}

assert.equal(result.status, 0, result.stderr);
const findings = JSON.parse(result.stdout || "{}");
assert.equal(findings[".vale/tests/clean.md"], undefined);

const violationFindings = findings[".vale/tests/violations.md"] ?? [];
const checks = new Set(violationFindings.map((finding) => finding.Check));
assert.deepEqual(
  [...checks].sort(),
  ["PwrAgent.Contractions", "PwrAgent.PassiveVoice", "PwrAgent.Terminology"],
);
assert.ok(
  violationFindings.every((finding) => finding.Line === 3),
  "Vale must ignore the matching text inside the fenced code block",
);

const config = readFileSync(".vale.ini", "utf8");
assert.match(config, /StylesPath = \.vale\/styles/);
console.log(`prose lint fixtures passed (${violationFindings.length} findings)`);
