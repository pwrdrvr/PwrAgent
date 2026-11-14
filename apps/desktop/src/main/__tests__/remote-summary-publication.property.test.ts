import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { buildFederatedThreadRef, type NavigationSnapshot, type NavigationThreadSummary } from "@pwragent/shared";
import { RemoteThreadSummaryCache } from "../federation/remote-thread-summary-cache";

async function advance() { for (let i = 0; i < 120; i++) await Promise.resolve(); }

it("publishes row exclusions only when the last published owner population has identical membership and placement", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({
    index: fc.integer({ min: 0, max: 3 }), membership: fc.boolean(),
  }), { minLength: 2, maxLength: 10 }), async (operations) => {
    const ref = buildFederatedThreadRef({ backend: "codex", threadId: "root", instanceId: "peer" });
    let threads: NavigationThreadSummary[] = Array.from({ length: 4 }, (_, i) => ({
      id: i ? "child" : "root", source: i === 3 ? "claude" : "codex", title: "Initial", titleSource: "explicit",
      inbox: { inInbox: false }, linkedDirectories: [], ...(i ? { parentThreadId: "root", parentThreadBackend: "codex" as const, parentThreadInstanceId: "peer" } : {}),
      federation: { ref: buildFederatedThreadRef({ backend: i === 3 ? "claude" : "codex", threadId: i ? "child" : "root",
        instanceId: i === 2 ? "nested-peer" : "peer" }), instanceLabel: "Peer", peerStatus: "connected" },
    }));
    const fetch = vi.fn(async (): Promise<NavigationSnapshot> => ({ backend: "all", unchanged: false,
      fetchedAt: 0, threads: structuredClone(threads), directories: [], inboxThreadKeys: [],
      launchpadDefaults: { backend: "codex", executionMode: "default" } }));
    const published = vi.fn();
    const cache = new RemoteThreadSummaryCache({ peers: () => [{ target: ref.target as { scope: "remote"; instanceId: string },
      label: "Peer", capabilities: ["thread_navigation"] }], peerStatus: () => ({ status: "connected" }),
      fetchSnapshot: fetch, fetchPinnedSnapshot: fetch, fetchArchivedThreads: async () => [],
      hasNavigationSubscription: () => true, onPinnedSummariesRefreshed: published,
    });
    try {
      await cache.resolvePinnedThreads([{ ref, addedAt: 0, instanceLabel: "Peer", summary: threads[0] }]);
      await advance(); expect(published).toHaveBeenCalled(); published.mockClear();
      for (const [step, op] of operations.entries()) {
        const changed = threads[op.index]!;
        // Mutate the owner, not the test expectation. The cache takes its own
        // observation; the published baseline must survive later mutation.
        if (op.membership) changed.linkedDirectories = [{ id: String(step), kind: "local", label: "Project", path: `/project-${step}` }];
        else changed.title = `Fresh ${step}`;
        cache.invalidate("peer"); await advance();
        expect(published).toHaveBeenCalledTimes(1);
        expect(published.mock.calls[0]).toEqual(op.membership ? ["peer"]
          : ["peer", [{ backend: changed.source, threadId: changed.id,
            ownerInstanceId: changed.federation!.ref.target.scope === "remote" ? changed.federation!.ref.target.instanceId : "peer" }]]);
        published.mockClear();
      }
    } finally { cache.dispose(); }
  }), { numRuns: 25 });
});

