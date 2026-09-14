import { expect, it } from "vitest";
import type { AgentEvent, FederationProtocolEnvelope, NavigationThreadSummary, NavigationSnapshot } from "@pwragent/shared";
import { buildFederatedThreadRef } from "@pwragent/shared";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import { FederationRouter } from "../federation/federation-router";
import { RemoteThreadSummaryCache } from "../federation/remote-thread-summary-cache";
import { readFederationPinnedSnapshot } from "../federation/federation-collection-client";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import type { FederationBackendOperations } from "../federation/federation-backend-bridge";

// Four viewers on one owner, matching the reported fan-out. Measures actual
// protocol-2 page JSON, excluding transport envelopes, encryption and relays.
it("budgets same-owner invalidation fan-out across four pinned viewers", async () => {
  const capabilities = ["thread_navigation", "event_subscriptions", "navigation_group_invalidations", "navigation_snapshot_deltas"] as const;
  const owner = new DesktopFederationRuntime() as unknown as {
    localInstanceId: string;
    router: FederationRouter;
    applyEventSubscription: (envelope: FederationProtocolEnvelope, peerId: string) => boolean;
    forwardLocalBackendEvent: (event: AgentEvent) => void;
  };
  owner.localInstanceId = "owner_one";
  owner.router = new FederationRouter({ localInstanceId: "owner_one" });
  const thread = (id: string, parentThreadId?: string): NavigationThreadSummary => ({
    source: "codex", id, title: `Thread ${id}`, linkedDirectories: [], inbox: { inInbox: false },
    ...(parentThreadId ? { parentThreadId, parentThreadBackend: "codex" } : {}),
  } as unknown as NavigationThreadSummary);
  const rows = Array.from({ length: 4 }, (_, i) => [thread(`root-${i}`),
    ...Array.from({ length: 50 }, (_, j) => thread(`child-${i}-${j}`, `root-${i}`))]).flat();
  rows.push(thread("unrelated"));
  const index = (): NavigationSnapshot => ({ backend: "all", fetchedAt: 1, unchanged: false, threads: rows,
    inboxThreadKeys: [], directories: [], launchpadDefaults: { backend: "codex", executionMode: "default" } });
  const store = new NavigationQueryStore();
  const caches: RemoteThreadSummaryCache[] = [];
  const traffic = { subscriptions: 0, notifications: 0, requests: 0, responseRows: 0, responseBytes: 0 };
  const clear = () => { traffic.subscriptions = traffic.notifications = traffic.requests = traffic.responseRows = traffic.responseBytes = 0; };
  const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
  const emit = async (sourceMethod: string, threadId?: string) => {
    owner.forwardLocalBackendEvent({ backend: "codex", notification: {
      method: "navigation/invalidated", params: { sourceMethod, ...(threadId ? { threadId } : {}) },
    } });
    await settle();
  };
  try {
    for (let i = 0; i < 4; i++) {
      const viewer = `viewer_${i}`;
      const viewerRuntime = new DesktopFederationRuntime();
      const viewerState = viewerRuntime as unknown as { localInstanceId: string; router: FederationRouter };
      viewerState.localInstanceId = viewer;
      viewerState.router = new FederationRouter({ localInstanceId: viewer });
      viewerState.router.registerConnection({ peerId: "owner_one", capabilities: [...capabilities], sendEnvelope: (envelope) => {
        traffic.subscriptions++;
        owner.applyEventSubscription(envelope, viewer);
      } });
      const backend = { getNavigationQueryPage: async (request) => {
        traffic.requests++;
        const page = await store.readPage({ request, scopeKey: viewer, loadIndex: async () => index() });
        traffic.responseRows += page.entries.length;
        traffic.responseBytes += Buffer.byteLength(JSON.stringify(page));
        return page;
      } } satisfies Partial<FederationBackendOperations>;
      const cache = new RemoteThreadSummaryCache({
        peers: () => [{ target: { scope: "remote", instanceId: "owner_one" }, label: "Owner", capabilities: [...capabilities] }],
        peerStatus: () => ({ status: "connected" }), hasNavigationSubscription: () => true,
        fetchSnapshot: async () => { throw new Error("Full snapshot forbidden"); }, fetchArchivedThreads: async () => [],
        fetchPinnedSnapshot: (_target, keys, options, state) => readFederationPinnedSnapshot(backend as FederationBackendOperations, keys, options, state),
        onPeerInterestChanged: (interests) => {
          viewerRuntime.setEventSubscriptions("pins", interests.map((interest) => ({
            sourceInstanceId: interest.instanceId, eventClasses: ["navigation"], threadSelection: interest.threadSelection,
          })));
        },
      });
      caches.push(cache);
      owner.router.registerConnection({ peerId: viewer, capabilities: [...capabilities],
        sendEnvelope: (envelope) => {
          if (envelope.kind !== "notification" || envelope.method !== "backend.event") return;
          traffic.notifications++;
          cache.invalidate("owner_one", envelope.params as AgentEvent);
        },
      });
      await cache.resolvePinnedThreads([{ ref: buildFederatedThreadRef({ backend: "codex", instanceId: "owner_one", threadId: `root-${i}` }), addedAt: 1, instanceLabel: "Owner" }]);
    }
    await settle();
    expect(traffic.requests).toBe(4);
    const cold = { ...traffic };
    clear();
    for (let i = 0; i < 27; i++) await emit("thread/status/changed", "unrelated");
    expect(traffic).toEqual({ subscriptions: 0, notifications: 0, requests: 0, responseRows: 0, responseBytes: 0 });
    const unrelated = { ...traffic };
    clear();
    for (let i = 0; i < 27; i++) await emit("navigation/providerThreads/refreshed");
    expect(traffic.requests).toBe(108);
    expect(traffic.subscriptions).toBe(0);
    expect(traffic.responseRows).toBe(0);
    expect(traffic.responseBytes).toBeLessThan(cold.responseBytes * 27 / 10);
    const unchanged = { ...traffic };
    clear();
    rows.push(thread("new-grandchild", "child-0-0"));
    await emit("thread/parent/set", "new-grandchild");
    expect(traffic.requests).toBe(5);
    expect(traffic.subscriptions).toBe(1);
    expect(traffic.responseRows).toBe(52);
    const discovery = { ...traffic };
    clear();
    rows.find((row) => row.id === "new-grandchild")!.title = "Updated grandchild";
    await emit("thread/name/updated", "new-grandchild");
    expect(traffic.notifications).toBe(1);
    expect(traffic.requests).toBe(1);
    expect({ cold, unrelated, unchanged, discovery, changedMember: { ...traffic } }).toMatchSnapshot();
  } finally { for (const cache of caches) cache.dispose(); }
});
