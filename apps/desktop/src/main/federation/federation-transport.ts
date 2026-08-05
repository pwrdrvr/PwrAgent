import http from "node:http";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import type {
  FederationCapability,
  FederationInstanceId,
  FederationInstanceRole,
  FederationProtocolEnvelope,
  FederationSessionId,
} from "@pwragent/shared";
import { getMainLogger } from "../log";
import {
  FEDERATION_PROTOCOL_VERSION,
  FEDERATION_TRANSPORT_VERSION,
  filterKnownFederationCapabilities,
  isFederationInstanceId,
} from "@pwragent/shared";
import {
  authenticateFederationReconnect,
  buildFederationGatewayAcceptedMessage,
  buildFederationGatewayChallengeMessage,
  buildFederationProofMessage,
  completeFederationEnrollment,
} from "./federation-enrollment";
import {
  signFederationMessage,
  verifyFederationMessageSignature,
} from "./federation-identity";
import {
  NoiseIKHandshake,
  type NoiseKeyPair,
  type NoiseTransport,
} from "./federation-noise";
import {
  federationFailure,
  type FederationRedactedFailure,
} from "./federation-redaction";
import { FederationSessionRegistry } from "./federation-session-state";
import type { FederationStore } from "./federation-store";

const log = getMainLogger("pwragent:federation-transport");
const FEDERATION_NOISE_TRANSPORT = "noise_ik_25519_aesgcm_sha256";

/**
 * Application close code sent to a connection evicted because the same
 * peer instance id authenticated again. Clients use it to distinguish
 * "another process is using my identity" from a network drop — the
 * signature of a cloned profile state.db (duplicate instance id + key)
 * kicking its sibling in a loop.
 */
export const FEDERATION_CLOSE_REPLACED_CODE = 4001;
/** Close code for a peer whose enrollment the gateway revoked. */
export const FEDERATION_CLOSE_REVOKED_CODE = 4002;
const REPLACEMENT_FLAP_WINDOW_MS = 5 * 60_000;
const REPLACEMENT_FLAP_THRESHOLD = 3;

/**
 * Liveness probe cadence (ssh ClientAliveInterval / ServerAliveInterval
 * analogue, both directions). A peer that misses one full interval's pong is
 * terminated, so a silently dropped link (sleep, NAT timeout, power loss) is
 * detected within one to two intervals instead of never — the close then
 * drives every existing onDisconnect/onClose consumer (peer status, remote
 * PTY reaping, reconnect backoff).
 */
export const FEDERATION_KEEPALIVE_INTERVAL_MS = 15_000;

/**
 * Hard ceiling on a single WebSocket frame, both directions. Legitimate
 * frames are JSON envelopes (RPC payloads, ≤ ~43 KiB base64 PTY chunks);
 * transcript-bearing responses can reach megabytes, so the ceiling is
 * generous — but without one, ws defaults to 100 MiB and a hostile enrolled
 * peer can force that allocation per frame.
 */
export const FEDERATION_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * WebSocket-level ping/pong watchdog. The counterpart answers pongs from the
 * protocol layer (ws auto-pong), so this needs no cooperation from the remote
 * application code — only a live link and an unwedged event loop.
 */
