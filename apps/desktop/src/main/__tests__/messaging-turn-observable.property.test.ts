import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { messagingInboundHarness } from "./fixtures/messaging-inbound-harness";

// Oracle: the owning backend accepts inputs in arrival order, one active turn
// at a time. Provider deliveries and backend calls are the projection; this
// model never reads the controller's turn or drain collections.
describe("observable messaging turn and drain protocol", () => {
  it("starts queued inputs in FIFO order after terminal evidence and coalesces repeated evidence", async () => {
    type Model = { active: boolean; accepted: string[]; queued: string[]; next: number };
    type Real = Awaited<ReturnType<typeof messagingInboundHarness>>;
    const send = fc.constant(null).map(() => ({
      check: () => true,
      run: async (model: Model, real: Real) => {
        const text = `Fixture input ${++model.next}`;
        await real.controller.handleInboundEvent(real.event(text));
        if (model.active) model.queued.push(text);
        else { model.accepted.push(text); model.active = true; }
        expect(real.starts.map(start => start.input[0])).toEqual(model.accepted.map(text => ({ type: "text", text })));
      },
      toString: () => "send",
    }));
    const finish = fc.constantFrom("completed", "failed", "cancelled").map(terminal => ({
      check: (model: Model) => model.active,
      run: async (model: Model, real: Real) => {
        // Re-delivery occurs before the released drain's next macrotask, as
        // with terminal + idle notifications from one provider completion.
        const turnId = `fixture-turn-${model.accepted.length}`;
        const first = real.finish(terminal, turnId);
        const repeated = real.controller.handleBackendEvent({ backend: real.starts[0]!.backend, notification: terminal === "failed" ? {
          method: "turn/failed", params: { threadId: "fixture-thread", turnId, turn: { id: turnId, status: "failed", error: { message: "Fixture terminal failure" } } },
        } : { method: "turn/completed", params: {
            threadId: "fixture-thread", turnId, turn: { id: turnId, status: terminal, output: [] },
          } } });
        await Promise.all([first, repeated]);
        await real.controller.whenQueuedTurnDrainsSettled();
        const next = model.queued.shift();
        if (next) model.accepted.push(next);
        else model.active = false;
        expect(real.starts.map(start => start.input[0])).toEqual(model.accepted.map(text => ({ type: "text", text })));
      },
      toString: () => `terminal(${terminal},repeat)`,
    }));
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.constantFrom("codex", "claude"),
      fc.commands([send, finish], { maxCommands: 12, size: "max" }), async (channel, backend, commands) => {
        const real = await messagingInboundHarness({ channel, backend, ownsQueue: false });
        try { await fc.asyncModelRun(() => ({ model: { active: false, accepted: [], queued: [], next: 0 }, real }), commands); }
        finally { await real.close(); }
      }), { numRuns: 25 });
  });

  it("settles a running drain after backend acceptance and notice retirement, including disposal", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.boolean(), fc.constantFrom("started", "failed"), async (scheduler, dispose, outcome) => {
      const real = await messagingInboundHarness({ ownsQueue: false });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let terminal: Promise<void> | undefined;
      try {
        await real.controller.handleInboundEvent(real.event("first"));
        await real.controller.handleInboundEvent(real.event("second"));
        real.hooks.outcome = outcome;
        real.hooks.start = async () => { entered.resolve(); await scheduler.schedule(release.promise, "queued acceptance"); };
        terminal = real.finish("completed");
        await entered.promise;
        let settled = false;
        const draining = real.controller.whenQueuedTurnDrainsSettled().then(() => { settled = true; });
        await setImmediate();
        expect(settled).toBe(false);
        expect(real.deliveries.some(intent => intent.kind === "confirmation" && intent.body === "Queued message sent as the next turn.")).toBe(false);
        if (dispose) real.controller.dispose();
        release.resolve(); await scheduler.waitAll(); await terminal; await draining;
        expect(real.starts).toHaveLength(2);
        // Shutdown closes the delivery boundary, while an already issued
        // backend start and the drain's settlement still finish normally.
        expect(real.deliveries.some(intent => intent.kind === "confirmation" && intent.body === "Queued message sent as the next turn.")).toBe(!dispose && outcome === "started");
        expect(real.deliveries.some(intent => intent.kind === "error" && intent.title === "Turn could not start")).toBe(!dispose && outcome === "failed");
      } finally { release.resolve(); await scheduler.waitAll(); await terminal; await real.close(); }
    }), { numRuns: 25 });
  });

  it("cancels an armed drain at shutdown without submitting queued input", async () => {
    const real = await messagingInboundHarness({ ownsQueue: false });
    try {
      await real.controller.handleInboundEvent(real.event("first"));
      await real.controller.handleInboundEvent(real.event("second"));
      real.setThreadStatus("idle");
      const admissions = real.admissions.length;
      await real.controller.handleBackendEvent({ backend: "codex", notification: { method: "turn/completed", params: {
        threadId: "fixture-thread", turnId: "fixture-turn-1", turn: { id: "fixture-turn-1", status: "completed", output: [] },
      } } });
      expect(real.admissions).toHaveLength(admissions);
      const draining = real.controller.whenQueuedTurnDrainsSettled();
      real.controller.dispose();
      await draining; await setImmediate();
      expect(real.starts).toHaveLength(1);
    } finally { await real.close(); }
  });
});
