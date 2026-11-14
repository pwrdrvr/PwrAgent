import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { archiveCoordinatorStandIn } from "./helpers/archive-coordinator-stand-in";
import { ArchiveCandidateDiscovery, archiveCandidateCheckpoint } from "../app-server/archive-candidate-discovery";

// Exercise real host turns without spending wall time on each owned rest.
vi.mock("node:timers/promises", () => ({ setTimeout: async (ms: number) => {
  expect(ms).toBe(25);
  await new Promise<void>((resolve) => setImmediate(resolve));
} }));

afterEach(() => vi.restoreAllMocks());

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function fixture(count: number) {
  const lifecycle = { closed: false };
  const rows: AppServerThreadSummary[] = Array.from({ length: count }, (_, id) => ({
    id: String(id), source: "codex", title: String(id), titleSource: "explicit", threadStatus: "idle", updatedAt: 1,
    projectKey: `/fixture/checkout-${id % 3}`, linkedDirectories: [],
  }));
  const store = {
    listAllActivePrStatusWatches: vi.fn(async () => []),
    getThreadOverlayStates: vi.fn(async () => ({})),
    getThreadListingOverlayStates: vi.fn(async () => ({})),
    listActiveThreadSubAgents: vi.fn(async () => []),
    listArchiveActiveSubAgentThreadIds: vi.fn(async () => []),
    listFinishedMonitorWorkerThreadKeys: vi.fn(async () => []),
  };
  const resolveWorkspace = vi.fn(async () => undefined);
  const page = vi.fn(async ({ archived, cursor, limit }: { archived: boolean; cursor?: string; limit: number }) => {
    const start = Number(cursor ?? 0);
    return { threads: archived ? [] : rows.slice(start, start + limit),
      nextCursor: !archived && start + limit < rows.length ? String(start + limit) : undefined };
  });
  const coordinator = archiveCoordinatorStandIn({ lifecycle, overlayStore: store,
    registry: () => ({ subAgentStartupReconciliation: Promise.resolve(),
      isBootstrapModeFn: () => false, isCodexBootstrapDeferredFn: () => false,
      acpWorktreeRepositoryResolver: resolveWorkspace }),
    providers: { codex: { listArchiveCleanupThreadsPage: page },
      acp: { archiveCleanupBackendIds: async () => [] }, claude: { listThreads: async () => [] } },
  });
  return { coordinator, lifecycle, store, rows, page, resolveWorkspace };
}

