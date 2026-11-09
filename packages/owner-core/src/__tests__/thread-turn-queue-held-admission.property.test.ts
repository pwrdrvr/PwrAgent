import fc from "fast-check";
import { expect, it } from "vitest";
import { ThreadTurnQueue } from "../thread-turn-queue";

const THREAD = { backend: "codex" as const, threadId: "held-admission" };
const drain = async () => await new Promise<void>(resolve => setImmediate(resolve));

async function cancelReview(count: number): Promise<void> {
  const sends: string[] = [];
  const observed = new Map<string, boolean>();
  let active = true;
  const queue = new ThreadTurnQueue({
    isThreadActive: () => active,
    startTurn: async entry => { sends.push(entry.id); return { ...THREAD, turnId: entry.id }; },
    onLifecycle: async event => {
      if (event.type === "queued" || event.type === "held") observed.set(event.entry.id, event.entry.manualReleaseRequired === true);
      if (event.type === "cancelled" || event.type === "started") observed.delete(event.entry.id);
      if (event.type === "queued" && event.entry.id === "review") {
        expect(queue.cancelEntryWithDisposition("review").disposition).toBe("cancelled");
        await drain();
      }
    },
  });
  try {
    for (let index = 0; index < count; index++) await queue.submit({ ...THREAD, id: `waiting-${index}`, origin: "manual",
      input: [{ type: "text", text: `Accepted input ${index}` }] });
    active = false;
    await queue.submitHeld({ ...THREAD, id: "review", origin: "scheduled", input: [] }, "Target turn ended; review required");
    await drain();
    // Admitting review holds every pre-existing input. Cancelling only that
    // new row grants no permission to dispatch any of those accepted inputs.
    expect(sends).toEqual([]);
    const waiting = queue.getQueuedEntries(THREAD);
    expect(waiting.map(entry => entry.id)).toEqual(Array.from({ length: count }, (_, index) => `waiting-${index}`));
    expect(waiting.every(entry => entry.manualReleaseRequired && entry.holdReason === "Target turn ended; review required")).toBe(true);
    expect([...observed.entries()].sort()).toEqual(waiting.map(entry => [entry.id, true]).sort());
    for (const [index, entry] of waiting.entries()) expect(entry.input).toEqual([{ type: "text", text: `Accepted input ${index}` }]);
    expect((await queue.releaseEntryWithDisposition("waiting-0")).disposition).toBe("started");
    expect(sends).toEqual(["waiting-0"]);
  } finally { queue.close(); }
}

it("held admission covers all pre-existing input before cancellation can drain its FIFO", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), cancelReview));
});

it("cancelling only the target-ended review row leaves older and next waiting for Retry", async () => {
  await cancelReview(2);
});
