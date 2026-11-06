import { describe, expect, it } from "vitest";
import {
  OPEN_RESTART_GATE,
  planRestartDispatch,
  restartGateHolds,
  transitionRestartGate,
  type RestartGateState,
} from "../app-server/restart-continuation-gate";

const schedule = (entryId: string, dispatchAt: number) => ({
  entryId,
  threadKey: `codex:${entryId}`,
  dispatchAt,
});

describe("restart continuation gate", () => {
  it("holds every entry while quieting", () => {
    const quieting = transitionRestartGate(OPEN_RESTART_GATE, { type: "quiet", at: 5 });
    expect(quieting).toEqual({ phase: "quieting", startedAt: 5 });
    expect(restartGateHolds(quieting, {}, 0)).toBe(true);
    // Even a continuation: nothing starts on the way down.
    expect(restartGateHolds(quieting, { restartEntryId: "a" }, Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(transitionRestartGate(quieting, { type: "quiet", at: 9 })).toBe(quieting);
  });

  it("holds other work until every continuation has settled, and each continuation until its time", () => {
    let state: RestartGateState = transitionRestartGate(OPEN_RESTART_GATE, {
      type: "restore",
      schedule: [schedule("a", 100), schedule("b", 200)],
      releaseBy: 1_000,
    });
    expect(state.phase).toBe("resuming");
    expect(restartGateHolds(state, {}, 500)).toBe(true);
    expect(restartGateHolds(state, { restartEntryId: "a" }, 99)).toBe(true);
    expect(restartGateHolds(state, { restartEntryId: "a" }, 100)).toBe(false);
    expect(restartGateHolds(state, { restartEntryId: "b" }, 150)).toBe(true);
    // A continuation the gate does not know is not held by its time.
    expect(restartGateHolds(state, { restartEntryId: "unknown" }, 0)).toBe(false);

    state = transitionRestartGate(state, { type: "settled", entryId: "a" });
    expect(restartGateHolds(state, {}, 500)).toBe(true);
    // A continuation that settled without starting (a lock held it) still
    // waits for its own time once released, while others are waiting.
    expect(restartGateHolds(state, { restartEntryId: "a" }, 99)).toBe(true);
    expect(restartGateHolds(state, { restartEntryId: "a" }, 100)).toBe(false);
    expect(transitionRestartGate(state, { type: "settled", entryId: "a" })).toBe(state);
    state = transitionRestartGate(state, { type: "settled", entryId: "b" });
    expect(state).toBe(OPEN_RESTART_GATE);
    expect(restartGateHolds(state, {}, 0)).toBe(false);
  });

  it("opens at its deadline even with a continuation still waiting", () => {
    const state = transitionRestartGate(OPEN_RESTART_GATE, {
      type: "restore",
      schedule: [schedule("a", 100)],
      releaseBy: 1_000,
    });
    expect(transitionRestartGate(state, { type: "deadline", at: 999 })).toBe(state);
    expect(transitionRestartGate(state, { type: "deadline", at: 1_000 })).toBe(OPEN_RESTART_GATE);
  });

  it("keeps a restart under way shut when continuations restore", () => {
    const quieting = transitionRestartGate(OPEN_RESTART_GATE, { type: "quiet", at: 1 });
    expect(transitionRestartGate(quieting, {
      type: "restore",
      schedule: [schedule("a", 1)],
      releaseBy: 2,
    })).toBe(quieting);
    expect(transitionRestartGate(OPEN_RESTART_GATE, {
      type: "restore",
      schedule: [],
      releaseBy: 2,
    })).toBe(OPEN_RESTART_GATE);
  });

  it("can quiet again while still resuming", () => {
    const resuming = transitionRestartGate(OPEN_RESTART_GATE, {
      type: "restore",
      schedule: [schedule("a", 1)],
      releaseBy: 2,
    });
    expect(transitionRestartGate(resuming, { type: "quiet", at: 3 })).toEqual({ phase: "quieting", startedAt: 3 });
  });
});

describe("planRestartDispatch", () => {
  it("staggers continuations in batches, each with its own jitter", () => {
    const randoms = [0, 0.5, 1, 0.25, 0, 0, 0.1, 0.9, 0.5];
    let index = 0;
    const entries = Array.from({ length: 9 }, (_, i) => ({ entryId: `e${i}`, threadKey: `codex:t${i}` }));
    const plan = planRestartDispatch(entries, {
      now: 1_000,
      batchSize: 4,
      firstDelayMs: 20_000,
      intervalMs: 45_000,
      jitterMs: 10_000,
      releaseGraceMs: 60_000,
      random: () => randoms[index++]!,
    });
    expect(plan.schedule.map((item) => item.dispatchAt)).toEqual([
      21_000, 26_000, 31_000, 23_500,
      66_000, 66_000, 67_000, 75_000,
      116_000,
    ]);
    expect(plan.releaseBy).toBe(176_000);
    expect(plan.schedule.map((item) => item.entryId)).toEqual(entries.map((entry) => entry.entryId));
  });

  it("clamps out-of-range options and random values", () => {
    const plan = planRestartDispatch([{ entryId: "a", threadKey: "codex:a" }], {
      now: 0,
      batchSize: 0,
      firstDelayMs: -5,
      intervalMs: -5,
      jitterMs: 100,
      releaseGraceMs: -1,
      random: () => 7,
    });
    expect(plan).toEqual({ schedule: [{ entryId: "a", threadKey: "codex:a", dispatchAt: 100 }], releaseBy: 100 });
  });

  it("releases at once with nothing to send", () => {
    expect(planRestartDispatch([], { now: 50, releaseGraceMs: 10 })).toEqual({ schedule: [], releaseBy: 60 });
  });
});
