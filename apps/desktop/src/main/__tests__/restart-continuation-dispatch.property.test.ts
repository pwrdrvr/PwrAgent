import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { MockBackendClient, createOverlayStoreMock } from "./helpers/backend-registry-fixture";
import type { RestartContinuationStorage, StoredRestartContinuation } from "../storage/desktop-runtime-storage";
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

function createMemoryRestartContinuationStore(
  initial: readonly StoredRestartContinuation[],
): RestartContinuationStorage {
  const rows = new Map<string, { owner: string; entry: StoredRestartContinuation }>(
    initial.map((entry) => [entry.id, { owner: "instance-a", entry }]),
  );
  return {
    saveAll(instanceId, continuations) {
      const saved: StoredRestartContinuation[] = [];
      for (const entry of continuations) {
        if (entry.kind === undefined && rows.has(entry.id)) continue;
        rows.set(entry.id, { owner: instanceId, entry });
        if (entry.kind === undefined) saved.push(entry);
      }
      return saved;
    },
    remove(entryId) {
      rows.delete(entryId);
    },
    claimOrphaned(instanceId, liveOwners) {
      const live = new Set([...liveOwners(), instanceId]);
      const claimed: StoredRestartContinuation[] = [];
      for (const row of rows.values()) {
        if (live.has(row.owner)) continue;
        row.owner = instanceId;
        claimed.push(row.entry);
      }
      return claimed.sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    },
  };
}

function createFixture(params: {
  threads: readonly string[];
  plan?: Omit<RestartDispatchPlanOptions, "now">;
}) {
  const store = createMemoryRestartContinuationStore(params.threads.map((threadId, index) => ({
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

  it.each([
    ["single stopped thread", ["t0"]],
    ["multiple batches", ["t0", "t1", "t2", "t3", "t4", "t5"]],
  ] as const)("starts the first continuation immediately once providers are ready (%s)", async (_label, stopped) => {
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
  });

  it.each([
    { label: "single thread completes before deadline", stopped: ["t0"], blockAll: false },
    { label: "multi-batch threads complete before deadline", stopped: ["t0", "t1", "t2", "t3"], blockAll: false },
    { label: "blocked turns still open at deadline", stopped: ["t0", "t1"], blockAll: true },
  ])("re-arms timers when setTimeout fires early so continuations and the deadline never strand ($label)", async ({ stopped, blockAll }) => {
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
      // Fire each distinct target early (-3ms, then -1ms) before letting it reach its target time (0ms).
      const earlyAttemptsByFireAt = new Map<number, number>();
      let steps = 0;
      while (clock.activeTimers().length > 0 && steps < 40) {
        const next = clock.activeTimers()[0]!;
        if (releaseBy !== undefined && next.fireAt > releaseBy + 10_000) break;
        const attempts = earlyAttemptsByFireAt.get(next.fireAt) ?? 0;
        earlyAttemptsByFireAt.set(next.fireAt, attempts + 1);
        const skew = attempts === 0 ? -3 : attempts === 1 ? -1 : 0;
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
  });

  type RaceOp =
    | { kind: "providers-ready" }
    | { kind: "begin-quiet" }
    | { kind: "cancel-quiet" }
    | { kind: "cancel-continuation"; index: number }
    | { kind: "fire-timer"; skew: number }
    | { kind: "advance"; ms: number };

  const runQuietCancelRace = async (stopped: readonly string[], ops: readonly RaceOp[]) => {
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
  };

  it.each([
    {
      label: "continuation cancelled while quieting",
      stopped: ["t0"],
      ops: [
        { kind: "begin-quiet" as const },
        { kind: "cancel-continuation" as const, index: 0 },
        { kind: "cancel-quiet" as const },
      ],
    },
    {
      label: "providers become ready while quieting",
      stopped: ["t0", "t1"],
      ops: [
        { kind: "begin-quiet" as const },
        { kind: "providers-ready" as const },
        { kind: "cancel-quiet" as const },
      ],
    },
    {
      label: "scheduled continuation becomes due while quieting",
      stopped: ["t0", "t1"],
      ops: [
        { kind: "providers-ready" as const },
        { kind: "begin-quiet" as const },
        { kind: "advance" as const, ms: 600 },
        { kind: "cancel-quiet" as const },
      ],
    },
  ])("preserves gate invariants across shrunk quiet-then-cancel counterexample ($label)", async ({ stopped, ops }) => {
    await runQuietCancelRace(stopped, ops);
  });

  it("preserves provider readiness, due timers, and cancellations across quiet-then-cancel races", async () => {
    const opArb: fc.Arbitrary<RaceOp> = fc.oneof(
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
        await runQuietCancelRace(stopped, ops);
      },
    ), { numRuns: 5 });
  });

  it.each([
    [1, 1],
    [2, 3],
    [4, 2],
  ] as const)(
    "does not let %d held continuation(s) steal batch-0 slots or inflate the deadline for %d pending continuation(s)",
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
        const status = fixture.registry.getRestartGateStatus();
        const expectedReleaseBy = 1_000_000 + Math.floor((pendingCount - 1) / heldCount) * 45_000 + 60_000;
        expect(status).toEqual({
          phase: "resuming",
          waiting: pendingCount,
          nextAt: 1_000_000,
          releaseBy: expectedReleaseBy,
        });
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
  );
});
