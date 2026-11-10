import { buildFederatedThreadRef, type NavigationSnapshot, type NavigationThreadSummary } from "@pwragent/shared";
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
