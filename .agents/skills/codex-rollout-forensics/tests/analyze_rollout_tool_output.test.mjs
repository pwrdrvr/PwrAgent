import assert from "node:assert/strict";
import { constants as bufferConstants } from "node:buffer";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(testDir, "../scripts/analyze_rollout_tool_output.mjs");
const fixture = path.join(testDir, "fixtures/structured-tool-output.jsonl");
const threadId = "00000000-0000-4000-8000-000000000001";

function withSessionTree(run) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rollout-discovery-"));
  try {
    run(home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeRollout(home, relativePath, id, records = []) {
  const file = path.join(home, ".codex", relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: "session_meta", payload: { id, cwd: "/synthetic" } },
    ...records,
  ].map((record) => JSON.stringify(record)).join("\n") + "\n");
  return file;
}

function writeOversizedUnrelatedRollout(home) {
  const file = writeRollout(home, "profiles/default/sessions/unrelated.jsonl", "unrelated");
  // Sparse storage reproduces the original string limit without a large artifact.
  fs.truncateSync(file, bufferConstants.MAX_STRING_LENGTH + 1);
  return file;
}

function runAnalyzer(home, args) {
  const result = spawnSync(process.execPath, ["--max-old-space-size=64", script, ...args, "--json"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home },
    maxBuffer: 1024 * 1024,
    timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).summaries;
}

test("filename discovery skips unrelated oversized rollouts and metadata fallback", () => {
  withSessionTree((home) => {
    writeOversizedUnrelatedRollout(home);
    const selected = writeRollout(home, `sessions/2026/01/01/rollout-fixture-${threadId}.jsonl`, threadId);
    writeRollout(home, "archived_sessions/renamed.jsonl", threadId);

    const summaries = runAnalyzer(home, ["--profile", "default", "--thread-id", threadId, "--top", "3"]);
    assert.deepEqual(summaries.map((summary) => summary.file), [selected]);
    assert.equal(summaries[0].meta.sessionId, threadId);
  });
});

test("fallback reads bounded metadata headers and ignores references in unrelated bodies", () => {
  withSessionTree((home) => {
    writeOversizedUnrelatedRollout(home);
    writeRollout(home, "profiles/default/sessions/reference.jsonl", "other-session", [
      { type: "event_msg", payload: { type: "user_message", message: threadId } },
    ]);
    const oversizedHeader = writeRollout(home, "profiles/default/sessions/large-header.jsonl", threadId);
    fs.writeFileSync(oversizedHeader, JSON.stringify({
      type: "session_meta",
      payload: { padding: "x".repeat(128 * 1024), id: threadId },
    }) + "\n");
    const selected = writeRollout(home, "archived_sessions/renamed.jsonl", threadId);
    // Also cover metadata-only files without a final newline and the legacy id key.
    fs.writeFileSync(selected, JSON.stringify({ type: "session_meta", payload: { session_id: threadId } }));

    const summaries = runAnalyzer(home, ["--profile", "default", "--thread-id", threadId]);
    assert.deepEqual(summaries.map((summary) => summary.file), [selected]);
    assert.equal(summaries[0].meta.sessionId, threadId);
  });
});

test("thread discovery honors max-files across profile and default session roots", () => {
  withSessionTree((home) => {
    const selected = writeRollout(home, `profiles/default/archived_sessions/rollout-fixture-${threadId}.jsonl`, threadId);
    writeRollout(home, `sessions/rollout-fixture-${threadId}.jsonl`, threadId);
    const summaries = runAnalyzer(home, ["--profile", "default", "--thread-id", threadId, "--max-files", "1"]);
    assert.deepEqual(summaries.map((summary) => summary.file), [selected]);
  });
});

test("streams selected rollouts larger than the heap while preserving output and replay totals", () => {
  withSessionTree((home) => {
    const selected = writeRollout(home, "sessions/streamed.jsonl", threadId);
    const fd = fs.openSync(selected, "a");
    try {
      const row = JSON.stringify({
        type: "event_msg",
        payload: { type: "exec_command_end", command: "synthetic-padding", output: "x".repeat(8192) },
      }) + "\n";
      for (let index = 0; index < 12_000; index += 1) {
        fs.writeSync(fd, row);
      }
      fs.writeSync(fd, "\ninvalid JSON\n" + JSON.stringify({
        type: "event_msg",
        payload: { type: "exec_command_end", command: "synthetic-command", output: "fixture output", exit_code: 0 },
      }) + "\n" + JSON.stringify({
        type: "event_msg",
        payload: { type: "token_count", info: { total_token_usage: { input_tokens: 42 } } },
      }));
    } finally {
      fs.closeSync(fd);
    }

    const summary = runAnalyzer(home, [selected])[0];
    assert.equal(summary.meta.sessionId, threadId);
    assert.equal(summary.totals.functionCalls, 12_001);
    assert.equal(summary.totals.functionOutputs, 12_001);
    assert.equal(summary.totals.outputChars, 12_000 * 8192 + 14);
    assert.equal(summary.totals.tokenCountEvents, 1);
    assert.equal(summary.totals.totalInputTokens, 42);
    assert.equal(summary.topOutputs[0].command, "synthetic-padding");
    assert.equal(summary.topOutputs[0].modelRequestsAfter, 1);
    assert.equal(summary.topOutputs[0].replayInputImpressions, 2048);
    assert.equal(summary.totals.replayInputImpressions, 12_000 * 2048 + 4);
  });
}, 20_000);

test("analyzes structured tool output blocks without counting non-text content", () => {
  const result = spawnSync(process.execPath, [script, fixture, "--json"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout).summaries[0];
  assert.equal(summary.totals.functionOutputs, 8);
  assert.equal(summary.totals.nonTextOutputs, 1);
  assert.equal(summary.totals.outputChars, 433);
  assert.equal(summary.totals.structuredOutputs, 7);
  assert.equal(summary.totals.truncatedOutputs, 2);

  const groups = new Map(summary.topGroups.map((group) => [group.command, group]));
  assert.equal(groups.get("exec (poll)").calls, 2);
  assert.equal(groups.get("sleep (poll)").calls, 2);
  assert.equal(groups.has("wait (poll)"), false);
  assert.equal(groups.has("write_stdin (poll)"), false);

  const cellPoll = summary.topOutputs.find((output) => output.exitCode === 7);
  assert.equal(cellPoll.command, "exec (poll)");
  assert.equal(cellPoll.exitCode, 7);
  assert.equal(cellPoll.originalTokenCount, 9);
  assert.equal(cellPoll.pollSessionId, "fixture-cell");
  assert.equal(cellPoll.truncated, true);

  const sessionPoll = summary.topOutputs.find((output) => output.exitCode === 0);
  assert.equal(sessionPoll.command, "sleep (poll)");
  assert.equal(sessionPoll.exitCode, 0);
  assert.equal(sessionPoll.originalTokenCount, 3);
  assert.equal(sessionPoll.pollSessionId, "42");
  assert.equal(sessionPoll.truncated, true);

  const legacyEvent = summary.topOutputs.find((output) => output.command === "legacy-event");
  assert.equal(legacyEvent.exitCode, 4);
  assert.equal(legacyEvent.chars, 13);
});