it("withdraws the row proof exactly at the UTF-8 notification byte boundary", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 16_383, max: 16_385 }), async (bytes) => {
    const changes = Array.from({ length: 20 }, (_, i) => ({ backend: "codex" as const, threadId: `row-${i}-`, ownerInstanceId: "peer" }));
    const padding = bytes - Buffer.byteLength(JSON.stringify(changes), "utf8");
    changes.forEach((ref, i) => { ref.threadId += "x".repeat(Math.floor(padding / changes.length) + (i < padding % changes.length ? 1 : 0)); });
    expect(Buffer.byteLength(JSON.stringify(changes), "utf8")).toBe(bytes);
    let threads: NavigationThreadSummary[] = changes.map((ref) => ({ id: ref.threadId, source: ref.backend,
      title: "Initial", titleSource: "explicit", inbox: { inInbox: false }, linkedDirectories: [] }));
    const pins = changes.map((ref) => ({ ref: buildFederatedThreadRef({ backend: ref.backend, threadId: ref.threadId, instanceId: "peer" }),
      addedAt: 0, instanceLabel: "Peer" }));
    const fetch = async (): Promise<NavigationSnapshot> => ({ backend: "all", unchanged: false, fetchedAt: 0,
      threads, directories: [], inboxThreadKeys: [], launchpadDefaults: { backend: "codex", executionMode: "default" } });
    const published = vi.fn();
    const cache = new RemoteThreadSummaryCache({ peers: () => [{ target: { scope: "remote", instanceId: "peer" },
      label: "Peer", capabilities: ["thread_navigation"] }], peerStatus: () => ({ status: "connected" }),
      fetchSnapshot: fetch, fetchPinnedSnapshot: fetch, fetchArchivedThreads: async () => [],
      hasNavigationSubscription: () => true, onPinnedSummariesRefreshed: published,
    });
    try {
      await cache.resolvePinnedThreads(pins); await advance(); published.mockClear();
      threads = threads.map((thread) => ({ ...thread, title: "Fresh" }));
      cache.invalidate("peer"); await advance();
      expect(published.mock.calls).toEqual([bytes <= 16 * 1024 ? ["peer", changes] : ["peer"]]);
    } finally { cache.dispose(); }
  }), { numRuns: 10, examples: [[16_384], [16_385]] });
});

it("bounds notification identities without truncating expanded owner populations", async () => {
  // Cross the exact notification bound. More than 100 changed rows must
  // withdraw the exclusion proof, while every row still reaches navigation.
  await fc.assert(fc.asyncProperty(fc.integer({ min: 95, max: 105 }), async (count) => {
    let threads: NavigationThreadSummary[] = Array.from({ length: count }, (_, i) => ({
      id: i ? `child-${i}` : "root", source: "codex", title: "Initial", titleSource: "explicit",
      inbox: { inInbox: false }, linkedDirectories: [], ...(i ? { parentThreadId: "root", parentThreadBackend: "codex" as const } : {}),
    }));
    const published = vi.fn();
    const fetch = async (): Promise<NavigationSnapshot> => ({ backend: "all", unchanged: false,
      fetchedAt: 0, threads, directories: [], inboxThreadKeys: [], launchpadDefaults: { backend: "codex", executionMode: "default" } });
    const cache = new RemoteThreadSummaryCache({ peers: () => [{ target: { scope: "remote", instanceId: "peer" },
      label: "Peer", capabilities: ["thread_navigation"] }], peerStatus: () => ({ status: "connected" }),
      fetchSnapshot: fetch, fetchPinnedSnapshot: fetch, fetchArchivedThreads: async () => [],
      hasNavigationSubscription: () => true, onPinnedSummariesRefreshed: published,
    });
    const pins = threads.map((thread) => ({ ref: buildFederatedThreadRef({ backend: thread.source, threadId: thread.id, instanceId: "peer" }),
      addedAt: 0, instanceLabel: "Peer", summary: thread }));
    try {
      await cache.resolvePinnedThreads(pins); await advance(); published.mockClear();
      threads = threads.map((thread) => ({ ...thread, title: "Fresh" }));
      cache.invalidate("peer"); await advance();
      const changed = published.mock.calls[0];
      expect(published).toHaveBeenCalledTimes(1);
      if (count <= 100) expect(changed?.[1]).toEqual(threads.map((thread) => ({ backend: thread.source, threadId: thread.id, ownerInstanceId: "peer" })));
      else expect(changed).toEqual(["peer"]);
      expect((await cache.resolvePinnedThreads(pins)).threads).toHaveLength(count);
    } finally { cache.dispose(); }
  }), { numRuns: 25, examples: [[100], [101]] });
});
