import fc from "fast-check";
import { expect, it } from "vitest";
import { ThreadTurnQueue } from "../thread-turn-queue";

const THREAD = { backend: "codex" as const, threadId: "refused-publication" };
const drain = async () => await new Promise<void>(resolve => setImmediate(resolve));

async function cancelRefused(count: number): Promise<void> {
  const sends: string[] = [];
  const observed = new Map<string, boolean>();
  let active = true;
  const queue = new ThreadTurnQueue({
    isThreadActive: () => active,
    startTurn: async entry => {
      if (entry.id === "refused") throw new Error("Provider refused submission");
      sends.push(entry.id);
      return { ...THREAD, turnId: entry.id };
    },
    onLifecycle: async event => {
      if (event.type === "queued" || event.type === "held") observed.set(event.entry.id, event.entry.manualReleaseRequired === true);
      if (event.type === "cancelled" || event.type === "started") observed.delete(event.entry.id);
      if (event.type === "blocked") {
        expect(queue.cancelEntryWithDisposition("refused").disposition).toBe("cancelled");
        await drain();
      }
    },
  });
  try {
    await queue.submit({ ...THREAD, id: "refused", origin: "manual", input: [{ type: "text", text: "Original refused input" }] });
    for (let index = 0; index < count; index++) await queue.submit({ ...THREAD, id: `waiting-${index}`, origin: "manual",
      input: [{ type: "text", text: `Original waiting input ${index}` }] });
    active = false;
    await queue.releaseThread(THREAD);
    await drain();
    // Cancelling the refused request answers no review of other accepted input.
    expect(sends).toEqual([]);
    const waiting = queue.getQueuedEntries(THREAD);
    expect(waiting.map(entry => entry.id)).toEqual(Array.from({ length: count }, (_, index) => `waiting-${index}`));
    expect(waiting.every(entry => entry.manualReleaseRequired && entry.holdReason === "Provider refused submission")).toBe(true);
    expect([...observed.entries()].sort()).toEqual(waiting.map(entry => [entry.id, true]).sort());
    for (const [index, entry] of waiting.entries()) expect(entry.input).toEqual([{ type: "text", text: `Original waiting input ${index}` }]);
    expect((await queue.releaseEntryWithDisposition("waiting-0")).disposition).toBe("started");
    expect(sends).toEqual(["waiting-0"]);
  } finally { queue.close(); }
}

it("refused-start publication covers every waiting input before cancellation can drain it", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 8 }), cancelRefused));
});

it("cancelling only a refused head cannot send its unreviewed successor", async () => {
  await cancelRefused(1);
});