describe("complete housekeeping candidate discovery", () => {
  // Rule: even when every dependency resolves in microtasks, a large read
  // must let the host event loop run before issuing another provider page.
  it("lets a host heartbeat run between provider pages for every large inventory", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1001, max: 2001 }), async (count) => {
      const run = fixture(count);
      let heartbeat = false;
      const beat = setImmediate(() => { heartbeat = true; });
      const observed: boolean[] = [];
      run.page.mockImplementation(async ({ archived, cursor, limit }) => {
        observed.push(heartbeat);
        const start = Number(cursor ?? 0);
        return { threads: archived ? [] : run.rows.slice(start, start + limit),
          nextCursor: !archived && start + limit < count ? String(start + limit) : undefined };
      });
      try {
        expect(await run.coordinator.listAutoArchiveCandidates()).toHaveLength(count);
        expect(observed.slice(1).every(Boolean)).toBe(true);
      } finally { clearImmediate(beat); }
    }), { numRuns: 5 });
  });

  // Rule: provider membership is complete, but histories and one subagent
  // query per identity are unnecessary. Bound each synchronous overlay read.
  it("bounds overlay slices and batches subagent protection without dropping identities", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 26, max: 101 }), async (count) => {
      const run = fixture(count);
      const result = await run.coordinator.listAutoArchiveCandidates();
      expect(result.map(({ thread }) => thread.id)).toEqual(run.rows.map((thread) => thread.id));
      expect(run.store.getThreadOverlayStates).not.toHaveBeenCalled();
      expect(run.store.listActiveThreadSubAgents).not.toHaveBeenCalled();
      const calls = run.store.getThreadListingOverlayStates.mock.calls as unknown as Array<[{ threadIds: string[]; withPrAutoDispatchPending: boolean }]>;
      expect(calls).toHaveLength(Math.ceil(count / 25));
      expect(calls.every(([params]) => params.threadIds.length <= 25 && params.withPrAutoDispatchPending)).toBe(true);
      expect(run.store.listArchiveActiveSubAgentThreadIds).toHaveBeenCalledTimes(calls.length);
      expect(run.resolveWorkspace).toHaveBeenCalledTimes(3);
    }), { numRuns: 5 });
  });

  it("owns one concurrent exploratory inventory and reads again after it settles (model)", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 2, max: 5 }), async (readers) => {
      const run = fixture(3);
      const entered = deferred();
      const release = deferred();
      run.page.mockImplementationOnce(async () => {
        entered.resolve();
        await release.promise;
        return { threads: run.rows, nextCursor: undefined };
      });
      const pending = Array.from({ length: readers }, () => run.coordinator.listAutoArchiveCandidates());
      await entered.promise;
      release.resolve();
      const results = await Promise.all(pending);
      expect(results.every((result) => result.length === 3)).toBe(true);
      expect(run.page).toHaveBeenCalledTimes(2);
      run.rows.push({ id: "new-owner", source: "codex", title: "new", titleSource: "explicit", linkedDirectories: [] });
      expect(await run.coordinator.listAutoArchiveCandidates()).toHaveLength(4);
      expect(run.page).toHaveBeenCalledTimes(4);
    }), { numRuns: 5 });
  });

  it("stops discovery before the next provider or store operation when shutdown closes admission", async () => {
    const run = fixture(300);
    run.page.mockImplementationOnce(async () => {
      run.lifecycle.closed = true;
      return { threads: run.rows.slice(0, 100), nextCursor: "100" };
    });
    await expect(run.coordinator.listAutoArchiveCandidates()).rejects.toThrow(/cancel/i);
    expect(run.page).toHaveBeenCalledOnce();
    expect(run.store.getThreadOverlayStates).not.toHaveBeenCalled();
    expect(run.store.getThreadListingOverlayStates).not.toHaveBeenCalled();
  });

  it("keeps every identity in an unreadable subagent slice, and still resolves other slices", async () => {
    const run = fixture(51);
    run.store.listArchiveActiveSubAgentThreadIds.mockRejectedValueOnce(new Error("Unreadable card state"));
    const candidates = await run.coordinator.listAutoArchiveCandidates();
    expect(candidates).toHaveLength(51);
    expect(candidates.slice(0, 25).every((candidate) => candidate.unreadable)).toBe(true);
    expect(candidates.slice(25).every((candidate) => !candidate.unreadable)).toBe(true);
  });
});

