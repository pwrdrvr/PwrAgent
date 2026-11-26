import { buildFederatedThreadRef } from "@pwragent/shared/contracts/federation";
import { type NavigationSnapshot, type NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { RemoteThreadSummaryCache } from "../federation/remote-thread-summary-cache";

it("cache-only link fallbacks preserve owner rows without creating or widening peer demand", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    connected: fc.boolean(), known: fc.boolean(),
  }), { minLength: 1, maxLength: 10 }), async (encounters) => {
    const target = { scope: "remote" as const, instanceId: "peer" };
    const ref = buildFederatedThreadRef({ backend: "codex", threadId: "known", instanceId: target.instanceId });
    const row: NavigationThreadSummary = { id: ref.threadId, source: ref.backend, title: "Known", titleSource: "explicit",
      linkedDirectories: [], inbox: { inInbox: false }, federation: { ref, instanceLabel: "Peer", peerStatus: "connected" } };
    const snapshot: NavigationSnapshot = { backend: "all", fetchedAt: 0, unchanged: false,
      threads: [row], directories: [], inboxThreadKeys: [],
      launchpadDefaults: { backend: "codex", executionMode: "default" },
    };
    const fetchSnapshot = vi.fn(async () => snapshot);
    const fetchPinnedSnapshot = vi.fn(async () => snapshot);
    const onPeerInterestChanged = vi.fn();
    let connected = true;
    const cache = new RemoteThreadSummaryCache({
      peers: () => connected ? [{ target, label: "Peer", capabilities: ["thread_navigation"] }] : [],
      fetchSnapshot, fetchPinnedSnapshot, fetchArchivedThreads: async () => [], onPeerInterestChanged,
      peerStatus: () => ({ status: connected ? "connected" : "disconnected", label: "Peer" }),
    });
    try {
      expect(await cache.threadFromPeer({ target, backend: ref.backend, threadId: ref.threadId })).toBe(row);
      const interests = onPeerInterestChanged.mock.calls.length;
      for (const encounter of encounters) {
        connected = encounter.connected;
        const rows = cache.resolveWatchedThreads([encounter.known ? ref
          : buildFederatedThreadRef({ backend: "codex", threadId: "cold", instanceId: target.instanceId })], { cacheOnly: true });
        expect(rows.map((thread) => thread.id)).toEqual(encounter.known ? [ref.threadId] : []);
        if (encounter.known && !connected) expect(rows[0]?.federation?.peerStatus).toBe("disconnected");
      }
      expect(fetchSnapshot).toHaveBeenCalledTimes(1);
      expect(fetchPinnedSnapshot).not.toHaveBeenCalled();
      expect(onPeerInterestChanged).toHaveBeenCalledTimes(interests);
    } finally {
      cache.dispose();
    }
  }), { numRuns: 25 });
});

