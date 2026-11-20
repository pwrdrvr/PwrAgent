import { expect, it, vi } from "vitest";
import fc from "fast-check";
import type { MessagingBindingRecord, MessagingDeliveryResult, MessagingSurfaceRef } from "@pwragent/messaging-interface";
import { MessagingAssistantStreams } from "../messaging/core/messaging-assistant-streams";

const binding: MessagingBindingRecord = {
  id: "fixture-binding", channel: { channel: "telegram", conversation: { id: "fixture-conversation", kind: "dm" } },
  backend: "codex", threadId: "fixture-thread", authorizedActorIds: ["fixture-actor"], createdAt: 1, updatedAt: 1,
};
const anchor = { channel: "telegram", id: "stream-message" } satisfies MessagingSurfaceRef;

it("cancels an in-flight stream, owns the late surface once and returns the dismissal outcome", async () => {
  await fc.assert(fc.asyncProperty(fc.scheduler(), fc.boolean(), async (scheduler, dismissSucceeds) => {
    const entered = Promise.withResolvers<void>();
    let now = 1_000;
    const dismiss = vi.fn(async () => dismissSucceeds);
    const streams = new MessagingAssistantStreams({
      now: () => now,
      streamingResponsesDefault: true,
      host: {
        isTerminalPrivateResponseTurn: () => false,
        turnProseKey: (bindingId, turnId) => `${bindingId}:${turnId}`,
        deliverAssistantMessage: async () => { expect.fail("Unexpected plain message"); },
        responseAttributionForBinding: async () => ({ label: "Fixture" }),
        newIntentId: prefix => prefix,
        dismissTerminalPrivateResponseSurface: dismiss,
        keepsReplyReceipts: () => false,
        deliver: async (_intent, _binding, _event, guard) => {
          expect(guard?.isCancelled()).toBe(false);
          entered.resolve();
          const result = await scheduler.schedule(Promise.resolve({
            channel: "telegram", deliveredAt: now, outcome: "presented", surface: anchor,
          } satisfies MessagingDeliveryResult), "adapter creates the surface");
          expect(guard?.isCancelled()).toBe(true);
          return result;
        },
      },
    });
    const delta = { delta: "hello", streamKey: "codex:stream", itemId: "item", turnId: "turn", threadId: binding.threadId };
    await streams.deliverAssistantStreamUpdate(delta, binding);
    now += 30_000;
    const delivery = streams.deliverAssistantStreamUpdate(delta, binding);
    let cancellation: Promise<boolean> | undefined;
    try {
      await Promise.race([entered.promise, delivery.then(() => expect.fail("Expected a held delivery"))]);
      cancellation = streams.cancelAssistantStreamsForTurn(binding, "turn");
      expect(dismiss).not.toHaveBeenCalled();
      await scheduler.waitAll();
      await delivery;
      expect(await cancellation).toBe(dismissSucceeds);
      expect(dismiss).toHaveBeenCalledExactlyOnceWith(binding, "turn", anchor);
    } finally {
      await scheduler.waitAll();
      await Promise.allSettled([delivery, cancellation]);
      streams.dispose();
    }
  }), { numRuns: 25 });
});
