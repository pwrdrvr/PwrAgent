import fc from "fast-check";
import { expect, it } from "vitest";
import { ThreadTurnQueue } from "../thread-turn-queue";

// The queue remembers the last 1,000 admitted entry ids and the last 1,000
// processed terminal turns. Each run admits or ends just past that many.
const LIMIT = 1_000;
const thread = (index: number) => ({ backend: "codex" as const, threadId: `limit-${index}` });
const SHARED = thread(-1);

it("an admitted id stays recognized for the newest 1,000 admissions, counting a late acceptance as new", async () => {
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 0, max: 4 }),
    // Early entries whose native acceptance lands later, while newer
    // admissions keep arriving, and the order those acceptances land in.
    fc.shuffledSubarray([0, 1, 2, 3], { minLength: 1 }),
    fc.integer({ min: 4, max: LIMIT + 4 }),
    async (overflow, late, acceptAt) => {
      const total = LIMIT + overflow;
      const accept = new Map<string, () => void>();
      const pending: Promise<unknown>[] = [];
      const queue = new ThreadTurnQueue({
        startTurn: async entry => {
          if (accept.has(entry.id)) await new Promise<void>(resolve => accept.set(entry.id, resolve));
          return { backend: entry.backend, threadId: entry.threadId, turnId: `turn-${entry.id}` };
        },
      });
      // Model: ids in the order they were last remembered, oldest first.
      const remembered: string[] = [];
      const remember = (id: string) => {
        const index = remembered.indexOf(id);
        if (index >= 0) remembered.splice(index, 1);
        remembered.push(id);
        if (remembered.length > LIMIT) remembered.shift();
      };
      try {
        for (const index of late) accept.set(`entry-${index}`, () => {});
        for (let index = 0; index < total; index++) {
          if (index === Math.min(acceptAt, total - 1)) {
            for (const lateIndex of late) {
              accept.get(`entry-${lateIndex}`)!();
              await pending[lateIndex];
              remember(`entry-${lateIndex}`);
            }
          }
          const id = `entry-${index}`;
          // A late acceptance holds its own thread. The rest run one after
          // another on a shared thread, each ending before the next starts.
          const submitted = queue.submit({ ...(accept.has(id) ? thread(index) : SHARED), id, origin: "manual", input: [] });
          pending.push(submitted);
          if (accept.has(id)) await new Promise<void>(resolve => setImmediate(resolve));
          else {
            await submitted;
            await queue.releaseThread({ ...SHARED, turnId: `turn-${id}`, status: "turn/completed" });
          }
          remember(id);
        }
        const retained = new Set(remembered);
        for (let index = 0; index < total; index++) {
          const id = `entry-${index}`;
          expect(queue.cancelEntryWithDisposition(id).disposition, id)
            .toBe(retained.has(id) ? "already_admitted" : "not_found");
        }
        const newest = remembered.at(-1)!;
        await expect(queue.submit({ ...SHARED, id: newest, origin: "manual", input: [] }))
          .rejects.toThrow(/already admitted/);
      } finally { queue.close(); }
    },
  ), { numRuns: 20 });
});

it("a processed terminal is ignored for the newest 1,000 terminals and forgotten after", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 0, max: 4 }), fc.nat(), async (overflow, pick) => {
    const total = LIMIT + overflow;
    // A probed thread is busy elsewhere, so a turn waits in its FIFO.
    const busy = new Set<string>();
    const queue = new ThreadTurnQueue({
      isThreadActive: params => busy.has(params.threadId),
      startTurn: async entry => ({ backend: entry.backend, threadId: entry.threadId, turnId: entry.id }),
    });
    /** Whether replaying a failure for an ended turn left its thread's waiting turn unheld. */
    const replayFailure = async (index: number) => {
      busy.add(thread(index).threadId);
      await queue.submit({ ...thread(index), id: `waiting-${index}`, origin: "manual", input: [] });
      await queue.releaseThread({ ...thread(index), turnId: `turn-${index}`, status: "turn/failed", errorMessage: "replayed" });
      return queue.getQueuedEntries(thread(index)).every(entry => !entry.manualReleaseRequired);
    };
    try {
      for (let index = 0; index < total; index++) {
        await queue.releaseThread({ ...thread(index), turnId: `turn-${index}`, status: "turn/completed" });
      }
      // A replayed terminal the queue still remembers must not hold its
      // thread. Probe retained turns first: replaying a forgotten one is
      // processed and evicts the oldest retained turn.
      expect(await replayFailure(overflow)).toBe(true);
      expect(await replayFailure(overflow + pick % (total - overflow))).toBe(true);
      expect(await replayFailure(total - 1)).toBe(true);
      if (overflow > 0) expect(await replayFailure(pick % overflow)).toBe(false);
    } finally { queue.close(); }
  }), { numRuns: 20 });
});
