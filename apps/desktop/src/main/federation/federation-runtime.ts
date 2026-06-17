import { randomBytes, randomUUID } from "node:crypto";
import type {
  AgentEvent,
  AppServerListSkillsResponse,
  AppServerListThreadsResponse,
  AppServerReadThreadResponse,
  CancelThreadExecutionModeQueueResponse,
  CompactThreadResponse,
  FederationCapability,
  FederationHealthStatus,
  FederationInstanceId,
  FederationInstanceRole,
  FederationPeerSummary,
  FederationProtocolEnvelope,
  HandoffThreadWorkspaceResponse,
  InterruptTurnResponse,
  QueueThreadExecutionModeResponse,
  RunCodexEnvironmentActionResponse,
  SetAcpSessionRuntimeOptionResponse,
  SetCodexThreadEnvironmentResponse,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsResponse,
  SteerTurnResponse,
  SubmitServerRequestResponse,
} from "@pwragent/shared";
import {
  FEDERATION_PROTOCOL_VERSION,
  buildFederatedThreadRef,
  federatedThreadIdentityKey,
  isRemoteFederationTarget,
  type AppServerListSkillsRequest,
  type AppServerListThreadsRequest,
  type AppServerReadThreadRequest,
  type CancelThreadExecutionModeQueueRequest,
  type CompactThreadRequest,
  type FederationRemoteTarget,
  type HandoffThreadWorkspaceRequest,
  type InterruptTurnRequest,
  type NavigationSnapshot,
  type QueueThreadExecutionModeRequest,
  type RunCodexEnvironmentActionRequest,
  type SetAcpSessionRuntimeOptionRequest,
  type SetCodexThreadEnvironmentRequest,
  type SetThreadExecutionModeRequest,
  type SetThreadModelSettingsRequest,
  type SteerTurnRequest,
  type StartTurnRequest,
  type StartTurnResponse,
  type SubmitServerRequestRequest,
} from "@pwragent/shared";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { rewriteTranscriptImageUrlsForRenderer } from "../transcript-image-protocol";
import { getMainLogger } from "../log";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { getAppStateDb, isAppStateInitialized } from "../state/app-state";
import {
  createFederationEnrollmentInvite,
  type FederationEnrollmentInvite,
} from "./federation-enrollment";
import {
  FEDERATION_BACKEND_EVENT_METHOD,
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  FederationRemoteBackendClient,
  registerFederationBackendHandlers,
  type FederationBackendEventNotification,
  type FederationBackendOperations,
} from "./federation-backend-bridge";
import { buildFederationHealthStatus } from "./federation-health";
import { FederationRouter } from "./federation-router";
import { FederationRpcEndpoint } from "./federation-rpc";
import { FederationStore } from "./federation-store";
import {
  connectFederationClient,
  FederationGatewayWebSocketServer,
  type FederationClientWebSocketClient,
  type FederationGatewayConnection,
} from "./federation-transport";

const log = getMainLogger("pwragent:federation-runtime");
const INSTANCE_ID_META_KEY = "federation_instance_id";
const GATEWAY_INSTANCE_ID_META_KEY = "federation_gateway_instance_id";
const PENDING_INVITE_TOKEN_META_KEY = "federation_pending_invite_token";
const FEDERATION_PEER_DIRECTORY_METHOD = "federation.peerDirectory";

const DEFAULT_CAPABILITIES: FederationCapability[] = [
  "remote_window",
  "thread_navigation",
  "thread_detail",
  "turn_control",
  "pending_request_control",
  "environment_actions",
  "federated_search",
  "gateway_relay",
];

type FederationInvitePayload = {
  version: 1;
  token: string;
  gatewayInstanceId: FederationInstanceId;
  gatewayUrl: string;
  expiresAt: number;
};

type FederationPeerDirectoryNotification = {
  method: typeof FEDERATION_PEER_DIRECTORY_METHOD;
  params: {
    peers: FederationPeerSummary[];
  };
};

