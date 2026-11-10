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

it("terminal publication retains ownership through controls, independent holds, refusal and close", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 7 }), fc.nat(), fc.boolean(), fc.boolean(),
    fc.constantFrom("complete", "fail", "reject", "close"), async (count, offset, independent, guidance, outcome) => {
      const sends: string[] = [];
      let active = false, armed = false;
      const observed = new Map<string, boolean>();
      const queue = new ThreadTurnQueue({
        isThreadActive: () => active,
        canSteerThread: () => active,
        steerTurn: async entry => { sends.push(entry.id); return { ...THREAD, turnId: "owner" }; },
        startTurn: async entry => { sends.push(entry.id); return { ...THREAD, turnId: entry.id }; },
        onLifecycle: async event => {
          if (event.type === "queued" || event.type === "held") observed.set(event.entry.id, event.entry.manualReleaseRequired === true);
          if (event.type === "cancelled" || event.type === "started") observed.delete(event.entry.id);
          if (!armed || event.type !== "terminal" || event.entry.id !== "owner") return;
          armed = false;
          const cancelled = `waiting-${offset % count}`;
          expect(queue.cancelEntryWithDisposition(cancelled).disposition).toBe("cancelled");
          const first = queue.getQueuedEntries(THREAD)[0]!;
          expect((await queue.setEntryPaused(first.id, true)).disposition).toBe("updated");
          expect((await queue.setEntryPaused(first.id, false)).disposition).toBe("updated");
          await queue.moveEntry(first.id);
          if (independent) {
            await queue.submitHeld({ ...THREAD, id: "locked", origin: "manual", input: [] }, "locked");
            expect((await queue.releaseEntryWithDisposition("locked")).disposition).toBe("busy");
            expect(await queue.releaseHold(THREAD, reason => reason === "locked")).toBe(true);
          }
          // New input has a fresh identity; it cannot steal terminal ownership.
          const added = { ...THREAD, id: "new-identity", origin: "manual" as const, input: [{ type: "text" as const, text: "New accepted input" }] };
          expect((await (guidance ? queue.submitSteer(added) : queue.submit(added))).status).toBe("queued");
          await drain();
          expect(sends).toEqual(["owner"]);
          if (outcome === "close") queue.close();
          if (outcome === "reject") throw new Error("Terminal observer refused");
        },
      });
      try {
        await queue.submit({ ...THREAD, id: "owner", origin: "manual", input: [] });
        active = true;
        for (let index = 0; index < count; index++) await queue.submit({ ...THREAD, id: `waiting-${index}`, origin: "manual", input: [] });
        active = false; // Both hosts retire native activity before releasing the queue.
        armed = true;
        const release = queue.releaseThread({ ...THREAD, turnId: "owner", status: outcome === "complete" ? "turn/completed" : "turn/failed", errorMessage: "failure review" });
        if (outcome === "reject") await expect(release).rejects.toThrow("Terminal observer refused");
        else await release;
        await drain();
        const waiting = queue.getQueuedEntries(THREAD);
        expect([...observed.entries()].sort()).toEqual(waiting.map(entry => [entry.id, entry.manualReleaseRequired === true]).sort());
        expect(waiting.at(-1)?.input).toEqual([{ type: "text", text: "New accepted input" }]);
        if (outcome === "complete") {
          const survivors = Array.from({ length: count }, (_, index) => `waiting-${index}`).filter(id => id !== `waiting-${offset % count}`);
          survivors.push(survivors.shift()!);
          if (independent) survivors.unshift("locked");
          expect(sends).toEqual(["owner", survivors[0]]);
        } else {
          expect(sends).toEqual(["owner"]);
          expect(waiting.every(entry => entry.manualReleaseRequired && entry.holdReason === "failure review")).toBe(true);
          // A later independent lock cannot release the failure's review.
          await queue.submitHeld({ ...THREAD, id: "later-lock", origin: "manual", input: [] }, "later lock");
          await queue.releaseHold(THREAD, reason => reason === "later lock");
          await drain();
          expect(sends).toEqual(["owner"]);
          expect((await queue.releaseEntryWithDisposition(waiting[0]!.id)).disposition).toBe(outcome === "close" ? "busy" : "started");
        }
        // Duplicate terminals do not retire the explicit Retry's new owner.
        const beforeDuplicate = [...sends];
        await queue.releaseThread({ ...THREAD, turnId: "owner", status: "turn/failed" });
        await drain();
        expect(sends).toEqual(beforeDuplicate);
      } finally { queue.close(); }
    }));
});
