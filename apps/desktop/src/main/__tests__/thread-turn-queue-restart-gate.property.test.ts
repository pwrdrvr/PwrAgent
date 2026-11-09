import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  OPEN_RESTART_GATE,
  planRestartDispatch,
  restartContinuationSettles,
  restartGateHolds,
  transitionRestartGate,
  type RestartGateEvent,
  type RestartGateState,
} from "../app-server/restart-continuation-gate";
import { ThreadTurnQueue, type ThreadTurnQueueEntry } from "@pwragent/owner-core/thread-turn-queue";

/**
 * A model of the turn queue behind the quiet-restart gate, wired the way
 * `DesktopBackendRegistry` wires it: the gate decides `isDispatchHeld`, a
 * continuation that starts, fails, is discarded, blocked or held settles the
 * gate, a scheduled time drains that thread, and the gate opening drains
 * every thread.
 *
 * The rules come from the feature request and `restart-continuation-gate.ts`:
 * 1. While any continuation waits, no other entry starts or steers, on any
 *    thread, unless the deadline passed or the operator released the gate.
 * 2. A continuation does not start before its dispatch time unless the gate
 *    opened.
 * 3. On its thread, the continuation is the first thing that starts.
 * 4. Once the gate opens and running turns end, every entry that is not
 *    paused or held starts.
 */

const THREADS = ["t0", "t1", "t2", "t3", "t4"] as const;
type ThreadName = (typeof THREADS)[number];

type Op =
  | { kind: "submit"; thread: ThreadName }
  | { kind: "steer"; thread: ThreadName }
  | { kind: "advance"; ms: number }
  | { kind: "complete"; thread: ThreadName }
  | { kind: "cancel-continuation"; thread: ThreadName }
  /** A held submission, as a locked thread's incoming message is. */
  | { kind: "hold"; thread: ThreadName }
  | { kind: "unlock"; thread: ThreadName }
  | { kind: "release" };

type Scenario = {
  /** Threads a quiet restart stopped, each with its continuation. */
  stopped: ThreadName[];
  /** Messages that waited in queues, restored behind the continuations. */
  queued: Array<{ thread: ThreadName; paused: boolean }>;
  /** Threads whose backend refuses their first start. */
  refusing: ThreadName[];
  randoms: number[];
  ops: Op[];
};

const thread = fc.constantFrom(...THREADS);

const scenario: fc.Arbitrary<Scenario> = fc.record({
  stopped: fc.uniqueArray(thread, { minLength: 1, maxLength: THREADS.length }),
  queued: fc.array(fc.record({ thread, paused: fc.boolean() }), { maxLength: 6 }),
  refusing: fc.uniqueArray(thread, { maxLength: 2 }),
  randoms: fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: THREADS.length, maxLength: THREADS.length }),
  ops: fc.array(fc.oneof(
    fc.record({ kind: fc.constant("submit" as const), thread }),
    fc.record({ kind: fc.constant("steer" as const), thread }),
    fc.record({ kind: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 60 }) }),
    fc.record({ kind: fc.constant("complete" as const), thread }),
    fc.record({ kind: fc.constant("cancel-continuation" as const), thread }),
    // A lock and its release must meet often enough to reach the held work.
    { arbitrary: fc.record({ kind: fc.constant("hold" as const), thread }), weight: 2 },
    { arbitrary: fc.record({ kind: fc.constant("unlock" as const), thread }), weight: 3 },
    fc.constant({ kind: "release" as const }),
  ), { maxLength: 30 }),
});

const LOCKED = "Thread is locked";
const REFUSED = "backend refused the turn";

