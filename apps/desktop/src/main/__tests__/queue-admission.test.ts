import { describe, expect, it } from "vitest";
import { transitionQueueAdmission } from "../app-server/queue-admission";

describe("queue admission identity", () => {
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
