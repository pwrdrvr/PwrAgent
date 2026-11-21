import { expect, it, onTestFinished, vi } from "vitest";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { FederationProtocolEnvelope } from "@pwragent/shared/contracts/federation";
import { buildThreadIdentityKey, type NavigationQueryRequest } from "@pwragent/shared/contracts/navigation";
import { navigationQueryEventRequiresRefresh } from "@pwragent/shared/navigation-query-events";
import { createNavigationQuerySnapshot } from "@pwragent/owner-core/navigation-query-projection";
import { NavigationWindowQueries } from "../../renderer/src/lib/navigation-window-queries";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import { FederationRouter } from "../federation/federation-router";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { MockBackendClient } from "./helpers/backend-registry-fixture";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { StateDb } from "../state/state-db";
import { createTempStateDb, removeTempStateDbDir } from "./sqlite-test-utils";
import { RemoteThreadSummaryCache } from "../federation/remote-thread-summary-cache";

const capabilities = ["thread_navigation", "event_subscriptions", "thread_detail", "navigation_snapshot_deltas", "gateway_relay"] as const;
const target = { scope: "remote" as const, instanceId: "owner" };

function endpoint(id: string, gatewayInstanceId?: string) {
  const runtime = new DesktopFederationRuntime();
  const wire = runtime as unknown as {
    remoteThreadSummaryCache?: RemoteThreadSummaryCache;
    localInstanceId: string;
    gatewayInstanceId?: string;
    router: FederationRouter;
    receiveEnvelope(frame: FederationProtocolEnvelope, source: string): Promise<void>;
    forwardLocalBackendEvent(event: AgentEvent): void;
  };
  wire.localInstanceId = id;
  wire.gatewayInstanceId = gatewayInstanceId;
  wire.router = new FederationRouter({ localInstanceId: id, trustedRelayPeerId: gatewayInstanceId });
  return { id, runtime, wire };
}

function sidebar(groups: number) {
  const store = new NavigationQueryStore();
  const demand = new Map<string, NavigationQueryRequest>();
  const add = (id: string, query: NavigationQueryRequest["query"]) => demand.set(id, {
    protocol: 2, inventory: "viewer", consumer: "main-sidebar", pageSize: 10, query,
  });
  add("index", { kind: "directory-index" });
  const directories = Array.from({ length: groups }, (_, i) => {
    const key = `directory:/project/${i}`;
    for (const roots of ["pinned", "unpinned"] as const) add(`${roots}-${i}`, { kind: "directory", directoryKey: key, roots });
    const threadKeys: string[] = [];
    for (let j = 0; j < 3; j++) {
      const root = `root-${i}-${j}`;
      add(`children-${root}`, { kind: "children", directoryKey: key, parent: { backend: "codex", threadId: root } });
      threadKeys.push(buildThreadIdentityKey("codex", root), buildThreadIdentityKey("codex", `${root}-child`));
    }
    return { key, kind: "directory" as const, label: key, needsAttentionCount: 0, threadKeys };
  });
  const threads = directories.flatMap((directory) => directory.threadKeys.map((key) => {
    const id = key.slice("codex:".length);
    return { id, source: "codex" as const, title: id, titleSource: "explicit" as const, linkedDirectories: [], inbox: { inInbox: false },
      ...(id.endsWith("-child") ? { parentThreadId: id.slice(0, -6), parentThreadBackend: "codex" as const } : {}) };
  }));
  const index = createNavigationQuerySnapshot({ threads, directories, coverage: { state: "complete" } });
  const read = vi.fn((request: NavigationQueryRequest) => store.readPage({ request, scopeKey: "local-viewer", loadIndex: async () => index }));
  const window = new NavigationWindowQueries({ getNavigationQueryPage: read });
  window.setDemand(demand);
  return { read, window };
}

