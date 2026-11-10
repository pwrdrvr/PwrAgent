import fc from "fast-check";
import { stat } from "node:fs";
import { expect, it } from "vitest";
import { ThreadTurnQueue } from "../thread-turn-queue";

const THREAD = { backend: "codex" as const, threadId: "drain-wakeup" };
/** Far past one event-loop turn, near enough to keep a failing run short. */
const BOUND_MS = 1_500;

type Source = "timer" | "timer-microtask" | "immediate" | "io";

/** Runs `schedule` from one event-loop phase, the way an owner's own
 * callback (a restore settling, a release, a provider reply) would. */
function fromPhase(source: Source, schedule: () => void): void {
  if (source === "timer") setTimeout(schedule, 0);
  else if (source === "timer-microtask") setTimeout(() => { void Promise.resolve().then(schedule); }, 0);
  else if (source === "immediate") setImmediate(schedule);
  else stat(".", () => schedule());
}

/**
 * A drain the queue schedules must run on its own. The test leaves the event
 * loop nothing else to do but one far bound timer, so a drain that cannot wake
 * the loop runs only when that bound fires. A queued send behind a hibernated
 * checkout restore waited ~4 s this way, and until the 5 s test timeout on
 * macOS CI, where nothing else woke the loop.
 */
async function drainRunsOnItsOwn(source: Source, queued: number): Promise<void> {
  let active = true;
  let resolveStarted!: () => void;
  const started = new Promise<"started">((resolve) => { resolveStarted = () => resolve("started"); });
  const sent: string[] = [];
  let requestedAt = 0;
  let startedAfterMs = Number.POSITIVE_INFINITY;
  const queue = new ThreadTurnQueue({
    isThreadActive: () => active,
    startTurn: async (entry) => {
      sent.push(entry.id);
      active = true;
      startedAfterMs = performance.now() - requestedAt;
      resolveStarted();
      return { ...THREAD, turnId: `turn-${entry.id}` };
    },
  });
  let bound: ReturnType<typeof setTimeout> | undefined;
  try {
    for (let index = 0; index < queued; index++) {
      await queue.submit({ ...THREAD, id: `queued-${index}`, origin: "manual", input: [] });
    }
    expect(sent).toEqual([]);
    fromPhase(source, () => {
      active = false;
      requestedAt = performance.now();
      queue.scheduleThreadDrain(THREAD);
    });
    const outcome = await Promise.race([
      started,
      new Promise<"stalled">((resolve) => { bound = setTimeout(() => resolve("stalled"), BOUND_MS); }),
    ]);
    expect(outcome).toBe("started");
    // A loop woken only by the bound starts the head as the bound fires, so
    // the race alone can read "started". The wait itself is the oracle.
    expect(startedAfterMs).toBeLessThan(BOUND_MS / 3);
    expect(sent).toEqual(["queued-0"]);
  } finally {
    clearTimeout(bound);
    queue.close();
  }
}

it("a scheduled drain starts the queue head without other event-loop work to wake it", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom<Source>("timer", "timer-microtask", "immediate", "io"),
      fc.integer({ min: 1, max: 4 }),
      drainRunsOnItsOwn,
    ),
    { numRuns: 24, endOnFailure: true },
  );
});
