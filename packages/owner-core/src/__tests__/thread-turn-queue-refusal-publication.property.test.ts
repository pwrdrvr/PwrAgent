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

it("refusal holds and projections survive simultaneous controls, independent causes and observer failure", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 6 }), fc.nat(),
    fc.constantFrom("controls", "independent", "reject", "close"), async (count, offset, action) => {
      const sent: string[] = [];
      const observed = new Map<string, { held: boolean; reason?: string }>();
      let active = true, armed = true;
      const queue = new ThreadTurnQueue({
        isThreadActive: () => active,
        startTurn: async entry => {
          if (entry.id === "refused") throw new Error("refusal review");
          sent.push(entry.id); return { ...THREAD, turnId: entry.id };
        },
        onLifecycle: async event => {
          if (event.type === "queued" || event.type === "held") observed.set(event.entry.id,
            { held: event.entry.manualReleaseRequired === true, reason: event.entry.holdReason });
          if (event.type === "started" || event.type === "cancelled") observed.delete(event.entry.id);
          if (!armed || event.type !== "blocked") return;
          armed = false;
          expect(queue.getQueuedEntries(THREAD).every(entry => entry.manualReleaseRequired)).toBe(true);
          queue.cancelEntryWithDisposition("refused");
          queue.cancelEntryWithDisposition(`waiting-${offset % count}`);
          const first = queue.getQueuedEntries(THREAD)[0]!;
          expect((await queue.moveEntry(first.id)).disposition).toBe("held");
          expect((await queue.setEntryPaused(first.id, true)).disposition).toBe("held");
          await queue.submitSteer({ ...THREAD, id: "fresh", origin: "manual", input: [{ type: "text", text: "Fresh identity" }] });
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
        await queue.submit({ ...THREAD, id: "refused", origin: "manual", input: [] });
        for (let index = 0; index < count; index++) await queue.submit({ ...THREAD, id: `waiting-${index}`, origin: "manual", input: [] });
        active = false;
        const release = queue.releaseThread(THREAD);
        if (action === "reject") await expect(release).rejects.toThrow("Observer refused");
        else await release;
        await drain();
        expect(sent).toEqual([]);
        const waiting = queue.getQueuedEntries(THREAD);
        expect(waiting.map(entry => entry.id)).toEqual([...Array.from({ length: count }, (_, index) => `waiting-${index}`)
          .filter((_, index) => index !== offset % count), "fresh"]);
        expect(waiting.every(entry => entry.manualReleaseRequired && entry.holdReason === "refusal review")).toBe(true);
        expect([...observed.entries()].sort()).toEqual(waiting.map(entry => [entry.id, { held: true, reason: "refusal review" }]).sort());
        expect(waiting.at(-1)?.input).toEqual([{ type: "text", text: "Fresh identity" }]);
        expect((await queue.releaseEntryWithDisposition(waiting[0]!.id)).disposition).toBe(action === "close" ? "busy" : "started");
      } finally { queue.close(); }
    }));
});

it("earlier hold observers own cancellation, release and replacement before blocked publication", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("cancel", "release", "replace", "rehold", "reject"), async action => {
    const observed = new Map<string, boolean>();
    let active = true, armed = true, blocked = 0;
    const queue = new ThreadTurnQueue({
      isThreadActive: () => active,
      startTurn: async () => { throw new Error("refusal review"); },
      onLifecycle: async event => {
        if (event.type === "blocked") { blocked++; observed.set(event.entry.id, true); }
        if (event.type === "queued" || event.type === "held") observed.set(event.entry.id, event.entry.manualReleaseRequired === true);
        if (event.type === "cancelled") observed.delete(event.entry.id);
        if (!armed || event.type !== "held") return;
        armed = false;
        active = true;
        if (action === "cancel") queue.cancelEntryWithDisposition("refused");
        if (action === "release" || action === "rehold") await queue.releaseHold(THREAD, reason => reason === "refusal review");
        if (action === "rehold") await queue.submitHeld({ ...THREAD, id: "new-review", origin: "manual", input: [] }, "newer review");
        if (action === "replace") await queue.submitHeld({ ...THREAD, id: "independent", origin: "manual", input: [] }, "independent review");
        await drain();
        if (action === "reject") throw new Error("Hold observer refused");
      },
    });
    try {
      await queue.submit({ ...THREAD, id: "refused", origin: "manual", input: [] });
      await queue.submit({ ...THREAD, id: "waiting", origin: "manual", input: [] });
      active = false;
      if (action === "reject") await expect(queue.releaseThread(THREAD)).rejects.toThrow("Hold observer refused");
      else await queue.releaseThread(THREAD);
      const waiting = queue.getQueuedEntries(THREAD);
      if (action !== "reject") expect([...observed.entries()].sort()).toEqual(waiting.map(entry => [entry.id, entry.manualReleaseRequired === true]).sort());
      expect(blocked).toBe(action === "replace" ? 1 : 0);
      if (action === "replace") {
        expect(await queue.releaseHold(THREAD, reason => reason === "independent review")).toBe(true);
        expect(waiting.find(entry => entry.id === "refused")).toMatchObject({ manualReleaseRequired: true, holdReason: "refusal review" });
      }
      if (action === "reject") expect(waiting.every(entry => entry.manualReleaseRequired)).toBe(true);
    } finally { queue.close(); }
  }));
});
