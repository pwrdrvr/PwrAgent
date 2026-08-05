import { describe, expect, it } from "vitest";
import type {
  AgentEvent,
  CodexEnvironmentSetupProgressEvent,
  FederationCapability,
  FederationInstanceId,
  FederationProtocolEnvelope,
  NavigationSnapshot,
} from "@pwragent/shared";
import {
  FEDERATION_PROTOCOL_VERSION,
  findPreferredReviewWorkspaceCwd,
} from "@pwragent/shared";
import {
  FEDERATION_BACKEND_EVENT_METHOD,
  FEDERATION_ENVIRONMENT_SETUP_PROGRESS_METHOD,
} from "../federation/federation-backend-bridge";
import { DesktopFederationRuntime } from "../federation/federation-runtime";
import { FederationRouter } from "../federation/federation-router";
import type { FederationGatewayConnection } from "../federation/federation-transport";

type RuntimeHarness = {
  router?: FederationRouter;
  receiveEnvelope: (
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ) => Promise<void>;
  applyPeerDirectory: (envelope: FederationProtocolEnvelope) => boolean;
  forwardLocalBackendEvent: (event: AgentEvent) => void;
  gatewayInstanceId?: FederationInstanceId;
  localInstanceId?: FederationInstanceId;
  publishRemoteBackendEvent: (
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ) => boolean;
  publishRemoteEnvironmentSetupProgress: (
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ) => boolean;
  remotePeerDirectory: Map<FederationInstanceId, unknown>;
  disconnectAdvertisedPeers: (reason: string) => void;
  registerGatewayConnection: (connection: FederationGatewayConnection) => void;
  remoteBackend: (target?: {
    scope: "remote";
    instanceId: FederationInstanceId;
  }) => {
    getNavigationSnapshot: () => Promise<NavigationSnapshot>;
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
  sendEnvelopeToTarget: (
    targetInstanceId: FederationInstanceId,
    envelope: FederationProtocolEnvelope,
  ) => void;
  setAgentEventPublisher: (publisher: (event: AgentEvent) => void) => void;
  setEnvironmentSetupProgressPublisher: (
    publisher: (event: CodexEnvironmentSetupProgressEvent) => void,
  ) => void;
  store: () => {
    getPeer: (peerId: FederationInstanceId) => {
      label: string;
      status: "connected";
    } | undefined;
    listPeers: () => [];
  };
  unregisterGatewayConnection: (connection: FederationGatewayConnection) => void;
  visiblePeers: () => Array<{
    id: FederationInstanceId;
    status: string;
  }>;
  connectedPeerTargets: () => Array<{
    target: { scope: "remote"; instanceId: FederationInstanceId };
    label: string;
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
    expect(findPreferredReviewWorkspaceCwd(snapshot.threads[0])).toBe(
      pwrAgentWorktree,
    );
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

  it("marks gateway-advertised routes disconnected when the gateway closes", () => {
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "client_one";
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

  it("resolves sibling RPC responses received from the gateway transport", async () => {
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

  it("forwards local backend events to remote-capable peers", () => {
    const forwarded: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(
      createConnection({
        peerId: "client_one",
        capabilities: ["remote_window"],
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

    expect(forwarded).toMatchObject([
      {
        kind: "notification",
        method: FEDERATION_BACKEND_EVENT_METHOD,
        params: {
          backend: "codex",
          notification: {
            method: "turn/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
      },
    ]);
  });

  it("publishes remote backend events with the source peer as federation target", () => {
    const published: AgentEvent[] = [];
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
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

  it("relays client backend events to sibling peers through the gateway", () => {
    const relayedToSibling: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({ localInstanceId: "gateway_one" });
    router.registerConnection(
      createConnection({
        peerId: "client_one",
        capabilities: ["remote_window"],
      }),
    );
    router.registerConnection(
      createConnection({
        peerId: "client_two",
        capabilities: ["remote_window"],
        sendEnvelope: (envelope) => relayedToSibling.push(envelope),
      }),
    );
    const runtime = new DesktopFederationRuntime() as unknown as RuntimeHarness;
    runtime.localInstanceId = "gateway_one";
    runtime.router = router;

    runtime.publishRemoteBackendEvent(
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
});
