import fc from "fast-check";
import { expect, it } from "vitest";
import { ThreadTurnQueue } from "../thread-turn-queue";

const THREAD = { backend: "codex" as const, threadId: "held-identity" };
const input = (text: string) => [{ type: "text" as const, text }];

it("a held admission cannot claim an ordinary acceptance even when its FIFO is already held", async () => {
  await fc.assert(fc.asyncProperty(fc.string({ maxLength: 30 }), fc.boolean(), async (suffix, heldFifo) => {
    const events: string[] = [];
    const queue = new ThreadTurnQueue({ isThreadActive: () => true,
      startTurn: async entry => ({ ...entry, turnId: "unused" }), onLifecycle: event => { events.push(event.type); } });
    const entry = { ...THREAD, id: "same", origin: "manual" as const, input: input(`Accepted ${suffix}`) };
    try {
      if (heldFifo) await queue.submitHeld({ ...THREAD, id: "review", origin: "scheduled", input: input("Review") }, "Review required");
      await queue.submit(entry);
      const before = structuredClone(queue.getQueuedEntries(THREAD));
      const offset = events.length;
      await expect(queue.submitHeld({ ...entry, origin: "scheduled" }, "Scheduled review required")).rejects.toThrow(/reused|identity/);
      expect(queue.getQueuedEntries(THREAD)).toEqual(before);
      expect(events.slice(offset)).toEqual([]);
    } finally { queue.close(); }
  }));
});
