import assert from "node:assert/strict";
import test from "node:test";
import { restartAfterCompletedTurn } from "./helpers.js";

function* interleave(left, right) {
  if (!left.length || !right.length) {
    yield [...left, ...right];
    return;
  }
  for (const rest of interleave(left.slice(1), right)) yield [left[0], ...rest];
  for (const rest of interleave(left, right.slice(1))) yield [right[0], ...rest];
}

async function runRestartModel(commands, outcome = "completed") {
  const turn = { threadId: "owner-thread", turnId: "owner-turn" };
  const model = { resultVisible: false, historySaved: false, completionReceived: false, stopped: false, started: false };
  const daemon = {};
  const h = {
    daemon,
    rpc: async (method) => {
      assert.equal(method, "list");
      return [
        { ...turn, turnId: "older-turn", status: "completed" },
        { ...turn, threadId: "another-thread", status: "completed" },
        { ...turn, status: model.completionReceived ? outcome : "running" },
      ];
    },
    stop: async (child) => {
      assert.equal(child, daemon);
      // Rule: a completed-turn restart cannot stop its owner until the
      // provider has saved history and the owner has received completion.
      assert.ok(model.historySaved && model.completionReceived && outcome === "completed",
        "restart stopped the owner before the requested turn completed");
      model.stopped = true;
    },
    start: async () => {
      assert.ok(model.stopped);
      model.started = true;
      return "replacement daemon";
    },
  };
  // Drive every observation with model commands, without sleeps or timers.
  const wait = async (check) => {
    for (const command of [...commands, "poll"]) {
      if (command === "result") model.resultVisible = true;
      if (command === "persist") model.historySaved = true;
      if (command === "complete") model.completionReceived = true;
      if (command === "poll" && await check()) return;
      assert.equal(model.stopped, false);
    }
    assert.fail("restart never observed the completed turn");
  };
  const restarted = restartAfterCompletedTurn(h, turn, wait);
  if (outcome !== "completed") {
    await assert.rejects(restarted, /completed/);
    assert.equal(model.stopped, false);
  } else {
    assert.equal(await restarted, "replacement daemon");
    assert.ok(model.resultVisible && model.started);
  }
}

test("a visible result does not permit a completed-turn restart", async () => {
  await runRestartModel(["result", "poll", "persist", "poll", "complete"]);
});

test("restart preserves the completion invariant for every observation ordering", async () => {
  for (const commands of interleave(["result", "persist", "complete"], ["poll", "poll", "poll"])) {
    await runRestartModel(commands);
  }
});

test("an unsuccessful or uncertain turn does not satisfy a completed-turn restart", async () => {
  for (const outcome of ["failed", "interrupted", "blocked", "unknown"]) {
    await runRestartModel(["result", "persist", "complete"], outcome);
  }
});
