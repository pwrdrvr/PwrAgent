import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ThreadGoalView } from "@pwragent/shared/contracts/thread-goal";
import { ThreadGoalControl, type ThreadGoalGate } from "../app-server/thread-goal-control";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import {
  ThreadTurnQueue,
  ThreadTurnQueueDispatchCancelled,
  type ThreadTurnQueueLifecycleEvent,
  type ThreadTurnQueueReleaseResult,
} from "@pwragent/owner-core/thread-turn-queue";

const threadId = "thread";

function fixture(scheduler: fc.Scheduler, options: {
  initialGoal?: ThreadGoalView;
  failPause?: boolean;
  retry?: (entryId: string) => Promise<ThreadTurnQueueReleaseResult>;
} = {}) {
  const { initialGoal = null, failPause, retry } = options;
  let goal = initialGoal;
  let entryId: string | undefined;
  const trace: string[] = [];
  const control = new ThreadGoalControl({
    read: async () => goal,
    set: async (_, status, objective) => {
      await scheduler.schedule(Promise.resolve(), `write ${status}`);
      trace.push(status);
      if (failPause && status === "paused") throw new Error("Goal pause failed");
      goal = {
        threadId, status, objective: objective ?? goal?.objective ?? "Fixture objective",
        updatedAt: trace.length, tokenBudget: goal?.tokenBudget ?? null,
        tokensUsed: goal?.tokensUsed ?? 0, timeUsedSeconds: goal?.timeUsedSeconds ?? 0,
      };
      return goal;
    },
    clear: async () => { goal = null; return true; },
    submit: async (_, entry) => { entryId = entry; return true; },
    cancel: () => { entryId = undefined; },
    retry: retry ?? (async (entryId) => ({ disposition: "not_found", entryId })),
    hasWaitingMessages: () => false,
    assertCanActivate: async () => {
      if (trace.includes("gate")) throw new Error("Gate closed");
    },
    isAdmissionRefusal: () => false,
    publish: async () => undefined,
    warn: (_, message) => { trace.push(message); },
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

const savedGoal: ThreadGoalView = {
  threadId, objective: "Finish the billing export", status: "active", tokenBudget: 1200,
  tokensUsed: 400, timeUsedSeconds: 90, updatedAt: 0,
};

describe("Codex goals and owner admission", () => {
  it("keeps an internal activation out of both queue projections and reports its hold on the goal", async () => {
    const scheduler = fc.schedulerFor([1, 2, 3]);
    const identity = { backend: "codex" as const, threadId };
    const registry = Object.create(DesktopBackendRegistry.prototype) as DesktopBackendRegistry;
    type LifecycleSink = { emitTurnQueueLifecycle: (event: ThreadTurnQueueLifecycleEvent) => Promise<void> };
    const lifecycle = registry as unknown as LifecycleSink;
    let busy = true;
    const test = fixture(scheduler, { retry: (entryId) => queue.releaseEntryWithDisposition(entryId) });
    const queue = new ThreadTurnQueue({
      isThreadActive: () => busy,
      startTurn: (entry) => test.control.startAdmitted(threadId, entry.id, async () => {
        await test.nativeStart();
        return { ...identity, turnId: "goal-turn" };
      }),
      onLifecycle: async (event) => {
        if (event.entry.id === test.entry()) await lifecycle.emitTurnQueueLifecycle(event);
      },
    });
    Object.assign(registry, { threadTurnQueue: queue, threadGoals: test.control });
    try {
      await scheduler.waitFor(test.control.change({ threadId, action: "set", objective: "Check the billing export" }));
      await queue.submit({ ...identity, id: test.entry()!, origin: "manual", input: [] });
      await queue.submit({ ...identity, id: "message", origin: "manual", input: [] });
      await queue.releaseThread({ ...identity, status: "turn/failed", errorMessage: "Check the previous turn" });
      const current = await test.control.change({ threadId, action: "read" });
      // Read the hold and both projections before asserting, so the oracle covers all views.
      expect({
        hold: current.activationHoldReason,
        rows: [...registry.iterateQueuedTurnSummaries(identity)].map((entry) => entry.queueEntryId),
        snapshot: Object.values(registry.getQueuedTurnsSnapshot()).flat().map((entry) => entry.queueEntryId),
      }).toEqual({ hold: "Check the previous turn", rows: ["message"], snapshot: ["message"] });
      queue.cancelEntry("message");
      busy = false;
      const retried = await scheduler.waitFor(test.control.change({ threadId, action: "resume" }));
      expect(retried.activationHoldReason).toBeUndefined();
      expect(retried.activationQueued).toBeUndefined();
      expect(test.trace).toEqual(["paused", "admitted", "active"]);
    } finally {
      queue.close();
    }
  });

  it("reports waiting input only if the FIFO can choose an entry that the operator has not paused", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { maxLength: 8 }), async (paused) => {
      const identity = { backend: "codex" as const, threadId };
      const queue = new ThreadTurnQueue({
        isThreadActive: () => true,
        startTurn: async () => { throw new Error("The fixture thread is busy"); },
      });
      try {
        for (const [index, pause] of paused.entries()) {
          const id = `message-${index}`;
          await queue.submit({ ...identity, id, origin: "manual", input: [] });
          if (pause) await queue.setEntryPaused(id, true);
        }
        expect(queue.hasWaitingEntries(identity)).toBe(paused.includes(false));
      } finally {
        queue.close();
      }
    }));
  });
  it("resolves persisted state on a cold lock and commits only on a confirmed pause", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.boolean(), async (scheduler, failPause) => {
      const test = fixture(scheduler, { initialGoal: savedGoal, failPause });
      const result = await scheduler.waitFor(test.control.withGate(threadId, "lock", test.commitGate)
        .then(() => "locked", () => "refused"));
      expect(result).toBe(failPause ? "refused" : "locked");
      expect(test.trace).toEqual(failPause ? ["paused"] : ["paused", "gate"]);
    }));
  });

  it("attempts the interrupt on both pause outcomes and warns only after a failed pause", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.boolean(), async (scheduler, failPause) => {
      const test = fixture(scheduler, { initialGoal: savedGoal, failPause });
      test.control.observe(threadId, savedGoal);
      await scheduler.waitFor(test.control.withGate(threadId, "stop", async () => { test.trace.push("interrupt"); }));
      expect(test.trace[0]).toBe("paused");
      expect(test.trace.filter((step) => step === "interrupt")).toEqual(["interrupt"]);
      expect(test.trace.some((step) => step.includes("Goal pause failed"))).toBe(failPause);
    }));
  });

  it("cancelling queued Resume preserves the paused objective and its usage", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.nat(), fc.nat(), async (scheduler, tokensUsed, timeUsedSeconds) => {
      const initial = { ...savedGoal, status: "paused" as const, tokensUsed, timeUsedSeconds };
      const test = fixture(scheduler, { initialGoal: initial });
      const queued = await scheduler.waitFor(test.control.change({ threadId, action: "resume" }));
      expect(queued.activationQueued).toBe(true);
      const after = await scheduler.waitFor(test.control.change({ threadId, action: "cancel" }));
      expect(after.activationQueued).toBeUndefined();
      expect(test.entry()).toBeUndefined();
      expect(after.goal).toEqual({ ...initial, updatedAt: 1 });
      expect(test.goal()).toEqual(after.goal);
    }));
  });
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
