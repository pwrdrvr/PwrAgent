import { randomBytes, randomUUID } from "node:crypto";
import type {
  AppServerListSkillsResponse,
  AppServerListThreadsResponse,
  AppServerReadThreadResponse,
  FederationCapability,
  FederationHealthStatus,
  FederationInstanceId,
  FederationPeerSummary,
  FederationProtocolEnvelope,
} from "@pwragent/shared";
import {
  buildFederatedThreadRef,
  buildThreadIdentityKey,
  isRemoteFederationTarget,
  type AppServerListSkillsRequest,
  type AppServerListThreadsRequest,
  type AppServerReadThreadRequest,
  type FederationRemoteTarget,
  type NavigationSnapshot,
  type StartTurnRequest,
  type StartTurnResponse,
} from "@pwragent/shared";
import { getDesktopBackendRegistry } from "../app-server/backend-registry";
import { rewriteTranscriptImageUrlsForRenderer } from "../transcript-image-protocol";
import { getMainLogger } from "../log";
import { getDesktopSettingsService } from "../settings/desktop-settings-singleton";
import { getAppStateDb } from "../state/app-state";
import {
  createFederationEnrollmentInvite,
  type FederationEnrollmentInvite,
} from "./federation-enrollment";
import {
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  FederationRemoteBackendClient,
  registerFederationBackendHandlers,
  type FederationBackendOperations,
} from "./federation-backend-bridge";
import { buildFederationHealthStatus } from "./federation-health";
import { FederationRouter } from "./federation-router";
import { FederationRpcEndpoint } from "./federation-rpc";
import { FederationStore } from "./federation-store";
import {
  connectFederationChild,
  FederationGatewayWebSocketServer,
  type FederationChildWebSocketClient,
  type FederationGatewayConnection,
} from "./federation-transport";

const log = getMainLogger("pwragent:federation-runtime");
const INSTANCE_ID_META_KEY = "federation_instance_id";
const GATEWAY_INSTANCE_ID_META_KEY = "federation_gateway_instance_id";
const PENDING_INVITE_TOKEN_META_KEY = "federation_pending_invite_token";

const DEFAULT_CAPABILITIES: FederationCapability[] = [
  "remote_window",
  "thread_navigation",
  "thread_detail",
  "turn_control",
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

export class DesktopFederationRuntime {
  private router?: FederationRouter;
  private server?: FederationGatewayWebSocketServer;
  private child?: FederationChildWebSocketClient;
  private localInstanceId?: FederationInstanceId;
  private listenUrl?: string;
  private gatewayUrl?: string;
  private readonly rpcByPeer = new Map<FederationInstanceId, FederationRpcEndpoint>();
  private restartPromise: Promise<void> | undefined;

  async restart(): Promise<void> {
    this.restartPromise ??= this.restartNow().finally(() => {
      this.restartPromise = undefined;
    });
    return await this.restartPromise;
  }

  async stop(): Promise<void> {
    this.child?.close();
    this.child = undefined;
    await this.server?.stop();
    this.server = undefined;
    this.router = undefined;
    this.listenUrl = undefined;
    this.gatewayUrl = undefined;
    this.rpcByPeer.clear();
  }

  async health(): Promise<FederationHealthStatus> {
    const settings = await getDesktopSettingsService().readSettings();
    const peers = this.store().listPeers({ includeRevoked: true });
    return buildFederationHealthStatus({
      settings,
      peers: peers.map((peer) =>
        this.router?.getConnection(peer.id)
          ? { ...peer, status: "connected" }
          : {
              ...peer,
              status: peer.status === "connected" ? "disconnected" : peer.status,
            },
      ),
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
      role: "child",
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
        mode: "child",
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
          if (!this.router?.sendToPeer(target.instanceId, envelope)) {
            throw new Error(`Federation peer ${target.instanceId} is not connected.`);
          }
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
        buildThreadIdentityKey(thread.source, thread.id),
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

    if (mode === "gateway" || mode === "dual") {
      this.server = new FederationGatewayWebSocketServer({
        gatewayInstanceId: localInstanceId,
        host: settings.federation.listenHost.value,
        port: settings.federation.listenPort.value,
        store: this.store(),
        onConnection: (connection) => this.registerGatewayConnection(connection),
        onDisconnect: (connection) => this.unregisterPeer(connection.peerId),
        onEnvelope: (envelope, connection) =>
          void this.receiveEnvelope(envelope, connection.peerId),
      });
      const started = await this.server.start();
      this.listenUrl = started.url;
      log.info("federation gateway listening", { url: started.url });
    }

    if (mode === "child" || mode === "dual") {
      await this.connectChild(settings.federation.gatewayUrl.value.trim());
    }
  }

  private async connectChild(gatewayUrl: string): Promise<void> {
    if (!gatewayUrl) return;
    const gatewayInstanceId = getAppStateDb().getMeta(GATEWAY_INSTANCE_ID_META_KEY);
    if (!gatewayInstanceId) {
      log.warn("federation child mode missing gateway instance id");
      return;
    }
    const pendingInviteToken = getAppStateDb().getMeta(PENDING_INVITE_TOKEN_META_KEY);
    const keyPair = await getDesktopSettingsService()
      .getOrCreateFederationIdentityKeyPair();
    this.gatewayUrl = gatewayUrl;
    this.child = await connectFederationChild({
      url: gatewayUrl,
      mode: pendingInviteToken ? "enroll" : "reconnect",
      gatewayInstanceId,
      peerInstanceId: this.ensureLocalInstanceId(),
      privateKeyPem: keyPair.privateKeyPem,
      publicKeyPem: keyPair.publicKeyPem,
      capabilities: DEFAULT_CAPABILITIES,
      inviteToken: pendingInviteToken || undefined,
      label: getAppStateDb().getMeta("profile_name") || this.ensureLocalInstanceId(),
      role: "child",
      onEnvelope: (envelope) =>
        void this.receiveEnvelope(envelope, gatewayInstanceId),
    });
    this.router?.registerConnection({
      peerId: gatewayInstanceId,
      capabilities: DEFAULT_CAPABILITIES,
      sendEnvelope: (envelope) => this.child?.sendEnvelope(envelope),
    });
    if (pendingInviteToken) {
      getAppStateDb().setMeta(PENDING_INVITE_TOKEN_META_KEY, "");
    }
    log.info("federation child connected", { gatewayUrl });
  }

  private registerGatewayConnection(connection: FederationGatewayConnection): void {
    this.router?.registerConnection({
      peerId: connection.peerId,
      capabilities: connection.capabilities,
      sendEnvelope: connection.sendEnvelope,
    });
  }

  private unregisterPeer(peerId: FederationInstanceId): void {
    this.router?.unregisterConnection(peerId);
    this.rpcByPeer.delete(peerId);
  }

  private async receiveEnvelope(
    envelope: FederationProtocolEnvelope,
    sourcePeerId: FederationInstanceId,
  ): Promise<void> {
    if (envelope.kind === "response" || envelope.kind === "error") {
      this.rpcByPeer.get(sourcePeerId)?.receiveEnvelope(envelope);
      return;
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
