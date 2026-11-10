import assert from "node:assert/strict";
import test from "node:test";
import { runCompletedTurn as callCompletedTurn } from "./helpers.js";

function* interleave(left, right) {
  if (!left.length || !right.length) { yield [...left, ...right]; return; }
  for (const rest of interleave(left.slice(1), right)) yield [left[0], ...rest];
  for (const rest of interleave(left, right.slice(1))) yield [right[0], ...rest];
}

async function checkCompletion(commands, outcome = "completed") {
  const turn = { threadId: "owner-thread", turnId: "owner-turn" };
  const model = { toolResult: false, history: false, completed: false, calls: 0 };
  const h = { rpc: async method => {
    assert.equal(method, "list");
    return [
      { ...turn, turnId: "older-turn", status: "completed" },
      { ...turn, threadId: "another-thread", status: "completed" },
      { ...turn, status: model.completed ? outcome : "running" },
    ];
  } };
  const wait = async check => {
    for (const command of [...commands, "poll"]) {
      if (command === "tool-result") model.toolResult = true;
      if (command === "history") model.history = true;
      if (command === "completion") model.completed = true;
      if (command === "poll" && await check()) return;
    }
    assert.fail("completion was never observed");
  };
  const result = callCompletedTurn(h, async () => { model.calls++; return turn; }, wait);
  if (outcome !== "completed") await assert.rejects(result, /completed/);
  else {
    assert.deepEqual(await result, turn);
    assert.ok(model.history && model.completed, "a completed-turn call returned before the owner recorded terminal completion");
  }
  assert.equal(model.calls, 1, "waiting for readiness must never resend accepted input");
}

test("a visible messaging tool result is not owner turn completion", async () => {
  await checkCompletion(["tool-result", "poll", "history", "poll", "completion"]);
});

test("completed messaging calls preserve owner readiness for every valid observation ordering", async () => {
  for (const commands of interleave(["tool-result", "history", "completion"], ["poll", "poll", "poll"])) {
    await checkCompletion(commands);
  }
});

test("failed or uncertain owner outcomes are refused without resubmitting accepted input", async () => {
  for (const outcome of ["failed", "interrupted", "blocked", "unknown"]) {
    await checkCompletion(["tool-result", "history", "completion"], outcome);
  }
});
