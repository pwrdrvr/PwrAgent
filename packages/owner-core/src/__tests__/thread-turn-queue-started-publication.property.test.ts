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

it("accepted starts retain buffered native terminals and their failure holds through rejected observers", async () => {
  await fc.assert(fc.asyncProperty(fc.constantFrom("before", "during", "after"), fc.boolean(), fc.boolean(),
    async (timing, failed, rejectTerminal) => {
      let active = true, dispatchHeld = true;
      const events: string[] = [], sent: string[] = [];
      const terminal = { ...THREAD, turnId: "native", status: failed ? "turn/failed" : "turn/completed", errorMessage: "Native failure" };
      const queue = new ThreadTurnQueue({
        isThreadActive: () => active,
        isDispatchHeld: () => dispatchHeld,
        startTurn: async entry => {
          sent.push(entry.id);
          active = true;
          if (timing === "before") { active = false; await queue.releaseThread(terminal); }
          return { ...THREAD, turnId: "native" };
        },
        onLifecycle: async event => {
          events.push(`${event.type}:${event.entry.id}`);
          if (event.type === "started") {
            dispatchHeld = true;
            if (timing === "during") { active = false; await queue.releaseThread(terminal); }
            throw new Error("Started publication rejected");
          }
          if (event.type === "terminal" && rejectTerminal) throw new Error("Terminal publication rejected");
        },
      });
      try {
        for (const id of ["accepted", "next"]) await queue.submit({ ...THREAD, id, origin: "manual", input: [] });
        active = false; dispatchHeld = false;
        await queue.releaseThread(THREAD);
        if (timing === "after") {
          active = false;
          const release = queue.releaseThread(terminal);
          if (rejectTerminal) await expect(release).rejects.toThrow("Terminal publication rejected");
          else await release;
        }
        await drain();
        expect(sent).toEqual(["accepted"]);
        expect(queue.getQueuedEntries(THREAD)).toMatchObject([{ id: "next", ...(failed ? { manualReleaseRequired: true, holdReason: "Native failure" } : {}) }]);
        expect(queue.getQueuedEntries(THREAD).some(entry => entry.manualReleaseRequired)).toBe(failed);
        expect(events.filter(event => event === "terminal:accepted")).toHaveLength(1);
        expect(events).not.toContain("failed:accepted");
        expect(events).not.toContain("blocked:accepted");
        // Duplicate provider terminals cannot recreate or re-publish acceptance.
        await queue.releaseThread(terminal);
        expect(events.filter(event => event === "terminal:accepted")).toHaveLength(1);
        dispatchHeld = false;
        queue.drainAll();
        await drain();
        expect(sent).toEqual(failed ? ["accepted"] : ["accepted", "next"]);
      } finally { queue.close(); }
    }));
});

it("started observers can control waiting input without restoring accepted start or guidance", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.nat(), fc.boolean(), async (steer, position, close) => {
    let active = true, gate = true;
    const sends: string[] = [], projected = new Map<string, boolean>();
    const queue = new ThreadTurnQueue({
      isThreadActive: () => active,
      isDispatchHeld: () => gate,
      canSteerThread: () => steer && active,
      startTurn: async entry => { sends.push(entry.id); active = true; return { ...THREAD, turnId: "native" }; },
      steerTurn: async entry => { sends.push(entry.id); return { ...THREAD, turnId: "native" }; },
      onLifecycle: async event => {
        if (event.type === "held" || event.type === "queued") projected.set(event.entry.id, event.entry.manualReleaseRequired === true);
        if (event.type === "started" || event.type === "cancelled") projected.delete(event.entry.id);
        if (event.type !== "started" || event.entry.id !== "accepted") return;
        expect(queue.cancelEntryWithDisposition("accepted").disposition).toBe("already_admitted");
        queue.cancelEntryWithDisposition(`waiting-${position % 3}`);
        const first = queue.getQueuedEntries(THREAD)[0]!;
        await Promise.all([queue.setEntryPaused(first.id, true), queue.moveEntry(first.id)]);
        await queue.submitHeld({ ...THREAD, id: "review", origin: "scheduled", input: [] }, "independent review");
        await queue.submitSteer({ ...THREAD, id: "fresh", origin: "manual", input: [{ type: "text", text: "Fresh immutable identity" }] });
        if (close) queue.close();
        await drain();
        throw new Error("Started publication rejected");
      },
    });
    try {
      await (steer ? queue.submitSteer.bind(queue) : queue.submit.bind(queue))({ ...THREAD, id: "accepted", origin: "manual", input: [] });
      for (let i = 0; i < 3; i++) await queue.submit({ ...THREAD, id: `waiting-${i}`, origin: "manual", input: [] });
      active = steer; gate = false;
      await queue.releaseThread(THREAD);
      await drain();
      const waiting = queue.getQueuedEntries(THREAD);
      expect(sends).toEqual(["accepted"]);
      const remaining = Array.from({ length: 3 }, (_, i) => `waiting-${i}`).filter((_, i) => i !== position % 3);
      expect(waiting.map(entry => entry.id)).toEqual(["review", remaining[1], remaining[0], "fresh"]);
      expect(waiting.every(entry => entry.manualReleaseRequired && entry.holdReason === "independent review")).toBe(true);
      expect([...projected.entries()].sort()).toEqual(waiting.map(entry => [entry.id, true]).sort());
      expect(await queue.releaseHold(THREAD, reason => reason === "Started publication rejected")).toBe(false);
      queue.close(); active = false;
      await queue.releaseThread({ ...THREAD, turnId: "native", status: "turn/completed" });
      expect(sends).toEqual(["accepted"]);
    } finally { queue.close(); }
  }));
});

it("direct native acceptance remains successful when started publication rejects", async () => {
  const queue = new ThreadTurnQueue({
    startTurn: async () => ({ ...THREAD, turnId: "native" }),
    onLifecycle: event => { if (event.type === "started") throw new Error("Observer rejected"); },
  });
  try {
    expect(await queue.submit({ ...THREAD, id: "direct", origin: "manual", input: [] })).toMatchObject({ status: "started", turnId: "native" });
    expect(queue.cancelEntryWithDisposition("direct")).toMatchObject({ disposition: "already_admitted", turnId: "native" });
  } finally { queue.close(); }
});
