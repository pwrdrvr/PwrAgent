import { describe, expect, it, vi } from "vitest";
import type {
  FederationProtocolEnvelope,
  TrustCodexProjectRequest,
} from "@pwragent/shared";
import {
  FEDERATION_BACKEND_METHODS,
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  FederationRemoteBackendClient,
  registerFederationBackendHandlers,
  type FederationBackendOperations,
} from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";

describe("federation backend bridge", () => {
  it("maps federation backend methods to local app-server operations", async () => {
    const backend: FederationBackendOperations = {
      listThreads: vi.fn(async () => ({
        backend: "codex",
        fetchedAt: 1_000,
        threads: [],
      })),
      readThread: vi.fn(),
      listSkills: vi.fn(),
      listBackends: vi.fn(),
      archiveThread: vi.fn(async () => ({
        backend: "codex",
        threadId: "thread-1",
        archivedAt: 2_000,
        cleanup: [],
      })),
      startTurn: vi.fn(),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "gateway_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
      now: () => 2_000,
    });
    router.registerConnection({
      peerId: "client_one",
      capabilities: ["thread_navigation", "turn_control"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "client_one",
      envelope: {
        id: "request-1",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.listThreads,
        params: { backend: "codex" },
        protocolVersion: 1,
        sourceInstanceId: "client_one",
        targetInstanceId: "gateway_one",
        createdAt: 1_000,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "client_one",
      envelope: {
        id: "request-2",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.archiveThread,
        params: { backend: "codex", threadId: "thread-1" },
        protocolVersion: 1,
        sourceInstanceId: "client_one",
        targetInstanceId: "gateway_one",
        createdAt: 1_100,
      },
    });

    expect(backend.listThreads).toHaveBeenCalledWith({ backend: "codex" });
    expect(backend.archiveThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(replies).toMatchObject([
      {
        kind: "response",
        requestId: "request-1",
        result: {
          backend: "codex",
          threads: [],
        },
      },
      {
        kind: "response",
        requestId: "request-2",
        result: {
          backend: "codex",
          threadId: "thread-1",
        },
      },
    ]);
  });

  it("serializes remote backend requests over RPC envelopes", async () => {
    const sent: FederationProtocolEnvelope[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "gateway_one",
      remoteInstanceId: "client_one",
      sendEnvelope: (envelope) => sent.push(envelope),
      now: () => 1_000,
    });
    const client = new FederationRemoteBackendClient(rpc);
    const pending = client.listThreads({ backend: "codex" });

    expect(sent).toMatchObject([
      {
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.listThreads,
        params: { backend: "codex" },
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
      },
    ]);

    rpc.receiveEnvelope({
      id: "response-1",
      kind: "response",
      requestId: sent[0]!.id,
      protocolVersion: 1,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 1_100,
      result: {
        backend: "codex",
        fetchedAt: 1_100,
        threads: [],
      },
    });

    await expect(pending).resolves.toMatchObject({
      backend: "codex",
      threads: [],
    });

    const archivePending = client.archiveThread({
      backend: "codex",
      threadId: "thread-1",
    });
    const archiveRequest = sent.at(-1)!;
    expect(archiveRequest).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.archiveThread,
      params: { backend: "codex", threadId: "thread-1" },
    });
    rpc.receiveEnvelope({
      id: "response-2",
      kind: "response",
      requestId: archiveRequest.id,
      protocolVersion: 1,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 1_200,
      result: {
        backend: "codex",
        threadId: "thread-1",
        archivedAt: 1_200,
        cleanup: [],
      },
    });
    await expect(archivePending).resolves.toMatchObject({
      threadId: "thread-1",
      cleanup: [],
    });

    const refreshPending = client.refreshDirectoryGitStatuses({
      directoryKeys: ["directory:/remote/repo"],
      force: true,
    });
    const refreshRequest = sent.at(-1)!;
    expect(refreshRequest).toMatchObject({
      kind: "request",
      method: FEDERATION_BACKEND_METHODS.refreshDirectoryGitStatuses,
      params: {
        directoryKeys: ["directory:/remote/repo"],
        force: true,
      },
    });
    rpc.receiveEnvelope({
      id: "response-3",
      kind: "response",
      requestId: refreshRequest.id,
      protocolVersion: 1,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 1_300,
      result: { scheduledCount: 1 },
    });
    await expect(refreshPending).resolves.toEqual({ scheduledCount: 1 });
  });

  it("executes directory Git status refreshes on the target instance", async () => {
    const backend = {
      refreshDirectoryGitStatuses: vi.fn(async () => ({ scheduledCount: 1 })),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "client_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "gateway_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "refresh-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.refreshDirectoryGitStatuses,
        params: {
          directoryKeys: ["directory:/remote/repo"],
          force: true,
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_000,
      },
    });

    expect(backend.refreshDirectoryGitStatuses).toHaveBeenCalledExactlyOnceWith({
      directoryKeys: ["directory:/remote/repo"],
      force: true,
    });
    expect(replies).toMatchObject([
      {
        kind: "response",
        requestId: "refresh-request",
        result: { scheduledCount: 1 },
      },
    ]);
  });

  it("requires thread-detail capability for remote thread reads", async () => {
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "gateway_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "client_one",
      capabilities: ["thread_navigation"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({
      router,
      backend: {
        listThreads: vi.fn(),
        readThread: vi.fn(),
        listSkills: vi.fn(),
        listBackends: vi.fn(),
        startTurn: vi.fn(),
      } as unknown as FederationBackendOperations,
    });

    await expect(
      router.routeEnvelope({
        sourcePeerId: "client_one",
        envelope: {
          id: "request-1",
          kind: "request",
          method: FEDERATION_BACKEND_METHODS.readThread,
          params: { backend: "codex", threadId: "thread-1" },
          protocolVersion: 1,
          sourceInstanceId: "client_one",
          targetInstanceId: "gateway_one",
          createdAt: 1_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "capability_denied",
    });
  });

  it("maps remote turn submission to a turn-control guarded handler", async () => {
    const backend: FederationBackendOperations = {
      listThreads: vi.fn(),
      readThread: vi.fn(),
      listSkills: vi.fn(),
      startTurn: vi.fn(async () => ({
        backend: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
        queueStatus: "started",
      })),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "client_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "gateway_one",
      capabilities: ["turn_control"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "request-1",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.startTurn,
        params: {
          backend: "codex",
          threadId: "thread-1",
          input: [{ type: "text", text: "ship it" }],
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_000,
      },
    });

    expect(backend.startTurn).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      input: [{ type: "text", text: "ship it" }],
    });
    expect(replies).toMatchObject([
      {
        kind: "response",
        requestId: "request-1",
        result: {
          backend: "codex",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      },
    ]);
  });

  it("maps expanded remote control operations to capability-guarded handlers", async () => {
    const backend: FederationBackendOperations = {
      getNavigationSnapshot: vi.fn(),
      listThreads: vi.fn(),
      readThread: vi.fn(),
      listSkills: vi.fn(),
      listBackends: vi.fn(),
      archiveThread: vi.fn(),
      startThread: vi.fn(),
      forkThread: vi.fn(),
      startTurn: vi.fn(),
      startReview: vi.fn(),
      compactThread: vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        turnId: "compact-1",
      })),
      interruptTurn: vi.fn(),
      steerTurn: vi.fn(),
      setThreadExecutionMode: vi.fn(),
      queueThreadExecutionMode: vi.fn(),
      cancelThreadExecutionModeQueue: vi.fn(),
      setAcpSessionRuntimeOption: vi.fn(),
      setThreadModelSettings: vi.fn(),
      submitServerRequest: vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        requestId: "approval-1",
      })),
      runCodexEnvironmentAction: vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        codexEnvironmentRuntime: {
          environmentId: "node",
          environmentName: "Node",
          executionTarget: "local" as const,
        },
      })),
      stopCodexEnvironmentAction: vi.fn(),
      setCodexThreadEnvironment: vi.fn(),
      materializeDirectoryLaunchpad: vi.fn(),
      refreshDirectoryGitStatuses: vi.fn(),
      handoffThreadWorkspace: vi.fn(),
      renameThread: vi.fn(),
      readApplications: vi.fn(),
      openApplication: vi.fn(),
      trustCodexProject: vi.fn(),
    };
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "client_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
      now: () => 2_000,
    });
    router.registerConnection({
      peerId: "gateway_one",
      capabilities: [
        "turn_control",
        "pending_request_control",
        "environment_actions",
      ],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "compact-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.compactThread,
        params: { backend: "codex", threadId: "thread-1" },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_000,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "approval-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.submitServerRequest,
        params: {
          backend: "codex",
          threadId: "thread-1",
          requestId: "approval-1",
          response: { decision: "approve" },
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_100,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "env-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.runCodexEnvironmentAction,
        params: {
          actionId: "start",
          backend: "codex",
          threadId: "thread-1",
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_200,
      },
    });

    expect(backend.compactThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
    });
    expect(backend.submitServerRequest).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      requestId: "approval-1",
      response: { decision: "approve" },
    });
    expect(backend.runCodexEnvironmentAction).toHaveBeenCalledWith({
      actionId: "start",
      backend: "codex",
      threadId: "thread-1",
    });
    expect(replies).toMatchObject([
      {
        kind: "response",
        requestId: "compact-request",
        result: { turnId: "compact-1" },
      },
      {
        kind: "response",
        requestId: "approval-request",
        result: { requestId: "approval-1" },
      },
      {
        kind: "response",
        requestId: "env-request",
        result: {
          codexEnvironmentRuntime: {
            environmentId: "node",
          },
        },
      },
    ]);
  });

  it("requires environment_actions for remote environment mutations", async () => {
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "client_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "gateway_one",
      capabilities: ["turn_control"],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({
      router,
      backend: {
        getNavigationSnapshot: vi.fn(),
        listThreads: vi.fn(),
        readThread: vi.fn(),
        listSkills: vi.fn(),
        listBackends: vi.fn(),
        archiveThread: vi.fn(),
        startThread: vi.fn(),
        forkThread: vi.fn(),
        startTurn: vi.fn(),
        startReview: vi.fn(),
        compactThread: vi.fn(),
        interruptTurn: vi.fn(),
        steerTurn: vi.fn(),
        setThreadExecutionMode: vi.fn(),
        queueThreadExecutionMode: vi.fn(),
        cancelThreadExecutionModeQueue: vi.fn(),
        setAcpSessionRuntimeOption: vi.fn(),
        setThreadModelSettings: vi.fn(),
        submitServerRequest: vi.fn(),
        runCodexEnvironmentAction: vi.fn(),
        stopCodexEnvironmentAction: vi.fn(),
        setCodexThreadEnvironment: vi.fn(),
        refreshDirectoryGitStatuses: vi.fn(),
        materializeDirectoryLaunchpad: vi.fn(),
        handoffThreadWorkspace: vi.fn(),
        renameThread: vi.fn(),
        readApplications: vi.fn(),
        openApplication: vi.fn(),
        trustCodexProject: vi.fn(),
      } as FederationBackendOperations,
    });

    await expect(
      router.routeEnvelope({
        sourcePeerId: "gateway_one",
        envelope: {
          id: "env-request",
          kind: "request",
          method: FEDERATION_BACKEND_METHODS.setCodexThreadEnvironment,
          params: {
            backend: "codex",
            environmentId: "node",
            threadId: "thread-1",
          },
          protocolVersion: 1,
          sourceInstanceId: "gateway_one",
          targetInstanceId: "client_one",
          createdAt: 1_000,
        },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "capability_denied",
    });
    expect(replies).toMatchObject([
      {
        kind: "error",
        requestId: "env-request",
        error: { code: "capability_denied" },
      },
    ]);
  });

  it("routes remote thread renames and application operations to the target instance", async () => {
    const backend = {
      renameThread: vi.fn(async () => ({
        backend: "codex" as const,
        threadId: "thread-1",
        renamedAt: 2_000,
      })),
      readApplications: vi.fn(async () => ({
        editors: [],
        terminals: [{
          id: "terminal",
          kind: "terminal" as const,
          name: "Terminal",
          source: "application" as const,
          canOpenWorkspace: true,
        }],
        preferredEditorId: { value: "", source: "default" as const },
        preferredTerminalId: { value: "", source: "default" as const },
        gh: {
          path: { value: "", source: "default" as const },
          discovery: { candidates: [] },
        },
        git: { discovery: { candidates: [] } },
      })),
      openApplication: vi.fn(async () => ({ opened: true as const })),
      trustCodexProject: vi.fn(async (request: TrustCodexProjectRequest) => ({
        ...request,
        trusted: true,
      })),
    } as unknown as FederationBackendOperations;
    const replies: FederationProtocolEnvelope[] = [];
    const router = new FederationRouter({
      localInstanceId: "client_one",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    router.registerConnection({
      peerId: "gateway_one",
      capabilities: [
        "turn_control",
        "remote_window",
        "environment_actions",
      ],
      sendEnvelope: (envelope) => replies.push(envelope),
    });
    registerFederationBackendHandlers({ router, backend });

    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "rename-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.renameThread,
        params: {
          backend: "codex",
          threadId: "thread-1",
          name: "Remote title",
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_000,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "applications-read-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.readApplications,
        params: {},
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_050,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "application-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.openApplication,
        params: {
          applicationId: "terminal",
          kind: "terminal",
          targetPath: "/remote/repo",
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_100,
      },
    });
    await router.routeEnvelope({
      sourcePeerId: "gateway_one",
      envelope: {
        id: "trust-request",
        kind: "request",
        method: FEDERATION_BACKEND_METHODS.trustCodexProject,
        params: {
          projectPath: "/remote/repo",
          configPath: "/remote/.codex/config.toml",
        },
        protocolVersion: 1,
        sourceInstanceId: "gateway_one",
        targetInstanceId: "client_one",
        createdAt: 1_200,
      },
    });

    expect(backend.renameThread).toHaveBeenCalledWith({
      backend: "codex",
      threadId: "thread-1",
      name: "Remote title",
    });
    expect(backend.readApplications).toHaveBeenCalledTimes(1);
    expect(backend.openApplication).toHaveBeenCalledWith({
      applicationId: "terminal",
      kind: "terminal",
      targetPath: "/remote/repo",
    });
    expect(backend.trustCodexProject).toHaveBeenCalledWith({
      projectPath: "/remote/repo",
      configPath: "/remote/.codex/config.toml",
    });
    expect(replies).toMatchObject([
      {
        kind: "response",
        requestId: "rename-request",
        result: { renamedAt: 2_000 },
      },
      {
        kind: "response",
        requestId: "applications-read-request",
        result: {
          terminals: [{ id: "terminal" }],
        },
      },
      {
        kind: "response",
        requestId: "application-request",
        result: { opened: true },
      },
      {
        kind: "response",
        requestId: "trust-request",
        result: { trusted: true },
      },
    ]);
  });
});
