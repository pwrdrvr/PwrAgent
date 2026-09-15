import { expect, it } from "vitest";
import type { AgentEvent, FederationProtocolEnvelope, NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared";
import { buildFederatedThreadRef } from "@pwragent/shared";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import { FederationRouter } from "../federation/federation-router";
import { RemoteThreadSummaryCache } from "../federation/remote-thread-summary-cache";
import { readFederationPinnedSnapshot } from "../federation/federation-collection-client";
import { RemoteNavigationPageBaselines } from "../federation/remote-navigation-page-baselines";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import { NavigationWindowQueries } from "../../renderer/src/lib/navigation-window-queries";
import type { FederationBackendOperations } from "../federation/federation-backend-bridge";

// RPC JSON, separated by initiating consumer. No compression, encryption,
// gateway relay copies or blob operations are included in these measurements.
it.each(["separate", "shared"])("budgets pin and renderer reads with four viewers and two active owner threads (%s mounts)", async (layout) => {
  const capabilities = ["thread_navigation", "event_subscriptions", "navigation_group_invalidations"] as const;
  const owner = new DesktopFederationRuntime() as unknown as {
    localInstanceId: string; router: FederationRouter;
    applyEventSubscription: (envelope: FederationProtocolEnvelope, peerId: string) => boolean;
    forwardLocalBackendEvent: (event: AgentEvent) => void;
  };
  owner.localInstanceId = "owner";
  owner.router = new FederationRouter({ localInstanceId: "owner" });
  const rows = Array.from({ length: 4 }, (_, i) => Array.from({ length: 11 }, (_, j) => ({
    source: "codex", id: `${i}-${j}`, title: `Thread ${i}-${j}`, titleSource: "explicit", linkedDirectories: [], projectKey: `/fixture/${i}`,
    inbox: { inInbox: false }, ...(j ? { parentThreadId: `${i}-0`, parentThreadBackend: "codex" } : {}),
  } as NavigationThreadSummary))).flat();
  const store = new NavigationQueryStore();
  const caches: RemoteThreadSummaryCache[] = [];
  const windows: NavigationWindowQueries[] = [];
  const sample = () => ({ requests: 0, requestBytes: 0, responseBytes: 0, responseRows: 0, unchanged: 0 });
  let traffic = { notifications: 0, pins: sample(), renderer: sample() };
  const measurements: Record<string, typeof traffic> = {};
  const capture = (name: string) => { measurements[name] = traffic; traffic = { notifications: 0, pins: sample(), renderer: sample() }; };
  const settle = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
  const target = { scope: "remote" as const, instanceId: "owner" };
  const emit = async (sourceMethod: string, threadId?: string, worktreePath?: string) => {
    owner.forwardLocalBackendEvent({ backend: "codex", notification: { method: "navigation/invalidated",
      params: { sourceMethod, threadId, worktreePath } } });
    await settle();
    await Promise.all(windows.map((window) => window.refresh(undefined, [target], true)));
    await settle();
  };
  try {
    for (let i = 0; i < 4; i++) {
      const viewer = `viewer-${i}`;
      const read = async (kind: "pins" | "renderer", request: NavigationQueryRequest) => {
        const page = await store.readPage({ request, scopeKey: viewer, loadIndex: async () => ({ threads: rows, directories: [] }) });
        traffic[kind].requests++;
        traffic[kind].requestBytes += Buffer.byteLength(JSON.stringify(request));
        traffic[kind].responseBytes += Buffer.byteLength(JSON.stringify(page));
        traffic[kind].responseRows += page.entries.length;
        traffic[kind].unchanged += Number(page.unchanged === true);
        return page;
      };
      const baselines = new RemoteNavigationPageBaselines();
      const window = new NavigationWindowQueries({ getNavigationQueryPage: (request) => baselines.read(request, (next) => read("renderer", next)) });
      windows.push(window);
      const runtime = new DesktopFederationRuntime();
      const state = runtime as unknown as { localInstanceId: string; router: FederationRouter };
      state.localInstanceId = viewer;
      state.router = new FederationRouter({ localInstanceId: viewer });
      state.router.registerConnection({ peerId: "owner", capabilities: [...capabilities], sendEnvelope: (envelope) => { owner.applyEventSubscription(envelope, viewer); } });
      const backend = { getNavigationQueryPage: (request: NavigationQueryRequest) => read("pins", request) } as FederationBackendOperations;
      const cache = new RemoteThreadSummaryCache({ peers: () => [{ target, label: "Owner", capabilities: [...capabilities] }],
        peerStatus: () => ({ status: "connected" }), hasNavigationSubscription: () => true,
        fetchSnapshot: async () => { throw new Error("Full snapshot forbidden"); }, fetchArchivedThreads: async () => [],
        fetchPinnedSnapshot: (_target, keys, options, baseline) => readFederationPinnedSnapshot(backend, keys, options, baseline),
        onPeerInterestChanged: (interests) => runtime.setEventSubscriptions("pins", interests.map((interest) => ({
          sourceInstanceId: interest.instanceId, eventClasses: ["navigation"], threadSelection: interest.threadSelection,
        }))),
      });
      caches.push(cache);
      owner.router.registerConnection({ peerId: viewer, capabilities: [...capabilities], sendEnvelope: (envelope) => {
        if (envelope.kind !== "notification" || envelope.method !== "backend.event") return;
        traffic.notifications++;
        const event = envelope.params as AgentEvent;
        cache.invalidate("owner", event);
        window.invalidate(undefined, [target], event);
      } });
      await cache.resolvePinnedThreads((layout === "shared" ? [0, 1] : [i]).map((root) => ({
        ref: buildFederatedThreadRef({ backend: "codex", instanceId: "owner", threadId: `${root}-0` }), addedAt: 1, instanceLabel: "Owner",
      })));
      window.setDemand(new Map([0, 1].map((j) => [`exact-${j}`, { protocol: 2, consumer: "main-sidebar", inventory: "owner",
        federationTarget: target, query: { kind: "exact", identities: [{ backend: "codex", threadId: layout === "shared" ? `${j}-0` : `${i}-${j}` }] }, pageSize: 100 }])));
    }
    await settle();
    capture("cold");
    // Even viewers mounting the active parent need no navigation read for
    // accounting-only updates. Exact subagent detail keeps its own stream.
    for (let i = 0; i < 27; i++) for (const threadId of ["0-0", "1-0"]) {
      owner.forwardLocalBackendEvent({ backend: "codex", notification: { method: "thread/subAgents/updated",
        params: { threadId, navigationChanged: false } } });
      await settle();
      await Promise.all(windows.map((window) => window.refresh(undefined, [target], true)));
    }
    capture("accountingOnly");
    for (let i = 0; i < 27; i++) await emit("thread/subAgents/updated", "unmounted");
    capture("unrelatedSubagents");
    for (let i = 0; i < 27; i++) for (const id of ["0-0", "1-0"]) await emit("thread/subAgents/updated", id);
    capture("twoActiveParents");
    await emit("navigation/threadGitWorkingState/updated", undefined, "/fixture/0");
    capture("oneWorktree");
    rows.push({ ...rows[0]!, id: "new-child", parentThreadId: "0-0", parentThreadBackend: "codex" });
    await emit("thread/parent/set", "new-child");
    capture("childDiscovery");
    expect(measurements).toMatchSnapshot();
    expect(measurements.unrelatedSubagents!.pins.requests).toBe(0);
    expect(measurements.unrelatedSubagents!.renderer.requests).toBe(0);
    expect(measurements.twoActiveParents!.pins.requests).toBe(layout === "shared" ? 216 : 54);
    expect(measurements.twoActiveParents!.renderer.requests).toBe(layout === "shared" ? 216 : 54);
    expect(measurements.oneWorktree!.pins.requests).toBe(layout === "shared" ? 4 : 1);
    expect(measurements.oneWorktree!.renderer.requests).toBe(layout === "shared" ? 4 : 2);
  } finally { for (const cache of caches) cache.dispose(); for (const window of windows) window.dispose(); }
});
