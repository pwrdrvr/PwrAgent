import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { messagingInboundHarness } from "./fixtures/messaging-inbound-harness";

// Kept separate from the extraction oracle: this is a suspected production
// counterexample, not baseline behavior that the refactor should preserve.
describe("messaging terminal evidence before start acknowledgement", () => {
  it("keeps a completed fast turn idle when its start reply arrives last", async () => {
    const real = await messagingInboundHarness({ ownsQueue: false });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let pending: Promise<void> | undefined;
    try {
      real.hooks.start = async () => { entered.resolve(); await release.promise; };
      pending = real.controller.handleInboundEvent(real.event("Fixture fast completion"));
      await entered.promise;
      await real.finish("completed", "fixture-turn-1");
      const boundary = real.deliveries.length;
      release.resolve(); await pending;
      expect(real.deliveries.slice(boundary).filter(intent => intent.kind === "activity" && intent.state === "active")).toEqual([]);
      expect(real.trace).toContain("started:reported");
    } finally { release.resolve(); await pending; await real.close(); }
  });

  it("never re-arms typing for a turn whose terminal notification already arrived", async () => {
    await fc.assert(fc.asyncProperty(fc.scheduler(), fc.constantFrom("completed", "failed", "cancelled"), async (scheduler, terminal) => {
      const real = await messagingInboundHarness({ ownsQueue: false });
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let pending: Promise<void> | undefined;
      try {
        real.hooks.start = async () => { entered.resolve(); await scheduler.schedule(release.promise, "late start acceptance"); };
        pending = real.controller.handleInboundEvent(real.event("Fixture fast turn"));
        await entered.promise;
        await real.finish(terminal, "fixture-turn-1");
        const terminalBoundary = real.deliveries.length;
        release.resolve(); await scheduler.waitAll(); await pending;
        expect(real.deliveries.slice(terminalBoundary).filter(intent => intent.kind === "activity" && intent.state === "active")).toEqual([]);
        expect(real.trace).toContain("started:reported");
      } finally { release.resolve(); await scheduler.waitAll(); await pending; await real.close(); }
    }), { numRuns: 25 });
  });
});
