import { describe, expect, it } from "vitest";
import { transitionQueueAdmission } from "../queue-admission";

describe("queue admission identity", () => {
  it("retains matching outcomes received after acknowledgement until the attempt settles", () => {
    const attempt = Symbol();
    const starting = transitionQueueAdmission({ phase: "idle" }, { type: "begin", attempt });
    const acknowledged = transitionQueueAdmission(starting, { type: "acknowledge", attempt, turnId: "current" });
    const stale = transitionQueueAdmission(acknowledged, {
      type: "terminal", terminal: { turnId: "old", status: "turn/failed" },
    });
    expect(stale).toMatchObject({ phase: "acknowledged", terminal: undefined });
    const completed = transitionQueueAdmission(stale, {
      type: "terminal", terminal: { turnId: "current", status: "turn/completed" },
    });
    expect(completed).toMatchObject({
      phase: "acknowledged", terminal: { turnId: "current", status: "turn/completed" },
    });
  });

  it("matches early completion by turn id and preserves the first terminal", () => {
    const attempt = Symbol();
    const starting = transitionQueueAdmission({ phase: "idle" }, { type: "begin", attempt });
    const completed = transitionQueueAdmission(starting, {
      type: "terminal", terminal: { turnId: "turn-1", status: "turn/completed" },
    });
    const duplicate = transitionQueueAdmission(completed, {
      type: "terminal", terminal: { turnId: "turn-1", status: "turn/failed" },
    });
    expect(duplicate).toBe(completed);
    expect(transitionQueueAdmission(duplicate, { type: "acknowledge", attempt, turnId: "turn-1" }))
      .toMatchObject({ phase: "acknowledged", terminal: { status: "turn/completed" } });
    expect(transitionQueueAdmission(duplicate, { type: "acknowledge", attempt, turnId: "turn-2" }))
      .toMatchObject({ phase: "acknowledged", terminal: undefined });
  });

  it("rejects an old acknowledgement or finalizer after a new admission", () => {
    const old = Symbol();
    const attempt = Symbol();
    const current = transitionQueueAdmission({ phase: "idle" }, { type: "begin", attempt });
    expect(transitionQueueAdmission(current, { type: "acknowledge", attempt: old, turnId: "old" })).toBe(current);
    expect(transitionQueueAdmission(current, { type: "settle", attempt: old })).toBe(current);
    expect(transitionQueueAdmission(current, { type: "begin", attempt: old })).toBe(current);
  });
});