it("coalesces bursts and disconnect/reconnect storms to one in-flight refresh per peer while converging to latest state", async () => {
  type Step =
    | { kind: "mutateAndInvalidate"; count: number }
    | { kind: "disconnect" }
    | { kind: "reconnect" }
    | { kind: "completeNextFetch"; fail: boolean };
  const stepArb: fc.Arbitrary<Step> = fc.oneof(
    fc.record({ kind: fc.constant("mutateAndInvalidate" as const), count: fc.integer({ min: 1, max: 5 }) }),
    fc.constant({ kind: "disconnect" as const }),
    fc.constant({ kind: "reconnect" as const }),
    fc.record({ kind: fc.constant("completeNextFetch" as const), fail: fc.boolean() }),
  );

  await fc.assert(fc.asyncProperty(
    fc.array(stepArb, { minLength: 3, maxLength: 20 }),
    async (steps) => {
      const target = { scope: "remote" as const, instanceId: "peer" };
      const ref = buildFederatedThreadRef({ backend: "codex", threadId: "root", instanceId: target.instanceId });
      let connected = true;
      let ownerRevision = 0;
      let activeFetches = 0;
      let maxConcurrentFetches = 0;
      let totalFetches = 0;
      const pending: Array<{
        revision: number;
        resolve: (snapshot: NavigationSnapshot) => void;
        reject: (error: Error) => void;
      }> = [];

      const makeRow = (revision: number): NavigationThreadSummary => ({
        id: ref.threadId,
        source: ref.backend,
        title: `Rev ${revision}`,
        titleSource: "explicit",
        linkedDirectories: [],
        inbox: { inInbox: false },
        federation: { ref, instanceLabel: "Peer", peerStatus: "connected" },
      });

      const fetchPinnedSnapshot = vi.fn((): Promise<NavigationSnapshot> => {
        activeFetches += 1;
        totalFetches += 1;
        maxConcurrentFetches = Math.max(maxConcurrentFetches, activeFetches);
        const capturedRevision = ownerRevision;
        return new Promise<NavigationSnapshot>((resolve, reject) => {
          pending.push({
            revision: capturedRevision,
            resolve: (snapshot) => { activeFetches -= 1; resolve(snapshot); },
            reject: (error) => { activeFetches -= 1; reject(error); },
          });
        });
      });

      const published = vi.fn();
      const cache = new RemoteThreadSummaryCache({
        peers: () => connected ? [{ target, label: "Peer", capabilities: ["thread_navigation"] }] : [],
        peerStatus: () => ({ status: connected ? "connected" : "disconnected", label: "Peer" }),
        fetchSnapshot: fetchPinnedSnapshot,
        fetchPinnedSnapshot,
        fetchArchivedThreads: async () => [],
        hasNavigationSubscription: () => connected,
        onPinnedSummariesRefreshed: published,
      });

      const flushMicrotasks = async () => {
        for (let i = 0; i < 20; i++) await Promise.resolve();
      };

      const finishOne = async (fail: boolean) => {
        const next = pending.shift();
        if (!next) return false;
        if (fail) {
          next.reject(new Error("simulated disconnect"));
        } else {
          next.resolve({
            backend: "all",
            fetchedAt: next.revision,
            unchanged: false,
            threads: [makeRow(next.revision)],
            directories: [],
            inboxThreadKeys: [],
            launchpadDefaults: { backend: "codex", executionMode: "default" },
          });
        }
        await flushMicrotasks();
        return true;
      };

      try {
        const initialResolve = cache.resolvePinnedThreads([{ ref, addedAt: 0, instanceLabel: "Peer", summary: makeRow(0) }]);
        await flushMicrotasks();
        await finishOne(false);
        await initialResolve;
        await flushMicrotasks();

        const fetchesBefore = totalFetches;
        let invalidateEvents = 0;
        let completions = 0;

        for (const step of steps) {
          if (step.kind === "mutateAndInvalidate") {
            for (let i = 0; i < step.count; i++) {
              ownerRevision += 1;
              invalidateEvents += 1;
              cache.invalidate(target.instanceId);
            }
            await flushMicrotasks();
          } else if (step.kind === "disconnect") {
            connected = false;
            cache.invalidate(target.instanceId);
            await flushMicrotasks();
          } else if (step.kind === "reconnect") {
            connected = true;
            cache.invalidate(target.instanceId);
            await flushMicrotasks();
          } else if (step.kind === "completeNextFetch") {
            if (await finishOne(step.fail)) completions += 1;
          }
          expect(maxConcurrentFetches).toBeLessThanOrEqual(1);
        }

        // End connected and settle all remaining in-flight / follow-up refreshes.
        connected = true;
        cache.invalidate(target.instanceId);
        await flushMicrotasks();
        let drainGuard = 0;
        while (pending.length > 0 && drainGuard < 20) {
          drainGuard += 1;
          await finishOne(false);
        }
        expect(pending).toHaveLength(0);
        expect(maxConcurrentFetches).toBeLessThanOrEqual(1);
        // Bounded coalescing: never more fetches than completions + initial + final settle.
        expect(totalFetches - fetchesBefore).toBeLessThanOrEqual(completions + 3);
        expect(invalidateEvents).toBeGreaterThanOrEqual(0);

        const settled = await cache.resolvePinnedThreads([{ ref, addedAt: 0, instanceLabel: "Peer", summary: makeRow(0) }]);
        expect(settled.threads[0]?.title).toBe(`Rev ${ownerRevision}`);
      } finally {
        while (pending.length > 0) {
          pending.shift()?.reject(new Error("disposed"));
        }
        cache.dispose();
      }
    },
  ), { numRuns: 30 });
});
