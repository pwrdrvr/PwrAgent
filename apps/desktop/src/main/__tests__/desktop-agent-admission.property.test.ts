import fc from "fast-check";
import { expect, it } from "vitest";
import { ThreadTurnQueue, type ThreadTurnQueueEntry, type ThreadTurnQueueLifecycleEvent } from "@pwragent/owner-core/thread-turn-queue";

const ref = { backend: "codex" as const, threadId: "recipient" };
const input = (text: string) => [{ type: "text" as const, text }];
const origin = (threadId: string) => ({ kind: "agent" as const, sourceThread: { backend: "codex" as const, threadId } });
const drain = async () => { for (let n = 0; n < 4; n++) await new Promise<void>(resolve => setImmediate(resolve)); };

it("individual admission preserves earlier agent neighbors, independent holds and every accepted input", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.tuple(fc.boolean(), fc.string({ maxLength: 40 })), { minLength: 2, maxLength: 8 }),
    fc.boolean(), fc.boolean(), async (messages, paused, close) => {
      let busy = true;
      const sends: ThreadTurnQueueEntry[] = [], events: ThreadTurnQueueLifecycleEvent[] = [];
      const queue = new ThreadTurnQueue({ isThreadActive: () => busy,
        startTurn: async entry => { sends.push(entry); return { ...ref, turnId: entry.id }; },
        onLifecycle: event => { events.push(event); } });
      try {
        // Two earlier agent messages, each its own acceptance.
        const group = await queue.submitSteer({ ...ref, origin: "manual", input: input("Legacy Alice"), messageOrigin: origin("alice") });
        await queue.submitSteer({ ...ref, origin: "manual", input: input("Legacy Bob"), messageOrigin: origin("bob") });
        if (paused) await queue.setEntryPaused(group.entry.id, true);
        await queue.submitHeld({ ...ref, id: "review", origin: "scheduled", input: input("Review") }, "Independent review");
        await queue.submitHeld({ ...ref, id: "lock", origin: "scheduled", input: input("Lock") }, "Independent lock");
        const neighbors = structuredClone(queue.getQueuedEntries(ref));
        const accepted: ThreadTurnQueueEntry[] = [];
        for (const [bob, text] of messages) {
          const result = await queue.submitSteer({ ...ref, origin: "manual", input: input(text), messageOrigin: origin(bob ? "bob" : "alice") });
          accepted.push(structuredClone(result.entry));
          expect(queue.getQueuedEntries(ref)).toEqual([...neighbors, ...accepted]);
          expect(new Set(accepted.map(entry => entry.id)).size).toBe(accepted.length);
          expect(events.at(-1)).toMatchObject({ type: "queued", entry: result.entry, position: neighbors.length + accepted.length });
        }
        await queue.releaseHold(ref, reason => reason === "Independent lock");
        expect(queue.getQueuedEntries(ref).every(entry => entry.manualReleaseRequired)).toBe(true);
        await drain(); expect(sends).toEqual([]);
        await queue.releaseHold(ref, () => true);
        if (paused) await queue.setEntryPaused(group.entry.id, false);
        const waiting = structuredClone(queue.getQueuedEntries(ref));
        if (close) queue.close();
        busy = false;
        queue.drainAll();
        await drain();
        if (close) { expect(sends).toEqual([]); return; }
        // Agent messages that wait next to each other share a delivery; the
        // review and the lock are not agent messages and go out alone. Every
        // delivery still names each immutable acceptance it carries.
        const expected: string[][] = [];
        waiting.forEach((entry, index) => {
          const agent = entry.messageOrigin?.kind === "agent";
          if (agent && index > 0 && waiting[index - 1]!.messageOrigin?.kind === "agent") expected.at(-1)!.push(entry.id);
          else expected.push([entry.id]);
        });
        expect(expected.at(-1)).toEqual(accepted.map(entry => entry.id));
        for (const ids of expected) {
          const sent = sends.at(-1)!;
          expect(sent.deliveredEntryIds ?? [sent.id]).toEqual(ids);
          await queue.releaseThread({ ...ref, turnId: sent.id, status: "completed" });
          await drain();
        }
        expect(sends).toHaveLength(expected.length);
        const combined = sends.at(-1)!;
        expect(combined.agentMessages?.map(message => message.input)).toEqual(accepted.map(entry => entry.input));
        expect(events.filter(event => event.type === "started").map(event => event.entry.id)).toEqual(expected.flat());
        expect(accepted.map(entry => entry.input)).toEqual(messages.map(([, text]) => input(text)));
      } finally { queue.close(); }
    }), { numRuns: 50 });
});

it("active-control admission stays queued when native occupancy ends before its admission", async () => {
  await fc.assert(fc.asyncProperty(fc.string(), async text => {
    const sends: ThreadTurnQueueEntry[] = [];
    const queue = new ThreadTurnQueue({ startTurn: async entry => { sends.push(entry); return { ...ref, turnId: entry.id }; } });
    try {
      const accepted = await queue.submitSteer({ ...ref, origin: "manual", input: input(text), messageOrigin: origin("alice") }, { deferStart: true });
      expect(accepted.status).toBe("queued");
      expect(sends).toEqual([]);
      await drain();
      expect(sends).toEqual([accepted.entry]);
      await queue.releaseThread({ ...ref, turnId: accepted.entry.id, status: "completed" });
      await drain();
      expect(sends).toHaveLength(1);
      expect(queue.getQueuedEntries(ref)).toEqual([]);
    } finally { queue.close(); }
  }), { numRuns: 50 });
});
