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

it("held admission preserves causes and event projection through simultaneous controls and close", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), fc.nat(),
    fc.constantFrom("controls", "independent", "close", "reject"), async (count, offset, action) => {
      const sends: string[] = [];
      const observed = new Map<string, boolean>();
      let active = true, armed = true;
      const queue = new ThreadTurnQueue({
        isThreadActive: () => active,
        startTurn: async entry => { sends.push(entry.id); return { ...THREAD, turnId: entry.id }; },
        onLifecycle: async event => {
          if (event.type === "queued" || event.type === "held") observed.set(event.entry.id, event.entry.manualReleaseRequired === true);
          if (event.type === "cancelled" || event.type === "started") observed.delete(event.entry.id);
          if (!armed || event.type !== "queued" || event.entry.id !== "review") return;
          armed = false;
          queue.cancelEntryWithDisposition("review");
          queue.cancelEntryWithDisposition(`waiting-${offset % count}`);
          const first = queue.getQueuedEntries(THREAD)[0]!;
          expect((await queue.moveEntry(first.id)).disposition).toBe("held");
          expect((await queue.setEntryPaused(first.id, true)).disposition).toBe("held");
          await queue.submitSteer({ ...THREAD, id: "fresh", origin: "manual", input: [{ type: "text", text: "Fresh accepted guidance" }] });
          if (action === "independent") {
            await queue.submitHeld({ ...THREAD, id: "lock", origin: "manual", input: [] }, "independent lock");
            expect(await queue.releaseHold(THREAD, reason => reason === "independent lock")).toBe(true);
            queue.cancelEntryWithDisposition("lock");
          }
          if (action === "close") queue.close();
          await drain();
          if (action === "reject") throw new Error("Observer refused");
        },
      });
      try {
        for (let index = 0; index < count; index++) await queue.submit({ ...THREAD, id: `waiting-${index}`, origin: "manual", input: [] });
        active = false;
        const admission = queue.submitHeld({ ...THREAD, id: "review", origin: "scheduled", input: [] }, "review required");
        if (action === "reject") await expect(admission).rejects.toThrow("Observer refused");
        else await admission;
        await drain();
        expect(sends).toEqual([]);
        const waiting = queue.getQueuedEntries(THREAD);
        expect(waiting.map(entry => entry.id)).toEqual([...Array.from({ length: count }, (_, index) => `waiting-${index}`)
          .filter((_, index) => index !== offset % count), "fresh"]);
        expect(waiting.every(entry => entry.manualReleaseRequired && entry.holdReason === "review required")).toBe(true);
        expect([...observed.entries()].sort()).toEqual(waiting.map(entry => [entry.id, true]).sort());
        expect(waiting.at(-1)?.input).toEqual([{ type: "text", text: "Fresh accepted guidance" }]);
        expect((await queue.releaseEntryWithDisposition(waiting[0]!.id)).disposition).toBe(action === "close" ? "busy" : "started");
      } finally { queue.close(); }
    }));
});

it("earlier hold observers cannot resurrect a cancelled admission or overwrite a newer hold", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("cancel", "replace", "release"), async action => {
    const observed = new Map<string, boolean>();
    const sends: string[] = [];
    let active = true, armed = true;
    const queue = new ThreadTurnQueue({
      isThreadActive: () => active,
      startTurn: async entry => { sends.push(entry.id); return { ...THREAD, turnId: entry.id }; },
      onLifecycle: async event => {
        if (event.type === "queued" || event.type === "held") observed.set(event.entry.id, event.entry.manualReleaseRequired === true);
        if (event.type === "cancelled" || event.type === "started") observed.delete(event.entry.id);
        if (!armed || event.type !== "held" || event.entry.id !== "older") return;
        armed = false;
        if (action === "cancel") queue.cancelEntryWithDisposition("review");
        else if (action === "replace") await queue.releaseThread({ ...THREAD, turnId: "external", status: "turn/failed", errorMessage: "newer failure" });
        else await queue.releaseHold(THREAD, reason => reason === "review required");
        await drain();
      },
    });
    try {
      await queue.submit({ ...THREAD, id: "older", origin: "manual", input: [] });
      await queue.submitHeld({ ...THREAD, id: "review", origin: "scheduled", input: [] }, "review required");
      const waiting = queue.getQueuedEntries(THREAD);
      expect([...observed.entries()].sort()).toEqual(waiting.map(entry => [entry.id, entry.manualReleaseRequired === true]).sort());
      if (action === "replace") expect(waiting.every(entry => entry.holdReason === "newer failure")).toBe(true);
      active = false;
      queue.drainAll(); await drain();
      expect(sends).toEqual(action === "release" ? ["review"] : []);
    } finally { queue.close(); }
  }));
});