class FederationSocketKeepalive {
  /**
   * Fired on every pong. The gateway assigns this once a session exists so
   * pongs count as session heartbeats — assignable after construction
   * because the watchdog is armed pre-auth, before there is a sessionId.
   */
  onLive?: () => void;
  private alive = true;
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    socket: WebSocket,
    options: {
      intervalMs: number;
      onDead: () => void;
    },
  ) {
    socket.on("pong", () => {
      this.alive = true;
      this.onLive?.();
    });
    this.timer = setInterval(() => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (!this.alive) {
        this.dispose();
        options.onDead();
        return;
      }
      this.alive = false;
      try {
        socket.ping();
      } catch {
        // The socket died between the readyState check and the ping; the
        // close event owns cleanup.
      }
    }, options.intervalMs);
    this.timer.unref?.();
    socket.once("close", () => this.dispose());
  }

  dispose(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

type FederationSocketTransportHelloMessage = {
  kind: "transport.hello";
  transportVersion: number;
  protocolVersion: number;
  encryption: typeof FEDERATION_NOISE_TRANSPORT;
};

type FederationSocketAuthMessage = {
  kind: "auth";
  mode: "enroll" | "reconnect";
  gatewayInstanceId: FederationInstanceId;
  peerInstanceId: FederationInstanceId;
  protocolVersion: number;
  nonce: string;
  capabilities: FederationCapability[];
  signatureBase64: string;
  inviteToken?: string;
  publicKeyPem?: string;
  label?: string;
  role?: FederationInstanceRole;
  endpoint?: string;
  profileName?: string;
};

type FederationSocketChallengeMessage = {
  kind: "auth.challenge";
  gatewayInstanceId: FederationInstanceId;
  gatewayPublicKeyPem: string;
  protocolVersion: number;
  nonce: string;
  signatureBase64: string;
};

type FederationSocketAcceptedMessage = {
  kind: "auth.accepted";
  gatewayInstanceId: FederationInstanceId;
  sessionId: FederationSessionId;
  protocolVersion: number;
  nonce: string;
  capabilities: FederationCapability[];
  signatureBase64: string;
};

type FederationSocketRejectedMessage = {
  kind: "auth.rejected";
  failure: FederationRedactedFailure;
};

type FederationSocketEnvelopeMessage = {
  kind: "envelope";
  envelope: FederationProtocolEnvelope;
};

type FederationSocketMessage =
  | FederationSocketTransportHelloMessage
  | FederationSocketAuthMessage
  | FederationSocketChallengeMessage
  | FederationSocketAcceptedMessage
  | FederationSocketRejectedMessage
  | FederationSocketEnvelopeMessage;

export type FederationGatewayConnection = {
  peerId: FederationInstanceId;
  sessionId: FederationSessionId;
  capabilities: FederationCapability[];
  sendEnvelope: (envelope: FederationProtocolEnvelope) => void;
  close: (code?: number, reason?: string) => void;
  /** Hard socket teardown for peers already presumed dead (stale sweep):
   *  a graceful close queues a frame a wedged socket may never deliver. */
  terminate?: () => void;
};

export type FederationGatewayWebSocketServerOptions = {
  gatewayInstanceId: FederationInstanceId;
  gatewayPrivateKeyPem: string;
  gatewayPublicKeyPem: string;
  host: string;
  port: number;
  store: FederationStore;
  sessions?: FederationSessionRegistry;
  /**
   * Gateway's Noise static keypair. When set, every connection runs a Noise_IK
   * handshake (responder role) before auth, and all frames are encrypted. When
   * unset, the transport runs in plaintext "tunnel" mode (confidentiality is
   * expected from an outer TLS tunnel, e.g. Cloudflare).
   */
  noiseStatic?: NoiseKeyPair;
  /** Ping cadence; a peer missing one interval's pong is terminated. */
  keepaliveIntervalMs?: number;
  /** Per-frame receive ceiling (ws maxPayload). */
  maxFrameBytes?: number;
  /** Deadline for a connected socket to finish Noise + identity auth. */
  authTimeoutMs?: number;
  onConnection?: (connection: FederationGatewayConnection) => void;
  onDisconnect?: (connection: FederationGatewayConnection) => void;
  /**
   * A new connection for a peer id evicted an existing one.
   * `duplicateInstanceIdSuspected` flags repeated evictions inside the
   * detection window — the cloned-profile signature — so the runtime can
   * surface it to peers observing this instance in the peer directory.
   */
  onPeerReplaced?: (info: {
    peerId: FederationInstanceId;
    duplicateInstanceIdSuspected: boolean;
  }) => void;
  onEnvelope?: (
    envelope: FederationProtocolEnvelope,
    connection: FederationGatewayConnection,
  ) => void;
};

export class FederationGatewayWebSocketServer {
  private httpServer?: http.Server;
  private wsServer?: WebSocketServer;
  private sweepTimer?: ReturnType<typeof setInterval>;
  private readonly sessions: FederationSessionRegistry;
  private stopping = false;
  private readonly connections = new Map<
    FederationInstanceId,
    FederationGatewayConnection
  >();

  /** Recent eviction timestamps per peer id, for duplicate-id detection. */
  private readonly replacementsByPeerId = new Map<FederationInstanceId, number[]>();

  constructor(private readonly options: FederationGatewayWebSocketServerOptions) {
    this.sessions = options.sessions ?? new FederationSessionRegistry();
  }

  async start(): Promise<{ url: string; port: number }> {
    if (this.httpServer) {
      const address = this.httpServer.address();
      const port = typeof address === "object" && address ? address.port : this.options.port;
      return { url: `ws://${this.options.host}:${port}`, port };
    }
    this.stopping = false;
    this.httpServer = http.createServer();
    this.wsServer = new WebSocketServer({
      server: this.httpServer,
      maxPayload: this.options.maxFrameBytes ?? FEDERATION_MAX_FRAME_BYTES,
    });
    this.wsServer.on("connection", (socket) => void this.handleSocket(socket));
    // Belt-and-suspenders behind the per-socket keepalive: sweep sessions
    // whose heartbeat (envelopes or pongs) stopped without the socket's
    // close event ever firing, so the registry can never wedge "active".
    const keepaliveIntervalMs =
      this.options.keepaliveIntervalMs ?? FEDERATION_KEEPALIVE_INTERVAL_MS;
    this.sweepTimer = setInterval(() => {
      const expired = this.sessions.expireStaleSessions({
        now: Date.now(),
        heartbeatTimeoutMs: keepaliveIntervalMs * 4,
      });
      for (const session of expired) {
        log.warn("federation session expired without heartbeat", {
          peerId: session.peerId,
          sessionId: session.sessionId,
        });
        const connection = [...this.connections.values()].find(
          (candidate) => candidate.sessionId === session.sessionId,
        );
        // The heartbeat already stopped, so the socket is presumed wedged:
        // terminate rather than queue a close frame it may never deliver.
        (connection?.terminate ?? connection?.close)?.();
      }
    }, keepaliveIntervalMs);
    this.sweepTimer.unref?.();

    await new Promise<void>((resolve, reject) => {
      const server = this.httpServer;
      if (!server) {
        reject(new Error("Federation HTTP server was not initialized"));
        return;
      }
      server.once("error", reject);
      server.listen(this.options.port, this.options.host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    const address = this.httpServer.address();
    const port = typeof address === "object" && address ? address.port : this.options.port;
    return {
      url: `ws://${this.options.host}:${port}`,
      port,
    };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    const wsServer = this.wsServer;
    const httpServer = this.httpServer;
    this.wsServer = undefined;
    this.httpServer = undefined;
    this.connections.clear();
    for (const client of wsServer?.clients ?? []) {
      client.close();
    }
    await new Promise<void>((resolve) => wsServer?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()) ?? resolve());
  }

  closePeer(peerId: FederationInstanceId): boolean {
    const connection = this.connections.get(peerId);
    if (!connection) return false;
    this.connections.delete(peerId);
    this.sessions.closePeerSessions({
      peerId,
      closedAt: Date.now(),
      reason: "revoked",
    });
    // Application close code so the revoked client can report "re-pair
    // needed" instead of a generic connection loss.
    connection.close(FEDERATION_CLOSE_REVOKED_CODE, "revoked");
    return true;
  }

  private async handleSocket(socket: WebSocket): Promise<void> {
    const reader = new FederationFrameReader(socket);

    // Armed for the socket's whole life, pre-auth included: a link that dies
    // silently is terminated after one missed pong instead of parking a
    // half-open connection forever.
    const keepalive = new FederationSocketKeepalive(socket, {
      intervalMs:
        this.options.keepaliveIntervalMs ?? FEDERATION_KEEPALIVE_INTERVAL_MS,
      onDead: () => {
        log.warn("federation peer failed keepalive; terminating socket");
        socket.terminate();
      },
    });
    // A live socket that upgrades and then never finishes auth would pass
    // keepalive forever (ws auto-pong needs no cooperation), so the auth
    // exchange gets its own deadline — the gateway-side mirror of the
    // client's FederationConnectDeadline.
    const authDeadline = setTimeout(() => {
      log.warn("federation auth deadline exceeded; terminating socket");
      socket.terminate();
    }, this.options.authTimeoutMs ?? FEDERATION_CONNECT_TIMEOUT_MS);
    authDeadline.unref?.();
    socket.once("close", () => clearTimeout(authDeadline));

    // Phase 1: Noise_IK handshake (responder). Skipped in tunnel mode.
    let transport: NoiseTransport | undefined;
    let channelBinding = "";
    if (this.options.noiseStatic) {
      sendFrame(socket, {
        kind: "transport.hello",
        transportVersion: FEDERATION_TRANSPORT_VERSION,
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        encryption: FEDERATION_NOISE_TRANSPORT,
      });
      try {
        const handshake = new NoiseIKHandshake({
          role: "responder",
          localStatic: this.options.noiseStatic,
        });
        handshake.readMessage1(await reader.next());
        socket.send(handshake.writeMessage2());
        transport = handshake.split();
        channelBinding = transport.handshakeHash.toString("base64");
      } catch {
        log.warn("federation Noise handshake rejected");
        socket.close();
        return;
      }
    }

    // Phase 2: signed identity auth, carried inside the encrypted channel.
    const challengeNonce = `challenge:${randomUUID()}`;
    const challengeMessage = buildFederationGatewayChallengeMessage({
      gatewayInstanceId: this.options.gatewayInstanceId,
      gatewayPublicKeyPem: this.options.gatewayPublicKeyPem,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      nonce: challengeNonce,
    });
    sendFrame(
      socket,
      {
        kind: "auth.challenge",
        gatewayInstanceId: this.options.gatewayInstanceId,
        gatewayPublicKeyPem: this.options.gatewayPublicKeyPem,
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        nonce: challengeNonce,
        signatureBase64: signFederationMessage({
          privateKeyPem: this.options.gatewayPrivateKeyPem,
          message: challengeMessage,
        }),
      },
      transport,
    );

    let authFrame: Buffer;
    try {
      authFrame = await reader.next();
    } catch {
      return;
    }
    let message: FederationSocketMessage | undefined;
    try {
      message = decodeFrame(authFrame, transport);
    } catch {
      closeAfterFrameAuthenticationFailure(socket);
      return;
    }
    if (!message || message.kind !== "auth") {
      this.options.store.appendAudit({
        kind: "rejected",
        createdAt: Date.now(),
        detail: "policy_denied",
      });
      sendFrame(
        socket,
        {
          kind: "auth.rejected",
          failure: federationFailure("policy_denied"),
        },
        transport,
      );
      socket.close();
      return;
    }
    this.options.store.appendAudit({
      peerId: isFederationInstanceId(message.peerInstanceId)
        ? message.peerInstanceId
        : undefined,
      kind: "connect_attempt",
      createdAt: Date.now(),
      detail: message.mode,
    });
    if (message.nonce !== challengeNonce) {
      this.options.store.appendAudit({
        peerId: isFederationInstanceId(message.peerInstanceId)
          ? message.peerInstanceId
          : undefined,
        kind: "rejected",
        createdAt: Date.now(),
        detail: "policy_denied",
      });
      sendFrame(
        socket,
        {
          kind: "auth.rejected",
          failure: federationFailure("policy_denied"),
        },
        transport,
      );
      socket.close();
      return;
    }
    const decision = this.authenticate(message, channelBinding);
    if (!decision.accepted) {
      this.options.store.appendAudit({
        peerId: isFederationInstanceId(message.peerInstanceId)
          ? message.peerInstanceId
          : undefined,
        kind: "rejected",
        createdAt: Date.now(),
        detail: decision.failure.code,
      });
      sendFrame(
        socket,
        { kind: "auth.rejected", failure: decision.failure },
        transport,
      );
      socket.close();
      return;
    }

    const sessionId = `federation-session:${randomUUID()}`;
    this.sessions.openSession({
      sessionId,
      peerId: decision.peer.id,
      connectedAt: Date.now(),
      capabilities: decision.capabilities,
    });
    const connection: FederationGatewayConnection = {
      peerId: decision.peer.id,
      sessionId,
      capabilities: decision.capabilities,
      sendEnvelope: (envelope) => {
        sendFrame(socket, { kind: "envelope", envelope }, transport);
      },
      close: (code?: number, reason?: string) => socket.close(code, reason),
      terminate: () => socket.terminate(),
    };
    const previous = this.connections.get(connection.peerId);
    if (previous && previous.sessionId !== connection.sessionId) {
      // Evictions were previously silent (bare close, no log, no audit),
      // which made a duplicate-identity kick loop invisible. Audit the
      // eviction BEFORE the new session's "connected" row so the trail
      // reads in causal order, and close with an application code the
      // client can distinguish from a network drop. Repeated evictions
      // inside the window are the cloned-profile signature — flag them.
      const now = Date.now();
      const replacements = [
        ...(this.replacementsByPeerId.get(connection.peerId) ?? []).filter(
          (at) => now - at < REPLACEMENT_FLAP_WINDOW_MS,
        ),
        now,
      ];
      this.replacementsByPeerId.set(connection.peerId, replacements);
      const duplicateSuspected =
        replacements.length >= REPLACEMENT_FLAP_THRESHOLD;
      this.options.store.appendAudit({
        peerId: connection.peerId,
        sessionId: previous.sessionId,
        kind: "disconnected",
        createdAt: now,
        detail: duplicateSuspected
          ? "replaced:duplicate_instance_id_suspected"
          : "replaced",
      });
      log.warn("federation peer session replaced", {
        peerId: connection.peerId,
        previousSessionId: previous.sessionId,
        sessionId,
        replacementsInWindow: replacements.length,
        duplicateInstanceIdSuspected: duplicateSuspected,
      });
      previous.close(
        FEDERATION_CLOSE_REPLACED_CODE,
        duplicateSuspected
          ? "replaced_by_new_session duplicate_instance_id_suspected"
          : "replaced_by_new_session",
      );
      this.options.onPeerReplaced?.({
        peerId: connection.peerId,
        duplicateInstanceIdSuspected: duplicateSuspected,
      });
    }
    this.connections.set(connection.peerId, connection);
    this.options.store.appendAudit({
      peerId: connection.peerId,
      sessionId,
      kind: "connected",
      createdAt: Date.now(),
      detail: message.mode,
    });
    sendFrame(
      socket,
      {
        kind: "auth.accepted",
        gatewayInstanceId: this.options.gatewayInstanceId,
        sessionId,
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        nonce: challengeNonce,
        capabilities: decision.capabilities,
        signatureBase64: signFederationMessage({
          privateKeyPem: this.options.gatewayPrivateKeyPem,
          message: buildFederationGatewayAcceptedMessage({
            gatewayInstanceId: this.options.gatewayInstanceId,
            peerInstanceId: decision.peer.id,
            sessionId,
            protocolVersion: FEDERATION_PROTOCOL_VERSION,
            nonce: challengeNonce,
            capabilities: decision.capabilities,
          }),
        }),
      },
      transport,
    );
    clearTimeout(authDeadline);
    // Pongs count as session liveness alongside envelopes, so an idle but
    // healthy peer never trips the stale-session sweep.
    keepalive.onLive = () => {
      this.sessions.heartbeat(sessionId, Date.now());
    };
    this.options.onConnection?.(connection);
    socket.once("close", () => {
      this.sessions.closeSession({
        sessionId,
        closedAt: Date.now(),
        reason: "transport_closed",
      });
      // A replaced session no longer owns the peer entry; its eviction
      // was already audited on the replace path — don't add a second,
      // later "disconnected" row for the same session.
      const stillOwner =
        this.connections.get(connection.peerId)?.sessionId === sessionId;
      if (stillOwner) {
        this.connections.delete(connection.peerId);
      }
      if (!this.stopping && stillOwner) {
        this.options.store.appendAudit({
          peerId: connection.peerId,
          sessionId,
          kind: "disconnected",
          createdAt: Date.now(),
          detail: "transport_closed",
        });
      }
      this.options.onDisconnect?.(connection);
    });

    // Phase 3: stream envelopes.
    for (;;) {
      let frame: Buffer;
      try {
        frame = await reader.next();
      } catch {
        return;
      }
      let next: FederationSocketMessage | undefined;
      try {
        next = decodeFrame(frame, transport);
      } catch {
        closeAfterFrameAuthenticationFailure(socket);
        return;
      }
      if (!next || next.kind !== "envelope") continue;
      this.sessions.heartbeat(sessionId, Date.now());
      this.options.onEnvelope?.(next.envelope, connection);
    }
  }

  private authenticate(message: FederationSocketAuthMessage, channelBinding: string) {
    if (message.gatewayInstanceId !== this.options.gatewayInstanceId) {
      return {
        accepted: false as const,
        failure: federationFailure("wrong_gateway"),
      };
    }
    if (message.mode === "enroll") {
      if (!message.inviteToken || !message.publicKeyPem || !message.role) {
        return {
          accepted: false as const,
          failure: federationFailure("missing_invite"),
        };
      }
      return completeFederationEnrollment({
        store: this.options.store,
        gatewayInstanceId: this.options.gatewayInstanceId,
        inviteToken: message.inviteToken,
        now: Date.now(),
        channelBinding,
        peer: {
          instanceId: message.peerInstanceId,
          label: message.label ?? message.peerInstanceId,
          role: message.role,
          publicKeyPem: message.publicKeyPem,
          capabilities: message.capabilities,
          protocolVersion: message.protocolVersion,
          nonce: message.nonce,
          signatureBase64: message.signatureBase64,
          endpoint: message.endpoint,
          profileName: message.profileName,
        },
      });
    }
    return authenticateFederationReconnect({
      store: this.options.store,
      gatewayInstanceId: this.options.gatewayInstanceId,
      peerInstanceId: message.peerInstanceId,
      protocolVersion: message.protocolVersion,
      nonce: message.nonce,
      requestedCapabilities: message.capabilities,
      signatureBase64: message.signatureBase64,
      channelBinding,
      now: Date.now(),
      label: message.label,
      profileName: message.profileName,
    });
  }
}

export type FederationClientWebSocketClient = {
  sessionId: FederationSessionId;
  capabilities: FederationCapability[];
  sendEnvelope: (envelope: FederationProtocolEnvelope) => void;
  close: () => void;
};

export async function connectFederationClient(params: {
  url: string;
  mode: "enroll" | "reconnect";
  gatewayInstanceId: FederationInstanceId;
  gatewayPublicKeyPem: string;
  peerInstanceId: FederationInstanceId;
  privateKeyPem: string;
  publicKeyPem: string;
  capabilities: readonly FederationCapability[];
  inviteToken?: string;
  label?: string;
  role?: FederationInstanceRole;
  endpoint?: string;
  profileName?: string;
  headers?: Record<string, string>;
  clientCertificate?: string;
  clientPrivateKey?: string;
  /**
   * Custom outer-transport socket factory (e.g. an SSH stdio forward). When
   * set, the WebSocket upgrade runs over the returned stream instead of a
   * direct TCP/TLS connection; `url` still names the inner listener so the
   * upgrade Host header matches. Everything inside — Noise handshake,
   * channel-bound auth, envelopes — is unchanged.
   */
  createSocket?: () => Duplex;
  /**
   * Deadline for the whole pre-session exchange: TCP/TLS connect, WebSocket
   * upgrade, transport hello, Noise handshake, and identity auth. Without it a
   * peer that accepts the upgrade and then goes silent parks this promise
   * forever, which stalls the caller's endpoint walk and reconnect loop.
   */
  connectTimeoutMs?: number;
  /** Ping cadence; a gateway missing one interval's pong is terminated. */
  keepaliveIntervalMs?: number;
  /** Per-frame receive ceiling (ws maxPayload). */
  maxFrameBytes?: number;
  /** Client's Noise static keypair. Enables encryption (initiator role). */
  noiseStatic?: NoiseKeyPair;
  /** Pinned gateway Noise static public key (raw 32 bytes), from the invite. */
  gatewayNoisePublicKey?: Buffer;
  onEnvelope?: (envelope: FederationProtocolEnvelope) => void;
  /**
   * Called once when the transport ends. `info` carries the WebSocket
   * close code/reason when the peer closed cleanly (e.g. 4001
   * "replaced_by_new_session"); undefined for socket errors.
   */
  onClose?: (info?: { code: number; reason: string }) => void;
}): Promise<FederationClientWebSocketClient> {
  const connectTimeoutMs =
    params.connectTimeoutMs ?? FEDERATION_CONNECT_TIMEOUT_MS;
  const maxPayload = params.maxFrameBytes ?? FEDERATION_MAX_FRAME_BYTES;
  const socket = new WebSocket(
    params.url,
    params.createSocket
      ? {
          headers: params.headers,
          handshakeTimeout: connectTimeoutMs,
          maxPayload,
          agent: outerSocketAgent(params.createSocket),
        }
      : {
          headers: params.headers,
          handshakeTimeout: connectTimeoutMs,
          maxPayload,
          cert: params.clientCertificate,
          key: params.clientPrivateKey,
        },
  );
  // Attach the reader before "open" so no inbound frame can be missed.
  const reader = new FederationFrameReader(socket);
  // `handshakeTimeout` only covers the upgrade. This deadline also covers the
  // frames after it, so a peer that upgrades and then stays silent still fails.
  const connectDeadline = new FederationConnectDeadline(socket, connectTimeoutMs);
  try {
    return await establishFederationClient(params, socket, reader);
  } finally {
    connectDeadline.clear();
  }
}

const FEDERATION_CONNECT_TIMEOUT_MS = 20_000;

// Closes the socket if the pre-session exchange has not finished in time. The
// close makes every pending `reader.next()` reject, so the caller's await
// chain unwinds instead of parking forever.
class FederationConnectDeadline {
  private timer?: ReturnType<typeof setTimeout>;

  constructor(socket: WebSocket, timeoutMs: number) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      log.warn("federation connect deadline exceeded", { timeoutMs });
      socket.close(1002, "Federation connect timeout");
      socket.terminate();
    }, timeoutMs);
    this.timer.unref?.();
  }

  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}

