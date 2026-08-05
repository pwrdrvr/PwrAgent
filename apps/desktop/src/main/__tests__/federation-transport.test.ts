import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  FEDERATION_PROTOCOL_VERSION,
  FEDERATION_TRANSPORT_VERSION,
  type FederationProtocolEnvelope,
} from "@pwragent/shared";
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
import {
  generateNoiseStaticKeyPair,
  NoiseIKHandshake,
} from "../federation/federation-noise";
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

  it("ignores capability names from newer builds instead of failing the handshake", async () => {
    const clientKeyPair = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-future-capability",
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

    // Simulate a client from a future release advertising a capability
    // this build has never heard of. The signed proof covers the raw
    // list, so the handshake must succeed and the unknown name must be
    // dropped from the granted set and the stored peer row.
    const futureCapabilities = [
      "thread_navigation",
      "capability_from_the_future",
    ] as unknown as import("@pwragent/shared").FederationCapability[];
    const client = await connectFederationClient({
      url,
      mode: "enroll",
      gatewayInstanceId: "gateway_one",
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      peerInstanceId: "client_future",
      privateKeyPem: clientKeyPair.privateKeyPem,
      publicKeyPem: clientKeyPair.publicKeyPem,
      capabilities: futureCapabilities,
      inviteToken: invite.token,
      label: "Future Client",
      role: "client",
    });

    expect(client.capabilities).toEqual(["thread_navigation"]);
    expect(store.getPeer("client_future")).toMatchObject({
      status: "connected",
      capabilities: ["thread_navigation"],
    });
    client.close();
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
        gatewayPrivateKeyPem: gatewayKeyPair.privateKeyPem,
        gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
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
        gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
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

  it("carries the encrypted channel over an externally created outer socket", async () => {
    const gatewayNoise = generateNoiseStaticKeyPair();
    const clientNoise = generateNoiseStaticKeyPair();
    const clientKeyPair = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-outer-socket",
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
    const { port } = await server!.start();

    // Stands in for an SSH stdio forward: the client never dials TCP itself;
    // the upgrade and every Noise frame ride the supplied stream.
    let outerSockets = 0;
    const reply = new Promise<FederationProtocolEnvelope>((resolve) => {
      void connectFederationClient({
        url: `ws://127.0.0.1:${port}`,
        createSocket: () => {
          outerSockets += 1;
          return net.connect(port, "127.0.0.1");
        },
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
    expect(outerSockets).toBe(1);
    expect(store.getPeer("client_one")).toMatchObject({
      status: "connected",
      pinnedPublicKeyPem: clientKeyPair.publicKeyPem,
    });
  });

  it("fails the connect when a peer upgrades and then goes silent", async () => {
    // Without a deadline this parks forever: the upgrade succeeds, so neither
    // "open" nor "close" nor "error" ever fires, and the reader waits on a
    // frame that never arrives. That stalled the whole endpoint walk and the
    // reconnect loop, and wedged Settings saves behind restart().
    rawServer = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    rawServer.on("connection", () => {
      // Accept the upgrade and deliberately send nothing.
    });
    await new Promise<void>((resolve) => rawServer!.once("listening", resolve));
    const address = rawServer.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const clientKeyPair = generateFederationIdentityKeyPair();
    const clientNoise = generateNoiseStaticKeyPair();

    const started = Date.now();
    await expect(
      connectFederationClient({
        url: `ws://127.0.0.1:${port}`,
        connectTimeoutMs: 250,
        mode: "reconnect",
        gatewayInstanceId: "gateway_one",
        gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
        peerInstanceId: "client_one",
        privateKeyPem: clientKeyPair.privateKeyPem,
        publicKeyPem: clientKeyPair.publicKeyPem,
        capabilities: ["remote_window"],
        noiseStatic: clientNoise,
        gatewayNoisePublicKey: generateNoiseStaticKeyPair().publicKeyRaw,
      }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("advertises the required Noise transport version before the handshake", async () => {
    const gatewayNoise = generateNoiseStaticKeyPair();
    server = new FederationGatewayWebSocketServer({
      gatewayInstanceId: "gateway_one",
      gatewayPrivateKeyPem: gatewayKeyPair.privateKeyPem,
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      host: "127.0.0.1",
      port: 0,
      store,
      noiseStatic: gatewayNoise,
    });
    const { url } = await server.start();
    const socket = new WebSocket(url);
    const reader = new TestSocketReader(socket);
    await waitForSocketOpen(socket);

    expect(JSON.parse((await reader.next()).toString("utf8"))).toEqual({
      kind: "transport.hello",
      transportVersion: FEDERATION_TRANSPORT_VERSION,
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      encryption: "noise_ik_25519_aesgcm_sha256",
    });
    socket.close();
  });

  it("rejects a legacy gateway before starting the Noise handshake", async () => {
    const gatewayNoise = generateNoiseStaticKeyPair();
    const clientNoise = generateNoiseStaticKeyPair();
    const clientKeyPair = generateFederationIdentityKeyPair();
    rawServer = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    rawServer.on("connection", (socket) => {
      socket.send(JSON.stringify({
        kind: "auth.challenge",
        gatewayInstanceId: "gateway_one",
        gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
        protocolVersion: FEDERATION_PROTOCOL_VERSION,
        nonce: "legacy-challenge",
        signatureBase64: "legacy-signature",
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
      noiseStatic: clientNoise,
      gatewayNoisePublicKey: gatewayNoise.publicKeyRaw,
    })).rejects.toThrow(
      `Federation gateway does not support required Noise transport version ${FEDERATION_TRANSPORT_VERSION}.`,
    );
  });

  it("closes an established session after encrypted frame authentication fails", async () => {
    const gatewayNoise = generateNoiseStaticKeyPair();
    const clientNoise = generateNoiseStaticKeyPair();
    const clientKeyPair = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-tampered-frame",
      gatewayInstanceId: "gateway_one",
      generatedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    let resolveConnected: (() => void) | undefined;
    const connected = new Promise<void>((resolve) => {
      resolveConnected = resolve;
    });
    let resolveDisconnected: (() => void) | undefined;
    const disconnected = new Promise<void>((resolve) => {
      resolveDisconnected = resolve;
    });
    server = new FederationGatewayWebSocketServer({
      gatewayInstanceId: "gateway_one",
      gatewayPrivateKeyPem: gatewayKeyPair.privateKeyPem,
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      host: "127.0.0.1",
      port: 0,
      store,
      noiseStatic: gatewayNoise,
      onConnection: () => resolveConnected?.(),
      onDisconnect: () => resolveDisconnected?.(),
    });
    const { url } = await server.start();
    const socket = new WebSocket(url);
    const reader = new TestSocketReader(socket);
    await waitForSocketOpen(socket);
    await reader.next();

    const handshake = new NoiseIKHandshake({
      role: "initiator",
      localStatic: clientNoise,
      remoteStaticPublicKey: gatewayNoise.publicKeyRaw,
    });
    socket.send(handshake.writeMessage1());
    handshake.readMessage2(await reader.next());
    const transport = handshake.split();
    const challenge = JSON.parse(
      transport.decrypt(await reader.next()).toString("utf8"),
    ) as {
      nonce: string;
    };
    const capabilities = ["remote_window"] as const;
    socket.send(transport.encrypt(Buffer.from(JSON.stringify({
      kind: "auth",
      mode: "enroll",
      gatewayInstanceId: "gateway_one",
      peerInstanceId: "client_one",
      protocolVersion: FEDERATION_PROTOCOL_VERSION,
      nonce: challenge.nonce,
      capabilities,
      signatureBase64: signFederationMessage({
        privateKeyPem: clientKeyPair.privateKeyPem,
        message: buildFederationProofMessage({
          purpose: "enroll",
          gatewayInstanceId: "gateway_one",
          peerInstanceId: "client_one",
          publicKeyPem: clientKeyPair.publicKeyPem,
          protocolVersion: FEDERATION_PROTOCOL_VERSION,
          nonce: challenge.nonce,
          capabilities,
          channelBinding: transport.handshakeHash.toString("base64"),
        }),
      }),
      inviteToken: invite.token,
      publicKeyPem: clientKeyPair.publicKeyPem,
      label: "Client",
      role: "client",
    }), "utf8")));
    const accepted = JSON.parse(
      transport.decrypt(await reader.next()).toString("utf8"),
    ) as { kind: string };
    expect(accepted.kind).toBe("auth.accepted");
    await connected;

    const socketClosed = new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
    });
    socket.send(Buffer.alloc(32, 0xa5));

    await socketClosed;
    await disconnected;
    expect(server.closePeer("client_one")).toBe(false);
    expect(store.listAudit({ peerId: "client_one" })[0]).toMatchObject({
      kind: "disconnected",
      detail: "transport_closed",
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
      gatewayPrivateKeyPem: gatewayKeyPair.privateKeyPem,
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
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
        gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
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

class TestSocketReader {
  private readonly queue: Buffer[] = [];
  private pending?: {
    resolve: (frame: Buffer) => void;
    reject: (error: Error) => void;
  };
  private failure?: Error;

  constructor(socket: WebSocket) {
    socket.on("message", (raw) => this.push(rawDataToBuffer(raw)));
    socket.once("close", () => this.fail(new Error("WebSocket closed")));
    socket.once("error", (error) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    );
  }

  next(): Promise<Buffer> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
    });
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
}

function rawDataToBuffer(raw: WebSocket.RawData): Buffer {
  if (Buffer.isBuffer(raw)) return raw;
  if (Array.isArray(raw)) return Buffer.concat(raw);
  return Buffer.from(raw as ArrayBuffer);
}