export class DesktopFederationRuntime {
  private router?: FederationRouter;
  private server?: FederationGatewayWebSocketServer;
  private client?: FederationClientWebSocketClient;
  private localInstanceId?: FederationInstanceId;
  private listenUrl?: string;
  private gatewayUrl?: string;
  private gatewayInstanceId?: FederationInstanceId;
  private readonly rpcByPeer = new Map<FederationInstanceId, FederationRpcEndpoint>();
  private readonly remotePeerDirectory = new Map<
    FederationInstanceId,
    FederationPeerSummary
  >();
  private publishAgentEvent?: (event: AgentEvent) => void;
  private unsubscribeLocalBackendEvents?: () => void;
  private restartPromise: Promise<void> | undefined;

  setAgentEventPublisher(publisher: (event: AgentEvent) => void): void {
    this.publishAgentEvent = publisher;
  }

  async restart(): Promise<void> {
    this.restartPromise ??= this.restartNow().finally(() => {
      this.restartPromise = undefined;
    });
    return await this.restartPromise;
  }

  async stop(): Promise<void> {
    this.unsubscribeLocalBackendEvents?.();
    this.unsubscribeLocalBackendEvents = undefined;
    this.client?.close();
    this.client = undefined;
    await this.server?.stop();
    this.server = undefined;
    this.router = undefined;
    this.listenUrl = undefined;
    this.gatewayUrl = undefined;
    this.gatewayInstanceId = undefined;
    this.rpcByPeer.clear();
    this.remotePeerDirectory.clear();
  }

  async health(): Promise<FederationHealthStatus> {
    const settings = await getDesktopSettingsService().readSettings();
    return buildFederationHealthStatus({
      settings,
      peers: this.visiblePeers(),
      instanceId: this.ensureLocalInstanceId(),
    });
  }

  async generateInvite(request: {
    label?: string;
    ttlMs?: number;
  }): Promise<{ invite: string; expiresAt: number }> {
    const settings = await getDesktopSettingsService().readSettings();
    const gatewayUrl = settings.federation.publicUrl.value.trim() || this.listenUrl;
    if (!gatewayUrl) {
      throw new Error("Federation gateway URL is not configured.");
    }
    const now = Date.now();
    const expiresAt = now + Math.max(60_000, Math.min(request.ttlMs ?? 3_600_000, 86_400_000));
    const entry = createFederationEnrollmentInvite({
      store: this.store(),
      token: randomBytes(24).toString("base64url"),
      gatewayInstanceId: this.ensureLocalInstanceId(),
      generatedAt: now,
      expiresAt,
      label: request.label,
      role: "client",
      endpoint: gatewayUrl,
    });
    return {
      invite: encodeInvite({
        version: 1,
        token: entry.token,
        gatewayInstanceId: this.ensureLocalInstanceId(),
        gatewayUrl,
        expiresAt,
      }),
      expiresAt,
    };
  }

  async importInvite(invite: string): Promise<{
    accepted: boolean;
    gatewayInstanceId: FederationInstanceId;
    gatewayUrl: string;
  }> {
    const payload = decodeInvite(invite);
    const stateDb = getAppStateDb();
    stateDb.setMeta(GATEWAY_INSTANCE_ID_META_KEY, payload.gatewayInstanceId);
    stateDb.setMeta(PENDING_INVITE_TOKEN_META_KEY, payload.token);
    await getDesktopSettingsService().writeConfigPatch({
      federation: {
        mode: "client",
        gatewayUrl: payload.gatewayUrl,
      },
    });
    await this.restart();
    return {
      accepted: true,
      gatewayInstanceId: payload.gatewayInstanceId,
      gatewayUrl: payload.gatewayUrl,
    };
  }

