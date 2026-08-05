import { randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type {
  AgentEvent,
  ApplyThreadModelMigrationResponse,
  AppServerListSkillsResponse,
  AppServerListThreadsResponse,
  AppServerReadThreadResponse,
  CancelQueuedTurnResponse,
  CancelThreadExecutionModeQueueResponse,
  CheckThreadBranchDriftResponse,
  CompactThreadResponse,
  CreateScheduledThreadActionRequest,
  CodexEnvironmentSetupProgressEvent,
  FederationCapability,
  FederationConnectionState,
  FederationDiagnosticEvent,
  FederationEndpointStatus,
  FederatedSearchRequest,
  FederatedSearchResponse,
  FederationHealthStatus,
  FederationInstanceId,
  FederationInstanceRole,
  FederationPeerSummary,
  FederationProtocolEnvelope,
  FederationSessionId,
  ForkThreadResponse,
  HandoffThreadWorkspaceResponse,
  InterruptTurnResponse,
  ListScheduledThreadActionsRequest,
  ListScheduledThreadActionsResponse,
  MaterializeDirectoryLaunchpadResponse,
  MarkThreadSeenResponse,
  MessagingPlatformStatus,
  PwrSnapConnectionStatus,
  OpenDesktopApplicationResponse,
  QueueThreadExecutionModeResponse,
  RefreshDirectoryGitStatusesResponse,
  RetainThreadBranchDriftResponse,
  RenameThreadResponse,
  RunCodexEnvironmentActionResponse,
  ScheduledThreadActionIdRequest,
  ScheduledThreadActionMutationResponse,
  SetAcpSessionRuntimeOptionResponse,
  SetCodexThreadEnvironmentResponse,
  SetThreadExecutionModeResponse,
  SetThreadModelSettingsResponse,
  StartReviewResponse,
  StartThreadResponse,
  SteerTurnResponse,
  StopCodexEnvironmentActionResponse,
  SubmitServerRequestResponse,
  TrustCodexProjectResponse,
  UpdateThreadExpectedBranchResponse,
  UpdateScheduledThreadActionRequest,
} from "@pwragent/shared";
import {
  FEDERATION_INVITE_VERSION,
  FEDERATION_PROTOCOL_VERSION,
  buildFederatedThreadRef,
  federationEndpointAcceptsCloudflareCredentials,
  isFederationGatewayEndpointUrl,
  formatFederationPeerDisplayLabel,
  isRemoteFederationTarget,
  resolveThreadTerminalCwd,
  type AppServerListSkillsRequest,
  type AppServerListThreadsRequest,
  type AppServerReadThreadRequest,
  type ApplyThreadModelMigrationRequest,
  type CancelQueuedTurnRequest,
  type CancelThreadExecutionModeQueueRequest,
  type CheckThreadBranchDriftRequest,
  type CompactThreadRequest,
  type ForkThreadRequest,
  type FederationRemoteTarget,
  type DesktopApplicationsSnapshot,
  type HandoffThreadWorkspaceRequest,
  type InterruptTurnRequest,
  type MaterializeDirectoryLaunchpadRequest,
  type MaterializeDirectoryLaunchpadOptions,
  type MarkThreadSeenRequest,
  type SetThreadPinRequest,
  type SetThreadPinResponse,
  type SetThreadPrAutoDispatchRequest,
  type SetThreadPrAutoDispatchResponse,
  type DetachThreadPullRequestRequest,
  type DetachThreadPullRequestResponse,
  type ReorderThreadPinsRequest,
  type ReorderThreadPinsResponse,
  type NavigationSnapshot,
  type OpenDesktopApplicationRequest,
  type QueueThreadExecutionModeRequest,
  type RefreshDirectoryGitStatusesRequest,
  type RetainThreadBranchDriftRequest,
  type RenameThreadRequest,
  type RunCodexEnvironmentActionRequest,
  type SetAcpSessionRuntimeOptionRequest,
  type SetCodexThreadEnvironmentRequest,
  type SetThreadExecutionModeRequest,
  type SetThreadModelSettingsRequest,
  type StartReviewRequest,
  type StartThreadRequest,
  type SteerTurnRequest,
  type StartTurnRequest,
  type StartTurnResponse,
  type SubmitServerRequestRequest,
  type StopCodexEnvironmentActionRequest,
  type TrustCodexProjectRequest,
  type UpdateThreadExpectedBranchRequest,
} from "@pwragent/shared";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { getDesktopOverlayStore } from "../app-server/desktop-overlay-store";
import { spawnTerminalPty } from "../terminal/integrated-terminal-service";
import {
  readTranscriptImageProtocolRequest,
  rewriteFederatedTranscriptImageUrlsForRenderer,
  rewriteTranscriptImageUrlsForRenderer,
} from "../transcript-image-protocol";
import { getMainLogger } from "../log";
import {
  discoverDesktopApplications,
  openDesktopApplication,
} from "../settings/application-discovery";
import { getPwrSnapConnectionService } from "../mcp-connections/pwrsnap-connection-service";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { getAppStateDb, isAppStateInitialized } from "../state/app-state";
import { DesktopMessagingBackendBridge } from "../messaging/desktop-backend-bridge";
import {
  createFederationEnrollmentInvite,
  decodeFederationInvite,
  encodeFederationInvite,
} from "./federation-enrollment";
import { FederatedSearchService } from "./federated-search-service";
import {
  FEDERATION_BACKEND_EVENT_METHOD,
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  FEDERATION_ENVIRONMENT_SETUP_PROGRESS_METHOD,
  additionalFederationBackendCapabilities,
  FederationRemoteBackendClient,
  registerFederationBackendHandlers,
  type FederationBackendEventNotification,
  type FederationBackendOperations,
  type FederationEnvironmentSetupProgressNotification,
} from "./federation-backend-bridge";
import {
  buildFederationHealthStatus,
  publicPeerSummary,
} from "./federation-health";
import {
  FEDERATION_PTY_ERROR_METHOD,
  FEDERATION_PTY_EXIT_METHOD,
  FEDERATION_PTY_OUTPUT_METHOD,
  FEDERATION_PTY_METHOD_CAPABILITIES,
  FederationPtyService,
  FederationRemotePtyClient,
  isFederationPtyStreamMethod,
  registerFederationPtyHandlers,
  type FederationPtyStreamEvent,
  type FederationRemotePtyOperations,
} from "./federation-pty-service";
import { FederationRouter } from "./federation-router";
import { FederationRpcEndpoint } from "./federation-rpc";
import { FederationStore } from "./federation-store";
import {
  classifyFederationClientFailure,
  redactFederationDiagnostic,
} from "./federation-redaction";
import {
  connectFederationClient,
  FEDERATION_CLOSE_REPLACED_CODE,
  FEDERATION_CLOSE_REVOKED_CODE,
  FederationGatewayWebSocketServer,
  type FederationClientWebSocketClient,
  type FederationGatewayConnection,
} from "./federation-transport";
import { orderFederationEndpointAttempts } from "./federation-endpoints";
import {
  dialFederationSshEndpoint,
  isFederationSshEndpointUrl,
  parseFederationSshEndpoint,
} from "./federation-ssh";
import { noiseKeyPairFromRawPrivate } from "./federation-noise";

const log = getMainLogger("pwragent:federation-runtime");
const INSTANCE_ID_META_KEY = "federation_instance_id";
const GATEWAY_INSTANCE_ID_META_KEY = "federation_gateway_instance_id";
const GATEWAY_PUBLIC_KEY_META_KEY = "federation_gateway_public_key_pem";
const GATEWAY_NOISE_PUBLIC_KEY_META_KEY = "federation_gateway_noise_public_key";
const GATEWAY_LAST_ENDPOINT_META_KEY = "federation_gateway_last_endpoint";
const PENDING_INVITE_TOKEN_META_KEY = "federation_pending_invite_token";
const GATEWAY_ENROLLED_AT_META_KEY = "federation_gateway_enrolled_at";
const FEDERATION_PEER_DIRECTORY_METHOD = "federation.peerDirectory";
const FEDERATION_RECONNECT_MAX_DELAY_MS = 30_000;
const DUPLICATE_IDENTITY_NOTE_TTL_MS = 5 * 60_000;
/** A session must last this long before it counts as stable enough to reset backoff. */
const FEDERATION_STABLE_SESSION_MS = 60_000;

const DEFAULT_CAPABILITIES: FederationCapability[] = [
  "remote_window",
  "thread_navigation",
  "thread_detail",
  "turn_control",
  "scheduled_actions",
  "pending_request_control",
  "environment_actions",
  "federated_search",
  "messaging_route",
  "pwrsnap_connection",
  "gateway_relay",
  // Federation is a same-operator trust domain and turn_control already
  // permits code execution via agent turns, so the direct shell defaults to
  // granted — but stays a dedicated capability so it is revocable on its own.
  "remote_pty",
];

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
  private instanceLabel?: string;
  private listenUrl?: string;
  private gatewayUrl?: string;
  private gatewayInstanceId?: FederationInstanceId;
  private configuredEndpoints: string[] = [];
  private readonly endpointStatuses = new Map<
    string,
    Omit<FederationEndpointStatus, "url">
  >();
  private readonly rpcByPeer = new Map<FederationInstanceId, FederationRpcEndpoint>();
  private readonly remotePeerDirectory = new Map<
    FederationInstanceId,
    FederationPeerSummary
  >();
  private readonly publishedPeerStatuses = new Map<
    FederationInstanceId,
    {
      status: FederationConnectionState;
      unavailableReason?: string;
    }
  >();
  private publishAgentEvent?: (event: AgentEvent) => void;
  private publishEnvironmentSetupProgress?: (
    event: CodexEnvironmentSetupProgressEvent,
  ) => void;
  private ptyService?: FederationPtyService;
  private readonly remotePtyEventListeners = new Set<
    (event: FederationPtyStreamEvent) => void
  >();
  private readonly remoteBackendEventListeners = new Set<
    (event: AgentEvent) => void | Promise<void>
  >();
  private readonly peerStatusListeners = new Set<() => void>();
  private unsubscribeLocalBackendEvents?: () => void;
  private restartPromise: Promise<void> | undefined;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private connectionGeneration = 0;
  /** Bumped only by stop(), so an in-flight endpoint walk can detect teardown. */
  private walkEpoch = 0;
  private lastConnectedAt?: number;
  private stopping = true;
  private lastConnectionError?: string;
  private lastConnectionFailureKind?: "auth" | "replaced" | "transport";
  /** Peer ids the gateway recently flagged for duplicate-identity churn. */
  private readonly duplicateIdentitySuspectedAt = new Map<
    FederationInstanceId,
    number
  >();
  private gatewayListenerError?: string;

  setAgentEventPublisher(publisher: (event: AgentEvent) => void): void {
    this.publishAgentEvent = publisher;
  }

  setEnvironmentSetupProgressPublisher(
    publisher: (event: CodexEnvironmentSetupProgressEvent) => void,
  ): void {
    this.publishEnvironmentSetupProgress = publisher;
  }

  onRemoteBackendEvent(
    listener: (event: AgentEvent) => void | Promise<void>,
  ): () => void {
    this.remoteBackendEventListeners.add(listener);
    return () => {
      this.remoteBackendEventListeners.delete(listener);
    };
  }

  /**
   * Fires whenever any peer's connection status changes. Used by the
   * application menu to keep its Remote Instances listing current.
   */
  onPeerStatusChanged(listener: () => void): () => void {
    this.peerStatusListeners.add(listener);
    return () => {
      this.peerStatusListeners.delete(listener);
    };
  }

  connectedPeerTargets(): Array<{
    target: FederationRemoteTarget;
    label: string;
    capabilities: FederationCapability[];
  }> {
    // Compose display labels against the full visible set so two
    // profiles of the same machine ("Mac-Mini-M4 / default",
    // "Mac-Mini-M4 / dev") stay tellable apart in window titles and
    // the Remote Instances menu.
    const visible = this.visiblePeers();
    return visible
      .filter((peer) => peer.status === "connected")
      .map((peer) => ({
        target: { scope: "remote", instanceId: peer.id },
        label: formatFederationPeerDisplayLabel(peer, visible),
        capabilities: [...peer.capabilities],
      }));
  }

  async restart(): Promise<void> {
    this.restartPromise ??= this.restartNow().finally(() => {
      this.restartPromise = undefined;
    });
    return await this.restartPromise;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.connectionGeneration += 1;
    this.walkEpoch += 1;
    if (isAppStateInitialized()) {
      for (const peer of this.visiblePeers()) {
        if (peer.status === "connected") {
          this.publishPeerStatus(
            peer.id,
            "disconnected",
            "Federation runtime stopped.",
          );
        }
      }
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.unsubscribeLocalBackendEvents?.();
    this.unsubscribeLocalBackendEvents = undefined;
    // Owner shutdown kills every remote session immediately, mirroring how
    // the local panel's shells die with the app.
    this.ptyService?.disposeAll();
    this.ptyService = undefined;
    this.client?.close();
    this.client = undefined;
    await this.server?.stop();
    this.server = undefined;
    this.router = undefined;
    this.listenUrl = undefined;
    this.gatewayUrl = undefined;
    this.gatewayInstanceId = undefined;
    this.configuredEndpoints = [];
    this.endpointStatuses.clear();
    this.rpcByPeer.clear();
    this.remotePeerDirectory.clear();
    this.publishedPeerStatuses.clear();
    this.reconnectAttempt = 0;
    this.lastConnectionError = undefined;
    this.lastConnectionFailureKind = undefined;
    this.gatewayListenerError = undefined;
  }

  async health(): Promise<FederationHealthStatus> {
    const settings = await getDesktopSettingsService().readSettings();
    const health = buildFederationHealthStatus({
      settings,
      peers: this.visiblePeers(),
      instanceId: this.ensureLocalInstanceId(),
      listenUrl: this.listenUrl,
      unavailableReason: this.gatewayListenerError,
    });
    if (
      settings.federation.mode.value === "client" ||
      settings.federation.mode.value === "dual"
    ) {
      // An auth-class failure (bad pin, revoked enrollment, version
      // skew) is terminal until the operator re-pairs — reporting it as
      // "connecting" hides the problem behind an infinite retry loop.
      health.status = this.client
        ? "connected"
        : this.lastConnectionFailureKind === "auth"
          ? "rejected"
          // A "replaced" eviction will reconnect (and evict the sibling
          // back) — degraded, not a clean connecting/disconnected, so
          // the panel surfaces the duplicate-identity explanation.
          : this.lastConnectionFailureKind === "replaced"
            ? "degraded"
            : this.reconnectTimer
              ? "connecting"
              : "disconnected";
      health.unavailableReason = this.lastConnectionError;
      const endpoints =
        this.configuredEndpoints.length > 0
          ? this.configuredEndpoints
          : settings.federation.gatewayEndpoints.value;
      health.gatewayEndpoints = endpoints.map((url) => ({
        url,
        state: "idle",
        ...this.endpointStatuses.get(url),
      }));
    }
    if (this.gatewayListenerError) {
      health.status = "degraded";
      health.unavailableReason = this.gatewayListenerError;
    }
    // Prefer the configured endpoint list: a profile that only ever used
    // multi-path endpoints has no legacy `gateway_url`, and the enrollment
    // card would otherwise show a paired gateway with no address.
    health.clientEnrollment = this.readClientEnrollment(
      settings.federation.gatewayEndpoints.value[0]?.trim()
        || settings.federation.gatewayUrl.value.trim(),
    );
    return health;
  }

  private readClientEnrollment(
    configuredGatewayUrl: string,
  ): FederationHealthStatus["clientEnrollment"] {
    if (!isAppStateInitialized()) return undefined;
    const stateDb = getAppStateDb();
    const gatewayInstanceId = stateDb.getMeta(GATEWAY_INSTANCE_ID_META_KEY);
    if (!gatewayInstanceId) return undefined;
    const enrolledAtRaw = stateDb.getMeta(GATEWAY_ENROLLED_AT_META_KEY);
    const enrolledAt = enrolledAtRaw ? Number(enrolledAtRaw) : Number.NaN;
    return {
      gatewayInstanceId,
      gatewayUrl: configuredGatewayUrl || undefined,
      enrolledAt: Number.isFinite(enrolledAt) ? enrolledAt : undefined,
      pendingInvite: Boolean(stateDb.getMeta(PENDING_INVITE_TOKEN_META_KEY)),
    };
  }

  /**
   * Forget the client-side pairing: drop the pinned gateway identity,
   * signing key, Noise key, and any pending invite token, then restart
   * the runtime. A client-only instance falls back to disabled mode so
   * it does not sit in a doomed reconnect loop against nothing.
   */
  async resetEnrollment(): Promise<{ cleared: boolean }> {
    const stateDb = getAppStateDb();
    const hadEnrollment = Boolean(stateDb.getMeta(GATEWAY_INSTANCE_ID_META_KEY));
    stateDb.setMeta(GATEWAY_INSTANCE_ID_META_KEY, "");
    stateDb.setMeta(GATEWAY_PUBLIC_KEY_META_KEY, "");
    stateDb.setMeta(GATEWAY_NOISE_PUBLIC_KEY_META_KEY, "");
    stateDb.setMeta(PENDING_INVITE_TOKEN_META_KEY, "");
    stateDb.setMeta(GATEWAY_ENROLLED_AT_META_KEY, "");
    // The endpoint list and its last-good memory belong to the pairing being
    // forgotten. Leaving them behind would keep a dual-mode instance dialing
    // the forgotten gateway with no pins left to satisfy it.
    stateDb.setMeta(GATEWAY_LAST_ENDPOINT_META_KEY, "");
    const settingsService = getDesktopSettingsService();
    const settings = await settingsService.readSettings();
    const mode = settings.federation.mode.value;
    if (mode === "client" || mode === "disabled") {
      // A pure client's own key material only matters to the gateway it
      // just forgot, so drop it too. This is the documented recovery when
      // the stored keys became undecryptable (keychain identity change):
      // the next enrollment mints fresh keys and the new invite pins
      // them. Gateway/dual instances keep their keys — enrolled clients
      // pinned them.
      await settingsService.clearSecret("federationInstancePrivateKey");
      await settingsService.clearSecret("federationNoiseStaticPrivateKey");
    }
    await settingsService.writeConfigPatch({
      federation: {
        gatewayUrl: "",
        gatewayEndpoints: [],
        ...(mode === "client" ? { mode: "disabled" as const } : {}),
      },
    });
    await this.restart();
    return { cleared: hadEnrollment };
  }

  async diagnostics(request: {
    limit?: number;
    peerId?: FederationInstanceId;
  }): Promise<{
    health: FederationHealthStatus;
    events: FederationDiagnosticEvent[];
  }> {
    return {
      health: await this.health(),
      events: this.store().listAudit(request).map((entry) => ({
        ...entry,
        detail: entry.detail
          ? redactFederationDiagnostic(entry.detail)
          : undefined,
      })),
    };
  }

  async revokePeer(peerId: FederationInstanceId): Promise<FederationPeerSummary> {
    const store = this.store();
    const peer = store.getPeer(peerId);
    if (!peer) {
      throw new Error("Federation peer is not enrolled.");
    }
    const revokedAt = Date.now();
    store.revokePeer(peerId, revokedAt);
    this.server?.closePeer(peerId);
    this.unregisterPeer(peerId);
    this.remotePeerDirectory.delete(peerId);
    this.publishPeerStatus(peerId, "revoked");
    this.broadcastPeerDirectory();
    return publicPeerSummary({
      ...peer,
      status: "revoked",
      revokedAt,
    });
  }

  async generateInvite(request: {
    label?: string;
    ttlMs?: number;
  }): Promise<{ invite: string; expiresAt: number }> {
    const settings = await getDesktopSettingsService().readSettings();
    const mode = settings.federation.mode.value;
    if (mode !== "gateway" && mode !== "dual") {
      throw new Error(
        "Invites are issued by the gateway. Switch Mode to gateway or dual first.",
      );
    }
    const advertisedEndpoints = settings.federation.advertisedEndpoints.value
      .map((endpoint) => endpoint.trim())
      .filter((endpoint) => endpoint.length > 0);
    const fallbackUrl =
      settings.federation.publicUrl.value.trim() || this.listenUrl;
    const gatewayEndpoints =
      advertisedEndpoints.length > 0
        ? advertisedEndpoints
        : fallbackUrl
          ? [fallbackUrl]
          : [];
    const gatewayUrl = gatewayEndpoints[0];
    if (!gatewayUrl) {
      throw new Error("Federation gateway URL is not configured.");
    }
    const now = Date.now();
    const expiresAt = now + Math.max(60_000, Math.min(request.ttlMs ?? 3_600_000, 86_400_000));
    const gatewayIdentity = await getDesktopSettingsService()
      .getOrCreateFederationIdentityKeyPair();
    const noise =
      await getDesktopSettingsService().getOrCreateFederationNoiseStaticKeyPair();
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
      invite: encodeFederationInvite({
        version: FEDERATION_INVITE_VERSION,
        token: entry.token,
        gatewayInstanceId: this.ensureLocalInstanceId(),
        gatewayPublicKeyPem: gatewayIdentity.publicKeyPem,
        gatewayUrl,
        gatewayEndpoints,
        gatewayNoisePublicKey: noise.publicKeyBase64,
        expiresAt,
      }),
      expiresAt,
    };
  }

  async importInvite(invite: string): Promise<{
    accepted: boolean;
    gatewayInstanceId: FederationInstanceId;
    gatewayUrl: string;
    gatewayEndpoints: string[];
  }> {
    const payload = decodeFederationInvite(invite);
    const stateDb = getAppStateDb();
    stateDb.setMeta(GATEWAY_INSTANCE_ID_META_KEY, payload.gatewayInstanceId);
    stateDb.setMeta(GATEWAY_PUBLIC_KEY_META_KEY, payload.gatewayPublicKeyPem);
    stateDb.setMeta(
      GATEWAY_NOISE_PUBLIC_KEY_META_KEY,
      payload.gatewayNoisePublicKey,
    );
    // A new gateway identity invalidates any endpoint memory from before.
    stateDb.setMeta(GATEWAY_LAST_ENDPOINT_META_KEY, "");
    stateDb.setMeta(PENDING_INVITE_TOKEN_META_KEY, payload.token);
    stateDb.setMeta(GATEWAY_ENROLLED_AT_META_KEY, String(Date.now()));
    // Importing on a listening instance must not silently kill its
    // listener: gateway/dual become dual, everything else becomes client.
    const currentMode = (await getDesktopSettingsService().readSettings())
      .federation.mode.value;
    const gatewayEndpoints = payload.gatewayEndpoints ?? [payload.gatewayUrl];
    await getDesktopSettingsService().writeConfigPatch({
      federation: {
        mode:
          currentMode === "gateway" || currentMode === "dual"
            ? "dual"
            : "client",
        gatewayUrl: payload.gatewayUrl,
        gatewayEndpoints,
      },
    });
    await this.restart();
    return {
      accepted: true,
      gatewayInstanceId: payload.gatewayInstanceId,
      gatewayUrl: payload.gatewayUrl,
      gatewayEndpoints,
    };
  }

  remoteBackend(target: FederationRemoteTarget): FederationBackendOperations {
    return new FederationRemoteBackendClient(
      this.rpcFor(target),
      (response) => rewriteFederatedTranscriptImageUrlsForRenderer(
        response,
        target.instanceId,
      ),
    );
  }

  /**
   * Viewer-side control client for a peer's remote PTY sessions. Streamed
   * output/exit/error frames arrive via {@link onRemotePtyEvent}.
   */
  remotePty(target: FederationRemoteTarget): FederationRemotePtyOperations {
    return new FederationRemotePtyClient(this.rpcFor(target));
  }

  onRemotePtyEvent(
    listener: (event: FederationPtyStreamEvent) => void,
  ): () => void {
    this.remotePtyEventListeners.add(listener);
    return () => {
      this.remotePtyEventListeners.delete(listener);
    };
  }

  private rpcFor(target: FederationRemoteTarget): FederationRpcEndpoint {
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
    return rpc;
  }

  async remoteNavigationSnapshot(
    target: FederationRemoteTarget,
    request: { backend?: AppServerListThreadsRequest["backend"]; filter?: string },
  ): Promise<NavigationSnapshot> {
    const backend = this.remoteBackend(target);
    const response = await backend.getNavigationSnapshot({
      backend: request.backend,
      filter: request.filter,
    });
    // visiblePeers reads the app-state db (local instance id); during
    // early boot or in store-injected test harnesses that db may be
    // absent — fall back to the bare store record (mirrors the menu's
    // peer-lookup guard in main/index.ts).
    let visible: FederationPeerSummary[] = [];
    try {
      visible = this.visiblePeers();
    } catch {
      visible = [];
    }
    const visiblePeer = visible.find(
      (candidate) => candidate.id === target.instanceId,
    );
    const peer = visiblePeer ?? this.store().getPeer(target.instanceId);
    // Same composed label as connectedPeerTargets so search chips and
    // thread rows agree with the window title on multi-profile peers.
    const instanceLabel = peer
      ? formatFederationPeerDisplayLabel(peer, visible)
      : target.instanceId;
    // The granted set the viewer can act on. remote_pty is stripped when the
    // peer is only reachable through a gateway relay: PTY streams are
    // point-to-point in v1, so the toggle must read as unavailable there.
    const directConnection = this.router?.getConnection(target.instanceId);
    const capabilities = directConnection
      ? [...directConnection.capabilities]
      : (visiblePeer?.capabilities ?? []).filter(
          (capability) => capability !== "remote_pty",
        );
    const peerStatus = visiblePeer?.status ?? peer?.status;
    const threads = response.threads.map((thread) => {
      const ref = buildFederatedThreadRef({
        backend: thread.source,
        instanceId: target.instanceId,
        threadId: thread.id,
      });
      return {
        ...thread,
        federation: {
          ref,
          instanceLabel,
          peerStatus,
          capabilities,
        },
      };
    });
    return {
      ...response,
      federationTarget: target,
      unchanged: false,
      threads,
    };
  }

  async searchConnectedPeers(
    request: FederatedSearchRequest,
  ): Promise<FederatedSearchResponse> {
    const service = new FederatedSearchService({
      includeLocal: false,
      local: localBackendOperations(),
      peers: () => {
        const visible = this.visiblePeers();
        return visible
          .filter(
            (peer) =>
              peer.status === "connected" &&
              peer.capabilities.includes("federated_search"),
          )
          .map((peer) => ({
            instanceId: peer.id,
            // Composed against the full visible set so multi-profile
            // machines keep distinct labels in search chips.
            label: formatFederationPeerDisplayLabel(peer, visible),
            status: peer.status,
            backend: this.remoteBackend({
              scope: "remote",
              instanceId: peer.id,
            }),
          }));
      },
    });
    return await service.search(request);
  }

  private async restartNow(): Promise<void> {
    await this.stop();
    const settings = await getDesktopSettingsService().readSettings();
    this.instanceLabel =
      settings.federation.instanceLabel.value.trim() || defaultInstanceLabel();
    const mode = settings.federation.mode.value;
    if (mode === "disabled") {
      return;
    }
    this.stopping = false;

    const localInstanceId = this.ensureLocalInstanceId();
    const router = new FederationRouter({
      localInstanceId,
      methodCapabilities: {
        ...FEDERATION_BACKEND_METHOD_CAPABILITIES,
        ...FEDERATION_PTY_METHOD_CAPABILITIES,
      },
      additionalRequiredCapabilities: additionalFederationBackendCapabilities,
    });
    registerFederationBackendHandlers({
      router,
      backend: localBackendOperations(),
      onEnvironmentSetupProgress: (event, targetInstanceId) => {
        this.sendEnvironmentSetupProgress(event, targetInstanceId);
      },
    });
    this.ptyService = new FederationPtyService({
      spawnPty: async (params) => await spawnTerminalPty(params),
      resolveThreadCwd: async ({ backend, threadId }) => {
        // Owner-resolved shell + cwd from THIS instance's thread state; the
        // viewer never sends a path, so a compromised viewer cannot pick the
        // cwd or binary.
        const threads = await getDesktopBackendRegistry().listThreads({
          backend,
          callerReason: "federation-remote-pty",
        });
        const thread = threads.find((candidate) => candidate.id === threadId);
        if (!thread) {
          // Refuse rather than fall through to the home-directory default: a
          // shell should only ever open for a thread this instance actually
          // has. (A thread that exists but has no directory still gets the
          // same home fallback the local panel uses.)
          throw new Error(
            "Remote terminal thread was not found on the owning instance.",
          );
        }
        return resolveThreadTerminalCwd(thread);
      },
      sendNotification: (peerId, method, params) =>
        this.sendPtyNotification(peerId, method, params),
      onAudit: (entry) => {
        // The audit trail must show which machine drove the shell, not just
        // its opaque instance id.
        const label =
          this.store().getPeer(entry.peerId)?.label
          ?? this.remotePeerDirectory.get(entry.peerId)?.label
          ?? entry.peerId;
        this.store().appendAudit({
          peerId: entry.peerId,
          sessionId: entry.sessionId,
          kind: entry.kind,
          createdAt: Date.now(),
          detail: `${entry.detail} · ${label}`,
        });
      },
      log: {
        info: (message, meta) => log.info(message, meta),
        warn: (message, meta) => log.warn(message, meta),
      },
    });
    registerFederationPtyHandlers({ router, service: this.ptyService });
    this.router = router;
    this.subscribeLocalBackendEvents();

    const noise =
      await getDesktopSettingsService().getOrCreateFederationNoiseStaticKeyPair();
    const noiseStatic = noiseKeyPairFromRawPrivate(
      Buffer.from(noise.privateKeyBase64, "base64"),
    );

    if (mode === "gateway" || mode === "dual") {
      const gatewayIdentity = await getDesktopSettingsService()
        .getOrCreateFederationIdentityKeyPair();
      this.server = new FederationGatewayWebSocketServer({
        gatewayInstanceId: localInstanceId,
        gatewayPrivateKeyPem: gatewayIdentity.privateKeyPem,
        gatewayPublicKeyPem: gatewayIdentity.publicKeyPem,
        host: settings.federation.listenHost.value,
        port: settings.federation.listenPort.value,
        store: this.store(),
        noiseStatic,
        onConnection: (connection) => this.registerGatewayConnection(connection),
        onDisconnect: (connection) => this.unregisterGatewayConnection(connection),
        onPeerReplaced: (info) => {
          if (info.duplicateInstanceIdSuspected) {
            this.duplicateIdentitySuspectedAt.set(info.peerId, Date.now());
          }
        },
        onEnvelope: (envelope, connection) =>
          void this.receiveEnvelope(envelope, connection.peerId),
      });
      try {
        const started = await this.server.start();
        this.listenUrl = started.url;
        log.info("federation gateway listening", { url: started.url });
      } catch (error) {
        this.gatewayListenerError = redactFederationDiagnostic(
          error instanceof Error ? error.message : String(error),
        );
        await this.server.stop().catch(() => undefined);
        this.server = undefined;
        log.error("federation gateway failed to listen", {
          error: this.gatewayListenerError,
        });
      }
    }

    if (mode === "client" || mode === "dual") {
      const configured = settings.federation.gatewayEndpoints.value
        .map((endpoint) => endpoint.trim())
        .filter((endpoint) => endpoint.length > 0);
      // Last line of defense before anything is dialed: the config file is
      // hand-editable and may predate the scheme allowlist.
      const endpoints = configured.filter(isFederationGatewayEndpointUrl);
      if (endpoints.length !== configured.length) {
        log.warn("ignoring federation endpoints with an unsupported scheme", {
          ignored: configured.length - endpoints.length,
        });
      }
      this.configuredEndpoints = endpoints;
      if (endpoints.length === 0) {
        this.lastConnectionError =
          configured.length > 0
            ? "No federation gateway endpoint uses a supported ws://, wss://, or ssh:// scheme."
            : "Federation gateway URL is not configured.";
      } else {
        await this.connectToGateway().catch((error) => {
          this.handleClientConnectionFailure(error);
        });
      }
    }
  }

  // One reconnect cycle: walk the configured endpoints (last-good first) and
  // stop at the first fully authenticated connection. Every endpoint runs the
  // identical pinned-identity + Noise handshake, so fallback can only change
  // reachability, never which gateway the client will trust.
  private async connectToGateway(): Promise<void> {
    const endpoints = this.configuredEndpoints;
    if (endpoints.length === 0) return;
    const lastGoodEndpoint =
      getAppStateDb().getMeta(GATEWAY_LAST_ENDPOINT_META_KEY) || undefined;
    const attempts = orderFederationEndpointAttempts(
      endpoints,
      lastGoodEndpoint,
    );
    // A restart during the walk flips `stopping` back to false, so `stopping`
    // alone would let a superseded walk keep dialing a stale endpoint list and
    // race the new one into `this.client`. `connectionGeneration` can't serve
    // here because connectClient bumps it per attempt; this epoch changes only
    // when the runtime is torn down.
    const walkEpoch = this.walkEpoch;
    let lastError: unknown;
    for (const endpoint of attempts) {
      if (this.stopping || this.walkEpoch !== walkEpoch) return;
      try {
        await this.connectClient(endpoint);
        return;
      } catch (error) {
        lastError = error;
        const rawMessage =
          error instanceof Error ? error.message : String(error);
        this.endpointStatuses.set(endpoint, {
          ...this.endpointStatuses.get(endpoint),
          state: "failed",
          lastError: redactFederationDiagnostic(rawMessage),
        });
        // Every endpoint authenticates against the SAME pinned gateway
        // identity, so an auth-class failure is a property of the pairing,
        // not of this path. Walking on would waste attempts and, worse, let
        // a later endpoint's network error mask a broken pin behind an
        // endless "connecting" retry instead of surfacing as "rejected".
        if (classifyFederationClientFailure(rawMessage) === "auth") {
          throw error;
        }
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new Error(
          "Federation gateway is unreachable on every configured endpoint.",
        );
  }

  private async connectClient(gatewayUrl: string): Promise<void> {
    if (!gatewayUrl) return;
    this.endpointStatuses.set(gatewayUrl, {
      ...this.endpointStatuses.get(gatewayUrl),
      state: "connecting",
      lastAttemptAt: Date.now(),
    });
    const gatewayInstanceId = getAppStateDb().getMeta(GATEWAY_INSTANCE_ID_META_KEY);
    if (!gatewayInstanceId) {
      throw new Error("Federation client mode is missing its gateway identity.");
    }
    const gatewayPublicKeyPem = getAppStateDb().getMeta(GATEWAY_PUBLIC_KEY_META_KEY);
    if (!gatewayPublicKeyPem) {
      throw new Error("Federation client mode is missing its pinned gateway key.");
    }
    this.gatewayInstanceId = gatewayInstanceId;
    const gatewayNoisePublicKeyBase64 = getAppStateDb().getMeta(
      GATEWAY_NOISE_PUBLIC_KEY_META_KEY,
    );
    if (!gatewayNoisePublicKeyBase64) {
      throw new Error(
        "Federation client mode is missing its pinned gateway encryption key. Re-import the federation invite.",
      );
    }
    const pendingInviteToken = getAppStateDb().getMeta(PENDING_INVITE_TOKEN_META_KEY);
    const connectionMode = pendingInviteToken ? "enroll" : "reconnect";
    const keyPair = await getDesktopSettingsService()
      .getOrCreateFederationIdentityKeyPair();
    const settingsService = getDesktopSettingsService();
    const settings = await settingsService.readSettings();
    const cloudflareCredentials =
      await settingsService.resolveFederationCloudflareCredentials();
    const sshEndpoint = isFederationSshEndpointUrl(gatewayUrl)
      ? parseFederationSshEndpoint(gatewayUrl)
      : undefined;
    // Cloudflare edge credentials ride the WebSocket upgrade, which happens
    // BEFORE the Noise handshake pins anything. So they must be scoped to the
    // one host the operator designated as Cloudflare-fronted — not to "any
    // wss:// URL", which would hand the Access bearer token and the mTLS client
    // key to every TLS endpoint in the fallback list.
    const acceptsCloudflareCredentials =
      federationEndpointAcceptsCloudflareCredentials({
        endpoint: gatewayUrl,
        cloudflareEndpoint: settings.federation.cloudflareEndpoint.value,
        configuredEndpointCount: this.configuredEndpoints.length,
      });
    const cloudflareMtlsEnabled =
      acceptsCloudflareCredentials
      && settings.federation.cloudflareMtlsEnabled.value;
    const cloudflareAccessEnabled =
      acceptsCloudflareCredentials
      && settings.federation.cloudflareAccessServiceAuthEnabled.value;
    if (
      !acceptsCloudflareCredentials
      && (settings.federation.cloudflareMtlsEnabled.value
        || settings.federation.cloudflareAccessServiceAuthEnabled.value)
    ) {
      log.info("federation endpoint is not the designated Cloudflare endpoint", {
        withheldCredentials: true,
      });
    }
    if (
      cloudflareMtlsEnabled &&
      (!cloudflareCredentials.clientCertificate ||
        !cloudflareCredentials.clientPrivateKey)
    ) {
      throw new Error(
        "Cloudflare mTLS is enabled but the client certificate or private key is missing.",
      );
    }
    if (
      cloudflareAccessEnabled &&
      (!cloudflareCredentials.accessClientId ||
        !cloudflareCredentials.accessClientSecret)
    ) {
      throw new Error(
        "Cloudflare Access service auth is enabled but its credentials are missing.",
      );
    }
    const noise =
      await settingsService.getOrCreateFederationNoiseStaticKeyPair();
    this.gatewayUrl = gatewayUrl;
    const connectionGeneration = ++this.connectionGeneration;
    this.store().appendAudit({
      peerId: gatewayInstanceId,
      kind: "connect_attempt",
      createdAt: Date.now(),
      detail: connectionMode,
    });
    const clientSession: { id?: FederationSessionId } = {};
    // Node reports a failed ssh dial as a generic "socket hang up", so keep the
    // real cause (auth, host key, timeout) and report that instead.
    const sshFailure: { error?: Error } = {};
    const client = await connectFederationClient({
      url: sshEndpoint
        ? `ws://${sshEndpoint.forwardHost}:${sshEndpoint.forwardPort}`
        : gatewayUrl,
      createSocket: sshEndpoint
        ? () =>
            dialFederationSshEndpoint(sshEndpoint, {
              onFailure: (error) => {
                sshFailure.error ??= error;
              },
            })
        : undefined,
      mode: connectionMode,
      gatewayInstanceId,
      gatewayPublicKeyPem,
      peerInstanceId: this.ensureLocalInstanceId(),
      privateKeyPem: keyPair.privateKeyPem,
      publicKeyPem: keyPair.publicKeyPem,
      capabilities: DEFAULT_CAPABILITIES,
      inviteToken: pendingInviteToken || undefined,
      label:
        this.instanceLabel ||
        settings.federation.instanceLabel.value.trim() ||
        defaultInstanceLabel(),
      // Advertise which profile this instance runs so peers can tell
      // several enrollments of the same machine apart in their UI.
      profileName: getAppStateDb().getMeta("profile_name") || undefined,
      role: "client",
      headers: cloudflareAccessEnabled
        ? {
            "CF-Access-Client-Id": cloudflareCredentials.accessClientId!,
            "CF-Access-Client-Secret":
              cloudflareCredentials.accessClientSecret!,
          }
        : undefined,
      clientCertificate: cloudflareMtlsEnabled
        ? cloudflareCredentials.clientCertificate
        : undefined,
      clientPrivateKey: cloudflareMtlsEnabled
        ? cloudflareCredentials.clientPrivateKey
        : undefined,
      noiseStatic: noiseKeyPairFromRawPrivate(
        Buffer.from(noise.privateKeyBase64, "base64"),
      ),
      gatewayNoisePublicKey: Buffer.from(
        gatewayNoisePublicKeyBase64,
        "base64",
      ),
      onClose: (info) => {
        if (
          this.stopping ||
          connectionGeneration !== this.connectionGeneration
        ) {
          return;
        }
        this.client = undefined;
        // 4001 is the gateway's "another connection authenticated with
        // your instance id" eviction — the signature of a cloned profile
        // state.db. Say so instead of the generic transport message, or
        // the operator sees an unexplained 30s connect/drop loop.
        const replaced = info?.code === FEDERATION_CLOSE_REPLACED_CODE;
        const revoked = info?.code === FEDERATION_CLOSE_REVOKED_CODE;
        this.lastConnectionError = replaced
          ? "Another instance connected with this federation identity "
            + "(a cloned profile state.db shares the instance id and key). "
            + "Reset federation on one of the profiles to stop the loop."
          : revoked
            ? "This instance's enrollment was revoked by the gateway. "
              + "Import a fresh invite to re-pair."
            : info
              ? `Federation gateway connection closed (${info.code}${
                  info.reason ? ` ${info.reason}` : ""
                }).`
              : "Federation gateway connection closed.";
        this.lastConnectionFailureKind = replaced
          ? "replaced"
          // Revocation is terminal until the operator re-pairs — the
          // auth kind makes health read "rejected" instead of hiding it
          // behind an endless "connecting".
          : revoked
            ? "auth"
            : "transport";
        const sessionAgeMs = this.lastConnectedAt
          ? Date.now() - this.lastConnectedAt
          : undefined;
        // Post-auth drops previously logged nothing at all; a repeating
        // short session age makes a kick loop obvious at a glance.
        log.warn("federation client session closed", {
          gatewayInstanceId,
          code: info?.code,
          reason: info?.reason,
          replaced,
          sessionAgeMs,
        });
        this.store().appendAudit({
          peerId: gatewayInstanceId,
          sessionId: clientSession.id,
          kind: "disconnected",
          createdAt: Date.now(),
          detail: replaced
            ? "replaced_by_new_session"
            : info
              ? `transport_closed:${info.code}`
              : "transport_closed",
        });
        this.unregisterPeer(gatewayInstanceId);
        this.publishPeerStatus(
          gatewayInstanceId,
          "disconnected",
          this.lastConnectionError,
        );
        this.disconnectAdvertisedPeers(this.lastConnectionError);
        this.endpointStatuses.set(gatewayUrl, {
          ...this.endpointStatuses.get(gatewayUrl),
          state: "idle",
        });
        this.scheduleReconnect();
      },
      onEnvelope: (envelope) =>
        void this.receiveEnvelope(envelope, gatewayInstanceId),
    }).catch((error: unknown) => {
      throw (
        sshFailure.error
        ?? (error instanceof Error ? error : new Error(String(error)))
      );
    });
    clientSession.id = client.sessionId;
    if (
      this.stopping ||
      connectionGeneration !== this.connectionGeneration
    ) {
      client.close();
      return;
    }
    this.client = client;
    this.router?.registerConnection({
      peerId: gatewayInstanceId,
      capabilities: client.capabilities,
      sendEnvelope: (envelope) => this.client?.sendEnvelope(envelope),
    });
    // This instance can also be the OWNER of remote PTY sessions the gateway
    // is viewing; a reconnect inside the grace keeps those alive.
    this.ptyService?.notifyPeerConnected(gatewayInstanceId);
    this.recordClientConnection({
      gatewayInstanceId,
      gatewayUrl,
      client,
      connectionMode,
      connectedAt: Date.now(),
    });
    this.publishPeerStatus(gatewayInstanceId, "connected");
    if (pendingInviteToken) {
      getAppStateDb().setMeta(PENDING_INVITE_TOKEN_META_KEY, "");
    }
    this.markEndpointConnected(gatewayUrl);
    // Backoff is reset by session *durability*, not by the mere fact that a
    // handshake succeeded — otherwise a gateway that accepts and immediately
    // drops (restart loop, eviction) pins reconnects at 1 Hz forever, spawning
    // a fresh ssh process every second for ssh:// endpoints.
    this.lastConnectedAt = Date.now();
    this.lastConnectionError = undefined;
    this.lastConnectionFailureKind = undefined;
    log.info("federation client connected", { gatewayUrl });
  }

  // Only a fully authenticated session ever updates the last-good endpoint
  // memory, so a hostile endpoint can never steer future attempt ordering.
  private markEndpointConnected(gatewayUrl: string): void {
    this.endpointStatuses.set(gatewayUrl, {
      ...this.endpointStatuses.get(gatewayUrl),
      state: "active",
      lastConnectedAt: Date.now(),
      lastError: undefined,
    });
    getAppStateDb().setMeta(GATEWAY_LAST_ENDPOINT_META_KEY, gatewayUrl);
  }

  private recordClientConnection(params: {
    gatewayInstanceId: FederationInstanceId;
    gatewayUrl: string;
    client: FederationClientWebSocketClient;
    connectionMode: "enroll" | "reconnect";
    connectedAt: number;
  }): void {
    const existing = this.remotePeerDirectory.get(params.gatewayInstanceId);
    this.remotePeerDirectory.set(params.gatewayInstanceId, {
      id: params.gatewayInstanceId,
      label: existing?.label ?? this.defaultPeerLabel(params.gatewayInstanceId),
      role: "gateway",
      status: "connected",
      capabilities: [...params.client.capabilities],
      protocolVersion:
        existing?.protocolVersion ?? FEDERATION_PROTOCOL_VERSION,
      endpoint: existing?.endpoint ?? params.gatewayUrl,
      profileName: existing?.profileName,
      lastConnectedAt: params.connectedAt,
      lastActivityAt: params.connectedAt,
      canRevoke: false,
    });
    this.store().appendAudit({
      peerId: params.gatewayInstanceId,
      sessionId: params.client.sessionId,
      kind: "connected",
      createdAt: params.connectedAt,
      detail: params.connectionMode,
    });
  }

  private handleClientConnectionFailure(error: unknown): void {
    if (this.stopping) return;
    this.client = undefined;
    const rawMessage = error instanceof Error ? error.message : String(error);
    this.lastConnectionFailureKind = classifyFederationClientFailure(rawMessage);
    this.lastConnectionError = redactFederationDiagnostic(rawMessage);
    if (this.gatewayInstanceId) {
      this.publishPeerStatus(
        this.gatewayInstanceId,
        "disconnected",
        this.lastConnectionError,
      );
    }
    this.disconnectAdvertisedPeers(this.lastConnectionError);
    this.store().appendAudit({
      peerId: this.gatewayInstanceId,
      kind: "error",
      createdAt: Date.now(),
      detail: this.lastConnectionError,
    });
    log.warn("federation client connection failed", {
      endpoints: this.configuredEndpoints.length,
      error: this.lastConnectionError,
    });
    this.scheduleReconnect();
  }

  // Backoff applies per full cycle through the endpoint list; every cycle
  // re-walks the endpoints last-good-first via connectToGateway.
  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return;
    if (
      this.lastConnectedAt !== undefined
      && Date.now() - this.lastConnectedAt >= FEDERATION_STABLE_SESSION_MS
    ) {
      this.reconnectAttempt = 0;
    }
    this.lastConnectedAt = undefined;
    const delayMs = Math.min(
      1_000 * 2 ** this.reconnectAttempt,
      FEDERATION_RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.stopping) return;
      void this.connectToGateway().catch((error) => {
        this.handleClientConnectionFailure(error);
      });
    }, delayMs);
  }

  private registerGatewayConnection(connection: FederationGatewayConnection): void {
    this.router?.registerConnection({
      peerId: connection.peerId,
      capabilities: connection.capabilities,
      sendEnvelope: connection.sendEnvelope,
    });
    // A transport blip that healed inside the reap grace keeps the peer's
    // remote PTY sessions alive.
    this.ptyService?.notifyPeerConnected(connection.peerId);
    this.publishPeerStatus(connection.peerId, "connected");
    this.broadcastPeerDirectory();
  }

  private unregisterGatewayConnection(connection: FederationGatewayConnection): void {
    const activeConnection = this.router?.getConnection(connection.peerId);
    if (activeConnection?.sendEnvelope !== connection.sendEnvelope) {
      return;
    }
    this.unregisterPeer(connection.peerId);
    this.publishPeerStatus(
      connection.peerId,
      "disconnected",
      "Federation peer connection closed.",
    );
    this.broadcastPeerDirectory();
  }

  private unregisterPeer(peerId: FederationInstanceId): void {
    this.router?.unregisterConnection(peerId);
    // Remote PTY sessions this peer opened get the 10s reap grace; if the
    // peer reconnects first, registerGatewayConnection cancels the reap.
    this.ptyService?.notifyPeerDisconnected(peerId);
    this.rpcByPeer.get(peerId)?.rejectAll(
      new Error(`Federation peer ${peerId} disconnected.`),
    );
    this.rpcByPeer.delete(peerId);
  }

  private disconnectAdvertisedPeers(reason: string): void {
    for (const [peerId, peer] of this.remotePeerDirectory) {
      // Dual mode: a peer directly connected to THIS instance's own
      // gateway is still reachable when the upstream client link drops —
      // publishing "disconnected" for it would be false.
      if (this.router?.getConnection(peerId)) {
        continue;
      }
      this.remotePeerDirectory.set(peerId, {
        ...peer,
        status: peer.status === "revoked" ? "revoked" : "disconnected",
        unavailableReason: reason,
      });
      this.publishPeerStatus(
        peerId,
        peer.status === "revoked" ? "revoked" : "disconnected",
        reason,
      );
    }
    for (const rpc of this.rpcByPeer.values()) {
      rpc.rejectAll(new Error(reason));
    }
    this.rpcByPeer.clear();
  }

  private async receiveEnvelope(
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ): Promise<void> {
    if (this.applyPeerDirectory(envelope)) {
      return;
    }
    if (this.publishRemotePtyStreamEvent(envelope, sourcePeerId)) {
      return;
    }
    if (this.publishRemoteEnvironmentSetupProgress(envelope, sourcePeerId)) {
      return;
    }
    if (this.publishRemoteBackendEvent(envelope, sourcePeerId)) {
      return;
    }
    if (envelope.kind === "response" || envelope.kind === "error") {
      const sourceInstanceId = envelope.sourceInstanceId;
      const originatingRpc = sourceInstanceId
        ? this.rpcByPeer.get(sourceInstanceId)
        : undefined;
      const handledByOrigin = originatingRpc?.receiveEnvelope(envelope) ?? false;
      const handled = handledByOrigin || [...this.rpcByPeer.entries()].some(
        ([peerId, rpc]) =>
          peerId !== sourceInstanceId && rpc.receiveEnvelope(envelope),
      );
      if (handled) return;
    }
    await this.router?.routeEnvelope({ envelope, sourcePeerId });
  }

  /**
   * Owner → viewer PTY stream frame. Deliberately DIRECT-only: no gateway
   * fallback, so `hopCount` stays 0 and a shell stream can never transit a
   * relay. Returns false when the peer has no direct connection — the
   * service's disconnect reap owns cleanup in that case.
   */
  private sendPtyNotification(
    peerId: FederationInstanceId,
    method: string,
    params: unknown,
  ): boolean {
    const connection = this.router?.getConnection(peerId);
    if (!connection) return false;
    connection.sendEnvelope({
      id: `federation-pty:${randomUUID()}`,
      kind: "notification",
      method,
      params,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: this.ensureLocalInstanceId(),
      targetInstanceId: peerId,
      createdAt: Date.now(),
    });
    return true;
  }

  private publishRemotePtyStreamEvent(
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ): boolean {
    if (
      envelope.kind !== "notification" ||
      !isFederationPtyStreamMethod(envelope.method)
    ) {
      return false;
    }
    // Point-to-point invariant, receive side: a PTY frame addressed to some
    // other instance is dropped, never relayed onward; and a frame whose
    // claimed origin differs from the authenticated link it arrived on is
    // spoofed, not trusted.
    if (
      envelope.targetInstanceId &&
      envelope.targetInstanceId !== this.ensureLocalInstanceId()
    ) {
      return true;
    }
    if (
      envelope.sourceInstanceId &&
      envelope.sourceInstanceId !== sourcePeerId
    ) {
      return true;
    }
    const kind =
      envelope.method === FEDERATION_PTY_OUTPUT_METHOD
        ? "output"
        : envelope.method === FEDERATION_PTY_EXIT_METHOD
          ? "exit"
          : "error";
    const event = {
      kind,
      peerId: sourcePeerId,
      params: envelope.params,
    } as FederationPtyStreamEvent;
    for (const listener of this.remotePtyEventListeners) {
      try {
        listener(event);
      } catch (error) {
        log.warn("federation remote pty event listener failed", {
          error: error instanceof Error ? error.message : String(error),
          method: envelope.method,
        });
      }
    }
    return true;
  }

  private sendEnvironmentSetupProgress(
    event: CodexEnvironmentSetupProgressEvent,
    targetInstanceId: FederationInstanceId,
  ): void {
    this.sendEnvelopeToTarget(targetInstanceId, {
      id: `federation-environment-setup:${randomUUID()}`,
      kind: "notification",
      method: FEDERATION_ENVIRONMENT_SETUP_PROGRESS_METHOD,
      params: event,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      sourceInstanceId: this.ensureLocalInstanceId(),
      targetInstanceId,
      createdAt: Date.now(),
    });
  }

  private publishRemoteEnvironmentSetupProgress(
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ): boolean {
    if (
      envelope.kind !== "notification" ||
      envelope.method !== FEDERATION_ENVIRONMENT_SETUP_PROGRESS_METHOD
    ) {
      return false;
    }
    const notification =
      envelope as FederationEnvironmentSetupProgressNotification & typeof envelope;
    const targetInstanceId = envelope.targetInstanceId;
    if (
      targetInstanceId &&
      targetInstanceId !== this.ensureLocalInstanceId()
    ) {
      void this.router?.routeEnvelope({ envelope, sourcePeerId });
      return true;
    }
    this.publishEnvironmentSetupProgress?.({
      ...notification.params,
      federationTarget: {
        scope: "remote",
        instanceId: envelope.sourceInstanceId || sourcePeerId,
      },
    });
    return true;
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
        visible.set(peer.id, { ...peer, canRevoke: false });
      }
    }

    for (const peer of this.store().listPeers({ includeRevoked: true })) {
      if (peer.id === localInstanceId) continue;
      visible.set(peer.id, { ...peer, canRevoke: true });
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
        canRevoke: existing?.canRevoke ?? false,
      });
    }

    return [...visible.values()]
      .map((peer) =>
        this.router?.getConnection(peer.id)
          ? { ...peer, status: "connected" as const }
          : this.remotePeerDirectory.has(peer.id)
            ? peer
          : {
              ...peer,
              status:
                peer.status === "connected"
                  ? ("disconnected" as const)
                  : peer.status,
            },
      )
      .map((peer) => {
        // Surface a recent duplicate-identity eviction storm to everyone
        // observing this peer (Settings rows here, and remote viewers via
        // the peer directory) — the flapping peer itself only ever sees
        // its own 4001 close.
        const suspectedAt = this.duplicateIdentitySuspectedAt.get(peer.id);
        return suspectedAt !== undefined
          && Date.now() - suspectedAt < DUPLICATE_IDENTITY_NOTE_TTL_MS
          && !peer.unavailableReason
          ? {
              ...peer,
              unavailableReason:
                "Multiple instances are presenting this federation identity "
                + "(likely a cloned profile state.db); its connection is "
                + "unstable until one is reset.",
            }
          : peer;
      });
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
        label: this.instanceLabel || localProfileName || "Gateway",
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
    const previousPeers = new Map(this.remotePeerDirectory);
    this.remotePeerDirectory.clear();
    for (const peer of notification.params.peers) {
      if (peer.id !== this.ensureLocalInstanceId()) {
        const previous = previousPeers.get(peer.id);
        this.remotePeerDirectory.set(peer.id, {
          ...peer,
          lastConnectedAt: peer.lastConnectedAt ?? previous?.lastConnectedAt,
          lastActivityAt: peer.lastActivityAt ?? previous?.lastActivityAt,
          canRevoke: false,
        });
        previousPeers.delete(peer.id);
      }
    }
    // Publish only after the complete snapshot is installed. Status listeners
    // synchronously read visiblePeers() (the application menu is one of them),
    // so notifying while this map is still being rebuilt can expose a partial
    // directory. If the remaining peers retain their previous statuses, the
    // deduplicating publisher will not fire again and that partial view can
    // remain visible indefinitely.
    for (const peer of this.remotePeerDirectory.values()) {
      this.publishPeerStatus(peer.id, peer.status, peer.unavailableReason);
    }
    for (const peerId of previousPeers.keys()) {
      this.publishPeerStatus(
        peerId,
        "disconnected",
        "Federation peer is no longer advertised by the gateway.",
      );
    }
    return true;
  }

  private publishPeerStatus(
    instanceId: FederationInstanceId,
    status: FederationConnectionState,
    unavailableReason?: string,
  ): void {
    const previous = this.publishedPeerStatuses.get(instanceId);
    if (
      previous?.status === status
      && previous.unavailableReason === unavailableReason
    ) {
      return;
    }
    this.publishedPeerStatuses.set(instanceId, { status, unavailableReason });
    for (const listener of this.peerStatusListeners) {
      try {
        listener();
      } catch (error) {
        log.warn("federation peer status listener failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.publishAgentEvent?.({
      backend: "codex",
      federationTarget: {
        scope: "remote",
        instanceId,
      },
      notification: {
        method: "federation/peerStatus/changed",
        params: {
          instanceId,
          status,
          ...(unavailableReason ? { unavailableReason } : {}),
        },
      },
    });
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
      const scheduledActionEvent =
        event.notification.method === "thread/scheduledAction/updated";
      if (
        scheduledActionEvent
          ? !connection.capabilities.includes("scheduled_actions")
          : !connection.capabilities.includes("remote_window")
            && !connection.capabilities.includes("thread_detail")
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
    const event: AgentEvent = {
      backend: notification.params.backend,
      federationTarget: {
        scope: "remote",
        instanceId: envelope.sourceInstanceId || sourcePeerId,
      },
      notification: notification.params.notification,
    };
    this.publishAgentEvent?.(event);
    for (const listener of this.remoteBackendEventListeners) {
      void Promise.resolve(listener(event)).catch((error) => {
        log.warn("federation remote backend event listener failed", {
          error: error instanceof Error ? error.message : String(error),
          method: event.notification.method,
        });
      });
    }
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

    const notification = envelope as FederationBackendEventNotification & typeof envelope;
    for (const connection of router.listConnections()) {
      if (connection.peerId === sourcePeerId) continue;
      const scheduledActionEvent =
        notification.params.notification.method
          === "thread/scheduledAction/updated";
      if (
        scheduledActionEvent
          ? !connection.capabilities.includes("scheduled_actions")
          : !connection.capabilities.includes("remote_window")
            && !connection.capabilities.includes("thread_detail")
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

/**
 * Fallback display name when the operator has not set one: the machine
 * hostname (minus the mDNS suffix) beats both the profile name (almost
 * always "default") and the raw instance GUID for recognizing a peer.
 */
function defaultInstanceLabel(): string {
  const host = hostname().trim().replace(/\.local$/i, "");
  return host || "PwrAgent";
}

let messagingPlatformStatusReader:
  | (() => MessagingPlatformStatus[] | Promise<MessagingPlatformStatus[]>)
  | undefined;

/**
 * Wire the local messaging runtime's platform statuses into the federation
 * backend so remote viewers can render this instance's MSG chip. Registered
 * by the messaging IPC layer (which owns the runtime singleton) to keep the
 * federation runtime free of a messaging-runtime import cycle.
 */
export function setFederationMessagingPlatformStatusReader(
  reader:
    | (() => MessagingPlatformStatus[] | Promise<MessagingPlatformStatus[]>)
    | undefined,
): void {
  messagingPlatformStatusReader = reader;
}

function localBackendOperations(): FederationBackendOperations {
  return {
    async getNavigationSnapshot(request = {}): Promise<NavigationSnapshot> {
      return await new DesktopMessagingBackendBridge()
        .getNavigationSnapshot(request);
    },
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
    async readTranscriptImage(request) {
      return await readTranscriptImageProtocolRequest(request.url);
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
    async listBackends(request = {}) {
      return await getDesktopBackendRegistry().listBackends(request);
    },
    async markThreadSeen(
      request: MarkThreadSeenRequest,
    ): Promise<MarkThreadSeenResponse> {
      const backend = request.backend ?? "codex";
      return await getDesktopOverlayStore().markThreadSeen({
        backend,
        seenAt: request.seenAt,
        seenUpdatedAt: request.seenUpdatedAt,
        threadId: request.threadId,
      });
    },
    async setThreadPin(
      request: SetThreadPinRequest,
    ): Promise<SetThreadPinResponse> {
      const backend = request.backend ?? "codex";
      const overlay = await getDesktopOverlayStore().setThreadPin({
        backend,
        threadId: request.threadId,
        pinnedRank: request.pinnedRank,
      });
      // Publish so this instance's own windows AND connected remote
      // viewers converge on the new pin state.
      await getDesktopBackendRegistry().publishLocalEvent({
        backend,
        notification: overlay.pinnedRank
          ? {
              method: "thread/pin/added",
              params: {
                threadId: request.threadId,
                pinnedRank: overlay.pinnedRank,
              },
            }
          : {
              method: "thread/pin/removed",
              params: {
                threadId: request.threadId,
              },
            },
      });
      return {
        backend,
        threadId: request.threadId,
        pinnedRank: overlay.pinnedRank,
      };
    },
    async readMessagingPlatformStatuses(): Promise<MessagingPlatformStatus[]> {
      // Registered by the messaging IPC layer — messaging-runtime imports
      // this module for event fan-out, so importing it back would be a
      // cycle. An unregistered reader (messaging not wired yet) reads as
      // "no platforms configured", which renders as no MSG chip.
      return await (messagingPlatformStatusReader?.() ?? []);
    },
    async detachThreadPullRequest(
      request: DetachThreadPullRequestRequest,
    ): Promise<DetachThreadPullRequestResponse> {
      // Delegates to the app-server service (PR status registry + dispatch
      // coordinator live there); the resulting thread/pullRequests/updated
      // event fans back out to remote viewers.
      return await getDesktopBackendRegistry().detachThreadPullRequest(request);
    },
    async setThreadPrAutoDispatch(
      request: SetThreadPrAutoDispatchRequest,
    ): Promise<SetThreadPrAutoDispatchResponse> {
      return await getDesktopBackendRegistry().setThreadPrAutoDispatch(request);
    },
    async reorderThreadPins(
      request: ReorderThreadPinsRequest,
    ): Promise<ReorderThreadPinsResponse> {
      const pinnedRanks = await getDesktopOverlayStore().reorderThreadPins({
        threadKeys: request.threadKeys,
      });
      // Pin order is global across backends; the backend field is
      // required by publishLocalEvent but irrelevant here (matches the
      // app-server reorder handler).
      await getDesktopBackendRegistry().publishLocalEvent({
        backend: "codex",
        notification: {
          method: "thread/pin/reordered",
          params: {
            pinnedRanks,
          },
        },
      });
      return { pinnedRanks };
    },
    async archiveThread(request) {
      return await getDesktopBackendRegistry().archiveThread(request);
    },
    async startThread(request: StartThreadRequest): Promise<StartThreadResponse> {
      return await getDesktopBackendRegistry().startThread(request);
    },
    async forkThread(
      request: ForkThreadRequest,
      options?: Pick<
        MaterializeDirectoryLaunchpadOptions,
        "onCodexEnvironmentSetupProgress"
      >,
    ): Promise<ForkThreadResponse> {
      return await getDesktopBackendRegistry().forkThread({
        ...request,
        onCodexEnvironmentSetupProgress:
          options?.onCodexEnvironmentSetupProgress,
      });
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
    async startReview(
      request: StartReviewRequest,
    ): Promise<StartReviewResponse> {
      return await getDesktopBackendRegistry().startReview(request);
    },
    async cancelQueuedTurn(
      request: CancelQueuedTurnRequest,
    ): Promise<CancelQueuedTurnResponse> {
      return {
        queueEntryId: request.queueEntryId,
        cancelled: getDesktopBackendRegistry().cancelQueuedTurn(
          request.queueEntryId,
          "Cancelled from a federated desktop composer.",
        ),
      };
    },
    async listScheduledThreadActions(
      request: ListScheduledThreadActionsRequest = {},
    ): Promise<ListScheduledThreadActionsResponse> {
      const { getScheduledThreadActionService } = await import(
        "../scheduled-actions/scheduled-thread-action-service.js"
      );
      return getScheduledThreadActionService().list(request);
    },
    async createScheduledThreadAction(
      request: CreateScheduledThreadActionRequest,
    ): Promise<ScheduledThreadActionMutationResponse> {
      const { getScheduledThreadActionService } = await import(
        "../scheduled-actions/scheduled-thread-action-service.js"
      );
      return await getScheduledThreadActionService().create(request);
    },
    async updateScheduledThreadAction(
      request: UpdateScheduledThreadActionRequest,
    ): Promise<ScheduledThreadActionMutationResponse> {
      const { getScheduledThreadActionService } = await import(
        "../scheduled-actions/scheduled-thread-action-service.js"
      );
      return await getScheduledThreadActionService().update(request);
    },
    async cancelScheduledThreadAction(
      request: ScheduledThreadActionIdRequest,
    ): Promise<ScheduledThreadActionMutationResponse> {
      const { getScheduledThreadActionService } = await import(
        "../scheduled-actions/scheduled-thread-action-service.js"
      );
      return await getScheduledThreadActionService().cancel(request);
    },
    async sendScheduledThreadActionNow(
      request: ScheduledThreadActionIdRequest,
    ): Promise<ScheduledThreadActionMutationResponse> {
      const { getScheduledThreadActionService } = await import(
        "../scheduled-actions/scheduled-thread-action-service.js"
      );
      return await getScheduledThreadActionService().sendNow(request);
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
      const registry = getDesktopBackendRegistry();
      const { admitSteerTurn } = await import(
        "../scheduled-actions/steer-turn-admission.js"
      );
      const { getScheduledThreadActionService } = await import(
        "../scheduled-actions/scheduled-thread-action-service.js"
      );
      return await admitSteerTurn(
        registry,
        getScheduledThreadActionService(registry),
        request,
      );
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
    async applyThreadModelMigration(
      request: ApplyThreadModelMigrationRequest,
    ): Promise<ApplyThreadModelMigrationResponse> {
      return await getDesktopBackendRegistry().applyThreadModelMigration(request);
    },
    async checkThreadBranchDrift(
      request: CheckThreadBranchDriftRequest,
    ): Promise<CheckThreadBranchDriftResponse> {
      return await getDesktopBackendRegistry().checkThreadBranchDrift(request);
    },
    async updateThreadExpectedBranch(
      request: UpdateThreadExpectedBranchRequest,
    ): Promise<UpdateThreadExpectedBranchResponse> {
      return await getDesktopBackendRegistry().updateThreadExpectedBranch(request);
    },
    async retainThreadBranchDrift(
      request: RetainThreadBranchDriftRequest,
    ): Promise<RetainThreadBranchDriftResponse> {
      return await getDesktopBackendRegistry().retainThreadBranchDrift(request);
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
    async stopCodexEnvironmentAction(
      request: StopCodexEnvironmentActionRequest,
    ): Promise<StopCodexEnvironmentActionResponse> {
      return await getDesktopBackendRegistry().stopCodexEnvironmentAction(request);
    },
    async setCodexThreadEnvironment(
      request: SetCodexThreadEnvironmentRequest,
    ): Promise<SetCodexThreadEnvironmentResponse> {
      return await getDesktopBackendRegistry().setCodexThreadEnvironment(request);
    },
    async refreshDirectoryGitStatuses(
      request: RefreshDirectoryGitStatusesRequest,
    ): Promise<RefreshDirectoryGitStatusesResponse> {
      return await getDesktopBackendRegistry().refreshDirectoryGitStatuses(request);
    },
    async materializeDirectoryLaunchpad(
      request: MaterializeDirectoryLaunchpadRequest,
      options?: MaterializeDirectoryLaunchpadOptions,
    ): Promise<MaterializeDirectoryLaunchpadResponse> {
      return await getDesktopBackendRegistry()
        .materializeDirectoryLaunchpad(request, options);
    },
    async handoffThreadWorkspace(
      request: HandoffThreadWorkspaceRequest,
    ): Promise<HandoffThreadWorkspaceResponse> {
      return await getDesktopBackendRegistry().handoffThreadWorkspace(request);
    },
    async renameThread(
      request: RenameThreadRequest,
    ): Promise<RenameThreadResponse> {
      return await getDesktopBackendRegistry().renameThread(request);
    },
    async readApplications(): Promise<DesktopApplicationsSnapshot> {
      return await discoverDesktopApplications();
    },
    async openApplication(
      request: OpenDesktopApplicationRequest,
    ): Promise<OpenDesktopApplicationResponse> {
      return await openDesktopApplication(request);
    },
    async readPwrSnapConnectionStatus(): Promise<PwrSnapConnectionStatus> {
      return await getPwrSnapConnectionService().readStatus();
    },
    async trustCodexProject(
      request: TrustCodexProjectRequest,
    ): Promise<TrustCodexProjectResponse> {
      return await getDesktopBackendRegistry().trustCodexProject(request);
    },
  };
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