it.each([[0, 3], [1, 3], [3, 3], [3, 6]])("materializes a child with %i subscribed but unmounted peers and %i expanded projects", async (peers, groups) => {
  const owner = endpoint("owner", peers === 3 ? "peer_0" : undefined);
  const codexClient = new MockBackendClient({ initializeResult: { methods: ["thread/start", "turn/start"] } });
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  const temp = createTempStateDb("launch-navigation-");
  const db = StateDb.open(temp.dbPath);
  const overlayStore = new SqliteOverlayStore(db);
  onTestFinished(() => { db.close(); removeTempStateDbDir(temp.tempDir); vi.unstubAllEnvs(); });
  const registry = createDesktopBackendRegistry({ codexClient, overlayStore });
  registry.rememberNavigationVisibilityIndex({
    directories: [{ key: "project", kind: "directory", label: "Project", threadKeys: ["codex:parent", "codex:prior-pin"], needsAttentionCount: 0,
      directoryThreadsCollapsed: true }],
    threads: [{ id: "parent", source: "codex", title: "Parent", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false } },
      { id: "prior-pin", source: "codex", title: "Pin", titleSource: "explicit", linkedDirectories: [], inbox: { inInbox: false }, pinnedRank: "1024" }],
  });
  const start = codexClient.startThread.bind(codexClient);
  vi.spyOn(codexClient, "startThread").mockImplementation(async (params) => {
    const result = await start(params);
    await codexClient.emit({ method: "thread/started", params: { threadId: result.threadId } });
    return result;
  });
  const received = new Map<string, string[]>();
  const sidebars: ReturnType<typeof sidebar>[] = [];
  const endpoints: ReturnType<typeof endpoint>[] = [];
  const deliveries: Promise<void>[] = [];
  const lastOwnerDelivery = new Map<string, { frame: FederationProtocolEnvelope; via: string }>();
  const returnedEvents: AgentEvent[] = [];
  owner.runtime.setAgentEventPublisher((event) => returnedEvents.push(event));
  function connect(from: ReturnType<typeof endpoint>, to: ReturnType<typeof endpoint>) {
    from.wire.router.registerConnection({ peerId: to.id, capabilities: [...capabilities], sendEnvelope: (frame) => {
      if (frame.sourceInstanceId === owner.id && frame.targetInstanceId === to.id && frame.kind === "notification") {
        lastOwnerDelivery.set(to.id, { frame, via: from.id });
      }
      deliveries.push(to.wire.receiveEnvelope(frame, from.id));
    } });
  }
  async function drain() {
    while (deliveries.length) await Promise.all(deliveries.splice(0));
  }
  const caches: RemoteThreadSummaryCache[] = [];
  const ownerReads = vi.fn(async (): Promise<never> => { throw new Error("Unmounted viewer requested the owner inventory"); });
  const off = registry.onEvent((event) => owner.wire.forwardLocalBackendEvent(event));
  try {
    for (let i = 0; i < peers; i++) {
      const id = `peer_${i}`;
      const peer = endpoint(id, i === 2 ? "peer_0" : undefined);
      endpoints.push(peer);
      const ui = sidebar(groups);
      sidebars.push(ui);
      const cache = new RemoteThreadSummaryCache({
        peers: () => [{ target, label: "Owner", capabilities: [...capabilities] }],
        peerStatus: () => ({ status: "connected" }), fetchSnapshot: ownerReads, fetchArchivedThreads: ownerReads,
        fetchPinnedSnapshot: ownerReads, onPinnedSummariesRefreshed: (instanceId) => peer.wire.forwardLocalBackendEvent({
          backend: "codex", notification: { method: "navigation/remoteThreadPins/changed", params: { instanceId } },
        }),
      });
      peer.wire.remoteThreadSummaryCache = cache;
      caches.push(cache);
      await cache.resolvePinnedThreads([]);
      const methods: string[] = [];
      received.set(id, methods);
      peer.runtime.setAgentEventPublisher((event) => {
        expect(event.federationTarget).toEqual(target);
        const method = event.notification.method === "navigation/invalidated" ? event.notification.params.sourceMethod : event.notification.method;
        if (typeof method === "string") methods.push(method);
        if (navigationQueryEventRequiresRefresh(event.notification.method, event.notification.params)) {
          ui.window.invalidate(undefined, [target, { scope: "local" }], event);
        }
      });
      const adjacent = i === 2 ? endpoints[0]! : owner;
      connect(peer, adjacent);
      connect(adjacent, peer);
      owner.runtime.setEventSubscriptions(id, [{ sourceInstanceId: id, eventClasses: ["navigation"], threadSelection: { kind: "all" } }]);
      // A global navigation observer (e.g. Star Map) receives the owner's
      // announcement. It does not create a mount in this machine's sidebar.
      peer.runtime.setEventSubscriptions("star-map", [{ sourceInstanceId: "owner", eventClasses: ["navigation"], threadSelection: { kind: "all" } }]);
      await vi.waitFor(() => expect([...ui.window.getSnapshot().resources.values()].every((r) => r.state.page && !r.loading)).toBe(true));
      await drain();
      expect([...ui.window.getSnapshot().resources].filter(([key]) => key.startsWith("children-"))
        .every(([, resource]) => resource.state.page!.entries.length === 1)).toBe(true);
      ui.read.mockClear();
    }
    const { writes } = await measureSqliteWrites(async () => {
      const result = await registry.materializeDirectoryLaunchpad({
        directoryKey: "project", launchpad: { backend: "codex", directoryKey: "project", directoryLabel: "Project",
          directoryKind: "directory", directoryPath: "/fixture/project", workMode: "local", executionMode: "default",
          parentThreadId: "parent", parentThreadBackend: "codex", prompt: "fixture", createdAt: 1, updatedAt: 1 },
      });
      expect(result.threadId).toBe("thread-1");
      expect(codexClient.startTurnCalls).toHaveLength(1);
      expect(await overlayStore.getThreadOverlayState({ backend: "codex", threadId: result.threadId })).toMatchObject({ parentThreadId: "parent" });
      await codexClient.emit({ method: "turn/started", params: { threadId: result.threadId, turn: { id: "turn-1" } } });
    });

    await drain();
    for (const methods of received.values()) expect(methods).toEqual(["thread/started", "thread/parent/set", "thread/pin/added", "turn/started", "turn/started"]);
    await Promise.all(sidebars.map(({ window }) => window.refresh(undefined, undefined, true)));
    expectSqliteWriteBudget({ scenario: "child-launch-with-automatic-pin-and-turn", writes,
      note: "Materialize a child, set its parent, pin it in the collapsed project and start its first turn." });
    expect(ownerReads).not.toHaveBeenCalled();
    expect(returnedEvents).toEqual([]);
    expect(sidebars.reduce((total, ui) => total + ui.read.mock.calls.length, 0)).toBe(0);
    // Navigation-only subscriptions also run on older, unsequenced transports.
    // Redelivering the same admitted frame must leave the viewer at rest.
    for (const peer of endpoints) {
      const { frame, via } = lastOwnerDelivery.get(peer.id)!;
      expect(via).toBe(peer.id === "peer_2" ? "peer_0" : "owner");
      await peer.wire.receiveEnvelope(frame, via);
      await peer.wire.receiveEnvelope(frame, via);
    }
    await drain();
    await Promise.all(sidebars.map(({ window }) => window.refresh(undefined, undefined, true)));
    expect(sidebars.reduce((total, ui) => total + ui.read.mock.calls.length, 0)).toBe(0);
    expect(ownerReads).not.toHaveBeenCalled();
    expect(returnedEvents).toEqual([]);
    // Independent peer changes must cross the same subscription in reverse,
    // including the third member behind the gateway.
    for (const peer of endpoints) peer.wire.forwardLocalBackendEvent({
      backend: "codex", notification: { method: "thread/started", params: { threadId: "independent" } },
    });
    await drain();
    expect(returnedEvents.map((event) => event.federationTarget)).toEqual(endpoints.map(({ id }) => ({ scope: "remote", instanceId: id })));
  } finally {
    off();
    for (const cache of caches) cache.dispose();
    for (const ui of sidebars) ui.window.dispose();
    await registry.close();
  }
});
