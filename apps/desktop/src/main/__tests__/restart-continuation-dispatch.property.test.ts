import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { MockBackendClient, createOverlayStoreMock } from "./helpers/backend-registry-fixture";
import { StateDb } from "../state/state-db";
import { RestartContinuationStore } from "../state/restart-continuation-store";
import {
  planRestartDispatch,
  type RestartDispatchPlanOptions,
} from "../app-server/restart-continuation-gate";

type VirtualTimer = {
  id: number;
  callback: () => void;
  fireAt: number;
  cleared: boolean;
};

function createVirtualClock(initialNow = 1_000_000) {
  let now = initialNow;
  let nextId = 1;
  const timers = new Map<number, VirtualTimer>();
  const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
  const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
    callback: (...args: unknown[]) => void,
    delay?: number,
  ) => {
    const id = nextId++;
    const handle = { id, unref: () => handle } as unknown as ReturnType<typeof setTimeout>;
    timers.set(id, {
      id,
      callback: () => callback(),
      fireAt: now + Math.max(0, Number(delay ?? 0)),
      cleared: false,
    });
    return handle;
  }) as typeof setTimeout);
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((
    handle?: ReturnType<typeof setTimeout>,
  ) => {
    const id = (handle as unknown as { id?: number } | undefined)?.id;
    if (typeof id === "number") {
      const entry = timers.get(id);
      if (entry) entry.cleared = true;
      timers.delete(id);
    }
  }) as typeof clearTimeout);

  const activeTimers = () => [...timers.values()]
    .filter((timer) => !timer.cleared)
    .sort((a, b) => a.fireAt - b.fireAt || a.id - b.id);

  const fireNext = (skewMs = 0): VirtualTimer | undefined => {
    const next = activeTimers()[0];
    if (!next) return undefined;
    // Real timers can fire slightly early relative to Date.now().
    now = Math.max(now, next.fireAt + skewMs);
    timers.delete(next.id);
    if (!next.cleared) next.callback();
    return next;
  };

  return {
    get now() { return now; },
    advance(ms: number) { now += ms; },
    activeTimers,
    fireNext,
    restore() {
      nowSpy.mockRestore();
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      timers.clear();
    },
  };
}