async function establishFederationClient(
  params: Parameters<typeof connectFederationClient>[0],
  socket: WebSocket,
  reader: FederationFrameReader,
): Promise<FederationClientWebSocketClient> {
  await waitForOpen(socket);

  // Phase 1: Noise_IK handshake (initiator). Skipped in tunnel mode.
  let transport: NoiseTransport | undefined;
  let channelBinding = "";
  if (params.noiseStatic) {
    if (!params.gatewayNoisePublicKey) {
      socket.close();
      throw new Error("Missing pinned gateway Noise key for encrypted federation");
    }
    const hello = decodeFrame(await reader.next());
    if (
      !hello
      || hello.kind !== "transport.hello"
      || hello.transportVersion !== FEDERATION_TRANSPORT_VERSION
      || hello.protocolVersion !== FEDERATION_PROTOCOL_VERSION
      || hello.encryption !== FEDERATION_NOISE_TRANSPORT
    ) {
      socket.close(1002, "Unsupported federation transport");
      throw new Error(
        `Federation gateway does not support required Noise transport version ${FEDERATION_TRANSPORT_VERSION}.`,
      );
    }
    try {
      const handshake = new NoiseIKHandshake({
        role: "initiator",
        localStatic: params.noiseStatic,
        remoteStaticPublicKey: params.gatewayNoisePublicKey,
      });
      socket.send(handshake.writeMessage1());
      handshake.readMessage2(await reader.next());
      transport = handshake.split();
      channelBinding = transport.handshakeHash.toString("base64");
    } catch (error) {
      socket.close();
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  // Phase 2: identity auth.
  let challenge: FederationSocketMessage | undefined;
  try {
    challenge = decodeFrame(await reader.next(), transport);
  } catch (error) {
    closeAfterFrameAuthenticationFailure(socket);
    throw error;
  }
  if (challenge?.kind === "auth.rejected") {
    socket.close();
    throw new Error(challenge.failure.code);
  }
  if (
    !challenge ||
    challenge.kind !== "auth.challenge" ||
    challenge.gatewayInstanceId !== params.gatewayInstanceId ||
    challenge.gatewayPublicKeyPem !== params.gatewayPublicKeyPem ||
    challenge.protocolVersion !== FEDERATION_PROTOCOL_VERSION
  ) {
    socket.close();
    throw new Error("Invalid federation auth challenge");
  }
  const challengeSignatureValid = verifyFederationMessageSignature({
    publicKeyPem: params.gatewayPublicKeyPem,
    message: buildFederationGatewayChallengeMessage({
      gatewayInstanceId: challenge.gatewayInstanceId,
      gatewayPublicKeyPem: challenge.gatewayPublicKeyPem,
      protocolVersion: challenge.protocolVersion,
      nonce: challenge.nonce,
    }),
    signatureBase64: challenge.signatureBase64,
  });
  if (!challengeSignatureValid) {
    socket.close();
    throw new Error("Invalid federation auth challenge signature");
  }
  const messageToSign = buildFederationProofMessage({
    purpose: params.mode === "enroll" ? "enroll" : "reconnect",
    gatewayInstanceId: params.gatewayInstanceId,
    peerInstanceId: params.peerInstanceId,
    publicKeyPem: params.publicKeyPem,
    protocolVersion: FEDERATION_PROTOCOL_VERSION,
    nonce: challenge.nonce,
    capabilities: params.capabilities,
    channelBinding,
  });
  const authMessage: FederationSocketAuthMessage = {
    kind: "auth",
    mode: params.mode,
    gatewayInstanceId: params.gatewayInstanceId,
    peerInstanceId: params.peerInstanceId,
    protocolVersion: FEDERATION_PROTOCOL_VERSION,
    nonce: challenge.nonce,
    capabilities: params.capabilities.slice(),
    signatureBase64: signFederationMessage({
      privateKeyPem: params.privateKeyPem,
      message: messageToSign,
    }),
    inviteToken: params.inviteToken,
    publicKeyPem: params.mode === "enroll" ? params.publicKeyPem : undefined,
    label: params.label,
    role: params.role,
    endpoint: params.endpoint,
    profileName: params.profileName,
  };
  sendFrame(socket, authMessage, transport);

  let accepted: FederationSocketMessage | undefined;
  try {
    accepted = decodeFrame(await reader.next(), transport);
  } catch (error) {
    closeAfterFrameAuthenticationFailure(socket);
    throw error;
  }
  if (accepted?.kind === "auth.rejected") {
    socket.close();
    throw new Error(accepted.failure.code);
  }
  if (!accepted || accepted.kind !== "auth.accepted") {
    socket.close();
    throw new Error("Unexpected federation auth response");
  }
  const acceptedSignatureValid =
    accepted.gatewayInstanceId === params.gatewayInstanceId &&
    accepted.nonce === challenge.nonce &&
    accepted.protocolVersion === FEDERATION_PROTOCOL_VERSION &&
    verifyFederationMessageSignature({
      publicKeyPem: params.gatewayPublicKeyPem,
      message: buildFederationGatewayAcceptedMessage({
        gatewayInstanceId: accepted.gatewayInstanceId,
        peerInstanceId: params.peerInstanceId,
        sessionId: accepted.sessionId,
        protocolVersion: accepted.protocolVersion,
        nonce: accepted.nonce,
        capabilities: accepted.capabilities,
      }),
      signatureBase64: accepted.signatureBase64,
    });
  if (!acceptedSignatureValid) {
    socket.close();
    throw new Error("Invalid federation auth acceptance signature");
  }
  // Carry the close code/reason to the runtime — dropping them made a
  // deliberate "replaced_by_new_session" eviction indistinguishable
  // from a network blip in every log and health surface. (An error is
  // usually followed by a close; the ended flag keeps onClose single-
  // fire, with the error path reporting no close info.)
  let transportEnded = false;
  const onSocketClose = (code: number, reason: Buffer) => {
    notifyTransportEnded({ code, reason: reason.toString("utf8") });
  };
  const onSocketError = () => notifyTransportEnded();
  function notifyTransportEnded(info?: { code: number; reason: string }): void {
    if (transportEnded) return;
    transportEnded = true;
    socket.off("close", onSocketClose);
    socket.off("error", onSocketError);
    params.onClose?.(info);
  }
  socket.once("close", onSocketClose);
  socket.once("error", onSocketError);

  // Client-side liveness probes (the ssh ServerAliveInterval direction):
  // a gateway whose link died silently is terminated, which fires onClose
  // and hands control to the caller's reconnect loop.
  new FederationSocketKeepalive(socket, {
    intervalMs: params.keepaliveIntervalMs ?? FEDERATION_KEEPALIVE_INTERVAL_MS,
    onDead: () => {
      log.warn("federation gateway failed keepalive; terminating socket");
      socket.terminate();
    },
  });

  // Phase 3: stream envelopes.
  void (async () => {
    for (;;) {
      let frame: Buffer;
      try {
        frame = await reader.next();
      } catch {
        return;
      }
      let message: FederationSocketMessage | undefined;
      try {
        message = decodeFrame(frame, transport);
      } catch {
        closeAfterFrameAuthenticationFailure(socket);
        return;
      }
      if (message?.kind === "envelope") {
        params.onEnvelope?.(message.envelope);
      }
    }
  })();

  return {
    sessionId: accepted.sessionId,
    // The signature above covered the raw list; narrow to capabilities
    // THIS build understands only after it verified, so a newer gateway
    // granting a capability we predate is ignored, not fatal.
    capabilities: knownCapabilities(accepted.capabilities),
    sendEnvelope: (envelope) => {
      sendFrame(socket, { kind: "envelope", envelope }, transport);
    },
    close: () => socket.close(),
  };
}

// A race-free, ordered reader over a WebSocket's discrete messages. Attaching
// it before any await guarantees no frame is dropped between socket events and
// the next read — important because the Noise handshake and auth exchange must
// consume frames in a strict order.
class FederationFrameReader {
  private readonly queue: Buffer[] = [];
  private pending?: { resolve: (frame: Buffer) => void; reject: (error: Error) => void };
  private failure?: Error;

  constructor(socket: WebSocket) {
    socket.on("message", (raw) => this.push(rawDataToBuffer(raw)));
    socket.once("close", () => this.fail(new Error("Federation socket closed")));
    socket.once("error", (error) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    );
  }

  private push(frame: Buffer): void {
    if (this.pending) {
      const { resolve } = this.pending;
      this.pending = undefined;
      resolve(frame);
      return;
    }
    this.queue.push(frame);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    if (this.pending) {
      const { reject } = this.pending;
      this.pending = undefined;
      reject(error);
    }
  }

  next(): Promise<Buffer> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
  }
}

// One-shot http.Agent that hands the WebSocket upgrade an externally created
// stream (e.g. an SSH stdio forward) instead of dialing TCP itself.
function outerSocketAgent(createSocket: () => Duplex): http.Agent {
  const agent = new http.Agent({ keepAlive: false });
  (
    agent as http.Agent & { createConnection: () => Duplex }
  ).createConnection = () => createSocket();
  return agent;
}

function rawDataToBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw as ArrayBuffer);
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState === WebSocket.OPEN) {
      resolve();
      return;
    }
    const cleanup = () => {
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}

