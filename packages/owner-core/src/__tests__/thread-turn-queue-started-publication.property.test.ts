import fc from "fast-check";
import { expect, it } from "vitest";
import { ThreadTurnQueue } from "../thread-turn-queue";

const THREAD = { backend: "codex" as const, threadId: "started-publication" };
const drain = async () => await new Promise<void>(resolve => setImmediate(resolve));

async function acceptedPublication(steer: boolean, count: number): Promise<void> {
  const sent: string[] = [];
  const projected = new Set<string>();
  let active = true, dispatchHeld = true;
  const queue = new ThreadTurnQueue({
    isThreadActive: () => active,
    isDispatchHeld: () => dispatchHeld,
    canSteerThread: () => steer && active,
    startTurn: async entry => {
      sent.push(entry.id);
      active = true;
      return { ...THREAD, turnId: "native" };
    },
    steerTurn: async entry => {
      sent.push(entry.id);
      return { ...THREAD, turnId: "native" };
    },
    onLifecycle: event => {
      if (event.type === "queued" || event.type === "held") projected.add(event.entry.id);
      if (event.type === "started" || event.type === "cancelled") projected.delete(event.entry.id);
      if (event.type === "started" && event.entry.id === "accepted") throw new Error("Started publication rejected");
    },
  });
  try {
    const submit = steer ? queue.submitSteer.bind(queue) : queue.submit.bind(queue);
    await submit({ ...THREAD, id: "accepted", origin: "manual", input: [{ type: "text", text: "Immutable accepted input" }] });
    for (let index = 0; index < count; index++) await queue.submit({ ...THREAD, id: `next-${index}`, origin: "manual", input: [] });
    active = steer;
    dispatchHeld = false;
    await queue.releaseThread(THREAD);
    await drain();
    // The native acknowledgement is the oracle. A rejected publication cannot
    // turn that accepted identity into waiting input or a refused-start hold.
    expect(sent).toEqual(["accepted"]);
    expect(queue.getQueuedEntries(THREAD).map(entry => entry.id)).toEqual(Array.from({ length: count }, (_, i) => `next-${i}`));
    expect(queue.getQueuedEntries(THREAD).some(entry => entry.manualReleaseRequired)).toBe(false);
    expect([...projected]).toEqual(Array.from({ length: count }, (_, i) => `next-${i}`));
    expect(queue.cancelEntryWithDisposition("accepted")).toMatchObject({ disposition: "already_admitted", turnId: "native" });
    queue.close();
    active = false;
    await queue.releaseThread({ ...THREAD, turnId: "native", status: "turn/completed" });
    await drain();
    expect(sent).toEqual(["accepted"]);
    expect(queue.getQueuedEntries(THREAD).map(entry => entry.id)).toEqual(Array.from({ length: count }, (_, i) => `next-${i}`));
  } finally { queue.close(); }
}

it("native acceptance never returns to waiting input after started publication rejects", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.integer({ min: 1, max: 6 }), acceptedPublication));
});

it.each([false, true])("accepted start/steer survives its rejected started publication (steer=%s)", async steer => {
  await acceptedPublication(steer, 1);
});
