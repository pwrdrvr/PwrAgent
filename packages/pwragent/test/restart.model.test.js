import assert from "node:assert/strict";
import test from "node:test";
import { restartAfterCompletedTurn, runCompletedTurn } from "./helpers.js";

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
  const model = { resultVisible: false, historySaved: false, completionReceived: false, stopRequested: false, stopped: false, started: false };
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
      // Record the attempted effect even if the safety oracle rejects it.
      model.stopRequested = true;
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
      assert.equal(model.stopRequested, false);
    }
    assert.fail("restart never observed the completed turn");
  };
  const restarted = restartAfterCompletedTurn(h, turn, wait);
  if (outcome !== "completed") {
    await assert.rejects(restarted, /completed/);
    assert.equal(model.stopRequested, false);
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

test("a tool result cannot admit the next turn before its owning job completes", async () => {
  const turn = { threadId: "messaging-thread", turnId: "messaging-turn" };
  for (const commands of interleave(["persist", "complete"], ["poll", "poll", "poll"])) {
    const model = { toolResult: false, persisted: false, completed: false, nextTurn: false };
    const h = { rpc: async (method) => {
      assert.equal(method, "list");
      return [
        { ...turn, turnId: "earlier-turn", status: "completed" },
        { ...turn, threadId: "different-thread", status: "completed" },
        { ...turn, status: model.completed ? "completed" : "running" },
      ];
    } };
    const wait = async (check) => {
      for (const command of [...commands, "poll"]) {
        if (command === "persist") model.persisted = true;
        if (command === "complete") model.completed = true;
        if (command === "poll" && await check()) return;
        assert.equal(model.nextTurn, false);
      }
      assert.fail("the workflow never observed its completed turn");
    };
    const result = await runCompletedTurn(h, async () => {
      model.toolResult = true;
      return turn;
    }, wait);
    model.nextTurn = true;
    assert.ok(model.toolResult && model.persisted && model.completed,
      "the workflow admitted its next turn before the owning job completed");
    assert.equal(result, turn);
  }
});
