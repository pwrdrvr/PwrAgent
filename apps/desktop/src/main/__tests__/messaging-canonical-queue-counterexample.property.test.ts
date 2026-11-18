import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { messagingCanonicalQueueHarness } from "./fixtures/messaging-canonical-queue-harness";

// Separate from baseline preservation: an accepted queued answer must belong
// to the same owner FIFO visible to desktop viewers, not only to messaging.
describe("async-question queue owner counterexample", () => {
  it("reports questionnaire submission only after its owner accepts the reply", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.boolean(), async (channel, accepted) => {
      const real = await messagingCanonicalQueueHarness({ channel });
      try {
        await real.controller.handleInboundEvent(real.event("first"));
        real.queueHooks.steer = async () => { throw new Error("Fixture steer unavailable"); };
        await real.controller.handleBackendEvent({ backend: "codex", notification: { method: "item/completed", params: {
          threadId: "fixture-thread", turnId: "fixture-turn-1", item: {
            id: "fixture-question", type: "agentMessage", phase: "final_answer", text: "Fixture question?", delivery: "async",
            questions: [{ title: "Fixture question?", options: null }],
          },
        } } });
        if (!accepted) real.queueHooks.admit = async () => { throw new Error("Fixture owner refusal"); };
        await real.controller.handleInboundEvent(real.event("Fixture answer"));
        const card = real.deliveries.filter(intent => intent.kind === "questionnaire").at(-1);
        if (accepted) {
          expect(card).toMatchObject({ phase: "submitted" });
          expect(real.queued()[0]?.input).toEqual([{ type: "text", text: expect.stringContaining("Fixture answer") }]);
        } else expect(card).not.toMatchObject({ phase: "submitted" });
        expect(real.queued()).toHaveLength(accepted ? 1 : 0);
        expect(await real.store.findActivePendingAsyncQuestionnaires({ backend: "codex", threadId: "fixture-thread", now: real.controllerOptions.now!() }))
          .toHaveLength(accepted ? 0 : 1);
      } finally { await real.close(); }
    }), { numRuns: 25 });
  });

  it("does not announce queue acceptance when the owner refuses a concurrent start", async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom("telegram", "discord"), fc.boolean(), async (channel, ownsQueueFlag) => {
      const real = await messagingCanonicalQueueHarness({ channel, ownsQueueFlag });
      try {
        real.queueHooks.admit = async () => { throw new Error("thread already has an active turn in progress"); };
        await real.controller.handleInboundEvent(real.event("Fixture refused input"));
        expect(real.queued()).toEqual([]);
        expect(real.deliveries).not.toContainEqual(expect.objectContaining({ title: "Message queued" }));
        expect(real.deliveries).toContainEqual(expect.objectContaining({ title: "Turn could not start" }));
      } finally { await real.close(); }
    }), { numRuns: 25 });
  });
});