describe("candidate discovery pacing and ownership", () => {
  it("yields at the row bound and rests at the elapsed-work bound or an explicit boundary (property)", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.record({ cost: fc.integer({ min: 0, max: 12 }), boundary: fc.boolean() }),
      { minLength: 40, maxLength: 100, size: "max" }), async (steps) => {
      let clock = 0;
      let lastRest = 0;
      let rows = 0;
      let rests = 0;
      let yields = 0;
      const checkpoint = archiveCandidateCheckpoint(() => {}, { now: () => clock,
        rest: async () => { rests += 1; }, yieldToHost: async () => { yields += 1; } });
      for (const step of steps) {
        clock += step.cost;
        rows += 1;
        const shouldRest = step.boundary || clock - lastRest >= 8;
        const shouldYield = !shouldRest && rows >= 16;
        const before = rests;
        const beforeYield = yields;
        await checkpoint(step.boundary);
        expect(rests - before).toBe(Number(shouldRest));
        expect(yields - beforeYield).toBe(Number(shouldYield));
        if (shouldRest) { rows = 0; lastRest = clock; }
        else if (shouldYield) rows = 0;
      }
    }));
    // Reach the exact row limit without either a time or a page boundary.
    let rests = 0;
    let yields = 0;
    const checkpoint = archiveCandidateCheckpoint(() => {}, { now: () => 0,
      rest: async () => { rests += 1; }, yieldToHost: async () => { yields += 1; } });
    for (let row = 0; row < 15; row += 1) await checkpoint();
    expect(rests).toBe(0);
    expect(yields).toBe(0);
    await checkpoint();
    expect(yields).toBe(1);
    expect(rests).toBe(0);
  });

  it("checks cancellation again after a pacing rest before resuming work", async () => {
    const release = deferred();
    let cancelled = false;
    const checkpoint = archiveCandidateCheckpoint(() => { if (cancelled) throw new Error("cancelled"); },
      { now: () => 0, rest: async () => { await release.promise; } });
    const waiting = checkpoint(true);
    cancelled = true;
    release.resolve();
    await expect(waiting).rejects.toThrow("cancelled");
  });

  it("cancels only the observer that leaves, and abandons work only after the last observer (model)", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 2, maxLength: 8 }), async (cancelled) => {
      const entered = deferred();
      const release = deferred();
      const signals: AbortSignal[] = [];
      const progress = vi.fn();
      const owner = new ArchiveCandidateDiscovery(async (publish, signal) => {
        signals.push(signal);
        entered.resolve();
        await release.promise;
        if (signal.aborted) throw new Error("cancelled");
        publish({ detail: "complete" });
        return [];
      });
      const controllers = cancelled.map(() => new AbortController());
      const results = controllers.map((controller) => owner.list(progress, controller.signal)
        .then(() => "complete", () => "cancelled"));
      await entered.promise;
      controllers.forEach((controller, index) => { if (cancelled[index]) controller.abort(); });
      expect(signals).toHaveLength(1);
      expect(signals[0]!.aborted).toBe(cancelled.every(Boolean));
      release.resolve();
      expect(await Promise.all(results)).toEqual(cancelled.map((value) => value ? "cancelled" : "complete"));
      expect(progress).toHaveBeenCalledTimes(cancelled.filter((value) => !value).length);
      await owner.close();
    }));
  });

  it("drains a failed pass and retries with a new owner instead of retaining a rejected cache", async () => {
    const read = vi.fn(async () => { throw new Error("provider failed"); });
    const owner = new ArchiveCandidateDiscovery(read);
    await expect(Promise.all([owner.list(), owner.list()])).rejects.toThrow("provider failed");
    expect(read).toHaveBeenCalledOnce();
    await expect(owner.list()).rejects.toThrow("provider failed");
    expect(read).toHaveBeenCalledTimes(2);
    await owner.close();
  });

  it("lets an abandoned provider read settle before starting a replacement owner", async () => {
    const entered = deferred();
    const release = deferred();
    const read = vi.fn(async () => []);
    read.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return []; });
    const owner = new ArchiveCandidateDiscovery(read);
    const abort = new AbortController();
    const abandoned = owner.list(undefined, abort.signal).catch(() => "cancelled");
    await entered.promise;
    abort.abort();
    const next = owner.list();
    await Promise.resolve();
    expect(read).toHaveBeenCalledOnce();
    release.resolve();
    expect(await abandoned).toBe("cancelled");
    expect(await next).toEqual([]);
    expect(read).toHaveBeenCalledTimes(2);
    await owner.close();
  });

  it("adds a shutdown barrier only while discovery owns work", async () => {
    const entered = deferred();
    const release = deferred();
    let signal!: AbortSignal;
    const owner = new ArchiveCandidateDiscovery(async (_publish, current) => {
      signal = current;
      entered.resolve();
      await release.promise;
      return [];
    });
    expect(owner.close()).toBeUndefined();
    const listing = owner.list();
    await entered.promise;
    const closing = owner.close();
    expect(closing).toBeInstanceOf(Promise);
    expect(signal.aborted).toBe(true);
    let closed = false;
    void closing!.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    release.resolve();
    await closing;
    await listing;
    expect(owner.close()).toBeUndefined();
  });
});
