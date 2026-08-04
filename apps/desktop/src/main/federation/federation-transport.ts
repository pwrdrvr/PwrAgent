import http from "node:http";
import { randomUUID } from "node:crypto";
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
  isFederationCapability,
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
  close: () => void;
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
  onConnection?: (connection: FederationGatewayConnection) => void;
  onDisconnect?: (connection: FederationGatewayConnection) => void;
  onEnvelope?: (
    envelope: FederationProtocolEnvelope,
    connection: FederationGatewayConnection,
  ) => void;
};

export class FederationGatewayWebSocketServer {
  private httpServer?: http.Server;
  private wsServer?: WebSocketServer;
  private readonly sessions: FederationSessionRegistry;
  private stopping = false;
  private readonly connections = new Map<
    FederationInstanceId,
    FederationGatewayConnection
  >();

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
    this.wsServer = new WebSocketServer({ server: this.httpServer });
    this.wsServer.on("connection", (socket) => void this.handleSocket(socket));

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
    connection.close();
    return true;
  }

  private async handleSocket(socket: WebSocket): Promise<void> {
    const reader = new FederationFrameReader(socket);

    // Phase 1: Noise_IK handshake (responder). Skipped in tunnel mode.
    let transport: NoiseTransport | undefined;
    let channelBinding = "";
    if (this.options.noiseStatic) {
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
    const message = decodeFrame(authFrame, transport);
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
      close: () => socket.close(),
    };
    const previous = this.connections.get(connection.peerId);
    if (previous && previous.sessionId !== connection.sessionId) {
      previous.close();
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
    this.options.onConnection?.(connection);
    socket.once("close", () => {
      this.sessions.closeSession({
        sessionId,
        closedAt: Date.now(),
        reason: "transport_closed",
      });
      if (this.connections.get(connection.peerId)?.sessionId === sessionId) {
        this.connections.delete(connection.peerId);
      }
      if (!this.stopping) {
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
      const next = decodeFrame(frame, transport);
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
  /** Client's Noise static keypair. Enables encryption (initiator role). */
  noiseStatic?: NoiseKeyPair;
  /** Pinned gateway Noise static public key (raw 32 bytes), from the invite. */
  gatewayNoisePublicKey?: Buffer;
  onEnvelope?: (envelope: FederationProtocolEnvelope) => void;
  onClose?: () => void;
}): Promise<FederationClientWebSocketClient> {
  const socket = new WebSocket(params.url, {
    headers: params.headers,
    cert: params.clientCertificate,
    key: params.clientPrivateKey,
  });
  // Attach the reader before "open" so no inbound frame can be missed.
  const reader = new FederationFrameReader(socket);
  await waitForOpen(socket);

  // Phase 1: Noise_IK handshake (initiator). Skipped in tunnel mode.
  let transport: NoiseTransport | undefined;
  let channelBinding = "";
  if (params.noiseStatic) {
    if (!params.gatewayNoisePublicKey) {
      socket.close();
      throw new Error("Missing pinned gateway Noise key for encrypted federation");
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
  const challenge = decodeFrame(await reader.next(), transport);
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

  const accepted = decodeFrame(await reader.next(), transport);
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
  let transportEnded = false;
  const notifyTransportEnded = () => {
    if (transportEnded) return;
    transportEnded = true;
    socket.off("close", notifyTransportEnded);
    socket.off("error", notifyTransportEnded);
    params.onClose?.();
  };
  socket.once("close", notifyTransportEnded);
  socket.once("error", notifyTransportEnded);

  // Phase 3: stream envelopes.
  void (async () => {
    for (;;) {
      let frame: Buffer;
      try {
        frame = await reader.next();
      } catch {
        return;
      }
      const message = decodeFrame(frame, transport);
      if (message?.kind === "envelope") {
        params.onEnvelope?.(message.envelope);
      }
    }
  })();

  return {
    sessionId: accepted.sessionId,
    capabilities: accepted.capabilities,
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

function decodeFrame(
  frame: Buffer,
  transport?: NoiseTransport,
): FederationSocketMessage | undefined {
  try {
    const json = transport ? transport.decrypt(frame) : frame;
    const parsed = JSON.parse(json.toString("utf8")) as Partial<FederationSocketMessage>;
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

function isAuthMessage(value: Partial<FederationSocketAuthMessage>): value is FederationSocketAuthMessage {
  return (
    value.kind === "auth" &&
    (value.mode === "enroll" || value.mode === "reconnect") &&
    typeof value.gatewayInstanceId === "string" &&
    typeof value.peerInstanceId === "string" &&
    typeof value.protocolVersion === "number" &&
    typeof value.nonce === "string" &&
    typeof value.signatureBase64 === "string" &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every(isFederationCapability)
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
    Array.isArray(value.capabilities) &&
    value.capabilities.every(isFederationCapability)
  );
}
