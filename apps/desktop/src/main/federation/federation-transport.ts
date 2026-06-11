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
import {
  FEDERATION_PROTOCOL_VERSION,
  isFederationCapability,
} from "@pwragent/shared";
import {
  authenticateFederationReconnect,
  buildFederationProofMessage,
  completeFederationEnrollment,
} from "./federation-enrollment";
import { signFederationMessage } from "./federation-identity";
import {
  federationFailure,
  type FederationRedactedFailure,
} from "./federation-redaction";
import { FederationSessionRegistry } from "./federation-session-state";
import type { FederationStore } from "./federation-store";

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
  protocolVersion: number;
  nonce: string;
};

type FederationSocketAcceptedMessage = {
  kind: "auth.accepted";
  sessionId: FederationSessionId;
  protocolVersion: number;
  capabilities: FederationCapability[];
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
  host: string;
  port: number;
  store: FederationStore;
  sessions?: FederationSessionRegistry;
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

  constructor(private readonly options: FederationGatewayWebSocketServerOptions) {
    this.sessions = options.sessions ?? new FederationSessionRegistry();
  }

  async start(): Promise<{ url: string; port: number }> {
    if (this.httpServer) {
      const address = this.httpServer.address();
      const port = typeof address === "object" && address ? address.port : this.options.port;
      return { url: `ws://${this.options.host}:${port}`, port };
    }
    this.httpServer = http.createServer();
    this.wsServer = new WebSocketServer({ server: this.httpServer });
    this.wsServer.on("connection", (socket) => this.handleSocket(socket));

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
    const wsServer = this.wsServer;
    const httpServer = this.httpServer;
    this.wsServer = undefined;
    this.httpServer = undefined;
    for (const client of wsServer?.clients ?? []) {
      client.close();
    }
    await new Promise<void>((resolve) => wsServer?.close(() => resolve()) ?? resolve());
    await new Promise<void>((resolve) => httpServer?.close(() => resolve()) ?? resolve());
  }

  private handleSocket(socket: WebSocket): void {
    let connection: FederationGatewayConnection | undefined;
    const challengeNonce = `challenge:${randomUUID()}`;
    sendSocketMessage(socket, {
      kind: "auth.challenge",
      gatewayInstanceId: this.options.gatewayInstanceId,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      nonce: challengeNonce,
    });
    socket.once("message", (raw) => {
      const message = parseSocketMessage(raw);
      if (!message || message.kind !== "auth") {
        sendSocketMessage(socket, {
          kind: "auth.rejected",
          failure: federationFailure("policy_denied"),
        });
        socket.close();
        return;
      }
      if (message.nonce !== challengeNonce) {
        sendSocketMessage(socket, {
          kind: "auth.rejected",
          failure: federationFailure("policy_denied"),
        });
        socket.close();
        return;
      }
      const decision = this.authenticate(message);
      if (!decision.accepted) {
        sendSocketMessage(socket, {
          kind: "auth.rejected",
          failure: decision.failure,
        });
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
      connection = {
        peerId: decision.peer.id,
        sessionId,
        capabilities: decision.capabilities,
        sendEnvelope: (envelope) => {
          sendSocketMessage(socket, { kind: "envelope", envelope });
        },
        close: () => socket.close(),
      };
      sendSocketMessage(socket, {
        kind: "auth.accepted",
        sessionId,
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        capabilities: decision.capabilities,
      });
      this.options.onConnection?.(connection);

      socket.on("message", (nextRaw) => {
        const next = parseSocketMessage(nextRaw);
        if (!next || next.kind !== "envelope" || !connection) return;
        this.sessions.heartbeat(sessionId, Date.now());
        this.options.onEnvelope?.(next.envelope, connection);
      });
      socket.once("close", () => {
        this.sessions.closeSession({
          sessionId,
          closedAt: Date.now(),
          reason: "transport_closed",
        });
        if (connection) {
          this.options.onDisconnect?.(connection);
        }
      });
    });
  }

  private authenticate(message: FederationSocketAuthMessage) {
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
  onEnvelope?: (envelope: FederationProtocolEnvelope) => void;
}): Promise<FederationClientWebSocketClient> {
  const socket = new WebSocket(params.url, {
    headers: params.headers,
  });
  const [challenge] = await Promise.all([
    waitForAuthChallenge(socket),
    waitForOpen(socket),
  ]);
  if (
    challenge.gatewayInstanceId !== params.gatewayInstanceId ||
    challenge.protocolVersion !== FEDERATION_PROTOCOL_VERSION
  ) {
    socket.close();
    throw new Error("Invalid federation auth challenge");
  }
  const messageToSign = buildFederationProofMessage({
    purpose: params.mode === "enroll" ? "enroll" : "reconnect",
    gatewayInstanceId: params.gatewayInstanceId,
    peerInstanceId: params.peerInstanceId,
    publicKeyPem: params.publicKeyPem,
    protocolVersion: FEDERATION_PROTOCOL_VERSION,
    nonce: challenge.nonce,
    capabilities: params.capabilities,
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

  sendSocketMessage(socket, authMessage);
  const accepted = await waitForAuthResult(socket);
  socket.on("message", (raw) => {
    const message = parseSocketMessage(raw);
    if (message?.kind === "envelope") {
      params.onEnvelope?.(message.envelope);
    }
  });
  return {
    sessionId: accepted.sessionId,
    capabilities: accepted.capabilities,
    sendEnvelope: (envelope) => {
      sendSocketMessage(socket, { kind: "envelope", envelope });
    },
    close: () => socket.close(),
  };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function waitForAuthChallenge(socket: WebSocket): Promise<FederationSocketChallengeMessage> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => {
      const message = parseSocketMessage(raw);
      if (message?.kind === "auth.challenge") {
        resolve(message);
        return;
      }
      if (message?.kind === "auth.rejected") {
        reject(new Error(message.failure.code));
        return;
      }
      reject(new Error("Unexpected federation auth challenge"));
    });
    socket.once("error", reject);
  });
}

function waitForAuthResult(socket: WebSocket): Promise<FederationSocketAcceptedMessage> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => {
      const message = parseSocketMessage(raw);
      if (message?.kind === "auth.accepted") {
        resolve(message);
        return;
      }
      if (message?.kind === "auth.rejected") {
        reject(new Error(message.failure.code));
        return;
      }
      reject(new Error("Unexpected federation auth response"));
    });
    socket.once("error", reject);
  });
}

function sendSocketMessage(socket: WebSocket, message: FederationSocketMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function parseSocketMessage(raw: WebSocket.RawData): FederationSocketMessage | undefined {
  try {
    const parsed = JSON.parse(raw.toString()) as Partial<FederationSocketMessage>;
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
    typeof value.protocolVersion === "number" &&
    typeof value.nonce === "string"
  );
}

function isAcceptedMessage(
  value: Partial<FederationSocketAcceptedMessage>,
): value is FederationSocketAcceptedMessage {
  return (
    value.kind === "auth.accepted" &&
    typeof value.sessionId === "string" &&
    typeof value.protocolVersion === "number" &&
    Array.isArray(value.capabilities) &&
    value.capabilities.every(isFederationCapability)
  );
}
