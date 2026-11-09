import fc from "fast-check";
import { expect, it } from "vitest";
import { ThreadTurnQueue } from "../thread-turn-queue";

const THREAD = { backend: "codex" as const, threadId: "terminal-publication" };
const drain = async () => await new Promise<void>(resolve => setImmediate(resolve));

async function cancelDuringTerminal(count: number, cancelled: number): Promise<void> {
  const sends: string[] = [];
  const observed = new Map<string, boolean>();
  let armed = false;
  const queue = new ThreadTurnQueue({
    startTurn: async entry => { sends.push(entry.id); return { ...THREAD, turnId: entry.id }; },
    onLifecycle: async event => {
      if (event.type === "queued" || event.type === "held") observed.set(event.entry.id, event.entry.manualReleaseRequired === true);
      if (event.type === "cancelled" || event.type === "started") observed.delete(event.entry.id);
      if (armed && event.type === "terminal" && event.entry.id === "owner") {
        armed = false;
        expect(queue.cancelEntryWithDisposition(`waiting-${cancelled}`).disposition).toBe("cancelled");
        await drain();
      }
    },
  });
  try {
    await queue.submit({ ...THREAD, id: "owner", origin: "manual", input: [] });
    for (let index = 0; index < count; index++) await queue.submit({ ...THREAD, id: `waiting-${index}`,
      origin: "manual", input: [{ type: "text", text: `Accepted input ${index}` }] });
    armed = true;
    await queue.releaseThread({ ...THREAD, turnId: "owner", status: "turn/failed", errorMessage: "review required" });
    await drain();
    // Retiring a running entry and cancelling waiting input grant no review
    // permission to any surviving accepted input, even while events await.
    expect(sends).toEqual(["owner"]);
    const waiting = queue.getQueuedEntries(THREAD);
    expect(waiting.map(entry => entry.id)).toEqual(Array.from({ length: count }, (_, index) => `waiting-${index}`).filter((_, index) => index !== cancelled));
    expect(waiting.every(entry => entry.manualReleaseRequired && entry.holdReason === "review required")).toBe(true);
    expect([...observed.entries()].sort()).toEqual(waiting.map(entry => [entry.id, true]).sort());
    for (const entry of waiting) expect(entry.input).toEqual([{ type: "text", text: `Accepted input ${entry.id.slice(8)}` }]);
    expect((await queue.releaseEntryWithDisposition(waiting[0]!.id)).disposition).toBe("started");
    expect(sends).toEqual(["owner", waiting[0]!.id]);
  } finally { queue.close(); }
}

it("tracked terminal publication preserves failure review across waiting-entry cancellation", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), fc.nat(), async (count, offset) => {
    await cancelDuringTerminal(count, offset % (count - 1));
  }));
});

it("cancelling older during the running owner's failed terminal leaves next waiting for Retry", async () => {
  await cancelDuringTerminal(2, 0);
});
