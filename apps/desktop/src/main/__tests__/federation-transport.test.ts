import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FederationProtocolEnvelope } from "@pwragent/shared";
import {
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

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-federation-transport-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new FederationStore(stateDb);
});

afterEach(async () => {
  await server?.stop();
  server = undefined;
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("federation transport", () => {
  it("authenticates a client and carries protocol envelopes", async () => {
    const clientKeyPair = generateFederationIdentityKeyPair();
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
        peerInstanceId: "client_one",
        privateKeyPem: clientKeyPair.privateKeyPem,
        publicKeyPem: clientKeyPair.publicKeyPem,
        capabilities: ["remote_window"],
        inviteToken: invite.token,
        label: "Client",
        role: "client",
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
  });

  it("rejects websocket clients that cannot prove an enrolled identity", async () => {
    const clientKeyPair = generateFederationIdentityKeyPair();
    server = new FederationGatewayWebSocketServer({
      gatewayInstanceId: "gateway_one",
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
        peerInstanceId: "client_one",
        privateKeyPem: clientKeyPair.privateKeyPem,
        publicKeyPem: clientKeyPair.publicKeyPem,
        capabilities: ["remote_window"],
      }),
    ).rejects.toThrow("unknown_peer");
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
});

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
