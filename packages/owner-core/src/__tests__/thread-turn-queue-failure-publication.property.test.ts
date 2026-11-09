import fc from "fast-check";
import { expect, it } from "vitest";
import { ThreadTurnQueue } from "../thread-turn-queue";

const THREAD = { backend: "codex" as const, threadId: "failure-publication" };
const drain = async () => await new Promise<void>(resolve => setImmediate(resolve));

async function cancelDuringFailure(count: number, publication: number): Promise<void> {
  const sends: string[] = [];
  const observed = new Map<string, boolean>();
  let active = true, armed = false, published = 0;
  const queue = new ThreadTurnQueue({
    isThreadActive: () => active,
    startTurn: async entry => { sends.push(entry.id); return { ...THREAD, turnId: entry.id }; },
    onLifecycle: async event => {
      if (event.type === "queued" || event.type === "held") observed.set(event.entry.id, event.entry.manualReleaseRequired === true);
      if (event.type === "cancelled") observed.delete(event.entry.id);
      if (armed && event.type === "held" && published++ === publication) {
        armed = false;
        expect(queue.cancelEntryWithDisposition(event.entry.id).disposition).toBe("cancelled");
        await drain();
      }
    },
  });
  try {
    for (let index = 0; index < count; index++) await queue.submit({ ...THREAD, id: `waiting-${index}`, origin: "manual", input: [{ type: "text", text: `Accepted input ${index}` }] });
    armed = true;
    const failure = queue.releaseThread({ ...THREAD, turnId: "prior-native", status: "turn/failed", errorMessage: "review required" });
    active = false;
    await failure;
    await drain();
    // A failure holds every waiting input before observers can cancel a
    // published row. Cancellation is no permission to send its successor.
    expect(sends).toEqual([]);
    const waiting = queue.getQueuedEntries(THREAD);
    expect(waiting.map(entry => entry.id)).toEqual(Array.from({ length: count }, (_, index) => `waiting-${index}`).filter((_, index) => index !== publication));
    expect(waiting.every(entry => entry.manualReleaseRequired && entry.holdReason === "review required")).toBe(true);
    expect([...observed.entries()].sort()).toEqual(waiting.map(entry => [entry.id, true]).sort());
    expect((await queue.releaseEntryWithDisposition(waiting[0]!.id)).disposition).toBe("started");
    expect(sends).toEqual([waiting[0]!.id]);
  } finally { queue.close(); }
}

it("failure publication never lets cancellation skip an unreviewed successor", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), fc.nat(), async (count, offset) => {
    await cancelDuringFailure(count, offset % (count - 1));
  }));
});

it("cancelling the first published failure hold leaves the next accepted input waiting for Retry", async () => {
  await cancelDuringFailure(2, 0);
});