const flush = async () => {
  for (let index = 0; index < 8; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
};

function createFixture(params: {
  threads: readonly string[];
  plan?: Omit<RestartDispatchPlanOptions, "now">;
}) {
  const db = StateDb.open(":memory:");
  const store = new RestartContinuationStore(db.raw, { processId: 4_242, processAlive: () => false });
  store.saveAll("instance-a", params.threads.map((threadId, index) => ({
    id: `restart:${threadId}`,
    backend: "codex" as const,
    threadId,
    input: [{ type: "text" as const, text: `Continue ${threadId}` }],
    createdAt: 100 + index,
  })));
  const codexClient = new MockBackendClient({});
  const registry = createDesktopBackendRegistry({
    codexClient,
    overlayStore: createOverlayStoreMock(),
    projectHeldWakeupStore: null,
    restartContinuationStore: store,
    ...(params.plan ? { restartDispatchPlan: params.plan } : {}),
    runtimeInstanceId: "instance-b",
    resolveLiveProfileRuntimeInstanceIds: () => ["instance-b"],
  });
  return {
    codexClient,
    registry,
    close: async () => {
      await registry.close();
      db.close();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("restart continuation dispatch (model)", () => {
  it("schedules the first continuation at now under default options regardless of jitter", () => {
    const entries = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 12 })
      .map((ids) => ids.map((entryId) => ({ entryId, threadKey: `codex:${entryId}` })));
    const randoms = fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 12, maxLength: 12 });
    fc.assert(fc.property(entries, fc.nat(1_000_000), randoms, (items, now, values) => {
      let index = 0;
      const plan = planRestartDispatch(items, { now, random: () => values[index++] ?? 0.5 });
      expect(plan.schedule[0]!.dispatchAt).toBe(now);
      expect(Math.min(...plan.schedule.map((item) => item.dispatchAt))).toBe(now);
    }), { numRuns: 50 });
  });

  it("starts the first continuation immediately once providers are ready", async () => {
    const threads = fc.uniqueArray(fc.constantFrom("t0", "t1", "t2", "t3", "t4", "t5"), { minLength: 1, maxLength: 6 });
    await fc.assert(fc.asyncProperty(threads, async (stopped) => {
      const clock = createVirtualClock(1_000_000);
      const fixture = createFixture({ threads: stopped });
      try {
        fixture.registry.beginRestartContinuationDispatch();
        while (clock.activeTimers()[0] && clock.activeTimers()[0]!.fireAt <= clock.now) {
          clock.fireNext(0);
        }
        await flush();
        expect(fixture.codexClient.startTurnCallCount).toBeGreaterThanOrEqual(1);
        expect(fixture.codexClient.startTurnCalls[0]!.threadId).toBe(stopped[0]);
      } finally {
        await fixture.close();
        clock.restore();
      }
    }), { numRuns: 20 });
  });

  it("re-arms timers when setTimeout fires early so continuations and the deadline never strand", async () => {
    const threads = fc.uniqueArray(fc.constantFrom("t0", "t1", "t2", "t3"), { minLength: 1, maxLength: 4 });
    const skews = fc.array(fc.integer({ min: -3, max: 0 }), { minLength: 20, maxLength: 20 });
    await fc.assert(fc.asyncProperty(threads, skews, fc.boolean(), async (stopped, timerSkews, blockAll) => {
      const clock = createVirtualClock(1_000_000);
      const fixture = createFixture({
        threads: stopped,
        plan: { batchSize: 2, firstDelayMs: 0, intervalMs: 1_000, jitterMs: 500, releaseGraceMs: 5_000, random: () => 0.5 },
      });
      try {
        if (blockAll) {
          vi.spyOn(fixture.codexClient, "startTurn").mockImplementation(() => new Promise(() => undefined));
        }
        fixture.registry.beginRestartContinuationDispatch();
        await flush();
        const status = fixture.registry.getRestartGateStatus();
        const releaseBy = status.phase === "resuming" ? status.releaseBy : undefined;
        let skewIndex = 0;
        let steps = 0;
        while (clock.activeTimers().length > 0 && steps < 40) {
          const next = clock.activeTimers()[0]!;
          if (releaseBy !== undefined && next.fireAt > releaseBy + 10_000) break;
          const skew = timerSkews[skewIndex++ % timerSkews.length]!;
          clock.fireNext(skew);
          await flush();
          steps += 1;
        }
        if (blockAll) {
          expect(fixture.registry.getRestartGateStatus()).toEqual({ phase: "open" });
        } else {
          expect(fixture.codexClient.startTurnCallCount).toBe(stopped.length);
          expect(fixture.registry.getRestartGateStatus()).toEqual({ phase: "open" });
          if (releaseBy !== undefined) {
            expect(clock.now).toBeLessThan(releaseBy);
          }
        }
      } finally {
        await fixture.close();
        clock.restore();
      }
    }), { numRuns: 30 });
  });

  it("preserves provider readiness, due timers, and cancellations across quiet-then-cancel races", async () => {
    type Op =
      | { kind: "providers-ready" }
      | { kind: "begin-quiet" }
      | { kind: "cancel-quiet" }
      | { kind: "cancel-continuation"; index: number }
      | { kind: "fire-timer"; skew: number }
      | { kind: "advance"; ms: number };
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.constant({ kind: "providers-ready" as const }),
      fc.constant({ kind: "begin-quiet" as const }),
      fc.constant({ kind: "cancel-quiet" as const }),
      fc.record({ kind: fc.constant("cancel-continuation" as const), index: fc.nat(3) }),
      fc.record({ kind: fc.constant("fire-timer" as const), skew: fc.integer({ min: -2, max: 2 }) }),
      fc.record({ kind: fc.constant("advance" as const), ms: fc.integer({ min: 0, max: 2_000 }) }),
    );
    await fc.assert(fc.asyncProperty(
      fc.uniqueArray(fc.constantFrom("t0", "t1", "t2", "t3"), { minLength: 1, maxLength: 4 }),
      fc.array(opArb, { minLength: 1, maxLength: 15 }),
      async (stopped, ops) => {
        const clock = createVirtualClock(1_000_000);
        const fixture = createFixture({
          threads: stopped,
          plan: { batchSize: 2, firstDelayMs: 0, intervalMs: 1_000, jitterMs: 500, releaseGraceMs: 5_000, random: () => 0.5 },
        });
        const cancelled = new Set<string>();
        let providersReadyCalled = false;
        let quieting = false;
        try {
          for (const op of ops) {
            switch (op.kind) {
              case "providers-ready":
                providersReadyCalled = true;
                fixture.registry.beginRestartContinuationDispatch();
                break;
              case "begin-quiet":
                quieting = true;
                fixture.registry.beginQuietRestart();
                break;
              case "cancel-quiet":
                quieting = false;
                fixture.registry.cancelQuietRestart(false);
                break;
              case "cancel-continuation": {
                const target = stopped[op.index % stopped.length]!;
                if (fixture.registry.cancelQueuedTurn(`restart:${target}`)) {
                  cancelled.add(target);
                }
                break;
              }
              case "fire-timer":
                clock.fireNext(op.skew);
                break;
              case "advance":
                clock.advance(op.ms);
                break;
            }
            await flush();
            const status = fixture.registry.getRestartGateStatus();
            if (!quieting && status.phase === "resuming") {
              const queuedContinuations = stopped.filter((threadId) =>
                fixture.registry.getQueuedTurnsForThread({ backend: "codex", threadId })
                  .some((entry) => entry.queueEntryId === `restart:${threadId}`),
              );
              expect(status.waiting).toBeLessThanOrEqual(queuedContinuations.length);
            }
          }
          if (quieting) {
            quieting = false;
            fixture.registry.cancelQuietRestart(false);
            await flush();
          }
          if (!providersReadyCalled) {
            fixture.registry.beginRestartContinuationDispatch();
            await flush();
          }
          const statusAfter = fixture.registry.getRestartGateStatus();
          if (statusAfter.phase === "resuming") {
            expect(statusAfter.nextAt).toBeDefined();
            expect(statusAfter.releaseBy).toBeDefined();
          }
          let steps = 0;
          while (clock.activeTimers().length > 0 && steps < 40) {
            clock.fireNext(0);
            await flush();
            steps += 1;
          }
          const expectedStarted = stopped.filter((threadId) => !cancelled.has(threadId));
          expect(fixture.codexClient.startTurnCalls.map((call) => call.threadId).sort()).toEqual([...expectedStarted].sort());
          expect(fixture.registry.getRestartGateStatus()).toEqual({ phase: "open" });
          expect(clock.activeTimers()).toEqual([]);
        } finally {
          await fixture.close();
          clock.restore();
        }
      },
    ), { numRuns: 40 });
  });

  it("does not let continuations held before dispatch steal batch-0 slots or inflate the deadline", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 4 }),
      fc.integer({ min: 1, max: 2 }),
      async (heldCount, pendingCount) => {
        const clock = createVirtualClock(1_000_000);
        const heldThreads = Array.from({ length: heldCount }, (_, index) => `held-${index}`);
        const pendingThreads = Array.from({ length: pendingCount }, (_, index) => `pending-${index}`);
        const fixture = createFixture({
          threads: [...heldThreads, ...pendingThreads],
          plan: { batchSize: heldCount, firstDelayMs: 0, intervalMs: 45_000, jitterMs: 0, releaseGraceMs: 60_000, random: () => 0 },
        });
        try {
          for (const threadId of heldThreads) {
            await fixture.registry.submitHeldTurn({
              queueEntryId: `held-msg:${threadId}`,
              backend: "codex",
              threadId,
              input: [{ type: "text", text: "Locked message" }],
              holdReason: "This thread is locked.",
            });
          }
          await flush();
          fixture.registry.beginRestartContinuationDispatch();
          while (clock.activeTimers()[0] && clock.activeTimers()[0]!.fireAt <= clock.now) {
            clock.fireNext(0);
          }
          await flush();
          expect(fixture.codexClient.startTurnCalls.map((call) => call.threadId)).toContain(pendingThreads[0]);
        } finally {
          await fixture.close();
          clock.restore();
        }
      },
    ), { numRuns: 10 });
  });
});