  remoteBackend(target: FederationRemoteTarget): FederationBackendOperations {
    if (!isRemoteFederationTarget(target)) {
      throw new Error("Federation target is not remote.");
    }
    let rpc = this.rpcByPeer.get(target.instanceId);
    if (!rpc) {
      rpc = new FederationRpcEndpoint({
        localInstanceId: this.ensureLocalInstanceId(),
        remoteInstanceId: target.instanceId,
        sendEnvelope: (envelope) => {
          this.sendEnvelopeToTarget(target.instanceId, envelope);
        },
      });
      this.rpcByPeer.set(target.instanceId, rpc);
    }
    return new FederationRemoteBackendClient(rpc);
  }

  async remoteNavigationSnapshot(
    target: FederationRemoteTarget,
    request: { backend?: AppServerListThreadsRequest["backend"]; filter?: string },
  ): Promise<NavigationSnapshot> {
    const backend = this.remoteBackend(target);
    const response = await backend.listThreads({
      backend: request.backend,
      filter: request.filter,
    });
    const peer = this.store().getPeer(target.instanceId);
    const instanceLabel = peer?.label ?? target.instanceId;
    const threads = response.threads.map((thread) => ({
      ...thread,
      federation: {
        ref: buildFederatedThreadRef({
          backend: thread.source,
          instanceId: target.instanceId,
          threadId: thread.id,
        }),
        instanceLabel,
        peerStatus: peer?.status,
      },
      inbox: { inInbox: true },
    }));
    return {
      backend: response.backend,
      fetchedAt: response.fetchedAt,
      federationTarget: target,
      unchanged: false,
      threads,
      inboxThreadKeys: threads.map((thread) =>
        federatedThreadIdentityKey(thread.federation.ref),
      ),
      directories: [],
      launchpadDefaults: {
        backend: request.backend ?? "codex",
        executionMode: "default",
      },
    };
  }

