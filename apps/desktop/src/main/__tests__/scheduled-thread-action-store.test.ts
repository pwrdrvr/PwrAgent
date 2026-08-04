import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ScheduledThreadActionStore } from "../scheduled-actions/scheduled-thread-action-store";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: ScheduledThreadActionStore;

beforeEach(() => {
  stateDb = StateDb.open(":memory:");
  store = new ScheduledThreadActionStore(stateDb);
});

afterEach(() => {
  stateDb.close();
});

describe("ScheduledThreadActionStore", () => {
  it("persists scheduled actions and filters them by thread", () => {
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 20_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
      now: 1_000,
    });
    store.create({
      id: "scheduled-2",
      backend: "codex",
      threadId: "thread-2",
      kind: "review",
      origin: "desktop",
      scheduledFor: 30_000,
      displayText: "/review",
      review: { target: { type: "uncommittedChanges" } },
      now: 2_000,
    });

    expect(store.list({ backend: "codex", threadId: "thread-1" })).toEqual([
      expect.objectContaining({
        id: "scheduled-1",
        status: "scheduled",
        displayText: "Follow up",
      }),
    ]);
    expect(store.nextScheduledAt()).toBe(20_000);
  });

  it("atomically claims due actions once", () => {
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 10_000,
      displayText: "First",
      turn: { input: [{ type: "text", text: "First" }] },
      now: 1_000,
    });
    store.create({
      id: "scheduled-2",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 20_000,
      displayText: "Second",
      turn: { input: [{ type: "text", text: "Second" }] },
      now: 2_000,
    });

    expect(store.claimDue({ now: 15_000 })).toEqual([
      expect.objectContaining({ id: "scheduled-1", status: "dispatching" }),
    ]);
    expect(store.claimDue({ now: 15_000 })).toEqual([]);
    expect(store.get("scheduled-2")).toMatchObject({ status: "scheduled" });
  });

  it("updates and cancels only actions that have not dispatched", () => {
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 10_000,
      displayText: "Original",
      turn: { input: [{ type: "text", text: "Original" }] },
      now: 1_000,
    });

    expect(store.update("scheduled-1", {
      scheduledFor: 12_000,
      displayText: "Updated",
      turn: { input: [{ type: "text", text: "Updated" }] },
      now: 2_000,
    })).toMatchObject({
      scheduledFor: 12_000,
      displayText: "Updated",
    });
    expect(store.cancel("scheduled-1", 3_000)).toMatchObject({
      status: "cancelled",
    });
    expect(store.update("scheduled-1", {
      displayText: "Too late",
      now: 4_000,
    })).toBeUndefined();
  });

  it("recovers registry-queued work after a main-process restart", () => {
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 10_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
      now: 1_000,
    });
    store.claim("scheduled-1", 10_000);
    store.markQueued("scheduled-1", "queue-1", 10_001);

    expect(store.recoverInterruptedQueues(20_000)).toEqual([
      expect.objectContaining({
        id: "scheduled-1",
        queueEntryId: undefined,
        status: "scheduled",
      }),
    ]);
    expect(store.claimDue({ now: 20_000 })).toEqual([
      expect.objectContaining({ id: "scheduled-1", status: "dispatching" }),
    ]);
  });

  it("does not automatically replay an ambiguous interrupted dispatch", () => {
    store.create({
      id: "scheduled-1",
      backend: "codex",
      threadId: "thread-1",
      kind: "turn",
      origin: "desktop",
      scheduledFor: 10_000,
      displayText: "Follow up",
      turn: { input: [{ type: "text", text: "Follow up" }] },
      now: 1_000,
    });
    store.claim("scheduled-1", 10_000);

    expect(store.failInterruptedDispatches(20_000)).toEqual([
      expect.objectContaining({
        id: "scheduled-1",
        status: "failed",
        errorMessage: expect.stringContaining("Check the thread"),
      }),
    ]);
    expect(store.claimDue({ now: 20_000 })).toEqual([]);
  });
});
