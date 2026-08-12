import { describe, expect, it, vi } from "vitest";
import type {
  AgentEvent,
  CelestialIconAssignment,
  CodexEnvironmentSetupProgressEvent,
  FederationCapability,
  FederationEventClass,
  FederationEventSubscription,
  FederationInstanceId,
  FederationProtocolEnvelope,
  GetNavigationSnapshotTransportRequest,
  NavigationSnapshot,
  NavigationSnapshotTransportResponse,
  SetCelestialIconResponse,
  StarMapArrangementEntry,
} from "@pwragent/shared";
import {
  FEDERATION_PROTOCOL_VERSION,
  MAX_CELESTIAL_ASSIGNMENTS,
  buildFederatedThreadRef,
  findPreferredReviewWorkspaceCwd,
} from "@pwragent/shared";
import {
  FEDERATION_BACKEND_EVENT_METHOD,
  FEDERATION_ENVIRONMENT_SETUP_PROGRESS_METHOD,
} from "../federation/federation-backend-bridge";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import {
  resetDesktopOverlayStoreForTests,
  setDesktopOverlayStoreForTests,
} from "../app-server/desktop-overlay-store";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import {
  FEDERATION_PEER_UNAVAILABLE_ERROR_CODE,
  FederationPeerUnavailableError,
} from "../federation/federation-peer-unavailable-error";
import { FederationRouter } from "../federation/federation-router";
import type { FederationGatewayConnection } from "../federation/federation-transport";

type RuntimeHarness = {
  router?: FederationRouter;
  receiveEnvelope: (
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ) => Promise<void>;
  applyPeerDirectory: (envelope: FederationProtocolEnvelope) => boolean;
  applyEventSubscription: (
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ) => boolean;
  forwardLocalBackendEvent: (event: AgentEvent) => void;
  hydrateLiveThreadMessageOrigin: (event: AgentEvent) => AgentEvent;
  broadcastStarMapArrangement: (
    entries: StarMapArrangementEntry[],
  ) => void;
  gatewayInstanceId?: FederationInstanceId;
  localInstanceId?: FederationInstanceId;
  publishRemoteBackendEvent: (
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ) => boolean;
  remoteThreadSummaryCache?: {
    invalidate: (instanceId?: string) => void;
  };
  publishRemoteEnvironmentSetupProgress: (
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ) => boolean;
  publishRemotePtyStreamEvent: (
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ) => boolean;
  sendPtyNotification: (
    peerId: FederationInstanceId,
    method: string,
    params: unknown,
  ) => boolean;
  onRemotePtyEvent: (
    listener: (event: {
      kind: string;
      peerId: FederationInstanceId;
      params: unknown;
    }) => void,
  ) => () => void;
  remotePeerDirectory: Map<FederationInstanceId, unknown>;
  ownedNavigationSnapshotTransport?: {
    clearClient: (clientId: string | number) => void;
  };
  ptyService?: {
    notifyPeerConnected: (peerId: FederationInstanceId) => void;
    notifyPeerDisconnected: (peerId: FederationInstanceId) => void;
  };
  onPeerStatusChanged: (listener: () => void) => () => void;
  recordClientConnection: (params: {
    gatewayInstanceId: FederationInstanceId;
    gatewayUrl: string;
    client: {
      sessionId: string;
      capabilities: FederationCapability[];
      sendEnvelope: (envelope: FederationProtocolEnvelope) => void;
      close: () => void;
    };
    connectionMode: "enroll" | "reconnect";
    connectedAt: number;
  }) => void;
  disconnectAdvertisedPeers: (reason: string) => void;
  registerGatewayConnection: (connection: FederationGatewayConnection) => void;
  unregisterPeer: (peerId: FederationInstanceId) => void;
  replayRelayedEventSubscriptions: (
    sourceInstanceId?: FederationInstanceId,
  ) => void;
  remoteBackend: (target?: {
    scope: "remote";
    instanceId: FederationInstanceId;
  }) => {
    getNavigationSnapshot: () => Promise<NavigationSnapshot>;
    getNavigationSnapshotTransport?: (
      request: GetNavigationSnapshotTransportRequest,
    ) => Promise<NavigationSnapshot | NavigationSnapshotTransportResponse>;
    listThreads: (request: { backend: "codex" }) => Promise<{
      backend: "codex";
      fetchedAt: number;
      threads: [];
    }>;
  };
  remoteNavigationSnapshot: (
    target: { scope: "remote"; instanceId: FederationInstanceId },
    request: Record<string, never>,
  ) => Promise<NavigationSnapshot>;
  remoteThreadSummaries: () => {
    searchForJump: (request: { query: string }) => Promise<{ results: unknown[] }>;
    dispose: () => void;
  };
  sendEnvelopeToTarget: (
    targetInstanceId: FederationInstanceId,
    envelope: FederationProtocolEnvelope,
  ) => void;
  setAgentEventPublisher: (publisher: (event: AgentEvent) => void) => void;
  setEventSubscriptions: (
    consumerId: string,
    subscriptions: readonly FederationEventSubscription[],
  ) => FederationEventSubscription[];
  setRendererEventSubscriptions: (
    webContentsId: number,
    consumerId: "remote-window" | "star-map" | "thread-view",
    subscriptions: readonly FederationEventSubscription[],
  ) => FederationEventSubscription[];
  setRemoteWindowEventSubscription: (
    webContentsId: number,
    sourceInstanceId: FederationInstanceId,
    capabilities: readonly FederationCapability[],
  ) => FederationEventSubscription[];
  clearRendererEventSubscriptions: (
    webContentsId: number,
    consumerId?: "remote-window" | "star-map" | "thread-view",
  ) => void;
  rendererWantsRemoteEvent: (
    webContentsId: number,
    sourceInstanceId: FederationInstanceId,
    eventClass: FederationEventClass,
  ) => boolean;
  setEnvironmentSetupProgressPublisher: (
    publisher: (event: CodexEnvironmentSetupProgressEvent) => void,
  ) => void;
  store: () => {
    appendAudit?: (entry: {
      peerId?: FederationInstanceId;
      sessionId?: string;
      kind: string;
      createdAt: number;
      detail?: string;
    }) => void;
    getPeer: (peerId: FederationInstanceId) => {
      id?: FederationInstanceId;
      label: string;
      role?: "client";
      status: "connected";
      capabilities?: FederationCapability[];
      canRevoke?: boolean;
    } | undefined;
    listPeers: (options?: { includeRevoked?: boolean }) => Array<{
      id: FederationInstanceId;
      status?: string;
    }>;
    revokePeer?: (peerId: FederationInstanceId, revokedAt: number) => void;
  };
  unregisterGatewayConnection: (connection: FederationGatewayConnection) => void;
  celestialAssignments?: Map<FederationInstanceId, CelestialIconAssignment>;
  celestialIconAssignments: () => CelestialIconAssignment[];
  celestialIconFor: (
    instanceId: FederationInstanceId,
  ) => CelestialIconAssignment["icon"] | undefined;
  reconcileCelestialAssignments: () => void;
  applyCelestialIcons: (
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ) => boolean;
  setCelestialIcon: (request: {
    instanceId: string;
    icon: string | null;
  }) => Promise<SetCelestialIconResponse>;
  revokePeer: (peerId: FederationInstanceId) => Promise<unknown>;
  visiblePeers: () => Array<{
    id: FederationInstanceId;
    label?: string;
    role?: "gateway" | "client" | "dual";
    status: string;
    capabilities?: FederationCapability[];
  }>;
  connectedPeerTargets: () => Array<{
    target: { scope: "remote"; instanceId: FederationInstanceId };
    label: string;
    capabilities: FederationCapability[];
  }>;
};

function createConnection(params: {
  peerId: FederationInstanceId;
  capabilities?: FederationCapability[];
  sendEnvelope?: (envelope: FederationProtocolEnvelope) => void;
}): FederationGatewayConnection {
  return {
    peerId: params.peerId,
    sessionId: `session:${params.peerId}`,
    capabilities: params.capabilities ?? ["gateway_relay"],
    sendEnvelope: params.sendEnvelope ?? (() => undefined),
    close: () => undefined,
  };
}

function applyEventSubscription(params: {
  runtime: RuntimeHarness;
  sourceInstanceId: FederationInstanceId;
  subscriberInstanceId: FederationInstanceId;
  sourcePeerId?: FederationInstanceId;
  eventClasses: FederationEventClass[];
  hopCount?: number;
}): void {
  expect(params.runtime.applyEventSubscription({
    id: `subscription:${params.subscriberInstanceId}`,
    kind: "notification",
    method: "federation.eventSubscription",
    params: { eventClasses: params.eventClasses },
    protocolVersion: FEDERATION_PROTOCOL_VERSION,
    sourceInstanceId: params.subscriberInstanceId,
    targetInstanceId: params.sourceInstanceId,
    ...(params.hopCount === undefined ? {} : { hopCount: params.hopCount }),
    createdAt: 1_000,
  }, params.sourcePeerId ?? params.subscriberInstanceId)).toBe(true);
}

