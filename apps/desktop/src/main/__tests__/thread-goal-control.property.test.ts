import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ThreadGoalView } from "@pwragent/shared/contracts/thread-goal";
import { ThreadGoalControl, type ThreadGoalGate } from "../app-server/thread-goal-control";
import { ThreadTurnQueue, ThreadTurnQueueDispatchCancelled } from "@pwragent/owner-core/thread-turn-queue";

const threadId = "thread";

function fixture(scheduler: fc.Scheduler) {
  let goal: ThreadGoalView | null = null;
  let entryId: string | undefined;
  const trace: string[] = [];
  const control = new ThreadGoalControl({
    read: async () => goal,
    set: async (_, status, objective) => {
      await scheduler.schedule(Promise.resolve(), `write ${status}`);
      trace.push(status);
      goal = {
        threadId, status, objective: objective ?? goal?.objective ?? "Fixture objective",
        updatedAt: trace.length, tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0,
      };
      return goal;
    },
    clear: async () => { goal = null; return true; },
    submit: async (_, entry) => { entryId = entry; return true; },
    cancel: () => undefined,
    hasWaitingMessages: () => false,
    assertCanActivate: async () => {
      if (trace.includes("gate")) throw new Error("Gate closed");
    },
    isAdmissionRefusal: () => false,
    publish: async () => undefined,
    warn: () => undefined,
  });
  return {
    control, trace, goal: () => goal, entry: () => entryId,
    nativeStart: async () => {
      await scheduler.schedule(Promise.resolve(), "owner turn admission");
      trace.push("admitted");
    },
    commitGate: async () => {
      await scheduler.schedule(Promise.resolve(), "gate commit");
      trace.push("gate");
      // Codex is free to continue as soon as the gate has committed.
      if (goal?.status === "active") trace.push("unadmitted");
    },
  };
}

describe("Codex goals and owner admission", () => {
  it("commits a gate only after Codex has independently acknowledged its pause", async () => {
    await fc.assert(fc.asyncProperty(
      fc.scheduler(),
      fc.constantFrom<ThreadGoalGate>("lock", "stop", "drift", "hibernate", "turn-control", "message"),
      async (scheduler, gate) => {
        const test = fixture(scheduler);
        await scheduler.waitFor(test.control.change({ threadId, action: "set", objective: "Fixture objective" }));
        await scheduler.waitFor(test.control.startAdmitted(threadId, test.entry(), test.nativeStart));
        expect(test.trace).toEqual(["paused", "admitted", "active"]);
        await scheduler.waitFor(test.control.withGate(threadId, gate, test.commitGate));
        expect(test.trace).toEqual(["paused", "admitted", "active", "paused", "gate"]);
        expect(test.goal()?.status).toBe("paused");
      },
    ), { numRuns: 25 });
  });

  it("serializes a standing gate with a racing queued activation", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.boolean(), async (scheduler, gateFirst) => {
      const test = fixture(scheduler);
      await scheduler.waitFor(test.control.change({ threadId, action: "set", objective: "Fixture objective" }));
      const start = () => test.control.startAdmitted(threadId, test.entry(), test.nativeStart).catch(() => undefined);
      const gate = () => test.control.withGate(threadId, "lock", test.commitGate);
      const operations = gateFirst ? [gate(), start()] : [start(), gate()];
      await scheduler.waitFor(Promise.all(operations));
      const gateIndex = test.trace.indexOf("gate");
      expect(test.trace.slice(gateIndex)).toEqual(["gate"]);
      expect(test.goal()?.status).toBe("paused");
    }), { numRuns: 25 });
  });

  it("preserves an unfinished goal when a different objective was confirmed", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom("clear", "set"), async (scheduler, action) => {
      const test = fixture(scheduler);
      await scheduler.waitFor(test.control.change({ threadId, action: "set", objective: "Fixture objective" }));
      const result = await scheduler.waitFor(test.control.change({
        threadId, action, objective: "New fixture objective", confirmedObjective: "Old fixture objective",
      }));
      expect(result.confirmationRequired).toBe(true);
      expect(test.goal()?.objective).toBe("Fixture objective");
      expect(test.trace).toEqual(["paused"]);
    }), { numRuns: 25 });
  });

  it("discards a withdrawn goal activation without holding the messages behind it", async () => {
    const identity = { backend: "codex" as const, threadId };
    const next = Promise.withResolvers<string>();
    let busy = true;
    const queue = new ThreadTurnQueue({
      isThreadActive: () => busy,
      startTurn: async (entry) => {
        if (entry.id === "goal") throw new ThreadTurnQueueDispatchCancelled("Goal activation was cancelled.");
        return { ...identity, turnId: "real-turn" };
      },
      onLifecycle: (event) => {
        if (event.type === "started") next.resolve(event.entry.id);
      },
    });
    try {
      await queue.submit({ ...identity, id: "goal", origin: "manual", input: [] });
      await queue.submit({ ...identity, id: "message", origin: "manual", input: [] });
      busy = false;
      queue.scheduleThreadDrain(identity);
      expect(await next.promise).toBe("message");
      expect([...queue.iterateQueuedEntries(identity)]).toEqual([]);
    } finally {
      queue.close();
    }
  });
});