function sendFrame(
  socket: WebSocket,
  message: FederationSocketMessage,
  transport?: NoiseTransport,
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  const json = Buffer.from(JSON.stringify(message), "utf8");
  socket.send(transport ? transport.encrypt(json) : json);
}

function closeAfterFrameAuthenticationFailure(socket: WebSocket): void {
  log.warn("encrypted federation frame authentication failed; closing session");
  socket.close(1008, "Encrypted federation frame authentication failed");
}

function decodeFrame(
  frame: Buffer,
  transport?: NoiseTransport,
): FederationSocketMessage | undefined {
  let json = frame;
  if (transport) {
    try {
      json = transport.decrypt(frame);
    } catch {
      throw new FederationFrameAuthenticationError();
    }
  }
  try {
    const parsed = JSON.parse(json.toString("utf8")) as Partial<FederationSocketMessage>;
    if (
      parsed.kind === "transport.hello"
      && isTransportHelloMessage(parsed)
    ) {
      return parsed;
    }
    if (parsed.kind === "auth" && isAuthMessage(parsed)) return parsed;
    if (parsed.kind === "auth.challenge" && isChallengeMessage(parsed)) return parsed;
    if (parsed.kind === "auth.accepted" && isAcceptedMessage(parsed)) return parsed;
    if (parsed.kind === "auth.rejected" && parsed.failure) {
      return parsed as FederationSocketRejectedMessage;
    }
    if (parsed.kind === "envelope" && parsed.envelope) {
      return parsed as FederationSocketEnvelopeMessage;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

class FederationFrameAuthenticationError extends Error {
  constructor() {
    super("Encrypted federation frame authentication failed");
    this.name = "FederationFrameAuthenticationError";
  }
}

function isTransportHelloMessage(
  value: Partial<FederationSocketTransportHelloMessage>,
): value is FederationSocketTransportHelloMessage {
  return (
    value.kind === "transport.hello"
    && typeof value.transportVersion === "number"
    && typeof value.protocolVersion === "number"
    && value.encryption === FEDERATION_NOISE_TRANSPORT
  );
}

/**
 * Forward-compatibility seam: a newer build may advertise capability
 * names this build has never heard of. Those must not read as a
 * malformed frame — rejecting the auth exchange over an unknown name
 * would make every future capability addition a breaking protocol
 * change. Frames validate structurally (a list of strings) and carry
 * the RAW list through signature verification (both proofs sign the
 * list as transmitted); consumers narrow to known capabilities with
 * `knownCapabilities` only after signatures check out.
 */
function isCapabilityNameList(value: unknown): value is string[] {
  return (
    Array.isArray(value)
    && value.every((entry) => typeof entry === "string")
  );
}

function knownCapabilities(
  value: readonly string[],
): FederationCapability[] {
  return filterKnownFederationCapabilities(value);
}

function isAuthMessage(value: Partial<FederationSocketAuthMessage>): value is FederationSocketAuthMessage {
  return (
    value.kind === "auth" &&
    (value.mode === "enroll" || value.mode === "reconnect") &&
    typeof value.gatewayInstanceId === "string" &&
    typeof value.peerInstanceId === "string" &&
    typeof value.protocolVersion === "number" &&
    typeof value.nonce === "string" &&
    typeof value.signatureBase64 === "string" &&
    isCapabilityNameList(value.capabilities)
  );
}

function isChallengeMessage(
  value: Partial<FederationSocketChallengeMessage>,
): value is FederationSocketChallengeMessage {
  return (
    value.kind === "auth.challenge" &&
    typeof value.gatewayInstanceId === "string" &&
    typeof value.gatewayPublicKeyPem === "string" &&
    typeof value.protocolVersion === "number" &&
    typeof value.nonce === "string" &&
    typeof value.signatureBase64 === "string"
  );
}

function isAcceptedMessage(
  value: Partial<FederationSocketAcceptedMessage>,
): value is FederationSocketAcceptedMessage {
  return (
    value.kind === "auth.accepted" &&
    typeof value.gatewayInstanceId === "string" &&
    typeof value.sessionId === "string" &&
    typeof value.protocolVersion === "number" &&
    typeof value.nonce === "string" &&
    typeof value.signatureBase64 === "string" &&
    isCapabilityNameList(value.capabilities)
  );
}
