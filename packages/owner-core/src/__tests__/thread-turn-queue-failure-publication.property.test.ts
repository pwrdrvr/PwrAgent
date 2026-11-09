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

it("failure holds cover simultaneous controls, independent causes and shutdown before any publication awaits", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), fc.nat(),
    fc.constantFrom("controls", "new review", "close"), async (count, offset, operation) => {
      const sends: string[] = [];
      const observed = new Map<string, { held: boolean; reason?: string }>();
      let armed = false, active = true, published = 0;
      const queue = new ThreadTurnQueue({
        isThreadActive: () => active,
        startTurn: async entry => { sends.push(entry.id); return { ...THREAD, turnId: entry.id }; },
        onLifecycle: async event => {
          if (event.type === "queued" || event.type === "held") observed.set(event.entry.id,
            { held: event.entry.manualReleaseRequired === true, reason: event.entry.holdReason });
          if (event.type === "cancelled" || event.type === "started") observed.delete(event.entry.id);
          if (!armed || event.type !== "held" || published++ !== offset % count) return;
          armed = false;
          expect(queue.getQueuedEntries(THREAD).every(entry => entry.manualReleaseRequired && entry.holdReason === "failure review")).toBe(true);
          // Every row, including those not published yet, is already held.
          const last = queue.getQueuedEntries(THREAD).at(-1)!;
          expect((await queue.setEntryPaused(last.id, true)).disposition).toBe("held");
          expect((await queue.moveEntry(last.id)).disposition).toBe("held");
          expect((await queue.releaseEntryWithDisposition(queue.getQueuedEntries(THREAD)[0]!.id)).disposition).toBe("busy");
          queue.cancelEntryWithDisposition(event.entry.id);
          if (operation === "new review") await queue.submitHeld({ ...THREAD, id: "independent", origin: "manual", input: [{ type: "text", text: "New identity" }] }, "independent review");
          if (operation === "close") queue.close();
          await drain();
        },
      });
      try {
        for (let index = 0; index < count; index++) await queue.submit({ ...THREAD, id: `waiting-${index}`, origin: "manual", input: [{ type: "text", text: `Original input ${index}` }] });
        armed = true;
        await queue.releaseThread({ ...THREAD, turnId: "prior-native", status: "turn/failed", errorMessage: "failure review" });
        active = false;
        await drain();
        expect(sends).toEqual([]);
        const waiting = queue.getQueuedEntries(THREAD);
        expect([...observed.entries()].sort()).toEqual(waiting.map(entry => [entry.id, { held: true, reason: entry.holdReason }]).sort());
        for (const entry of waiting.filter(entry => entry.id !== "independent")) {
          expect(entry.input).toEqual([{ type: "text", text: `Original input ${entry.id.slice(8)}` }]);
          expect(entry.holdReason).toBe("failure review");
        }
        expect(await queue.releaseHold(THREAD, reason => reason === "failure review")).toBe(true);
        await drain();
        expect(sends).toEqual(operation === "close" ? [] : [waiting[0]!.id]);
        if (operation === "new review") {
          expect(queue.getQueuedEntries(THREAD).at(-1)).toMatchObject({ id: "independent", manualReleaseRequired: true, holdReason: "independent review" });
          expect(await queue.releaseHold(THREAD, reason => reason === "independent review")).toBe(true);
        }
      } finally { queue.close(); }
    }));
});

it("failure publication cannot overwrite a simultaneous explicit release or resurrect a cancelled snapshot", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 8 }), fc.nat(), fc.boolean(), async (count, offset, retry) => {
    const sends: string[] = [];
    const observed = new Map<string, boolean>();
    let active = true, armed = false, published = 0;
    const queue = new ThreadTurnQueue({
      isThreadActive: () => active,
      startTurn: async entry => { sends.push(entry.id); return { ...THREAD, turnId: entry.id }; },
      onLifecycle: async event => {
        if (event.type === "queued" || event.type === "held") observed.set(event.entry.id, event.entry.manualReleaseRequired === true);
        if (event.type === "cancelled" || event.type === "started") observed.delete(event.entry.id);
        if (!armed || event.type !== "held" || published++ !== offset % (count - 1)) return;
        armed = false;
        queue.cancelEntryWithDisposition(`waiting-${count - 1}`);
        if (retry) {
          active = false;
          expect((await queue.releaseEntryWithDisposition("waiting-0")).disposition).toBe("started");
        } else expect(await queue.releaseHold(THREAD, reason => reason === "review required")).toBe(true);
      },
    });
    try {
      for (let index = 0; index < count; index++) await queue.submit({ ...THREAD, id: `waiting-${index}`, origin: "manual", input: [] });
      armed = true;
      await queue.releaseThread({ ...THREAD, turnId: "prior-native", status: "turn/failed", errorMessage: "review required" });
      active = false;
      await drain();
      expect(sends).toEqual(["waiting-0"]);
      const waiting = queue.getQueuedEntries(THREAD);
      expect(waiting.map(entry => entry.id)).toEqual(Array.from({ length: count - 2 }, (_, index) => `waiting-${index + 1}`));
      expect(waiting.every(entry => !entry.manualReleaseRequired && entry.holdReason === undefined)).toBe(true);
      expect([...observed.entries()].sort()).toEqual(waiting.map(entry => [entry.id, false]).sort());
    } finally { queue.close(); }
  }));
});
