import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(testDir, "../scripts/analyze_rollout_tool_output.mjs");
const fixture = path.join(testDir, "fixtures/structured-tool-output.jsonl");

test("analyzes structured tool output blocks without counting non-text content", () => {
  const result = spawnSync(process.execPath, [script, fixture, "--json"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout).summaries[0];
  assert.equal(summary.totals.functionOutputs, 6);
  assert.equal(summary.totals.nonTextOutputs, 1);
  assert.equal(summary.totals.outputChars, 267);
  assert.equal(summary.totals.structuredOutputs, 5);
  assert.equal(summary.totals.truncatedOutputs, 2);

  const cellPoll = summary.topOutputs.find((output) => output.command === "exec (poll)");
  assert.equal(cellPoll.exitCode, 7);
  assert.equal(cellPoll.originalTokenCount, 9);
  assert.equal(cellPoll.pollSessionId, "fixture-cell");
  assert.equal(cellPoll.truncated, true);

  const sessionPoll = summary.topOutputs.find((output) => output.command === "sleep (poll)");
  assert.equal(sessionPoll.exitCode, 0);
  assert.equal(sessionPoll.originalTokenCount, 3);
  assert.equal(sessionPoll.pollSessionId, "42");
  assert.equal(sessionPoll.truncated, true);

  const legacyEvent = summary.topOutputs.find((output) => output.command === "legacy-event");
  assert.equal(legacyEvent.exitCode, 4);
  assert.equal(legacyEvent.chars, 13);
});