describe("DesktopFederationRuntime", () => {
  it("preserves renderer-compatible thread keys in remote navigation lenses", async () => {
    const pwrAgentWorktree = "/worktrees/PwrAgnt";
    const gitWorkingState = {
      dirtyFiles: 0,
      dirtyAdditions: 0,
      dirtyDeletions: 0,
      untrackedFiles: 0,
      unpushedCommits: 0,
      baseBranch: "main",
      baseAheadCommitCount: 16,
    };
    const response: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 1_000,
      unchanged: false,
      threads: [
        {
          id: "thread-1",
          title: "Remote work",
          titleSource: "fallback",
          projectKey: pwrAgentWorktree,
          linkedDirectories: [
            {
              id: "pwragent",
              kind: "worktree",
              label: "PwrAgnt",
              path: "/repos/PwrAgnt",
              worktreePath: pwrAgentWorktree,
            },
            {
              id: "pwrsnap",
              kind: "local",
              label: "PwrSnap",
              path: "/repos/PwrSnap",
            },
          ],
          gitWorkingState,
          source: "codex",
          inbox: { inInbox: false },
        },
      ],
      inboxThreadKeys: [],
      directories: [
        {
          key: "directory:/repo",
          kind: "directory",
          label: "repo",
          path: "/repo",
          threadKeys: ["codex:thread-1"],
          needsAttentionCount: 0,
        },
      ],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.remoteBackend = () => ({
      getNavigationSnapshot: async () => response,
      listThreads: async () => ({ backend: "codex", fetchedAt: 1_000, threads: [] }),
    });
    runtime.store = () => ({
      getPeer: () => ({
        label: "Studio Mac",
        status: "connected",
      }),
      listPeers: () => [],
    });
    // remoteNavigationSnapshot also consults the live peer view for the
    // granted-capability set; there is no app state db in this harness.
    runtime.visiblePeers = () => [{
      id: "client_one",
      label: "Studio Mac",
      role: "client",
      status: "connected",
      capabilities: ["remote_pty"],
    }];

    const snapshot = await runtime.remoteNavigationSnapshot(
      { scope: "remote", instanceId: "client_one" },
      {},
    );

    expect(snapshot.threads[0]).toMatchObject({
      id: "thread-1",
      inbox: { inInbox: false },
      federation: {
        instanceLabel: "Studio Mac",
        ref: {
          backend: "codex",
          target: {
            scope: "remote",
            instanceId: "client_one",
          },
          threadId: "thread-1",
        },
      },
    });
    expect(snapshot.inboxThreadKeys).toEqual([]);
    expect(snapshot.directories[0]?.threadKeys).toEqual(["codex:thread-1"]);
    expect(snapshot.threads[0]?.gitWorkingState).toEqual(gitWorkingState);
    expect(snapshot.threads[0]?.federation?.capabilities).toContain("remote_pty");
    expect(findPreferredReviewWorkspaceCwd(snapshot.threads[0])).toBe(
      pwrAgentWorktree,
    );
  });

  it("reconstructs Federation navigation deltas against the peer revision", async () => {
    const firstSnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 1_000,
      unchanged: false,
      threads: [
        {
          id: "thread-1",
          title: "Remote one",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: true, reason: "new-thread" },
        },
        {
          id: "thread-2",
          title: "Remote two",
          titleSource: "explicit",
          source: "codex",
          linkedDirectories: [],
          inbox: { inInbox: true, reason: "new-thread" },
        },
      ],
      inboxThreadKeys: ["codex:thread-1", "codex:thread-2"],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const getNavigationSnapshotTransport = vi
      .fn<(request: GetNavigationSnapshotTransportRequest) =>
        Promise<NavigationSnapshotTransportResponse>>()
      .mockResolvedValueOnce({
        kind: "full",
        revision: "peer-revision-1",
        snapshot: firstSnapshot,
      })
      .mockResolvedValueOnce({
        kind: "delta",
        baseRevision: "peer-revision-1",
        revision: "peer-revision-2",
        fetchedAt: 2_000,
        removedThreadKeys: ["codex:thread-2"],
        upsertedThreads: [{
          ...firstSnapshot.threads[0]!,
          title: "Remote one updated",
        }],
        removedDirectoryKeys: [],
        upsertedDirectories: [],
        removedInboxThreadKeys: ["codex:thread-2"],
      })
      .mockResolvedValueOnce({
        kind: "unchanged",
        revision: "peer-revision-2",
      });
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.remoteBackend = () => ({
      getNavigationSnapshot: async () => firstSnapshot,
      getNavigationSnapshotTransport,
      listThreads: async () => ({
        backend: "codex",
        fetchedAt: 1_000,
        threads: [],
      }),
    });
    runtime.store = () => ({
      getPeer: () => ({ label: "Studio Mac", status: "connected" }),
      listPeers: () => [],
    });
    runtime.visiblePeers = () => [{
      id: "client_one",
      label: "Studio Mac",
      role: "client",
      status: "connected",
      capabilities: ["thread_navigation", "navigation_snapshot_deltas"],
    }];
    const target = { scope: "remote" as const, instanceId: "client_one" };

    const first = await runtime.remoteNavigationSnapshot(target, {});
    const changed = await runtime.remoteNavigationSnapshot(target, {});
    const unchanged = await runtime.remoteNavigationSnapshot(target, {});

    expect(first.threads.map((thread) => thread.title)).toEqual([
      "Remote one",
      "Remote two",
    ]);
    expect(changed.threads.map((thread) => thread.title)).toEqual([
      "Remote one updated",
    ]);
    expect(changed.inboxThreadKeys).toEqual(["codex:thread-1"]);
    expect(unchanged.threads.map((thread) => thread.title)).toEqual([
      "Remote one updated",
    ]);
    expect(getNavigationSnapshotTransport).toHaveBeenNthCalledWith(2, {
      backend: undefined,
      filter: undefined,
      transport: {
        baseRevision: "peer-revision-1",
        protocol: 1,
      },
    });
    expect(getNavigationSnapshotTransport).toHaveBeenNthCalledWith(3, {
      backend: undefined,
      filter: undefined,
      transport: {
        baseRevision: "peer-revision-2",
        protocol: 1,
      },
    });
  });

  it("uses full snapshots when an older owner does not advertise delta support", async () => {
    const legacySnapshot: NavigationSnapshot = {
      backend: "all",
      fetchedAt: 1_000,
      unchanged: false,
      threads: [{
        id: "legacy-thread",
        title: "Legacy owner thread",
        titleSource: "explicit",
        source: "codex",
        linkedDirectories: [],
        inbox: { inInbox: false },
      }],
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    };
    const getNavigationSnapshotTransport = vi.fn(async () => legacySnapshot);
    const getNavigationSnapshot = vi.fn(async () => legacySnapshot);
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.remoteBackend = () => ({
      getNavigationSnapshot,
      getNavigationSnapshotTransport,
      listThreads: async () => ({
        backend: "codex",
        fetchedAt: 1_000,
        threads: [],
      }),
    });
    runtime.store = () => ({
      getPeer: () => ({ label: "Older Mac", status: "connected" }),
      listPeers: () => [],
    });
    runtime.visiblePeers = () => [{
      id: "older_owner",
      label: "Older Mac",
      role: "client",
      status: "connected",
      capabilities: ["thread_navigation"],
    }];

    const snapshot = await runtime.remoteNavigationSnapshot(
      { scope: "remote", instanceId: "older_owner" },
      {},
    );

    expect(snapshot.threads[0]).toMatchObject({
      id: "legacy-thread",
      federation: {
        instanceLabel: "Older Mac",
      },
    });
    expect(getNavigationSnapshot).toHaveBeenCalledTimes(1);
    expect(getNavigationSnapshotTransport).not.toHaveBeenCalled();
  });

  it("preserves a transitive child's true federation owner", async () => {
    const response = {
      backend: "all" as const,
      fetchedAt: 1_000,
      unchanged: false,
      threads: [{
        id: "child",
        title: "Remote child",
        titleSource: "derived" as const,
        source: "codex" as const,
        linkedDirectories: [],
        inbox: { inInbox: false },
        parentThreadId: "parent",
        parentThreadBackend: "codex" as const,
        parentThreadInstanceId: "parent-peer",
        federation: {
          ref: buildFederatedThreadRef({
            backend: "codex",
            instanceId: "child-peer",
            threadId: "child",
          }),
          instanceLabel: "Child Mac",
        },
      }],
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex" as const,
        executionMode: "default" as const,
      },
    } as NavigationSnapshot;
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.remoteBackend = () => ({
      getNavigationSnapshot: async () => response,
      listThreads: async () => ({ backend: "codex", fetchedAt: 1_000, threads: [] }),
    });
    runtime.store = () => ({
      getPeer: (instanceId: string) => ({
        label: instanceId === "child-peer" ? "Child Mac" : "Parent Mac",
        status: "connected",
      }),
      listPeers: () => [],
    });
    runtime.visiblePeers = () => [
      {
        id: "parent-peer",
        label: "Parent Mac",
        role: "client",
        status: "connected",
        capabilities: ["thread_navigation"],
      },
      {
        id: "child-peer",
        label: "Child Mac",
        role: "client",
        status: "connected",
        capabilities: ["thread_navigation", "remote_pty"],
      },
    ];

    const snapshot = await runtime.remoteNavigationSnapshot(
      { scope: "remote", instanceId: "parent-peer" },
      {},
    );

    expect(snapshot.threads[0]).toMatchObject({
      parentThreadInstanceId: "parent-peer",
      federation: {
        instanceLabel: "Child Mac",
        capabilities: ["thread_navigation", "remote_pty"],
        ref: {
          target: { scope: "remote", instanceId: "child-peer" },
        },
      },
    });
  });

  it("ungroups pinned remote children on their owner after parent archive", async () => {
    const stateDb = openInMemoryStateDb();
    const overlayStore = new SqliteOverlayStore(stateDb);
    setDesktopOverlayStoreForTests(overlayStore);
    try {
      const ref = buildFederatedThreadRef({
        backend: "codex",
        instanceId: "child-peer",
        threadId: "child",
      });
      await overlayStore.addRemoteThreadPin({
        ref,
        instanceLabel: "Child Mac",
        pinnedVia: "child",
        summary: {
          source: "codex",
          id: "child",
          title: "Remote child",
          titleSource: "derived",
          linkedDirectories: [],
          inbox: { inInbox: false },
          parentThreadId: "parent",
          parentThreadBackend: "codex",
          parentThreadInstanceId: "parent-peer",
        },
      });
      const setThreadParent = vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "child",
      }));
      const runtime = new DesktopFederationRuntime();
      vi.spyOn(runtime, "health").mockResolvedValue({
        instanceId: "parent-peer",
      } as never);
      vi.spyOn(runtime, "remoteBackend").mockReturnValue({
        setThreadParent,
      } as never);

      await runtime.ungroupRemoteChildrenOfArchivedThread({
        backend: "codex",
        parentThreadId: "parent",
      });

      expect(setThreadParent).toHaveBeenCalledWith({
        backend: "codex",
        threadId: "child",
        parentThreadId: null,
      });
      const [pin] = await overlayStore.listRemoteThreadPins();
      expect(pin?.summary?.parentThreadId).toBeUndefined();
      expect(pin?.summary?.parentThreadBackend).toBeUndefined();
      expect(pin?.summary?.parentThreadInstanceId).toBeUndefined();
    } finally {
      resetDesktopOverlayStoreForTests();
      stateDb.close();
    }
  });

  it("records gateway-advertised peers for client instance health and opening", () => {
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "client_one";
    runtime.store = () => ({
      getPeer: () => undefined,
      listPeers: () => [],
    });

    const handled = runtime.applyPeerDirectory({
      id: "peers-1",
      kind: "notification",
      method: "federation.peerDirectory",
      params: {
        peers: [
          {
            id: "gateway_one",
            label: "Studio",
            role: "gateway",
            status: "connected",
            capabilities: ["remote_window", "gateway_relay"],
          },
          {
            id: "client_two",
            label: "Laptop",
            role: "client",
            status: "connected",
            capabilities: ["remote_window", "thread_detail"],
          },
          {
            id: "client_one",
            label: "Self",
            role: "client",
            status: "connected",
            capabilities: ["remote_window"],
          },
        ],
      },
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "gateway_one",
      targetInstanceId: "client_one",
      createdAt: 2_000,
    });

    expect(handled).toBe(true);
    expect([...runtime.remotePeerDirectory.values()]).toMatchObject([
      {
        id: "gateway_one",
        label: "Studio",
        role: "gateway",
        status: "connected",
        canRevoke: false,
      },
      {
        id: "client_two",
        label: "Laptop",
        role: "client",
        status: "connected",
        canRevoke: false,
      },
    ]);
    expect(runtime.visiblePeers()).toMatchObject([
      { id: "gateway_one", status: "connected" },
      { id: "client_two", status: "connected" },
    ]);
  });

  it("publishes peer status changes after installing the full directory", () => {
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "client_one";
    runtime.store = () => ({
      getPeer: () => undefined,
      listPeers: () => [],
    });
    const peerDirectory = (
      id: string,
      peers: Array<{
        id: FederationInstanceId;
        label: string;
      }>,
    ): FederationProtocolEnvelope => ({
      id,
      kind: "notification",
      method: "federation.peerDirectory",
      params: {
        peers: peers.map((peer) => ({
          ...peer,
          role: peer.id === "gateway_one" ? "gateway" : "client",
          status: "connected",
          capabilities: ["remote_window"],
        })),
      },
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "gateway_one",
      targetInstanceId: "client_one",
      createdAt: 2_000,
    });

    runtime.applyPeerDirectory(peerDirectory("peers-1", [
      { id: "gateway_one", label: "Gateway" },
      { id: "client_m5", label: "M5" },
    ]));

    const visibleSnapshots: FederationInstanceId[][] = [];
    runtime.onPeerStatusChanged(() => {
      visibleSnapshots.push(
        runtime.connectedPeerTargets().map((peer) => peer.target.instanceId),
      );
    });

    runtime.applyPeerDirectory(peerDirectory("peers-2", [
      { id: "gateway_one", label: "Gateway" },
      { id: "client_2018", label: "2018" },
      { id: "client_m5", label: "M5" },
    ]));

    expect(visibleSnapshots).toEqual([
      ["gateway_one", "client_2018", "client_m5"],
    ]);
  });

  it("propagates advertised viewer disconnects and reconnects to remote PTY sessions", () => {
    const connected: FederationInstanceId[] = [];
    const disconnected: FederationInstanceId[] = [];
    const clearedNavigationClients: Array<string | number> = [];
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "owner_one";
    runtime.ownedNavigationSnapshotTransport = {
      clearClient: (clientId) => clearedNavigationClients.push(clientId),
    };
    runtime.ptyService = {
      notifyPeerConnected: (peerId) => connected.push(peerId),
      notifyPeerDisconnected: (peerId) => disconnected.push(peerId),
    };
    const directory = (
      id: string,
      status?: "connected" | "disconnected",
    ): FederationProtocolEnvelope => ({
      id,
      kind: "notification",
      method: "federation.peerDirectory",
      params: {
        peers: status
          ? [{
              id: "viewer_one",
              label: "Viewer",
              role: "client",
              status,
              capabilities: ["remote_pty"],
            }]
          : [],
      },
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "gateway_one",
      targetInstanceId: "owner_one",
      createdAt: 2_000,
    });

    runtime.applyPeerDirectory(directory("peers-1", "connected"));
    expect(connected).toEqual(["viewer_one"]);
    runtime.applyPeerDirectory(directory("peers-2", "disconnected"));
    expect(disconnected).toEqual(["viewer_one"]);
    runtime.applyPeerDirectory(directory("peers-3", "connected"));
    expect(connected).toEqual(["viewer_one", "viewer_one"]);
    runtime.applyPeerDirectory(directory("peers-4"));
    expect(disconnected).toEqual(["viewer_one", "viewer_one"]);
    expect(clearedNavigationClients).toEqual(["viewer_one", "viewer_one"]);
  });

  it("disconnects every relayed PTY viewer when the upstream gateway closes", () => {
    const disconnected: FederationInstanceId[] = [];
    const clearedNavigationClients: Array<string | number> = [];
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "owner_one";
    runtime.ownedNavigationSnapshotTransport = {
      clearClient: (clientId) => clearedNavigationClients.push(clientId),
    };
    runtime.ptyService = {
      notifyPeerConnected: () => undefined,
      notifyPeerDisconnected: (peerId) => disconnected.push(peerId),
    };
    runtime.remotePeerDirectory.set("viewer_one", {
      id: "viewer_one",
      label: "Viewer",
      role: "client",
      status: "connected",
      capabilities: ["remote_pty"],
    });

    runtime.disconnectAdvertisedPeers("Gateway disconnected.");

    expect(disconnected).toEqual(["viewer_one"]);
    expect(clearedNavigationClients).toEqual(["viewer_one"]);
  });

  it("records a successful client session and preserves its timing", () => {
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    const audits: Array<{
      peerId?: FederationInstanceId;
      sessionId?: string;
      kind: string;
      createdAt: number;
      detail?: string;
    }> = [];
    runtime.localInstanceId = "client_one";
    runtime.remotePeerDirectory.set("gateway_one", {
      id: "gateway_one",
      label: "Mac Mini",
      role: "gateway",
      status: "connected",
      capabilities: ["remote_window"],
    });
    runtime.store = () => ({
      appendAudit: (entry) => audits.push(entry),
      getPeer: () => undefined,
      listPeers: () => [],
    });

    runtime.recordClientConnection({
      gatewayInstanceId: "gateway_one",
      gatewayUrl: "ws://192.168.6.163:47830",
      client: {
        sessionId: "session:gateway_one",
        capabilities: ["remote_window", "thread_navigation"],
        sendEnvelope: () => undefined,
        close: () => undefined,
      },
      connectionMode: "reconnect",
      connectedAt: 5_000,
    });

    expect([...runtime.remotePeerDirectory.values()]).toMatchObject([
      {
        id: "gateway_one",
        label: "Mac Mini",
        status: "connected",
        endpoint: "ws://192.168.6.163:47830",
        lastConnectedAt: 5_000,
        lastActivityAt: 5_000,
      },
    ]);
    expect(audits).toEqual([
      {
        peerId: "gateway_one",
        sessionId: "session:gateway_one",
        kind: "connected",
        createdAt: 5_000,
        detail: "reconnect",
      },
    ]);

    runtime.applyPeerDirectory({
      id: "peers-1",
      kind: "notification",
      method: "federation.peerDirectory",
      params: {
        peers: [
          {
            id: "gateway_one",
            label: "Mac Mini",
            role: "gateway",
            status: "connected",
            capabilities: ["remote_window", "thread_navigation"],
          },
        ],
      },
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "gateway_one",
      targetInstanceId: "client_one",
      createdAt: 5_001,
    });

    expect([...runtime.remotePeerDirectory.values()]).toMatchObject([
      {
        id: "gateway_one",
        lastConnectedAt: 5_000,
        lastActivityAt: 5_000,
      },
    ]);
  });

  it("marks gateway-advertised routes disconnected when the gateway closes", () => {
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    const publishedEvents: AgentEvent[] = [];
    runtime.localInstanceId = "client_one";
    runtime.setAgentEventPublisher((event) => publishedEvents.push(event));
    runtime.store = () => ({
      getPeer: () => undefined,
      listPeers: () => [],
    });
    runtime.applyPeerDirectory({
      id: "peers-1",
      kind: "notification",
      method: "federation.peerDirectory",
      params: {
        peers: [
          {
            id: "gateway_one",
            label: "Studio",
            role: "gateway",
            status: "connected",
            capabilities: ["gateway_relay"],
          },
          {
            id: "client_two",
            label: "Laptop",
            role: "client",
            status: "connected",
            capabilities: ["thread_detail"],
          },
        ],
      },
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "gateway_one",
      targetInstanceId: "client_one",
      createdAt: 2_000,
    });

    runtime.disconnectAdvertisedPeers("Gateway transport closed.");

    expect(runtime.visiblePeers()).toMatchObject([
      {
        id: "gateway_one",
        status: "disconnected",
        unavailableReason: "Gateway transport closed.",
      },
      {
        id: "client_two",
        status: "disconnected",
        unavailableReason: "Gateway transport closed.",
      },
    ]);
    expect(runtime.connectedPeerTargets()).toEqual([]);
    expect(
      publishedEvents.map((event) => ({
        target: event.federationTarget,
        notification: event.notification,
      })),
    ).toMatchObject([
      {
        target: { scope: "remote", instanceId: "gateway_one" },
        notification: {
          method: "federation/peerStatus/changed",
          params: { instanceId: "gateway_one", status: "connected" },
        },
      },
      {
        target: { scope: "remote", instanceId: "client_two" },
        notification: {
          method: "federation/peerStatus/changed",
          params: { instanceId: "client_two", status: "connected" },
        },
      },
      {
        target: { scope: "remote", instanceId: "gateway_one" },
        notification: {
          method: "federation/peerStatus/changed",
          params: {
            instanceId: "gateway_one",
            status: "disconnected",
            unavailableReason: "Gateway transport closed.",
          },
        },
      },
      {
        target: { scope: "remote", instanceId: "client_two" },
        notification: {
          method: "federation/peerStatus/changed",
          params: {
            instanceId: "client_two",
            status: "disconnected",
            unavailableReason: "Gateway transport closed.",
          },
        },
      },
    ]);
  });

  it("falls back to the gateway when a client targets a sibling peer", () => {
    const sentToGateway: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "client_one" });
    router.registerConnection(
      createConnection({
        peerId: "gateway_one",
        capabilities: ["gateway_relay"],
        sendEnvelope: (envelope) => sentToGateway.push(envelope),
      }),
    );
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.gatewayInstanceId = "gateway_one";
    runtime.localInstanceId = "client_one";
    runtime.router = router;

    const request: FederationProtocolEnvelope = {
      id: "request-1",
      kind: "request",
      method: "backend.listThreads",
      params: {},
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "client_one",
      targetInstanceId: "client_two",
      createdAt: 2_000,
    };

    runtime.sendEnvelopeToTarget("client_two", request);

    expect(sentToGateway).toEqual([request]);
  });

  it("classifies a missing route as expected peer unavailability", () => {
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.gatewayInstanceId = "gateway_one";
    runtime.localInstanceId = "client_one";
    runtime.router = new FederationRouter({ localInstanceId: "client_one" });
    const request: FederationProtocolEnvelope = {
      id: "request-unavailable",
      kind: "request",
      method: "backend.listThreads",
      params: {},
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "client_one",
      targetInstanceId: "client_two",
      createdAt: 2_000,
    };

    expect(() => runtime.sendEnvelopeToTarget("client_two", request)).toThrow(
      FederationPeerUnavailableError,
    );
    try {
      runtime.sendEnvelopeToTarget("client_two", request);
    } catch (error) {
      expect(error).toMatchObject({
        code: FEDERATION_PEER_UNAVAILABLE_ERROR_CODE,
        instanceId: "client_two",
      });
    }
  });

  it("resolves sibling RPC responses received from the gateway transport", async () => {
    const sentToGateway: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "client_one",
      trustedRelayPeerId: "gateway_one",
    });
    router.registerConnection(
      createConnection({
        peerId: "gateway_one",
        capabilities: ["gateway_relay"],
        sendEnvelope: (envelope) => sentToGateway.push(envelope),
      }),
    );
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.gatewayInstanceId = "gateway_one";
    runtime.localInstanceId = "client_one";
    runtime.router = router;

    const pending = runtime.remoteBackend({
      scope: "remote",
      instanceId: "client_two",
    }).listThreads({ backend: "codex" });
    const request = sentToGateway[0]!;

    await runtime.receiveEnvelope(
      {
        id: "response-1",
        kind: "response",
        requestId: request.id,
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: "client_two",
        targetInstanceId: "client_one",
        createdAt: 2_000,
        hopCount: 1,
        result: { backend: "codex", fetchedAt: 2_000, threads: [] },
      },
      "gateway_one",
    );

    await expect(pending).resolves.toEqual({
      backend: "codex",
      fetchedAt: 2_000,
      threads: [],
    });
  });

  it("keeps connected peers idle until they subscribe to backend events", () => {
    const forwarded: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(
      createConnection({
        peerId: "client_one",
        capabilities: [
          "remote_window",
          "thread_navigation",
          "event_subscriptions",
        ],
        sendEnvelope: (envelope) => forwarded.push(envelope),
      }),
    );
    router.registerConnection(
      createConnection({
        peerId: "limited_peer",
        capabilities: ["messaging_route"],
        sendEnvelope: (envelope) => forwarded.push(envelope),
      }),
    );
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "gateway_one";
    runtime.router = router;

    runtime.forwardLocalBackendEvent({
      backend: "codex",
      notification: {
        method: "turn/started",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "in_progress" },
          turnId: "turn-1",
        },
      },
    } as AgentEvent);

    expect(forwarded).toEqual([]);
  });

  it("replaces viewer subscriptions when retargeted and unsubscribes on close", () => {
    const sentToOne: FederationProtocolEnvelope[] = [];
    const sentToTwo: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "viewer_one" });
    router.registerConnection(createConnection({
      peerId: "owner_one",
      capabilities: [
        "thread_navigation",
        "event_subscriptions",
      ],
      sendEnvelope: (envelope) => sentToOne.push(envelope),
    }));
    router.registerConnection(createConnection({
      peerId: "owner_two",
      capabilities: ["thread_detail", "event_subscriptions"],
      sendEnvelope: (envelope) => sentToTwo.push(envelope),
    }));
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "viewer_one";
    runtime.router = router;

    runtime.setEventSubscriptions("renderer:7", [{
      sourceInstanceId: "owner_one",
      eventClasses: ["navigation"],
    }]);
    runtime.setEventSubscriptions("renderer:7", [{
      sourceInstanceId: "owner_two",
      eventClasses: ["transcript"],
    }]);
    runtime.setEventSubscriptions("renderer:7", []);

    expect(sentToOne.map((envelope) =>
      envelope.kind === "notification" ? envelope.params : undefined
    )).toEqual([
      { eventClasses: ["navigation"] },
      { eventClasses: [] },
    ]);
    expect(sentToTwo.map((envelope) =>
      envelope.kind === "notification" ? envelope.params : undefined
    )).toEqual([
      { eventClasses: ["transcript"] },
      { eventClasses: [] },
    ]);
  });

  it("keeps viewer and thread subscriptions while Star Map opens and closes", () => {
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "viewer_one";
    runtime.router = new FederationRouter({ localInstanceId: "viewer_one" });
    runtime.router.registerConnection(createConnection({
      peerId: "owner_one",
      capabilities: [
        "thread_navigation",
        "thread_detail",
        "pending_request_control",
        "scheduled_actions",
        "event_subscriptions",
      ],
    }));
    runtime.router.registerConnection(createConnection({
      peerId: "owner_two",
      capabilities: ["thread_navigation", "event_subscriptions"],
    }));

    runtime.setRemoteWindowEventSubscription(7, "owner_one", [
      "thread_navigation",
      "thread_detail",
      "pending_request_control",
      "scheduled_actions",
      "event_subscriptions",
    ]);
    runtime.setRendererEventSubscriptions(7, "star-map", [{
      sourceInstanceId: "owner_one",
      eventClasses: ["navigation", "star_map"],
    }, {
      sourceInstanceId: "owner_two",
      eventClasses: ["navigation", "star_map"],
    }]);
    runtime.setRendererEventSubscriptions(7, "thread-view", [{
      sourceInstanceId: "owner_two",
      eventClasses: ["navigation"],
    }]);
    runtime.clearRendererEventSubscriptions(7, "star-map");

    expect(runtime.rendererWantsRemoteEvent(7, "owner_one", "navigation"))
      .toBe(true);
    expect(runtime.rendererWantsRemoteEvent(7, "owner_one", "transcript"))
      .toBe(true);
    expect(runtime.rendererWantsRemoteEvent(7, "owner_one", "star_map"))
      .toBe(true);
    expect(runtime.rendererWantsRemoteEvent(7, "owner_one", "pending_requests"))
      .toBe(true);
    expect(runtime.rendererWantsRemoteEvent(7, "owner_one", "scheduled_actions"))
      .toBe(true);
    expect(runtime.rendererWantsRemoteEvent(7, "owner_two", "navigation"))
      .toBe(true);
    runtime.clearRendererEventSubscriptions(7, "thread-view");
    expect(runtime.rendererWantsRemoteEvent(7, "owner_two", "navigation"))
      .toBe(false);
  });

  it("publishes only the event classes and source instances Star Map requests", () => {
    const published: AgentEvent[] = [];
    const router = new FederationRouter({ localInstanceId: "viewer_one" });
    for (const peerId of ["owner_one", "owner_two"] as const) {
      router.registerConnection(createConnection({
        peerId,
        capabilities: [
          "gateway_relay",
          "thread_navigation",
          "scheduled_actions",
          "event_subscriptions",
        ],
      }));
    }
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "viewer_one";
    runtime.router = router;
    runtime.setAgentEventPublisher((event) => published.push(event));
    runtime.setEventSubscriptions("renderer:star-map", [{
      sourceInstanceId: "owner_one",
      eventClasses: ["navigation", "scheduled_actions", "star_map"],
    }]);

    const publish = (
      sourceInstanceId: FederationInstanceId,
      method: string,
    ) => runtime.publishRemoteBackendEvent({
      id: `event:${sourceInstanceId}:${method}`,
      kind: "notification",
      method: FEDERATION_BACKEND_EVENT_METHOD,
      params: {
        backend: "codex",
        notification: {
          method,
          params: { threadId: "thread-1" },
        },
      },
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId,
      targetInstanceId: "viewer_one",
      createdAt: 2_000,
    }, sourceInstanceId);

    publish("owner_one", "thread/status/changed");
    publish("owner_one", "item/agentMessage/delta");
    publish("owner_one", "thread/scheduledAction/updated");
    publish("owner_one", "starMap/intake/status");
    publish("owner_two", "thread/status/changed");

    expect(published.map((event) => ({
      instanceId: event.federationTarget?.scope === "remote"
        ? event.federationTarget.instanceId
        : undefined,
      method: event.notification.method,
    }))).toEqual([
      { instanceId: "owner_one", method: "thread/status/changed" },
      {
        instanceId: "owner_one",
        method: "thread/scheduledAction/updated",
      },
      { instanceId: "owner_one", method: "starMap/intake/status" },
    ]);
  });

  it("sends Star Map arrangement deltas only to star-map subscribers", () => {
    const subscribed: FederationProtocolEnvelope[] = [];
    const unrelated: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "owner_one" });
    router.registerConnection(createConnection({
      peerId: "viewer_one",
      capabilities: ["thread_navigation", "event_subscriptions"],
      sendEnvelope: (envelope) => subscribed.push(envelope),
    }));
    router.registerConnection(createConnection({
      peerId: "viewer_two",
      capabilities: ["thread_navigation", "event_subscriptions"],
      sendEnvelope: (envelope) => unrelated.push(envelope),
    }));
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "owner_one";
    runtime.router = router;
    applyEventSubscription({
      runtime,
      sourceInstanceId: "owner_one",
      subscriberInstanceId: "viewer_one",
      eventClasses: ["star_map"],
    });

    runtime.broadcastStarMapArrangement([{
      instanceId: "owner_one",
      threadKey: "acp:grok:thread-1",
      dx: 10,
      dy: 20,
      updatedAt: 1_000,
      by: "owner_one",
    }]);

    expect(subscribed).toMatchObject([{
      method: "federation.starMapArrangement",
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      params: {
        entries: [{ threadKey: "acp%3Agrok:thread-1" }],
      },
    }]);
    expect(unrelated).toEqual([]);
  });

  it("rejects a direct peer spoofing a subscribed source instance", () => {
    const published: AgentEvent[] = [];
    const router = new FederationRouter({ localInstanceId: "viewer_one" });
    router.registerConnection(createConnection({
      peerId: "owner_one",
      capabilities: ["thread_detail", "event_subscriptions"],
    }));
    router.registerConnection(createConnection({
      peerId: "owner_two",
      capabilities: [
        "gateway_relay",
        "thread_detail",
        "event_subscriptions",
      ],
    }));
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "viewer_one";
    runtime.router = router;
    runtime.setAgentEventPublisher((event) => published.push(event));
    runtime.setEventSubscriptions("viewer", [{
      sourceInstanceId: "owner_one",
      eventClasses: ["transcript"],
    }]);

    runtime.publishRemoteBackendEvent({
      id: "spoofed-event",
      kind: "notification",
      method: FEDERATION_BACKEND_EVENT_METHOD,
      params: {
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1" },
        },
      },
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 2_000,
    }, "owner_two");

    expect(published).toEqual([]);
  });

  it("replays desired subscriptions once per reconnect without duplicates", () => {
    const sent: FederationProtocolEnvelope[] = [];
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "viewer_one";
    runtime.router = new FederationRouter({ localInstanceId: "viewer_one" });
    runtime.setEventSubscriptions("renderer:7", [{
      sourceInstanceId: "owner_one",
      eventClasses: ["navigation"],
    }]);
    const connection = createConnection({
      peerId: "owner_one",
      capabilities: [
        "thread_navigation",
        "event_subscriptions",
      ],
      sendEnvelope: (envelope) => sent.push(envelope),
    });

    runtime.registerGatewayConnection(connection);
    runtime.unregisterGatewayConnection(connection);
    runtime.registerGatewayConnection(connection);

    expect(
      sent.filter(
        (envelope) =>
          envelope.kind === "notification"
          && envelope.method === "federation.eventSubscription",
      ).map((envelope) =>
        envelope.kind === "notification" ? envelope.params : undefined
      ),
    ).toEqual([
      { eventClasses: ["navigation"] },
      { eventClasses: ["navigation"] },
    ]);
  });

  it("replays retained downstream subscriptions after its upstream reconnects", () => {
    const sentUpstream: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "dual_one" });
    router.registerConnection(createConnection({
      peerId: "viewer_one",
      capabilities: [
        "gateway_relay",
        "thread_detail",
        "event_subscriptions",
      ],
    }));
    const upstreamConnection = createConnection({
      peerId: "gateway_one",
      capabilities: ["gateway_relay", "event_subscriptions"],
      sendEnvelope: (envelope) => sentUpstream.push(envelope),
    });
    router.registerConnection(upstreamConnection);
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.gatewayInstanceId = "gateway_one";
    runtime.localInstanceId = "dual_one";
    runtime.router = router;
    applyEventSubscription({
      runtime,
      sourceInstanceId: "owner_one",
      subscriberInstanceId: "viewer_one",
      eventClasses: ["transcript"],
    });
    expect(sentUpstream).toHaveLength(1);

    sentUpstream.length = 0;
    runtime.unregisterPeer("gateway_one");
    router.registerConnection(upstreamConnection);
    runtime.replayRelayedEventSubscriptions();

    expect(sentUpstream).toMatchObject([{
      kind: "notification",
      method: "federation.eventSubscription",
      params: { eventClasses: ["transcript"] },
      sourceInstanceId: "viewer_one",
      targetInstanceId: "owner_one",
      hopCount: 1,
    }]);
  });

  it("routes live transcript images back through their owning instance", () => {
    const forwarded: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(
      createConnection({
        peerId: "client_one",
        capabilities: ["thread_detail", "event_subscriptions"],
        sendEnvelope: (envelope) => forwarded.push(envelope),
      }),
    );
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "gateway_one";
    runtime.router = router;
    applyEventSubscription({
      runtime,
      sourceInstanceId: "gateway_one",
      subscriberInstanceId: "client_one",
      eventClasses: ["transcript"],
    });
    const ownerUrl =
      `pwragent-image://file/${encodeURIComponent("file:///Users/owner/.pwragent/profiles/default/state/image-inputs/image.png")}`;

    runtime.forwardLocalBackendEvent({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "user-message-1",
            type: "userMessage",
            content: [
              { type: "text", text: "Describe it" },
              { type: "image", url: ownerUrl },
            ],
          },
        },
      },
    } as AgentEvent);

    expect(forwarded).toMatchObject([{
      params: {
        notification: {
          method: "item/completed",
          params: {
            item: {
              content: [
                { type: "text", text: "Describe it" },
                {
                  type: "image",
                  url:
                    `pwragent-image://federation/gateway_one/${encodeURIComponent(ownerUrl)}`,
                },
              ],
            },
          },
        },
      },
      sourceInstanceId: "gateway_one",
      targetInstanceId: "client_one",
    }]);
  });

  it("hydrates trusted instance metadata on live transcript origins", () => {
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "owner_one";
    runtime.visiblePeers = () => [{
      id: "source_one",
      label: "Source Mac",
      status: "connected",
    }];
    runtime.celestialIconFor = () => "moon";

    const hydrated = runtime.hydrateLiveThreadMessageOrigin({
      backend: "codex",
      notification: {
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "user-message-1",
            type: "userMessage",
            origin: {
              kind: "agent",
              sourceThread: {
                backend: "codex",
                instanceId: "source_one",
                instanceLabel: "Spoofed Mac",
                celestialIcon: "black-hole",
                threadId: "source-thread",
                title: "Source thread",
              },
            },
            content: [{ type: "text", text: "Remote result" }],
          },
        },
      },
    } as AgentEvent);

    expect(hydrated).toMatchObject({
      notification: {
        method: "item/completed",
        params: {
          item: {
            origin: {
              sourceThread: {
                instanceId: "source_one",
                instanceLabel: "Source Mac",
                celestialIcon: "moon",
                threadId: "source-thread",
              },
            },
          },
        },
      },
    });
  });

  it("forwards scheduler lifecycle events to scheduler-capable peers", () => {
    const forwarded: FederationProtocolEnvelope[] = [];
    const unauthorized: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(
      createConnection({
        peerId: "client_one",
        capabilities: ["scheduled_actions", "event_subscriptions"],
        sendEnvelope: (envelope) => forwarded.push(envelope),
      }),
    );
    router.registerConnection(
      createConnection({
        peerId: "client_two",
        capabilities: ["remote_window", "thread_detail"],
        sendEnvelope: (envelope) => unauthorized.push(envelope),
      }),
    );
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "gateway_one";
    runtime.router = router;
    applyEventSubscription({
      runtime,
      sourceInstanceId: "gateway_one",
      subscriberInstanceId: "client_one",
      eventClasses: ["scheduled_actions"],
    });

    runtime.forwardLocalBackendEvent({
      backend: "codex",
      notification: {
        method: "thread/scheduledAction/updated",
        params: {
          action: {
            id: "scheduled-1",
            backend: "codex",
            threadId: "thread-1",
            kind: "turn",
            origin: "desktop",
            status: "scheduled",
            scheduledFor: 3_000,
            displayText: "Follow up",
            turn: { input: [{ type: "text", text: "Follow up" }] },
            createdAt: 1_000,
            updatedAt: 1_000,
          },
        },
      },
    } as AgentEvent);

    expect(forwarded).toMatchObject([
      {
        kind: "notification",
        method: FEDERATION_BACKEND_EVENT_METHOD,
        params: {
          notification: {
            method: "thread/scheduledAction/updated",
          },
        },
        targetInstanceId: "client_one",
      },
    ]);
    expect(unauthorized).toEqual([]);
  });

  it("publishes remote backend events with the source peer as federation target", () => {
    const published: AgentEvent[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(createConnection({
      peerId: "client_one",
      capabilities: ["thread_detail", "event_subscriptions"],
    }));
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "gateway_one";
    runtime.router = router;
    runtime.setEventSubscriptions("viewer", [{
      sourceInstanceId: "client_one",
      eventClasses: ["transcript"],
    }]);
    runtime.setAgentEventPublisher((event) => {
      published.push(event);
    });

    const handled = runtime.publishRemoteBackendEvent(
      {
        id: "event-1",
        kind: "notification",
        method: FEDERATION_BACKEND_EVENT_METHOD,
        params: {
          backend: "codex",
          notification: {
            method: "item/agentMessage/delta",
            params: {
              delta: "hello",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: "client_one",
        targetInstanceId: "gateway_one",
        createdAt: 2_000,
      },
      "client_one",
    );

    expect(handled).toBe(true);
    expect(published).toEqual([
      {
        backend: "codex",
        federationTarget: { scope: "remote", instanceId: "client_one" },
        notification: {
          method: "item/agentMessage/delta",
          params: {
            delta: "hello",
            itemId: "item-1",
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
      },
    ]);
  });

  it("invalidates cached remote summaries when a peer updates attached PRs", () => {
    const invalidated: Array<string | undefined> = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(createConnection({
      peerId: "client_one",
      capabilities: ["thread_detail", "event_subscriptions"],
    }));
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "gateway_one";
    runtime.router = router;
    runtime.setEventSubscriptions("viewer", [{
      sourceInstanceId: "client_one",
      eventClasses: ["navigation"],
    }]);
    runtime.remoteThreadSummaryCache = {
      invalidate: (instanceId) => invalidated.push(instanceId),
    };

    runtime.publishRemoteBackendEvent(
      {
        id: "event-prs",
        kind: "notification",
        method: FEDERATION_BACKEND_EVENT_METHOD,
        params: {
          backend: "codex",
          notification: {
            method: "thread/pullRequests/updated",
            params: {
              threadId: "thread-1",
              prs: [],
            },
          },
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: "client_one",
        targetInstanceId: "gateway_one",
        createdAt: 2_000,
      },
      "client_one",
    );

    expect(invalidated).toEqual(["client_one"]);
  });

  it("invalidates cached remote summaries when a peer updates reactions", () => {
    const invalidated: Array<string | undefined> = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(createConnection({
      peerId: "client_one",
      capabilities: ["thread_navigation", "event_subscriptions"],
    }));
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "gateway_one";
    runtime.router = router;
    runtime.setEventSubscriptions("viewer", [{
      sourceInstanceId: "client_one",
      eventClasses: ["navigation"],
    }]);
    runtime.remoteThreadSummaryCache = {
      invalidate: (instanceId) => invalidated.push(instanceId),
    };

    runtime.publishRemoteBackendEvent(
      {
        id: "event-reactions",
        kind: "notification",
        method: FEDERATION_BACKEND_EVENT_METHOD,
        params: {
          backend: "codex",
          notification: {
            method: "thread/reactions/updated",
            params: {
              threadId: "thread-1",
              reactions: ["✋", "👀"],
            },
          },
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: "client_one",
        targetInstanceId: "gateway_one",
        createdAt: 2_000,
      },
      "client_one",
    );

    expect(invalidated).toEqual(["client_one"]);
  });

  it("invalidates Cmd+K summaries when a peer names a thread", () => {
    const invalidated: Array<string | undefined> = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(createConnection({
      peerId: "client_one",
      capabilities: ["thread_navigation", "event_subscriptions"],
    }));
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "gateway_one";
    runtime.router = router;
    runtime.setEventSubscriptions("viewer", [{
      sourceInstanceId: "client_one",
      eventClasses: ["navigation"],
    }]);
    runtime.remoteThreadSummaryCache = {
      invalidate: (instanceId) => invalidated.push(instanceId),
    };

    runtime.publishRemoteBackendEvent(
      {
        id: "event-name",
        kind: "notification",
        method: FEDERATION_BACKEND_EVENT_METHOD,
        params: {
          backend: "codex",
          notification: {
            method: "thread/name/updated",
            params: {
              threadId: "thread-1",
              threadName: "Sync generated names over federation",
            },
          },
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: "client_one",
        targetInstanceId: "gateway_one",
        createdAt: 2_000,
      },
      "client_one",
    );

    expect(invalidated).toEqual(["client_one"]);
  });

  it("subscribes Cmd+K snapshot peers to navigation updates for the cache TTL", async () => {
    vi.useFakeTimers();
    const sent: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "viewer_one" });
    router.registerConnection(createConnection({
      peerId: "owner_one",
      capabilities: ["thread_navigation", "event_subscriptions"],
      sendEnvelope: (envelope) => sent.push(envelope),
    }));
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "viewer_one";
    runtime.router = router;
    runtime.connectedPeerTargets = () => [{
      target: { scope: "remote", instanceId: "owner_one" },
      label: "Owner",
      capabilities: ["thread_navigation", "event_subscriptions"],
    }];
    runtime.remoteNavigationSnapshot = async () => ({
      backend: "all",
      fetchedAt: 1_000,
      unchanged: false,
      threads: [],
      inboxThreadKeys: [],
      directories: [],
      launchpadDefaults: {
        backend: "codex",
        executionMode: "default",
      },
    });

    const cache = runtime.remoteThreadSummaries();
    try {
      await cache.searchForJump({ query: "49" });
      expect(sent).toMatchObject([{
        kind: "notification",
        method: "federation.eventSubscription",
        params: { eventClasses: ["navigation"] },
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
      }]);

      await vi.advanceTimersByTimeAsync(15_000);
      expect(sent.at(-1)).toMatchObject({
        kind: "notification",
        method: "federation.eventSubscription",
        params: { eventClasses: [] },
        sourceInstanceId: "viewer_one",
        targetInstanceId: "owner_one",
      });
    } finally {
      cache.dispose();
      vi.useRealTimers();
    }
  });

  it("publishes remote environment setup progress with its source target", () => {
    const published: CodexEnvironmentSetupProgressEvent[] = [];
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "gateway_one";
    runtime.setEnvironmentSetupProgressPublisher((event) => {
      published.push(event);
    });

    const handled = runtime.publishRemoteEnvironmentSetupProgress(
      {
        id: "setup-1",
        kind: "notification",
        method: FEDERATION_ENVIRONMENT_SETUP_PROGRESS_METHOD,
        params: {
          directoryKey: "directory:/repo/app",
          environmentId: "node",
          environmentName: "Node",
          command: "pnpm install",
          phase: "stdout",
          chunk: "Installing",
          at: 2_000,
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: "client_one",
        targetInstanceId: "gateway_one",
        createdAt: 2_000,
      },
      "client_one",
    );

    expect(handled).toBe(true);
    expect(published).toEqual([
      {
        directoryKey: "directory:/repo/app",
        federationTarget: { scope: "remote", instanceId: "client_one" },
        environmentId: "node",
        environmentName: "Node",
        command: "pnpm install",
        phase: "stdout",
        chunk: "Installing",
        at: 2_000,
      },
    ]);
  });

  it("relays environment setup progress to the requesting sibling", () => {
    const published: CodexEnvironmentSetupProgressEvent[] = [];
    const relayed: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(
      createConnection({
        peerId: "client_one",
        capabilities: ["environment_actions", "gateway_relay"],
      }),
    );
    router.registerConnection(
      createConnection({
        peerId: "client_two",
        capabilities: ["environment_actions", "gateway_relay"],
        sendEnvelope: (envelope) => relayed.push(envelope),
      }),
    );
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "gateway_one";
    runtime.router = router;
    runtime.setEnvironmentSetupProgressPublisher((event) => {
      published.push(event);
    });
    const notification: FederationProtocolEnvelope = {
      id: "setup-relay-1",
      kind: "notification",
      method: FEDERATION_ENVIRONMENT_SETUP_PROGRESS_METHOD,
      params: {
        directoryKey: "directory:/repo/app",
        environmentId: "node",
        environmentName: "Node",
        command: "pnpm install",
        phase: "stdout",
        chunk: "Installing",
        at: 2_000,
      },
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "client_one",
      targetInstanceId: "client_two",
      createdAt: 2_000,
    };

    const handled = runtime.publishRemoteEnvironmentSetupProgress(
      notification,
      "client_one",
    );

    expect(handled).toBe(true);
    expect(published).toEqual([]);
    expect(relayed).toEqual([
      {
        ...notification,
        hopCount: 1,
      },
    ]);
  });

  it("relays client backend events only toward a subscribed sibling", () => {
    const relayedToSibling: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(
      createConnection({
        peerId: "client_one",
        capabilities: ["gateway_relay", "event_subscriptions"],
      }),
    );
    router.registerConnection(
      createConnection({
        peerId: "client_two",
        capabilities: [
          "gateway_relay",
          "thread_detail",
          "event_subscriptions",
        ],
        sendEnvelope: (envelope) => relayedToSibling.push(envelope),
      }),
    );
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "gateway_one";
    runtime.router = router;
    const event: FederationProtocolEnvelope = {
      id: "event-1",
      kind: "notification",
      method: FEDERATION_BACKEND_EVENT_METHOD,
      params: {
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            delta: "hello",
            itemId: "item-1",
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
      },
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "client_one",
      targetInstanceId: "client_two",
      createdAt: 2_000,
    };

    runtime.publishRemoteBackendEvent(event, "client_one");
    expect(relayedToSibling).toEqual([]);

    applyEventSubscription({
      runtime,
      sourceInstanceId: "client_one",
      subscriberInstanceId: "client_two",
      eventClasses: ["transcript"],
    });

    runtime.publishRemoteBackendEvent(event, "client_one");

    expect(relayedToSibling).toMatchObject([
      {
        id: "event-1",
        kind: "notification",
        method: FEDERATION_BACKEND_EVENT_METHOD,
        sourceInstanceId: "client_one",
        targetInstanceId: "client_two",
        hopCount: 1,
      },
    ]);
  });

  it("routes a delegated subscription and event through a dual instance", () => {
    const sentToOwner: FederationProtocolEnvelope[] = [];
    const sentToDual: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(createConnection({
      peerId: "dual_one",
      capabilities: [
        "gateway_relay",
        "thread_detail",
        "event_subscriptions",
      ],
      sendEnvelope: (envelope) => sentToDual.push(envelope),
    }));
    router.registerConnection(createConnection({
      peerId: "owner_one",
      capabilities: ["gateway_relay", "event_subscriptions"],
      sendEnvelope: (envelope) => sentToOwner.push(envelope),
    }));
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "gateway_one";
    runtime.router = router;
    applyEventSubscription({
      runtime,
      sourceInstanceId: "owner_one",
      subscriberInstanceId: "viewer_one",
      sourcePeerId: "dual_one",
      eventClasses: ["transcript"],
      hopCount: 1,
    });

    expect(sentToOwner).toMatchObject([{
      method: "federation.eventSubscription",
      sourceInstanceId: "viewer_one",
      targetInstanceId: "owner_one",
      hopCount: 1,
    }]);

    runtime.publishRemoteBackendEvent({
      id: "event-via-dual",
      kind: "notification",
      method: FEDERATION_BACKEND_EVENT_METHOD,
      params: {
        backend: "codex",
        notification: {
          method: "item/agentMessage/delta",
          params: {
            delta: "hello",
            itemId: "item-1",
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
      },
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 2_000,
    }, "owner_one");

    expect(sentToDual).toMatchObject([{
      id: "event-via-dual",
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      hopCount: 1,
    }]);
  });

  it("relays scheduler lifecycle events only to an explicitly subscribed sibling", () => {
    const authorized: FederationProtocolEnvelope[] = [];
    const unauthorized: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(createConnection({
      peerId: "client_one",
      capabilities: ["gateway_relay", "event_subscriptions"],
    }));
    router.registerConnection(createConnection({
      peerId: "client_two",
      capabilities: ["gateway_relay", "thread_detail", "event_subscriptions"],
      sendEnvelope: (envelope) => unauthorized.push(envelope),
    }));
    router.registerConnection(createConnection({
      peerId: "client_three",
      capabilities: [
        "gateway_relay",
        "scheduled_actions",
        "event_subscriptions",
      ],
      sendEnvelope: (envelope) => authorized.push(envelope),
    }));
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "gateway_one";
    runtime.router = router;
    applyEventSubscription({
      runtime,
      sourceInstanceId: "client_one",
      subscriberInstanceId: "client_three",
      eventClasses: ["scheduled_actions"],
    });

    runtime.publishRemoteBackendEvent({
      id: "scheduled-event-1",
      kind: "notification",
      method: FEDERATION_BACKEND_EVENT_METHOD,
      params: {
        backend: "codex",
        notification: {
          method: "thread/scheduledAction/updated",
          params: {
            action: {
              id: "scheduled-1",
              backend: "codex",
              threadId: "thread-1",
              kind: "turn",
              origin: "desktop",
              status: "scheduled",
              scheduledFor: 3_000,
              displayText: "private prompt",
              createdAt: 1_000,
              updatedAt: 1_000,
            },
          },
        },
      },
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "client_one",
      targetInstanceId: "client_three",
      createdAt: 2_000,
    }, "client_one");

    expect(authorized).toHaveLength(1);
    expect(unauthorized).toEqual([]);
  });

  it("routes unmatched relayed responses back to the target peer", async () => {
    const relayed: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(
      createConnection({
        peerId: "client_one",
        sendEnvelope: (envelope) => relayed.push(envelope),
      }),
    );
    router.registerConnection(
      createConnection({
        peerId: "client_two",
        capabilities: ["gateway_relay"],
      }),
    );
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = router;

    await runtime.receiveEnvelope(
      {
        id: "response-1",
        kind: "response",
        requestId: "request-1",
        protocolVersion: 1,
        sourceInstanceId: "client_two",
        targetInstanceId: "client_one",
        createdAt: 2_000,
        result: { ok: true },
      },
      "client_two",
    );

    expect(relayed).toMatchObject([
      {
        kind: "response",
        requestId: "request-1",
        sourceInstanceId: "client_two",
        targetInstanceId: "client_one",
        hopCount: 1,
      },
    ]);
  });

  it("routes PTY stream notifications through a gateway and preserves the owner identity", () => {
    const relayed: FederationProtocolEnvelope[] = [];
    const gatewayRouter = new FederationRouter({ localInstanceId: "gateway_one" });
    gatewayRouter.registerConnection(createConnection({
      peerId: "owner_one",
      capabilities: ["gateway_relay", "remote_pty"],
    }));
    gatewayRouter.registerConnection(createConnection({
      peerId: "viewer_one",
      capabilities: ["gateway_relay", "remote_pty"],
      sendEnvelope: (envelope) => relayed.push(envelope),
    }));
    const gateway = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    gateway.localInstanceId = "gateway_one";
    gateway.router = gatewayRouter;

    expect(gateway.publishRemotePtyStreamEvent({
      id: "pty-output-1",
      kind: "notification",
      method: "pty.output",
      params: {
        sessionId: "session-1",
        seq: 1,
        dataBase64: "b2s=",
      },
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "owner_one",
      targetInstanceId: "viewer_one",
      createdAt: 2_000,
    }, "owner_one")).toBe(true);
    expect(relayed).toMatchObject([
      {
        method: "pty.output",
        sourceInstanceId: "owner_one",
        targetInstanceId: "viewer_one",
        hopCount: 1,
      },
    ]);

    const viewerRouter = new FederationRouter({
      localInstanceId: "viewer_one",
      trustedRelayPeerId: "gateway_one",
    });
    viewerRouter.registerConnection(createConnection({
      peerId: "gateway_one",
      capabilities: ["gateway_relay", "remote_pty"],
    }));
    const viewer = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    viewer.localInstanceId = "viewer_one";
    viewer.router = viewerRouter;
    const events: Array<{
      kind: string;
      peerId: FederationInstanceId;
      params: unknown;
    }> = [];
    viewer.onRemotePtyEvent((event) => events.push(event));
    expect(viewer.publishRemotePtyStreamEvent(relayed[0]!, "gateway_one")).toBe(true);
    expect(events).toMatchObject([
      {
        kind: "output",
        peerId: "owner_one",
        params: { sessionId: "session-1", seq: 1 },
      },
    ]);

    expect(viewer.publishRemotePtyStreamEvent(
      relayed[0]!,
      "other_peer",
    )).toBe(true);
    expect(events).toHaveLength(1);
  });

  it("sends owner PTY notifications through the enrolled gateway fallback", () => {
    const sentToGateway: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "owner_one" });
    router.registerConnection(createConnection({
      peerId: "gateway_one",
      capabilities: ["gateway_relay", "remote_pty"],
      sendEnvelope: (envelope) => sentToGateway.push(envelope),
    }));
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "owner_one";
    runtime.gatewayInstanceId = "gateway_one";
    runtime.router = router;

    expect(runtime.sendPtyNotification(
      "viewer_one",
      "pty.output",
      { sessionId: "session-1", seq: 1, dataBase64: "b2s=" },
    )).toBe(true);
    expect(sentToGateway).toMatchObject([
      {
        kind: "notification",
        method: "pty.output",
        sourceInstanceId: "owner_one",
        targetInstanceId: "viewer_one",
      },
    ]);
  });

  it("ignores stale disconnects after the peer has reconnected", () => {
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = router;
    const oldConnection = createConnection({
      peerId: "client_one",
      sendEnvelope: () => undefined,
    });
    const newSendEnvelope = () => undefined;
    const newConnection = createConnection({
      peerId: "client_one",
      sendEnvelope: newSendEnvelope,
    });

    runtime.registerGatewayConnection(oldConnection);
    runtime.registerGatewayConnection(newConnection);
    runtime.unregisterGatewayConnection(oldConnection);

    expect(router.getConnection("client_one")?.sendEnvelope).toBe(newSendEnvelope);

    runtime.unregisterGatewayConnection(newConnection);

    expect(router.getConnection("client_one")).toBeUndefined();
  });

  it("assigns unique celestial icons on peer connect and broadcasts the map", () => {
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = router;
    runtime.localInstanceId = "gateway_one";
    runtime.celestialAssignments = new Map();
    runtime.store = () => ({
      getPeer: () => undefined,
      listPeers: () => [],
    });
    const sent: FederationProtocolEnvelope[] = [];
    runtime.visiblePeers = () => [
      { id: "client_one", status: "connected" },
      { id: "client_two", status: "connected" },
    ];
    router.registerConnection({
      peerId: "client_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => sent.push(envelope),
    });
    router.registerConnection({
      peerId: "client_two",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => sent.push(envelope),
    });
    runtime.reconcileCelestialAssignments();

    const assignments = runtime.celestialIconAssignments();
    const byInstance = new Map(
      assignments.map((entry) => [entry.instanceId, entry.icon]),
    );
    expect(byInstance.get("gateway_one")).toBe("sun");
    expect(new Set(byInstance.values()).size).toBe(3);

    const celestialBroadcasts = sent.filter(
      (envelope) =>
        envelope.kind === "notification"
        && envelope.method === "federation.celestialIcons",
    );
    expect(celestialBroadcasts.length).toBeGreaterThan(0);
    const lastBroadcast = celestialBroadcasts[
      celestialBroadcasts.length - 1
    ] as FederationProtocolEnvelope & {
      params: { assignments: CelestialIconAssignment[] };
    };
    expect(lastBroadcast.params.assignments).toHaveLength(3);
  });

  it("merges incoming celestial snapshots last-writer-wins and republishes on change only", () => {
    const router = new FederationRouter({ localInstanceId: "client_one" });
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = router;
    runtime.localInstanceId = "client_one";
    runtime.celestialAssignments = new Map([
      [
        "client_one",
        {
          instanceId: "client_one",
          icon: "moon" as const,
          source: "auto" as const,
          updatedAt: 1_000,
        },
      ],
    ]);
    runtime.store = () => ({
      getPeer: () => undefined,
      listPeers: () => [],
    });
    const published: AgentEvent[] = [];
    runtime.setAgentEventPublisher((event) => published.push(event));

    const snapshot = (
      id: string,
      assignments: CelestialIconAssignment[],
    ): FederationProtocolEnvelope => ({
      id,
      kind: "notification",
      method: "federation.celestialIcons",
      params: { assignments },
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: "gateway_one",
      targetInstanceId: "client_one",
      createdAt: 2_000,
    });

    const gatewaySnapshot: CelestialIconAssignment[] = [
      {
        instanceId: "gateway_one",
        icon: "sun",
        source: "auto",
        updatedAt: 2_000,
      },
      {
        instanceId: "client_one",
        icon: "black-hole",
        source: "override",
        updatedAt: 3_000,
      },
    ];

    expect(
      runtime.applyCelestialIcons(snapshot("celestial-1", gatewaySnapshot), "gateway_one"),
    ).toBe(true);
    const merged = new Map(
      runtime
        .celestialIconAssignments()
        .map((entry) => [entry.instanceId, entry]),
    );
    expect(merged.get("client_one")?.icon).toBe("black-hole");
    expect(merged.get("gateway_one")?.icon).toBe("sun");
    expect(
      published.filter(
        (event) =>
          event.notification.method === "federation/celestialIcons/changed",
      ),
    ).toHaveLength(1);

    // Replaying the same snapshot is a no-op: no extra publish.
    runtime.applyCelestialIcons(snapshot("celestial-2", gatewaySnapshot), "gateway_one");
    expect(
      published.filter(
        (event) =>
          event.notification.method === "federation/celestialIcons/changed",
      ),
    ).toHaveLength(1);

    // An older entry for the same instance loses the merge.
    runtime.applyCelestialIcons(
      snapshot("celestial-3", [
        {
          instanceId: "client_one",
          icon: "moon",
          source: "auto",
          updatedAt: 500,
        },
      ]),
      "gateway_one",
    );
    expect(
      new Map(
        runtime
          .celestialIconAssignments()
          .map((entry) => [entry.instanceId, entry]),
      ).get("client_one")?.icon,
    ).toBe("black-hole");
  });

  it("applies coordinator overrides locally and broadcasts them", async () => {
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = router;
    runtime.localInstanceId = "gateway_one";
    runtime.celestialAssignments = new Map();
    runtime.store = () => ({
      getPeer: () => undefined,
      listPeers: () => [],
    });
    const sent: FederationProtocolEnvelope[] = [];
    router.registerConnection({
      peerId: "client_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => sent.push(envelope),
    });

    const response = await runtime.setCelestialIcon({
      instanceId: "client_one",
      icon: "black-hole",
    });
    const override = response.assignments.find(
      (entry) => entry.instanceId === "client_one",
    );
    expect(override?.icon).toBe("black-hole");
    expect(override?.source).toBe("override");
    expect(
      sent.some(
        (envelope) =>
          envelope.kind === "notification"
          && envelope.method === "federation.celestialIcons",
      ),
    ).toBe(true);

    await expect(
      runtime.setCelestialIcon({ instanceId: "client_one", icon: "comet" }),
    ).rejects.toThrow(/invalid celestial icon/i);
  });

  it("resolves icon collisions: override keeps, oldest keeps, losers reassign", () => {
    const assignment = (
      instanceId: FederationInstanceId,
      icon: CelestialIconAssignment["icon"],
      updatedAt: number,
      source: "auto" | "override" = "auto",
    ): [FederationInstanceId, CelestialIconAssignment] => [
      instanceId,
      { instanceId, icon, source, updatedAt },
    ];
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = new FederationRouter({ localInstanceId: "gateway_one" });
    runtime.localInstanceId = "gateway_one";
    runtime.store = () => ({
      getPeer: () => undefined,
      listPeers: () => [],
    });
    runtime.visiblePeers = () => [
      { id: "client_a", status: "connected" },
      { id: "client_b", status: "connected" },
      { id: "client_c", status: "connected" },
    ];
    // Three instances collided on the moon while apart: the override entry
    // must keep it, the auto entries must both move to distinct free icons.
    runtime.celestialAssignments = new Map([
      assignment("gateway_one", "sun", 1_000),
      assignment("client_a", "moon", 5_000, "override"),
      assignment("client_b", "moon", 2_000),
      assignment("client_c", "moon", 3_000),
    ]);
    runtime.reconcileCelestialAssignments();

    const byInstance = new Map(
      runtime.celestialIconAssignments().map((entry) => [entry.instanceId, entry]),
    );
    expect(byInstance.get("client_a")).toMatchObject({
      icon: "moon",
      source: "override",
      updatedAt: 5_000,
    });
    expect(byInstance.get("client_b")?.icon).not.toBe("moon");
    expect(byInstance.get("client_c")?.icon).not.toBe("moon");
    expect(byInstance.get("client_b")?.icon).not.toBe(
      byInstance.get("client_c")?.icon,
    );
    const icons = [...byInstance.values()].map((entry) => entry.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });

  it("keeps the oldest auto entry in a collision when no override is involved", () => {
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = new FederationRouter({ localInstanceId: "gateway_one" });
    runtime.localInstanceId = "gateway_one";
    runtime.store = () => ({
      getPeer: () => undefined,
      listPeers: () => [],
    });
    runtime.visiblePeers = () => [
      { id: "client_b", status: "connected" },
      { id: "client_c", status: "connected" },
    ];
    runtime.celestialAssignments = new Map([
      [
        "client_b",
        {
          instanceId: "client_b",
          icon: "moon" as const,
          source: "auto" as const,
          updatedAt: 2_000,
        },
      ],
      [
        "client_c",
        {
          instanceId: "client_c",
          icon: "moon" as const,
          source: "auto" as const,
          updatedAt: 3_000,
        },
      ],
    ]);
    runtime.reconcileCelestialAssignments();

    const byInstance = new Map(
      runtime.celestialIconAssignments().map((entry) => [entry.instanceId, entry]),
    );
    expect(byInstance.get("client_b")).toMatchObject({
      icon: "moon",
      updatedAt: 2_000,
    });
    expect(byInstance.get("client_c")?.icon).not.toBe("moon");
  });

  it("tombstones a revoked peer's icon and frees it for reuse", async () => {
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = router;
    runtime.localInstanceId = "gateway_one";
    runtime.store = () => ({
      getPeer: () => ({
        id: "client_one",
        label: "Studio Mac",
        role: "client",
        status: "connected",
        capabilities: [],
        canRevoke: true,
      }),
      listPeers: () => [],
      revokePeer: () => undefined,
    });
    runtime.celestialAssignments = new Map([
      [
        "client_one",
        {
          instanceId: "client_one",
          icon: "moon" as const,
          source: "auto" as const,
          updatedAt: 1_000,
        },
      ],
    ]);
    const sent: FederationProtocolEnvelope[] = [];
    router.registerConnection({
      peerId: "client_two",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => sent.push(envelope),
    });

    await runtime.revokePeer("client_one");

    expect(runtime.celestialIconFor("client_one")).toBeUndefined();
    const tombstone = runtime
      .celestialIconAssignments()
      .find((entry) => entry.instanceId === "client_one");
    expect(tombstone?.removed).toBe(true);
    const broadcast = sent.findLast(
      (envelope) =>
        envelope.kind === "notification"
        && envelope.method === "federation.celestialIcons",
    ) as (FederationProtocolEnvelope & {
      params: { assignments: CelestialIconAssignment[] };
    }) | undefined;
    expect(
      broadcast?.params.assignments.find(
        (entry) => entry.instanceId === "client_one",
      )?.removed,
    ).toBe(true);

    // The freed icon is reusable: a new peer picks the moon again.
    runtime.visiblePeers = () => [{ id: "client_three", status: "connected" }];
    runtime.reconcileCelestialAssignments();
    expect(runtime.celestialIconFor("client_three")).toBe("moon");
  });

  it("keeps a revoked peer tombstoned across reconcile (real visiblePeers)", async () => {
    // Deliberately does NOT stub visiblePeers: it retains revoked peers via
    // listPeers({ includeRevoked: true }) to feed the Settings list, and a
    // celestial pass that reads it directly both spares the revoked peer
    // from pruning and re-assigns it a live icon, undoing the tombstone.
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = router;
    runtime.localInstanceId = "gateway_one";
    let revoked = false;
    runtime.store = () => ({
      getPeer: () => ({
        id: "client_one",
        label: "Studio Mac",
        role: "client",
        status: "connected",
        capabilities: [],
        canRevoke: true,
      }),
      listPeers: (options?: { includeRevoked?: boolean }) =>
        revoked && !options?.includeRevoked
          ? []
          : [
              {
                id: "client_one",
                label: "Studio Mac",
                role: "client" as const,
                status: revoked ? ("revoked" as const) : ("connected" as const),
                capabilities: [],
              },
            ],
      revokePeer: () => {
        revoked = true;
      },
    });
    runtime.celestialAssignments = new Map([
      [
        "client_one",
        {
          instanceId: "client_one",
          icon: "moon" as const,
          source: "auto" as const,
          updatedAt: 1_000,
        },
      ],
    ]);

    await runtime.revokePeer("client_one");
    expect(runtime.celestialIconFor("client_one")).toBeUndefined();

    // Any later peer connect reconciles; the tombstone must survive it.
    runtime.reconcileCelestialAssignments();
    expect(runtime.celestialIconFor("client_one")).toBeUndefined();
    expect(
      runtime
        .celestialIconAssignments()
        .find((entry) => entry.instanceId === "client_one")?.removed,
    ).toBe(true);
  });

  it("tombstones a revoked peer even without an explicit revoke call", () => {
    // The prune pass is the safety net: a peer revoked by an earlier build
    // (or in a session whose removeCelestialAssignment never ran) still
    // loses its icon on the next reconcile.
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = new FederationRouter({ localInstanceId: "gateway_one" });
    runtime.localInstanceId = "gateway_one";
    runtime.store = () => ({
      getPeer: () => undefined,
      listPeers: (options?: { includeRevoked?: boolean }) =>
        options?.includeRevoked
          ? [
              {
                id: "client_one",
                label: "Studio Mac",
                role: "client" as const,
                status: "revoked" as const,
                capabilities: [],
              },
            ]
          : [],
    });
    runtime.celestialAssignments = new Map([
      [
        "client_one",
        {
          instanceId: "client_one",
          icon: "moon" as const,
          source: "auto" as const,
          updatedAt: 1_000,
        },
      ],
    ]);

    runtime.reconcileCelestialAssignments();

    expect(runtime.celestialIconFor("client_one")).toBeUndefined();
  });

  it("prunes entries unknown to the directory and store, sparing enrolled peers", () => {
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = new FederationRouter({ localInstanceId: "gateway_one" });
    runtime.localInstanceId = "gateway_one";
    runtime.store = () => ({
      getPeer: () => undefined,
      listPeers: () => [{ id: "enrolled_offline" }],
    });
    runtime.visiblePeers = () => [];
    runtime.celestialAssignments = new Map([
      [
        "enrolled_offline",
        {
          instanceId: "enrolled_offline",
          icon: "moon" as const,
          source: "auto" as const,
          updatedAt: 1_000,
        },
      ],
      [
        "long_gone",
        {
          instanceId: "long_gone",
          icon: "ringed-planet" as const,
          source: "auto" as const,
          updatedAt: 1_000,
        },
      ],
    ]);
    runtime.reconcileCelestialAssignments();

    expect(runtime.celestialIconFor("enrolled_offline")).toBe("moon");
    expect(runtime.celestialIconFor("long_gone")).toBeUndefined();
    const tombstone = runtime
      .celestialIconAssignments()
      .find((entry) => entry.instanceId === "long_gone");
    expect(tombstone?.removed).toBe(true);
  });

  it("rejects malformed instance ids and bounds snapshot growth", () => {
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = new FederationRouter({ localInstanceId: "client_one" });
    runtime.localInstanceId = "client_one";
    runtime.store = () => ({
      getPeer: () => undefined,
      listPeers: () => [],
    });
    runtime.celestialAssignments = new Map();
    const assignments: CelestialIconAssignment[] = [
      {
        instanceId: "not a valid id!",
        icon: "moon",
        source: "auto",
        updatedAt: 2_000,
      },
    ];
    for (let index = 0; index < 100; index += 1) {
      assignments.push({
        instanceId: `flood_${index}`,
        icon: "black-hole",
        source: "auto",
        updatedAt: 2_000,
      });
    }
    runtime.applyCelestialIcons(
      {
        id: "celestial-flood",
        kind: "notification",
        method: "federation.celestialIcons",
        params: { assignments },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 2_000,
      },
      "gateway_one",
    );

    const merged = runtime.celestialIconAssignments();
    expect(merged.length).toBeLessThanOrEqual(MAX_CELESTIAL_ASSIGNMENTS);
    expect(
      merged.some((entry) => entry.instanceId === "not a valid id!"),
    ).toBe(false);
    // Entries for already-known instances still merge at the cap.
    const knownUpdate = runtime.applyCelestialIcons(
      {
        id: "celestial-known",
        kind: "notification",
        method: "federation.celestialIcons",
        params: {
          assignments: [
            {
              instanceId: "flood_0",
              icon: "moon",
              source: "auto",
              updatedAt: 3_000,
            },
          ],
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 3_000,
      },
      "gateway_one",
    );
    expect(knownUpdate).toBe(true);
    expect(runtime.celestialIconFor("flood_0")).toBe("moon");
  });

  it("expires stale tombstones on the client receive path and keeps them off the cap", () => {
    // A pure client never reconciles, so applyCelestialIcons owns expiry
    // there; and tombstones must not consume the entry budget or a churning
    // federation would starve out real peers.
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = new FederationRouter({ localInstanceId: "client_one" });
    runtime.localInstanceId = "client_one";
    runtime.store = () => ({
      getPeer: () => undefined,
      listPeers: () => [],
    });
    const stale = Date.now() - 8 * 24 * 60 * 60_000;
    const assignments = new Map<FederationInstanceId, CelestialIconAssignment>([
      [
        "long_gone",
        {
          instanceId: "long_gone",
          icon: "moon",
          source: "auto",
          updatedAt: stale,
          removed: true,
        },
      ],
    ]);
    // Fill the rest of the budget with fresh tombstones: they should not
    // block the one live entry arriving below.
    for (let index = 0; index < MAX_CELESTIAL_ASSIGNMENTS; index += 1) {
      assignments.set(`dead_${index}`, {
        instanceId: `dead_${index}`,
        icon: "black-hole",
        source: "auto",
        updatedAt: 1_000,
        removed: true,
      });
    }
    runtime.celestialAssignments = assignments;

    runtime.applyCelestialIcons(
      {
        id: "celestial-live",
        kind: "notification",
        method: "federation.celestialIcons",
        params: {
          assignments: [
            {
              instanceId: "gateway_one",
              icon: "sun",
              source: "auto",
              updatedAt: 2_000,
            },
          ],
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 2_000,
      },
      "gateway_one",
    );

    // The stale tombstone is gone; fresh ones remain but did not crowd out
    // the newly advertised live gateway.
    expect(
      runtime
        .celestialIconAssignments()
        .some((entry) => entry.instanceId === "long_gone"),
    ).toBe(false);
    expect(runtime.celestialIconFor("gateway_one")).toBe("sun");
  });

  it("clears an operator override back to auto and broadcasts the reset", async () => {
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = router;
    runtime.localInstanceId = "gateway_one";
    runtime.store = () => ({
      getPeer: () => undefined,
      listPeers: () => [],
    });
    runtime.celestialAssignments = new Map([
      [
        "gateway_one",
        {
          instanceId: "gateway_one",
          icon: "sun" as const,
          source: "auto" as const,
          updatedAt: 1_000,
        },
      ],
      [
        "client_one",
        {
          instanceId: "client_one",
          icon: "black-hole" as const,
          source: "override" as const,
          updatedAt: 2_000,
        },
      ],
    ]);
    const sent: FederationProtocolEnvelope[] = [];
    router.registerConnection({
      peerId: "client_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => sent.push(envelope),
    });

    const response = await runtime.setCelestialIcon({
      instanceId: "client_one",
      icon: null,
    });
    const cleared = response.assignments.find(
      (entry) => entry.instanceId === "client_one",
    );
    expect(cleared?.source).toBe("auto");
    expect(cleared?.icon).toBe("moon");
    expect(cleared?.updatedAt).toBeGreaterThan(2_000);
    expect(
      sent.some(
        (envelope) =>
          envelope.kind === "notification"
          && envelope.method === "federation.celestialIcons",
      ),
    ).toBe(true);

    await expect(
      runtime.setCelestialIcon({ instanceId: "not a valid id!", icon: null }),
    ).rejects.toThrow(/invalid celestial icon/i);
  });

  it("applies an incoming tombstone and stops reporting the icon", () => {
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.router = new FederationRouter({ localInstanceId: "client_one" });
    runtime.localInstanceId = "client_one";
    runtime.store = () => ({
      getPeer: () => undefined,
      listPeers: () => [],
    });
    runtime.celestialAssignments = new Map([
      [
        "client_two",
        {
          instanceId: "client_two",
          icon: "moon" as const,
          source: "auto" as const,
          updatedAt: 1_000,
        },
      ],
    ]);

    runtime.applyCelestialIcons(
      {
        id: "celestial-tombstone",
        kind: "notification",
        method: "federation.celestialIcons",
        params: {
          assignments: [
            {
              instanceId: "client_two",
              icon: "moon",
              source: "auto",
              updatedAt: 2_000,
              removed: true,
            },
          ],
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 2_000,
      },
      "gateway_one",
    );

    expect(runtime.celestialIconFor("client_two")).toBeUndefined();
    expect(
      runtime
        .celestialIconAssignments()
        .find((entry) => entry.instanceId === "client_two")?.removed,
    ).toBe(true);
  });
});