const flush = async () => {
  for (let index = 0; index < 8; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

type Dispatch = { id: string; thread: ThreadName; continuation: boolean; at: number; gate: RestartGateState };

async function runScenario(input: Scenario) {
  let now = 0;
  let gate: RestartGateState = OPEN_RESTART_GATE;
  const dispatches: Dispatch[] = [];
  const running = new Set<ThreadName>();
  const refusing = new Set(input.refusing);
  const refused = new Set<ThreadName>();
  const continuationId = (name: ThreadName) => `restart:${name}`;
  let queue!: ThreadTurnQueue;

  const applyGate = (event: RestartGateEvent) => {
    const wasClosed = gate.phase !== "open";
    gate = transitionRestartGate(gate, event);
    if (wasClosed && gate.phase === "open") queue.drainAll();
  };
  const record = (entry: ThreadTurnQueueEntry) => {
    dispatches.push({
      id: entry.id,
      thread: entry.threadId as ThreadName,
      continuation: entry.restartContinuation === true,
      at: now,
      gate,
    });
  };

  queue = new ThreadTurnQueue({
    now: () => now,
    startTurn: async (entry) => {
      const name = entry.threadId as ThreadName;
      if (refusing.has(name) && !refused.has(name)) {
        refused.add(name);
        throw new Error(REFUSED);
      }
      record(entry);
      running.add(name);
      return { backend: entry.backend, threadId: entry.threadId, turnId: `turn:${entry.id}` };
    },
    canSteerThread: () => true,
    steerTurn: async (entry) => {
      record(entry);
      return { backend: entry.backend, threadId: entry.threadId, turnId: `steer:${entry.id}` };
    },
    isThreadActive: (params) => running.has(params.threadId as ThreadName),
    isDispatchHeld: (entry) => restartGateHolds(gate, {
      ...(entry.restartContinuation && entry.id ? { restartEntryId: entry.id } : {}),
    }, now),
    onLifecycle: (event) => {
      if (event.entry.restartContinuation && restartContinuationSettles(event.type)) {
        applyGate({ type: "settled", entryId: event.entry.id });
      }
    },
  });

  try {
    // Startup, as `restoreRestartContinuations` in the registry does it.
    queue.restoreQueued(input.queued.map((item, index) => ({
      id: `queued:${index}`,
      backend: "codex",
      threadId: item.thread,
      origin: "manual",
      input: [{ type: "text", text: `queued ${index}` }],
      createdAt: index,
      ...(item.paused ? { paused: true } : {}),
    })));
    queue.restoreRestartContinuations(input.stopped.map((name, index) => ({
      id: continuationId(name),
      backend: "codex",
      threadId: name,
      origin: "scheduled",
      input: [{ type: "text", text: "continue" }],
      createdAt: -100 + index,
    })));
    let randomIndex = 0;
    const plan = planRestartDispatch(
      input.stopped.map((name) => ({ entryId: continuationId(name), threadKey: `codex:${name}` })),
      {
        now,
        batchSize: 2,
        firstDelayMs: 20,
        intervalMs: 30,
        jitterMs: 10,
        releaseGraceMs: 50,
        random: () => input.randoms[randomIndex++] ?? 0,
      },
    );
    applyGate({ type: "restore", schedule: plan.schedule, releaseBy: plan.releaseBy });
    const dispatchAt = new Map(plan.schedule.map((item) => [item.entryId, item.dispatchAt]));
    const drained = new Set<string>();
    const fireTimers = () => {
      for (const item of plan.schedule) {
        if (now >= item.dispatchAt && !drained.has(item.entryId)) {
          drained.add(item.entryId);
          queue.scheduleThreadDrain({ backend: "codex", threadId: item.threadKey.slice("codex:".length) });
        }
      }
      if (now >= plan.releaseBy) applyGate({ type: "deadline", at: now });
    };
    const complete = async (name: ThreadName) => {
      if (!running.delete(name)) return;
      await queue.releaseThread({ backend: "codex", threadId: name, status: "turn/completed" });
    };

    const refusedNow = (error: unknown) => {
      if (!(error instanceof Error) || error.message !== REFUSED) throw error;
    };
    let serial = 0;
    for (const op of input.ops) {
      switch (op.kind) {
        case "submit":
          // A start the backend refuses at once is the caller's error.
          await queue.submit({
            id: `submit:${serial++}`,
            backend: "codex",
            threadId: op.thread,
            origin: "manual",
            input: [{ type: "text", text: "hello" }],
          }).catch(refusedNow);
          break;
        case "steer":
          await queue.submitSteer({
            id: `steer:${serial++}`,
            backend: "codex",
            threadId: op.thread,
            origin: "messaging",
            input: [{ type: "text", text: "steer" }],
          }).catch(refusedNow);
          break;
        case "advance":
          now += op.ms;
          fireTimers();
          break;
        case "complete":
          await complete(op.thread);
          break;
        case "cancel-continuation":
          queue.cancelEntry(continuationId(op.thread));
          break;
        case "hold":
          await queue.submitHeld({
            id: `held:${serial++}`,
            backend: "codex",
            threadId: op.thread,
            origin: "messaging",
            input: [{ type: "text", text: "held" }],
          }, LOCKED);
          break;
        case "unlock":
          await queue.releaseHold({ backend: "codex", threadId: op.thread }, (reason) => reason === LOCKED);
          break;
        case "release":
          applyGate({ type: "release" });
          break;
      }
      await flush();
    }

    // Let time run out and every turn finish, as a real session would.
    now = Math.max(now, plan.releaseBy);
    fireTimers();
    await flush();
    for (let round = 0; round < 20 && running.size > 0; round += 1) {
      for (const name of [...running]) await complete(name);
      await flush();
    }

    return {
      dispatches,
      dispatchAt,
      gate,
      held: queue.getAllQueuedEntries().filter((entry) => entry.manualReleaseRequired).map((entry) => entry.id),
      waiting: queue.getAllQueuedEntries().filter((entry) => !entry.paused && !entry.manualReleaseRequired),
    };
  } finally {
    queue.close();
  }
}

describe("thread turn queue behind the restart gate (model)", () => {
  it("starts each continuation first, holds everything else until the gate opens, then drains", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (input) => {
        const result = await runScenario(input);
        const continuations = new Set(input.stopped.map((name) => `restart:${name}`));

        for (const dispatch of result.dispatches) {
          if (dispatch.continuation) {
            // Rule 2.
            expect(
              dispatch.gate.phase === "open" || dispatch.at >= (result.dispatchAt.get(dispatch.id) ?? Infinity),
              `${dispatch.id} started at ${dispatch.at} before its time`,
            ).toBe(true);
          } else {
            // Rule 1.
            expect(dispatch.gate.phase, `${dispatch.id} started while continuations waited`).toBe("open");
          }
        }

        // Rule 3: on a stopped thread, nothing starts before its continuation.
        for (const name of input.stopped) {
          const onThread = result.dispatches.filter((dispatch) => dispatch.thread === name);
          const first = onThread[0];
          if (first && onThread.some((dispatch) => dispatch.continuation)) {
            expect(first.id, `${name} started ${first.id} before its continuation`).toBe(`restart:${name}`);
          }
        }

        // Rule 4: the gate is open and nothing that can start is left waiting.
        expect(result.gate.phase).toBe("open");
        expect(result.waiting.map((entry) => entry.id)).toEqual([]);
        // Each continuation started, was discarded, or waits on the operator
        // behind a hold (a lock, or a backend that refused it).
        for (const id of continuations) {
          const name = id.slice("restart:".length) as ThreadName;
          const cancelled = input.ops.some((op) => op.kind === "cancel-continuation" && op.thread === name);
          expect(
            cancelled || result.held.includes(id) || result.dispatches.some((dispatch) => dispatch.id === id),
            `${id} never started`,
          ).toBe(true);
        }
      }),
      { numRuns: 50 },
    );
  });
});
