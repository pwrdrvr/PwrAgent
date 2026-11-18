import { setImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { messagingCanonicalQueueHarness } from "./fixtures/messaging-canonical-queue-harness";

// Activity projection cannot admit work. Owner acceptance and release are
// separate observable boundaries, even when provider evidence is redelivered.
describe("observable messaging and owner turn protocol", () => {
  it("leaves draining to the owner under stale and repeated bus evidence", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.integer({ min: 1, max: 4 }), async (channel, repeats) => {
      const real = await messagingCanonicalQueueHarness({ channel });
      try {
        await real.controller.handleInboundEvent(real.event("first"));
        expect(real.starts).toHaveLength(1);
        await real.controller.handleInboundEvent(real.event("second"));
        for (let index = 0; index < repeats; index++) {
          await real.controller.handleBackendEvent({ backend: "codex", notification: { method: "turn/completed", params: {
            threadId: "fixture-thread", turnId: "old-turn", turn: { id: "old-turn", status: "completed", output: [] },
          } } });
          await real.controller.handleBackendEvent({ backend: "codex", notification: { method: "thread/status/changed", params: {
            threadId: "fixture-thread", status: { type: "idle" },
          } } });
        }
        await setImmediate();
        expect(real.starts).toHaveLength(1);
        expect(real.queued().map(entry => entry.input)).toEqual([[{ type: "text", text: "second" }]]);
        await real.finishOwner("completed");
        expect(real.starts).toHaveLength(2);
      } finally { await real.close(); }
    }), { numRuns: 25 });
  });

  it("keeps bus delivery independent of an owner dispatch acknowledgement, including messaging shutdown", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.boolean(), fc.constantFrom("started", "failed"), async (scheduler, dispose, outcome) => {
      const real = await messagingCanonicalQueueHarness();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let terminal: Promise<void> | undefined;
      try {
        await real.controller.handleInboundEvent(real.event("first"));
        expect(real.starts).toHaveLength(1);
        await real.controller.handleInboundEvent(real.event("second"));
        real.hooks.outcome = outcome;
        real.hooks.start = async () => { entered.resolve(); await scheduler.schedule(release.promise, "owner native acknowledgement"); };
        terminal = real.finishOwner("completed");
        await entered.promise;
        await real.controller.handleBackendEvent({ backend: "codex", notification: { method: "thread/status/changed", params: {
          threadId: "fixture-thread", status: { type: "idle" },
        } } });
        expect(real.starts).toHaveLength(2);
        expect(real.trace.filter(event => event === "start:accepted")).toHaveLength(1);
        if (dispose) real.controller.dispose();
        release.resolve(); await scheduler.waitAll(); await terminal;
        expect(real.trace.filter(event => event === "start:accepted")).toHaveLength(outcome === "started" ? 2 : 1);
        if (outcome === "started") expect(real.queued()).toEqual([]);
        else expect(real.queued()).toEqual([expect.objectContaining({ manualReleaseRequired: true, holdReason: "Fixture startup failure" })]);
      } finally { release.resolve(); await scheduler.waitAll(); await terminal; await real.close(); }
    }), { numRuns: 25 });
  });

  it("does not dispatch waiting input after the owner shuts down", async () => {
    const real = await messagingCanonicalQueueHarness();
    try {
      await real.controller.handleInboundEvent(real.event("first"));
        expect(real.starts).toHaveLength(1);
      await real.controller.handleInboundEvent(real.event("second"));
      real.owner.close(); real.controller.dispose();
      await real.finishOwner("completed"); await setImmediate();
      expect(real.starts).toHaveLength(1);
      expect(real.queued().map(entry => entry.input)).toEqual([[{ type: "text", text: "second" }]]);
    } finally { await real.close(); }
  });
});
