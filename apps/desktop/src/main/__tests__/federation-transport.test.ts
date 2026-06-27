import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FederationProtocolEnvelope } from "@pwragent/shared";
import {
  buildFederationGatewayAcceptedMessage,
  buildFederationGatewayChallengeMessage,
  buildFederationProofMessage,
  createFederationEnrollmentInvite,
} from "../federation/federation-enrollment";
import {
  generateFederationIdentityKeyPair,
  signFederationMessage,
} from "../federation/federation-identity";
import { generateNoiseStaticKeyPair } from "../federation/federation-noise";
import { FederationStore } from "../federation/federation-store";
import {
  connectFederationClient,
  FederationGatewayWebSocketServer,
} from "../federation/federation-transport";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let store: FederationStore;
let tempDir: string;
let server: FederationGatewayWebSocketServer | undefined;
let rawServer: WebSocketServer | undefined;
let gatewayKeyPair: ReturnType<typeof generateFederationIdentityKeyPair>;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-federation-transport-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new FederationStore(stateDb);
  gatewayKeyPair = generateFederationIdentityKeyPair();
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  for (const client of rawServer?.clients ?? []) {
    client.terminate();
  }
  await new Promise<void>((resolve) => rawServer?.close(() => resolve()) ?? resolve());
  rawServer = undefined;
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("federation transport", () => {
  it("authenticates a client and carries protocol envelopes", async () => {
    const clientKeyPair = generateFederationIdentityKeyPair();
    let closeCount = 0;
    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-transport",
      gatewayInstanceId: "gateway_one",
      generatedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    const received = new Promise<FederationProtocolEnvelope>((resolve) => {
      server = new FederationGatewayWebSocketServer({
        gatewayInstanceId: "gateway_one",
        gatewayPrivateKeyPem: gatewayKeyPair.privateKeyPem,
        gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
        host: "127.0.0.1",
        port: 0,
        store,
        onEnvelope: (envelope, connection) => {
          connection.sendEnvelope({
            id: "response-1",
            kind: "response",
            requestId: envelope.id,
            protocolVersion: 1,
            sourceInstanceId: "gateway_one",
            targetInstanceId: connection.peerId,
            createdAt: 2_000,
            result: { ok: true },
          });
          resolve(envelope);
        },
      });
    });
    const { url } = await server!.start();

    const reply = new Promise<FederationProtocolEnvelope>((resolve) => {
      void connectFederationClient({
        url,
        mode: "enroll",
        gatewayInstanceId: "gateway_one",
        gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
        peerInstanceId: "client_one",
        privateKeyPem: clientKeyPair.privateKeyPem,
        publicKeyPem: clientKeyPair.publicKeyPem,
        capabilities: ["remote_window"],
        inviteToken: invite.token,
        label: "Client",
        role: "client",
        onEnvelope: resolve,
        onClose: () => {
          closeCount += 1;
          resolveClosed?.();
        },
      }).then((client) => {
        client.sendEnvelope({
          id: "request-1",
          kind: "request",
          method: "thread.list",
          params: {},
          protocolVersion: 1,
          sourceInstanceId: "client_one",
          targetInstanceId: "gateway_one",
          createdAt: 1_000,
        });
      });
    });

    await expect(received).resolves.toMatchObject({
      id: "request-1",
      kind: "request",
      sourceInstanceId: "client_one",
    });
    await expect(reply).resolves.toMatchObject({
      kind: "response",
      requestId: "request-1",
      result: { ok: true },
    });
    expect(store.getPeer("client_one")).toMatchObject({
      status: "connected",
      pinnedPublicKeyPem: clientKeyPair.publicKeyPem,
    });
    expect(store.listAudit({ peerId: "client_one" })).toMatchObject([
      {
        kind: "connected",
        detail: "enroll",
      },
      {
        kind: "connect_attempt",
        detail: "enroll",
      },
    ]);
    expect(server?.closePeer("client_one")).toBe(true);
    await closed;
    expect(closeCount).toBe(1);
    expect(server?.closePeer("client_one")).toBe(false);
  });

  it("rejects websocket clients that cannot prove an enrolled identity", async () => {
    const clientKeyPair = generateFederationIdentityKeyPair();
    server = new FederationGatewayWebSocketServer({
      gatewayInstanceId: "gateway_one",
      gatewayPrivateKeyPem: gatewayKeyPair.privateKeyPem,
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      host: "127.0.0.1",
      port: 0,
      store,
    });
    const { url } = await server.start();

    await expect(
      connectFederationClient({
        url,
        mode: "reconnect",
        gatewayInstanceId: "gateway_one",
        gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
        peerInstanceId: "client_one",
        privateKeyPem: clientKeyPair.privateKeyPem,
        publicKeyPem: clientKeyPair.publicKeyPem,
        capabilities: ["remote_window"],
      }),
    ).rejects.toThrow("unknown_peer");
    expect(store.listAudit({ peerId: "client_one" })).toMatchObject([
      {
        kind: "rejected",
        detail: "unknown_peer",
      },
      {
        kind: "connect_attempt",
        detail: "reconnect",
      },
    ]);
  });

  it("runs an encrypted, channel-bound handshake and carries envelopes (Noise mode)", async () => {
    const gatewayNoise = generateNoiseStaticKeyPair();
    const clientNoise = generateNoiseStaticKeyPair();
    const clientKeyPair = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-encrypted",
      gatewayInstanceId: "gateway_one",
      generatedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    const received = new Promise<FederationProtocolEnvelope>((resolve) => {
      server = new FederationGatewayWebSocketServer({
        gatewayInstanceId: "gateway_one",
        host: "127.0.0.1",
        port: 0,
        store,
        noiseStatic: gatewayNoise,
        onEnvelope: (envelope, connection) => {
          connection.sendEnvelope({
            id: "response-1",
            kind: "response",
            requestId: envelope.id,
            protocolVersion: 1,
            sourceInstanceId: "gateway_one",
            targetInstanceId: connection.peerId,
            createdAt: 2_000,
            result: { ok: true },
          });
          resolve(envelope);
        },
      });
    });
    const { url } = await server!.start();

    const reply = new Promise<FederationProtocolEnvelope>((resolve) => {
      void connectFederationClient({
        url,
        mode: "enroll",
        gatewayInstanceId: "gateway_one",
        peerInstanceId: "client_one",
        privateKeyPem: clientKeyPair.privateKeyPem,
        publicKeyPem: clientKeyPair.publicKeyPem,
        capabilities: ["remote_window"],
        inviteToken: invite.token,
        label: "Client",
        role: "client",
        noiseStatic: clientNoise,
        gatewayNoisePublicKey: gatewayNoise.publicKeyRaw,
        onEnvelope: resolve,
      }).then((client) => {
        client.sendEnvelope({
          id: "request-1",
          kind: "request",
          method: "thread.list",
          params: {},
          protocolVersion: 1,
          sourceInstanceId: "client_one",
          targetInstanceId: "gateway_one",
          createdAt: 1_000,
        });
      });
    });

    await expect(received).resolves.toMatchObject({ id: "request-1", kind: "request" });
    await expect(reply).resolves.toMatchObject({
      kind: "response",
      requestId: "request-1",
      result: { ok: true },
    });
    expect(store.getPeer("client_one")).toMatchObject({
      status: "connected",
      pinnedPublicKeyPem: clientKeyPair.publicKeyPem,
    });
  });

  it("fails when the client pins the wrong gateway Noise key (wrong machine / MITM)", async () => {
    const gatewayNoise = generateNoiseStaticKeyPair();
    const attackerNoise = generateNoiseStaticKeyPair();
    const clientNoise = generateNoiseStaticKeyPair();
    const clientKeyPair = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-wrong-gateway",
      gatewayInstanceId: "gateway_one",
      generatedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    server = new FederationGatewayWebSocketServer({
      gatewayInstanceId: "gateway_one",
      host: "127.0.0.1",
      port: 0,
      store,
      noiseStatic: gatewayNoise,
    });
    const { url } = await server.start();

    await expect(
      connectFederationClient({
        url,
        mode: "enroll",
        gatewayInstanceId: "gateway_one",
        peerInstanceId: "client_one",
        privateKeyPem: clientKeyPair.privateKeyPem,
        publicKeyPem: clientKeyPair.publicKeyPem,
        capabilities: ["remote_window"],
        inviteToken: invite.token,
        label: "Client",
        role: "client",
        noiseStatic: clientNoise,
        // Pin the WRONG (attacker) gateway key — the handshake must fail.
        gatewayNoisePublicKey: attackerNoise.publicKeyRaw,
      }),
    ).rejects.toThrow();
    expect(store.getPeer("client_one")).toBeUndefined();
  });

  it("rejects auth proofs signed with a client-selected nonce", async () => {
    const clientKeyPair = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-stale-nonce",
      gatewayInstanceId: "gateway_one",
      generatedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    server = new FederationGatewayWebSocketServer({
      gatewayInstanceId: "gateway_one",
      gatewayPrivateKeyPem: gatewayKeyPair.privateKeyPem,
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      host: "127.0.0.1",
      port: 0,
      store,
    });
    const { url } = await server.start();
    const socket = new WebSocket(url);
    const challenge = nextSocketMessage(socket);
    await waitForSocketOpen(socket);
    await expect(challenge).resolves.toMatchObject({
      kind: "auth.challenge",
      gatewayInstanceId: "gateway_one",
    });

    const nonce = "nonce:client-selected";
    socket.send(
      JSON.stringify({
        kind: "auth",
        mode: "enroll",
        gatewayInstanceId: "gateway_one",
        peerInstanceId: "client_one",
        protocolVersion: 1,
        nonce,
        capabilities: ["remote_window"],
        signatureBase64: signFederationMessage({
          privateKeyPem: clientKeyPair.privateKeyPem,
          message: buildFederationProofMessage({
            purpose: "enroll",
            gatewayInstanceId: "gateway_one",
            peerInstanceId: "client_one",
            publicKeyPem: clientKeyPair.publicKeyPem,
            protocolVersion: 1,
            nonce,
            capabilities: ["remote_window"],
          }),
        }),
        inviteToken: invite.token,
        publicKeyPem: clientKeyPair.publicKeyPem,
        label: "Client",
        role: "client",
      }),
    );

    await expect(nextSocketMessage(socket)).resolves.toMatchObject({
      kind: "auth.rejected",
      failure: { code: "policy_denied" },
    });
    socket.close();
    expect(store.getPeer("client_one")).toBeUndefined();
  });

  it("rejects an auth challenge not signed by the pinned gateway", async () => {
    const attackerKeyPair = generateFederationIdentityKeyPair();
    const clientKeyPair = generateFederationIdentityKeyPair();
    const nonce = "challenge:forged";
    rawServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    rawServer.on("connection", (socket) => {
      socket.send(JSON.stringify({
        kind: "auth.challenge",
        gatewayInstanceId: "gateway_one",
        gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
        protocolVersion: 1,
        nonce,
        signatureBase64: signFederationMessage({
          privateKeyPem: attackerKeyPair.privateKeyPem,
          message: buildFederationGatewayChallengeMessage({
            gatewayInstanceId: "gateway_one",
            gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
            protocolVersion: 1,
            nonce,
          }),
        }),
      }));
    });
    const url = await websocketServerUrl(rawServer);

    await expect(connectFederationClient({
      url,
      mode: "reconnect",
      gatewayInstanceId: "gateway_one",
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      peerInstanceId: "client_one",
      privateKeyPem: clientKeyPair.privateKeyPem,
      publicKeyPem: clientKeyPair.publicKeyPem,
      capabilities: ["remote_window"],
    })).rejects.toThrow("Invalid federation auth challenge signature");
  });

  it("rejects an auth acceptance not signed by the pinned gateway", async () => {
    const attackerKeyPair = generateFederationIdentityKeyPair();
    const clientKeyPair = generateFederationIdentityKeyPair();
    const nonce = "challenge:trusted";
    rawServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    rawServer.on("connection", (socket) => {
      socket.send(JSON.stringify({
        kind: "auth.challenge",
        gatewayInstanceId: "gateway_one",
        gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
        protocolVersion: 1,
        nonce,
        signatureBase64: signFederationMessage({
          privateKeyPem: gatewayKeyPair.privateKeyPem,
          message: buildFederationGatewayChallengeMessage({
            gatewayInstanceId: "gateway_one",
            gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
            protocolVersion: 1,
            nonce,
          }),
        }),
      }));
      socket.once("message", () => {
        const sessionId = "federation-session:forged";
        const capabilities = ["remote_window"] as const;
        socket.send(JSON.stringify({
          kind: "auth.accepted",
          gatewayInstanceId: "gateway_one",
          sessionId,
          protocolVersion: 1,
          nonce,
          capabilities,
          signatureBase64: signFederationMessage({
            privateKeyPem: attackerKeyPair.privateKeyPem,
            message: buildFederationGatewayAcceptedMessage({
              gatewayInstanceId: "gateway_one",
              peerInstanceId: "client_one",
              sessionId,
              protocolVersion: 1,
              nonce,
              capabilities,
            }),
          }),
        }));
      });
    });
    const url = await websocketServerUrl(rawServer);

    await expect(connectFederationClient({
      url,
      mode: "reconnect",
      gatewayInstanceId: "gateway_one",
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      peerInstanceId: "client_one",
      privateKeyPem: clientKeyPair.privateKeyPem,
      publicKeyPem: clientKeyPair.publicKeyPem,
      capabilities: ["remote_window"],
    })).rejects.toThrow("Invalid federation auth acceptance signature");
  });
});

async function websocketServerUrl(wsServer: WebSocketServer): Promise<string> {
  if (!wsServer.address()) {
    await new Promise<void>((resolve) => wsServer.once("listening", () => resolve()));
  }
  const address = wsServer.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected websocket server to listen on a TCP port");
  }
  return `ws://127.0.0.1:${address.port}`;
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function nextSocketMessage(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("message", (raw) => {
      try {
        resolve(JSON.parse(raw.toString()));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}