  private async restartNow(): Promise<void> {
    await this.stop();
    const settings = await getDesktopSettingsService().readSettings();
    const mode = settings.federation.mode.value;
    if (mode === "disabled") {
      return;
    }

    const localInstanceId = this.ensureLocalInstanceId();
    const router = new FederationRouter({
      localInstanceId,
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    registerFederationBackendHandlers({
      router,
      backend: localBackendOperations(),
    });
    this.router = router;
    this.subscribeLocalBackendEvents();

    if (mode === "gateway" || mode === "dual") {
      this.server = new FederationGatewayWebSocketServer({
        gatewayInstanceId: localInstanceId,
        host: settings.federation.listenHost.value,
        port: settings.federation.listenPort.value,
        store: this.store(),
        onConnection: (connection) => this.registerGatewayConnection(connection),
        onDisconnect: (connection) => this.unregisterGatewayConnection(connection),
        onEnvelope: (envelope, connection) =>
          void this.receiveEnvelope(envelope, connection.peerId),
      });
      const started = await this.server.start();
      this.listenUrl = started.url;
      log.info("federation gateway listening", { url: started.url });
    }

    if (mode === "client" || mode === "dual") {
      await this.connectClient(settings.federation.gatewayUrl.value.trim());
    }
  }

  private async connectClient(gatewayUrl: string): Promise<void> {
    if (!gatewayUrl) return;
    const gatewayInstanceId = getAppStateDb().getMeta(GATEWAY_INSTANCE_ID_META_KEY);
    if (!gatewayInstanceId) {
      log.warn("federation client mode missing gateway instance id");
      return;
    }
    this.gatewayInstanceId = gatewayInstanceId;
    const pendingInviteToken = getAppStateDb().getMeta(PENDING_INVITE_TOKEN_META_KEY);
    const keyPair = await getDesktopSettingsService()
      .getOrCreateFederationIdentityKeyPair();
    this.gatewayUrl = gatewayUrl;
    this.client = await connectFederationClient({
      url: gatewayUrl,
      mode: pendingInviteToken ? "enroll" : "reconnect",
      gatewayInstanceId,
      peerInstanceId: this.ensureLocalInstanceId(),
      privateKeyPem: keyPair.privateKeyPem,
      publicKeyPem: keyPair.publicKeyPem,
      capabilities: DEFAULT_CAPABILITIES,
      inviteToken: pendingInviteToken || undefined,
      label: getAppStateDb().getMeta("profile_name") || this.ensureLocalInstanceId(),
      role: "client",
      onEnvelope: (envelope) =>
        void this.receiveEnvelope(envelope, gatewayInstanceId),
    });
    this.router?.registerConnection({
      peerId: gatewayInstanceId,
      capabilities: DEFAULT_CAPABILITIES,
      sendEnvelope: (envelope) => this.client?.sendEnvelope(envelope),
    });
    if (pendingInviteToken) {
      getAppStateDb().setMeta(PENDING_INVITE_TOKEN_META_KEY, "");
    }
    log.info("federation client connected", { gatewayUrl });
  }

  private registerGatewayConnection(connection: FederationGatewayConnection): void {
    this.router?.registerConnection({
      peerId: connection.peerId,
      capabilities: connection.capabilities,
      sendEnvelope: connection.sendEnvelope,
    });
    this.broadcastPeerDirectory();
  }

  private unregisterGatewayConnection(connection: FederationGatewayConnection): void {
    const activeConnection = this.router?.getConnection(connection.peerId);
    if (activeConnection?.sendEnvelope !== connection.sendEnvelope) {
      return;
    }
    this.unregisterPeer(connection.peerId);
    this.broadcastPeerDirectory();
  }

  private unregisterPeer(peerId: FederationInstanceId): void {
    this.router?.unregisterConnection(peerId);
    this.rpcByPeer.delete(peerId);
  }

  private async receiveEnvelope(
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ): Promise<void> {
    if (this.applyPeerDirectory(envelope)) {
      return;
    }
    if (this.publishRemoteBackendEvent(envelope, sourcePeerId)) {
      return;
    }
    if (envelope.kind === "response" || envelope.kind === "error") {
      const handled = this.rpcByPeer.get(sourcePeerId)?.receiveEnvelope(envelope) ?? false;
      if (handled) return;
    }
    await this.router?.routeEnvelope({ envelope, sourcePeerId });
  }

  private ensureLocalInstanceId(): FederationInstanceId {
    if (this.localInstanceId) return this.localInstanceId;
    const stateDb = getAppStateDb();
    const existing = stateDb.getMeta(INSTANCE_ID_META_KEY);
    if (existing) {
      this.localInstanceId = existing;
      return existing;
    }
    const next = `pwr_${randomUUID()}`;
    stateDb.setMeta(INSTANCE_ID_META_KEY, next);
    this.localInstanceId = next;
    return next;
  }

  private store(): FederationStore {
    return new FederationStore(getAppStateDb());
  }

  private sendEnvelopeToTarget(
    targetInstanceId: FederationInstanceId,
    envelope: FederationProtocolEnvelope,
  ): void {
    if (this.router?.sendToPeer(targetInstanceId, envelope)) {
      return;
    }

    const gatewayInstanceId = this.gatewayInstanceId ??
      getAppStateDb().getMeta(GATEWAY_INSTANCE_ID_META_KEY);
    if (
      gatewayInstanceId &&
      gatewayInstanceId !== targetInstanceId &&
      this.router?.sendToPeer(gatewayInstanceId, envelope)
    ) {
      return;
    }

    throw new Error(`Federation peer ${targetInstanceId} is not connected.`);
  }

  private visiblePeers(): FederationPeerSummary[] {
    const localInstanceId = this.ensureLocalInstanceId();
    const visible = new Map<FederationInstanceId, FederationPeerSummary>();

    for (const peer of this.remotePeerDirectory.values()) {
      if (peer.id !== localInstanceId) {
        visible.set(peer.id, peer);
      }
    }

    for (const peer of this.store().listPeers({ includeRevoked: true })) {
      if (peer.id === localInstanceId) continue;
      visible.set(peer.id, peer);
    }

    for (const connection of this.router?.listConnections() ?? []) {
      if (connection.peerId === localInstanceId) continue;
      const existing = visible.get(connection.peerId);
      visible.set(connection.peerId, {
        id: connection.peerId,
        label: existing?.label ?? this.defaultPeerLabel(connection.peerId),
        role: existing?.role ?? this.defaultPeerRole(connection.peerId),
        status: "connected",
        capabilities: [...connection.capabilities],
        protocolVersion: existing?.protocolVersion,
        endpoint: existing?.endpoint,
        profileName: existing?.profileName,
        lastConnectedAt: existing?.lastConnectedAt,
        lastActivityAt: existing?.lastActivityAt,
        revokedAt: existing?.revokedAt,
        unavailableReason: existing?.unavailableReason,
      });
    }

    return [...visible.values()].map((peer) =>
      this.router?.getConnection(peer.id)
        ? { ...peer, status: "connected" }
        : {
            ...peer,
            status: peer.status === "connected" ? "disconnected" : peer.status,
          },
    );
  }

  private defaultPeerLabel(peerId: FederationInstanceId): string {
    return peerId === getAppStateDb().getMeta(GATEWAY_INSTANCE_ID_META_KEY)
      ? "Gateway"
      : peerId;
  }

  private defaultPeerRole(peerId: FederationInstanceId): FederationInstanceRole {
    return peerId === getAppStateDb().getMeta(GATEWAY_INSTANCE_ID_META_KEY)
      ? "gateway"
      : "client";
  }

  private buildPeerDirectory(
    recipientPeerId: FederationInstanceId,
  ): FederationPeerSummary[] {
    const localInstanceId = this.ensureLocalInstanceId();
    const localProfileName = getAppStateDb().getMeta("profile_name") || undefined;
    const peers: FederationPeerSummary[] = [
      {
        id: localInstanceId,
        label: localProfileName || "Gateway",
        role: "gateway",
        status: "connected",
        capabilities: DEFAULT_CAPABILITIES,
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        profileName: localProfileName,
      },
    ];

    for (const peer of this.visiblePeers()) {
      if (peer.id === recipientPeerId) continue;
      peers.push(peer);
    }

    return peers;
  }

  private broadcastPeerDirectory(): void {
    const router = this.router;
    if (!router) return;
    if (!isAppStateInitialized()) return;
    const localInstanceId = this.ensureLocalInstanceId();

    for (const connection of router.listConnections()) {
      connection.sendEnvelope({
        id: `federation-peers:${randomUUID()}`,
        kind: "notification",
        method: FEDERATION_PEER_DIRECTORY_METHOD,
        params: {
          peers: this.buildPeerDirectory(connection.peerId),
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: localInstanceId,
        targetInstanceId: connection.peerId,
        createdAt: Date.now(),
      });
    }
  }

  private applyPeerDirectory(envelope: FederationProtocolEnvelope): boolean {
    if (
      envelope.kind !== "notification" ||
      envelope.method !== FEDERATION_PEER_DIRECTORY_METHOD
    ) {
      return false;
    }

    const notification = envelope as FederationPeerDirectoryNotification & typeof envelope;
    this.remotePeerDirectory.clear();
    for (const peer of notification.params.peers) {
      if (peer.id !== this.ensureLocalInstanceId()) {
        this.remotePeerDirectory.set(peer.id, peer);
      }
    }
    return true;
  }

  private subscribeLocalBackendEvents(): void {
    this.unsubscribeLocalBackendEvents?.();
    this.unsubscribeLocalBackendEvents = getDesktopBackendRegistry().onEvent((event) => {
      this.forwardLocalBackendEvent(event);
    });
  }

  private forwardLocalBackendEvent(event: AgentEvent): void {
    const router = this.router;
    if (!router) return;

    for (const connection of router.listConnections()) {
      if (
        !connection.capabilities.includes("remote_window") &&
        !connection.capabilities.includes("thread_detail")
      ) {
        continue;
      }

      connection.sendEnvelope({
        id: `federation-event:${randomUUID()}`,
        kind: "notification",
        method: FEDERATION_BACKEND_EVENT_METHOD,
        params: {
          backend: event.backend,
          notification: event.notification,
        },
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        sourceInstanceId: this.ensureLocalInstanceId(),
        targetInstanceId: connection.peerId,
        createdAt: Date.now(),
      });
    }
  }

  private publishRemoteBackendEvent(
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ): boolean {
    if (
      envelope.kind !== "notification" ||
      envelope.method !== FEDERATION_BACKEND_EVENT_METHOD
    ) {
      return false;
    }

    const notification = envelope as FederationBackendEventNotification & typeof envelope;
    this.publishAgentEvent?.({
      backend: notification.params.backend,
      federationTarget: {
        scope: "remote",
        instanceId: envelope.sourceInstanceId || sourcePeerId,
      },
      notification: notification.params.notification,
    });
    this.relayRemoteBackendEvent(envelope, sourcePeerId);
    return true;
  }

  private relayRemoteBackendEvent(
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ): void {
    const router = this.router;
    if (!router || sourcePeerId === this.gatewayInstanceId) {
      return;
    }
    const hopCount = envelope.hopCount ?? 0;
    if (hopCount >= 1) {
      return;
    }

    for (const connection of router.listConnections()) {
      if (connection.peerId === sourcePeerId) continue;
      if (
        !connection.capabilities.includes("remote_window") &&
        !connection.capabilities.includes("thread_detail")
      ) {
        continue;
      }
      connection.sendEnvelope({
        ...envelope,
        hopCount: hopCount + 1,
        targetInstanceId: connection.peerId,
      });
    }
  }
}

function localBackendOperations(): FederationBackendOperations {
  return {
    async listThreads(
      request: AppServerListThreadsRequest = {},
    ): Promise<AppServerListThreadsResponse> {
      const threads = await getDesktopBackendRegistry().listThreads({
        backend: request.backend,
        archived: request.archived,
        callerReason: "federation-list-threads",
        filter: request.filter,
      });
      return {
        backend: request.backend ?? "all",
        fetchedAt: Date.now(),
        threads,
      };
    },
    async readThread(
      request: AppServerReadThreadRequest,
    ): Promise<AppServerReadThreadResponse> {
      const backend = request.backend ?? "codex";
      const response = await getDesktopBackendRegistry().readThread({
        backend,
        threadId: request.threadId,
        before: request.before,
        limit: request.limit,
      });
      return rewriteTranscriptImageUrlsForRenderer(response);
    },
    async listSkills(
      request: AppServerListSkillsRequest = {},
    ): Promise<AppServerListSkillsResponse> {
      const backend = request.backend ?? "codex";
      const response = await getDesktopBackendRegistry().listSkills({
        backend,
        cwd: request.cwd,
        cwds: request.cwds,
        threadId: request.threadId,
      });
      return {
        backend,
        fetchedAt: Date.now(),
        data: response.data,
      };
    },
    async startTurn(request: StartTurnRequest): Promise<StartTurnResponse> {
      const submitted = await getDesktopBackendRegistry().submitTurn({
        ...request,
        origin: "manual",
      });
      return submitted.status === "started"
        ? {
            backend: submitted.entry.backend,
            threadId: submitted.entry.threadId,
            turnId: submitted.turnId,
            queueStatus: "started",
            queueEntryId: submitted.entry.id,
          }
        : {
            backend: submitted.entry.backend,
            threadId: submitted.entry.threadId,
            turnId: submitted.entry.id,
            queueStatus: "queued",
            queueEntryId: submitted.entry.id,
          };
    },
    async compactThread(
      request: CompactThreadRequest,
    ): Promise<CompactThreadResponse> {
      return await getDesktopBackendRegistry().compactThread(request);
    },
    async interruptTurn(
      request: InterruptTurnRequest,
    ): Promise<InterruptTurnResponse> {
      return await getDesktopBackendRegistry().interruptTurn(request);
    },
    async steerTurn(request: SteerTurnRequest): Promise<SteerTurnResponse> {
      return await getDesktopBackendRegistry().steerTurn(request);
    },
    async setThreadExecutionMode(
      request: SetThreadExecutionModeRequest,
    ): Promise<SetThreadExecutionModeResponse> {
      return await getDesktopBackendRegistry().setThreadExecutionMode(request);
    },
    async queueThreadExecutionMode(
      request: QueueThreadExecutionModeRequest,
    ): Promise<QueueThreadExecutionModeResponse> {
      return await getDesktopBackendRegistry().queueThreadExecutionMode(request);
    },
    async cancelThreadExecutionModeQueue(
      request: CancelThreadExecutionModeQueueRequest,
    ): Promise<CancelThreadExecutionModeQueueResponse> {
      return await getDesktopBackendRegistry().cancelThreadExecutionModeQueue(request);
    },
    async setAcpSessionRuntimeOption(
      request: SetAcpSessionRuntimeOptionRequest,
    ): Promise<SetAcpSessionRuntimeOptionResponse> {
      return await getDesktopBackendRegistry().setAcpSessionRuntimeOption(request);
    },
    async setThreadModelSettings(
      request: SetThreadModelSettingsRequest,
    ): Promise<SetThreadModelSettingsResponse> {
      return await getDesktopBackendRegistry().setThreadModelSettings(request);
    },
    async submitServerRequest(
      request: SubmitServerRequestRequest,
    ): Promise<SubmitServerRequestResponse> {
      return await getDesktopBackendRegistry().submitServerRequest(request);
    },
    async runCodexEnvironmentAction(
      request: RunCodexEnvironmentActionRequest,
    ): Promise<RunCodexEnvironmentActionResponse> {
      return await getDesktopBackendRegistry().runCodexEnvironmentAction(request);
    },
    async setCodexThreadEnvironment(
      request: SetCodexThreadEnvironmentRequest,
    ): Promise<SetCodexThreadEnvironmentResponse> {
      return await getDesktopBackendRegistry().setCodexThreadEnvironment(request);
    },
    async handoffThreadWorkspace(
      request: HandoffThreadWorkspaceRequest,
    ): Promise<HandoffThreadWorkspaceResponse> {
      return await getDesktopBackendRegistry().handoffThreadWorkspace(request);
    },
  };
}

function encodeInvite(payload: FederationInvitePayload): string {
  return `pwragent-federation:${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}`;
}

function decodeInvite(invite: string): FederationInvitePayload {
  const encoded = invite.trim().replace(/^pwragent-federation:/, "");
  const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<FederationInvitePayload>;
  if (
    parsed.version !== 1 ||
    typeof parsed.token !== "string" ||
    typeof parsed.gatewayInstanceId !== "string" ||
    typeof parsed.gatewayUrl !== "string" ||
    typeof parsed.expiresAt !== "number"
  ) {
    throw new Error("Invalid federation invite.");
  }
  if (parsed.expiresAt <= Date.now()) {
    throw new Error("Federation invite has expired.");
  }
  return parsed as FederationInvitePayload;
}

let runtime: DesktopFederationRuntime | undefined;

export function getDesktopFederationRuntime(): DesktopFederationRuntime {
  runtime ??= new DesktopFederationRuntime();
  return runtime;
}

export async function disposeDesktopFederationRuntime(): Promise<void> {
  await runtime?.stop();
  runtime = undefined;
}
