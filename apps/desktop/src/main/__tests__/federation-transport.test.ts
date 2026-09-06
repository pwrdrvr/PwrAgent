import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { FederationSessionRegistry } from "../federation/federation-session-state";
import { FederationStore } from "../federation/federation-store";
import {
  connectFederationClient,
  FEDERATION_SEND_BUFFER_HIGH_WATER_BYTES,
  federationTransportCodecForTest,
  FederationGatewayWebSocketServer,
  FederationSocketKeepalive,
  waitForFederationSendCapacity,
  type FederationGatewayConnection,
  type FederationKeepaliveSocket,
} from "../federation/federation-transport";
import { StateDb } from "../state/state-db";

const transportLog = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../log", () => ({ getMainLogger: () => transportLog }));

let stateDb: StateDb;
let store: FederationStore;
let tempDir: string;
let server: FederationGatewayWebSocketServer | undefined;
let rawServer: WebSocketServer | undefined;
let gatewayKeyPair: ReturnType<typeof generateFederationIdentityKeyPair>;

beforeEach(() => {
  vi.clearAllMocks();
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
  it("encodes blob bytes as a binary tail and rejects blob JSON envelopes", () => {
    const data = Buffer.from([0, 1, 2, 0xff]);
    const envelope = {
      id: "blob-codec",
      kind: "blob_chunk" as const,
      protocolVersion: 1,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 1_000,
      transferId: "transfer-1",
      chunkIndex: 0,
      chunkCount: 1,
      totalSize: data.byteLength,
      sha256: "0".repeat(64),
      name: "screen.png",
      inputType: "localImage" as const,
      data,
    };

    const wire = federationTransportCodecForTest.encodeEnvelope(envelope);
    expect(wire.subarray(0, 8).toString("ascii")).toBe("PWRBLOB1");
    const headerLength = wire.readUInt32BE(8);
    const header = JSON.parse(wire.subarray(12, 12 + headerLength).toString("utf8"));
    expect(header.envelope).not.toHaveProperty("data");
    expect(JSON.stringify(header)).not.toContain(data.toString("base64"));
    expect(wire.subarray(12 + headerLength)).toEqual(data);
    expect(federationTransportCodecForTest.decodeEnvelope(wire)).toEqual(envelope);

    const jsonWire = Buffer.from(JSON.stringify({
      kind: "envelope",
      envelope,
    }), "utf8");
    expect(federationTransportCodecForTest.decodeEnvelope(jsonWire)).toBeUndefined();
  });

  it("authenticates a client and carries protocol envelopes", async () => {
    const clientKeyPair = generateFederationIdentityKeyPair();
    let closeCount = 0;
    let lastCloseInfo: { code: number; reason: string } | undefined;
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
          expect(connection.peerDirectoryPaging).toBe(true);
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
        onClose: (info) => {
          closeCount += 1;
          lastCloseInfo = info;
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
    // Revocation closes with its own application code so the client can
    // report "re-pair needed" instead of a generic connection loss.
    expect(lastCloseInfo).toMatchObject({ code: 4002, reason: "revoked" });
    expect(server?.closePeer("client_one")).toBe(false);
  });

  it("carries attachment bytes in the binary blob frame instead of JSON", async () => {
    const transfers: Array<{ direction: "sent" | "received"; dataByteCount: number; byteCount: number }> = [];
    const clientKeyPair = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-binary-blob",
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
        onEnvelope: resolve,
        onEnvelopeTransfer: (info) => transfers.push(info),
      });
    });
    const { url } = await server!.start();
    const client = await connectFederationClient({
      url,
      mode: "enroll",
      gatewayInstanceId: "gateway_one",
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      peerInstanceId: "client_one",
      privateKeyPem: clientKeyPair.privateKeyPem,
      publicKeyPem: clientKeyPair.publicKeyPem,
      capabilities: ["turn_input_blobs"],
      inviteToken: invite.token,
      label: "Client",
      role: "client",
      onEnvelopeTransfer: (info) => transfers.push(info),
    });
    const bytes = Buffer.from([0, 1, 2, 0xff]);

    await client.sendEnvelopeWithBackpressure!({
      id: "blob-1",
      kind: "blob_chunk",
      protocolVersion: 1,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 1_000,
      transferId: "transfer-1",
      chunkIndex: 0,
      chunkCount: 1,
      totalSize: bytes.byteLength,
      sha256: "0".repeat(64),
      name: "screen.png",
      inputType: "localImage",
      data: bytes,
    });

    await expect(received).resolves.toMatchObject({
      kind: "blob_chunk",
      transferId: "transfer-1",
      data: bytes,
    });
    const expectedBytes = federationTransportCodecForTest.encodeEnvelope(await received).byteLength;
    expect(transfers).toHaveLength(2);
    expect(transfers.map(({ direction, dataByteCount, byteCount }) => ({ direction, dataByteCount, byteCount })))
      .toEqual([
        { direction: "sent", dataByteCount: expectedBytes, byteCount: expectedBytes },
        { direction: "received", dataByteCount: expectedBytes, byteCount: expectedBytes },
      ]);
    client.close();
  });

  it.each([false, true])("reports exact bytes and correlated large responses at both ends (Noise: %s)", async (encrypted) => {
    const gatewayNoise = generateNoiseStaticKeyPair();
    const clientNoise = generateNoiseStaticKeyPair();
    const clientKeyPair = generateFederationIdentityKeyPair();
    const gatewayTransfers: Array<{
      peerId: string;
      direction: "sent" | "received";
      byteCount: number;
      dataByteCount: number;
      envelope: FederationProtocolEnvelope;
    }> = [];
    const clientTransfers: Array<{
      direction: "sent" | "received";
      byteCount: number;
      dataByteCount: number;
      envelope: FederationProtocolEnvelope;
    }> = [];
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-transfer",
      gatewayInstanceId: "gateway_one",
      generatedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    server = new FederationGatewayWebSocketServer({
      gatewayInstanceId: "gateway_one",
      gatewayPrivateKeyPem: gatewayKeyPair.privateKeyPem,
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      noiseStatic: encrypted ? gatewayNoise : undefined,
      instanceLabel: (id) => id === "gateway_one" ? "Gateway" : "Client",
      host: "127.0.0.1",
      port: 0,
      store,
      onEnvelope: (envelope, connection) => {
        connection.sendEnvelope({
          id: "response-transfer",
          kind: "response",
          requestId: envelope.id,
          protocolVersion: 1,
          sourceInstanceId: "gateway_one",
          targetInstanceId: connection.peerId,
          createdAt: 2_000,
          result: { privatePayload: "x".repeat(600_000) },
        });
      },
      onEnvelopeTransfer: (info) => gatewayTransfers.push(info),
    });
    const { url } = await server.start();

    const reply = new Promise<FederationProtocolEnvelope>((resolve) => {
      void connectFederationClient({
        url,
        noiseStatic: encrypted ? clientNoise : undefined,
        instanceLabel: (id) => id === "gateway_one" ? "Gateway" : "Client",
        gatewayNoisePublicKey: encrypted ? gatewayNoise.publicKeyRaw : undefined,
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
        onEnvelopeTransfer: (info) => clientTransfers.push(info),
      }).then((client) => {
        client.sendEnvelope({
          id: "request-transfer",
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
    await expect(reply).resolves.toMatchObject({
      kind: "response",
      requestId: "request-transfer",
    });

    // Envelope frames only — the auth exchange fires no taps, so one
    // round-trip is exactly two events per side.
    expect(gatewayTransfers).toHaveLength(2);
    expect(clientTransfers).toHaveLength(2);
    const [gatewayReceived, gatewaySent] = gatewayTransfers;
    const [clientSent, clientReceived] = clientTransfers;
    for (const message of ["large federation frame queued for send", "large federation frame received"]) {
      expect(transportLog.info).toHaveBeenCalledWith(message, expect.objectContaining({
        envelopeKind: "response",
        requestId: "request-transfer",
        method: "thread.list",
        sourceInstanceId: "gateway_one",
        sourceInstanceLabel: "Gateway",
        targetInstanceId: "client_one",
        targetInstanceLabel: "Client",
      }));
    }
    const largeLogs = transportLog.info.mock.calls.filter(([message]) => message.startsWith("large federation frame"));
    expect(largeLogs).toHaveLength(2);
    expect(largeLogs[0][1]).toMatchObject({ peerId: "client_one", peerLabel: "Client" });
    expect(largeLogs[1][1]).toMatchObject({ peerId: "gateway_one", peerLabel: "Gateway" });
    expect(JSON.stringify(largeLogs)).not.toContain("privatePayload");
    expect(JSON.stringify(largeLogs)).not.toContain("maxFrameBytes");
    expect(gatewayReceived).toMatchObject({
      peerId: "client_one",
      direction: "received",
    });
    expect(gatewaySent).toMatchObject({
      peerId: "client_one",
      direction: "sent",
    });
    expect(clientSent.direction).toBe("sent");
    expect(clientReceived.direction).toBe("received");
    // Both ends count the same wire frames, so the figures agree — the
    // property that makes a local ledger a truthful transfer monitor.
    expect(gatewayReceived.byteCount).toBe(clientSent.byteCount);
    expect(clientReceived.byteCount).toBe(gatewaySent.byteCount);
    expect(clientSent.byteCount).toBeGreaterThan(0);
    expect(gatewaySent.byteCount).toBeGreaterThan(0);
    for (const transfer of [...gatewayTransfers, ...clientTransfers]) {
      expect(transfer.dataByteCount).toBe(Buffer.byteLength(JSON.stringify({
        kind: "envelope", envelope: transfer.envelope,
      }), "utf8"));
      expect(transfer.byteCount).toBe(transfer.dataByteCount + (encrypted ? 16 : 0));
    }
  });

  it("evicts a duplicated peer id with close code 4001 and audits the replacement", async () => {
    const clientKeyPair = generateFederationIdentityKeyPair();
    let firstClose: { code: number; reason: string } | undefined;
    let resolveFirstClosed: (() => void) | undefined;
    const firstClosed = new Promise<void>((resolve) => {
      resolveFirstClosed = resolve;
    });
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-replace",
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

    await connectFederationClient({
      url,
      mode: "enroll",
      gatewayInstanceId: "gateway_one",
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      peerInstanceId: "client_one",
      privateKeyPem: clientKeyPair.privateKeyPem,
      publicKeyPem: clientKeyPair.publicKeyPem,
      capabilities: ["remote_window"],
      inviteToken: invite.token,
      label: "Clone A",
      role: "client",
      onClose: (info) => {
        firstClose = info;
        resolveFirstClosed?.();
      },
    });

    // A second process presenting the same instance id + pinned key (a
    // cloned profile state.db) authenticates and evicts the first.
    const second = await connectFederationClient({
      url,
      mode: "reconnect",
      gatewayInstanceId: "gateway_one",
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      peerInstanceId: "client_one",
      privateKeyPem: clientKeyPair.privateKeyPem,
      publicKeyPem: clientKeyPair.publicKeyPem,
      capabilities: ["remote_window"],
      label: "Clone B",
      role: "client",
    });

    await firstClosed;
    // The evicted side can tell this apart from a network drop.
    expect(firstClose).toMatchObject({
      code: 4001,
      reason: "replaced_by_new_session",
    });

    // Newest-first audit trail: the old session's "replaced" eviction is
    // recorded before (i.e. listed after) the new session's "connected",
    // and the evicted socket's close adds no duplicate disconnected row.
    expect(store.listAudit({ peerId: "client_one" })).toMatchObject([
      { kind: "connected", detail: "reconnect" },
      { kind: "disconnected", detail: "replaced" },
      { kind: "connect_attempt", detail: "reconnect" },
      { kind: "connected", detail: "enroll" },
      { kind: "connect_attempt", detail: "enroll" },
    ]);
    second.close();
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
    // Paging is negotiated independently of persisted authorization grants.
    expect(client.peerDirectoryPaging).toBe(true);
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
      onConnection: (connection) => {
        expect(connection.peerDirectoryPaging).toBe(false);
        resolveConnected?.();
      },
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

describe("federation transport liveness", () => {
  it("terminates an authenticated peer whose link stops answering keepalive probes", async () => {
    const clientKeyPair = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-keepalive",
      gatewayInstanceId: "gateway_one",
      generatedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    const registry = new FederationSessionRegistry();
    server = new FederationGatewayWebSocketServer({
      gatewayInstanceId: "gateway_one",
      gatewayPrivateKeyPem: gatewayKeyPair.privateKeyPem,
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      host: "127.0.0.1",
      port: 0,
      store,
      sessions: registry,
      keepaliveIntervalMs: 50,
      // Keep the auth deadline out of the way: this test is about the
      // post-auth keepalive, not the pre-auth deadline.
      authTimeoutMs: 60_000,
    });
    const { url } = await server.start();
    const socket = new WebSocket(url);
    const challengePromise = nextSocketMessage(socket);
    await waitForSocketOpen(socket);
    const challenge = (await challengePromise) as { nonce: string };
    socket.send(
      JSON.stringify({
        kind: "auth",
        mode: "enroll",
        gatewayInstanceId: "gateway_one",
        peerInstanceId: "client_one",
        protocolVersion: 1,
        nonce: challenge.nonce,
        capabilities: ["remote_window"],
        signatureBase64: signFederationMessage({
          privateKeyPem: clientKeyPair.privateKeyPem,
          message: buildFederationProofMessage({
            purpose: "enroll",
            gatewayInstanceId: "gateway_one",
            peerInstanceId: "client_one",
            publicKeyPem: clientKeyPair.publicKeyPem,
            protocolVersion: 1,
            nonce: challenge.nonce,
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
      kind: "auth.accepted",
    });
    const session = registry.listActiveSessions()[0];
    expect(session).toBeDefined();

    // Simulate a silently dead link: stop reading, so the gateway's pings
    // are never processed and no pong ever goes back. No FIN, no RST —
    // exactly the failure mode keepalive exists for.
    (socket as unknown as { _socket: net.Socket })._socket.pause();

    await expect
      .poll(() => registry.listActiveSessions().length, { timeout: 5_000 })
      .toBe(0);
    expect(registry.getSession(session.sessionId)).toMatchObject({
      status: "closed",
      closeReason: "transport_closed",
    });
    socket.terminate();
  });

  it("terminates a socket that upgrades but never completes auth", async () => {
    server = new FederationGatewayWebSocketServer({
      gatewayInstanceId: "gateway_one",
      gatewayPrivateKeyPem: gatewayKeyPair.privateKeyPem,
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      host: "127.0.0.1",
      port: 0,
      store,
      authTimeoutMs: 100,
      // Keepalive alone cannot catch this: a live-but-stalled peer answers
      // pings from the ws protocol layer forever. Park it out of the way so
      // this test isolates the auth deadline.
      keepaliveIntervalMs: 60_000,
    });
    const { url } = await server.start();
    const socket = new WebSocket(url);
    await waitForSocketOpen(socket);
    // Upgrade succeeded, challenge received; now say nothing.
    const closed = new Promise<boolean>((resolve) => {
      socket.once("close", () => resolve(true));
    });
    await expect(closed).resolves.toBe(true);
  });

  it("keeps an idle authenticated peer connected and counts pongs as heartbeats", async () => {
    const clientKeyPair = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-idle",
      gatewayInstanceId: "gateway_one",
      generatedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    const registry = new FederationSessionRegistry();
    server = new FederationGatewayWebSocketServer({
      gatewayInstanceId: "gateway_one",
      gatewayPrivateKeyPem: gatewayKeyPair.privateKeyPem,
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      host: "127.0.0.1",
      port: 0,
      store,
      sessions: registry,
      keepaliveIntervalMs: 40,
    });
    const { url } = await server.start();
    let closeCount = 0;
    const client = await connectFederationClient({
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
      keepaliveIntervalMs: 40,
      onClose: () => {
        closeCount += 1;
      },
    });
    const session = registry.listActiveSessions()[0];
    expect(session).toBeDefined();

    // Several keepalive cycles with zero envelopes: the session must stay
    // active and its heartbeat must advance on pongs alone, or the stale
    // sweep would reap every idle-but-healthy peer.
    await expect
      .poll(
        () =>
          registry.getSession(session.sessionId)?.lastHeartbeatAt ??
          session.connectedAt,
        { timeout: 5_000 },
      )
      .toBeGreaterThan(session.connectedAt);
    expect(registry.listActiveSessions()).toHaveLength(1);
    expect(closeCount).toBe(0);
    client.close();
  });

  it("closes the connection when a frame exceeds the payload ceiling", async () => {
    const clientKeyPair = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-max-frame",
      gatewayInstanceId: "gateway_one",
      generatedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    const received: FederationProtocolEnvelope[] = [];
    server = new FederationGatewayWebSocketServer({
      gatewayInstanceId: "gateway_one",
      gatewayPrivateKeyPem: gatewayKeyPair.privateKeyPem,
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      host: "127.0.0.1",
      port: 0,
      store,
      maxFrameBytes: 64 * 1024,
      onEnvelope: (envelope) => {
        received.push(envelope);
      },
    });
    const { url } = await server.start();
    let closeCount = 0;
    const client = await connectFederationClient({
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
      onClose: () => {
        closeCount += 1;
      },
    });
    const envelope = (payload: unknown): FederationProtocolEnvelope => ({
      id: "request-max-frame",
      kind: "request",
      method: "backend.listThreads",
      params: payload,
      protocolVersion: 1,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 1_000,
    });

    // Within the ceiling: delivered.
    client.sendEnvelope(envelope({ note: "small" }));
    await expect.poll(() => received.length, { timeout: 5_000 }).toBe(1);

    // Over the ceiling: the gateway drops the connection instead of
    // buffering a frame of the peer's choosing.
    client.sendEnvelope(envelope({ blob: "x".repeat(128 * 1024) }));
    await expect.poll(() => closeCount, { timeout: 5_000 }).toBe(1);
    expect(received).toHaveLength(1);
  });

  it("rejects an oversized client envelope before sending it", async () => {
    const gatewayNoise = generateNoiseStaticKeyPair();
    const clientNoise = generateNoiseStaticKeyPair();
    const clientKeyPair = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-client-send-limit",
      gatewayInstanceId: "gateway_one",
      generatedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    const received: FederationProtocolEnvelope[] = [];
    server = new FederationGatewayWebSocketServer({
      gatewayInstanceId: "gateway_one",
      gatewayPrivateKeyPem: gatewayKeyPair.privateKeyPem,
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      host: "127.0.0.1",
      port: 0,
      store,
      noiseStatic: gatewayNoise,
      onEnvelope: (envelope) => received.push(envelope),
    });
    const { url } = await server.start();
    const client = await connectFederationClient({
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
      maxFrameBytes: 64 * 1024,
      noiseStatic: clientNoise,
      gatewayNoisePublicKey: gatewayNoise.publicKeyRaw,
    });
    const envelope = (id: string, payload: unknown): FederationProtocolEnvelope => ({
      id,
      kind: "request",
      method: "backend.listThreads",
      params: payload,
      protocolVersion: 1,
      sourceInstanceId: "client_one",
      targetInstanceId: "gateway_one",
      createdAt: 1_000,
    });

    expect(() => client.sendEnvelope(
      envelope("request-too-large", { blob: "x".repeat(128 * 1024) }),
    )).toThrow(/exceeds.*frame.*limit/i);
    client.sendEnvelope(envelope("request-small", { note: "small" }));
    await expect.poll(() => received.length, { timeout: 5_000 }).toBe(1);
    expect(received[0]?.id).toBe("request-small");
  });

  it("rejects an oversized gateway envelope before sending it", async () => {
    const gatewayNoise = generateNoiseStaticKeyPair();
    const clientNoise = generateNoiseStaticKeyPair();
    const clientKeyPair = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({
      store,
      token: "invite-token-gateway-send-limit",
      gatewayInstanceId: "gateway_one",
      generatedAt: Date.now() - 1_000,
      expiresAt: Date.now() + 60_000,
    });
    let gatewayConnection: FederationGatewayConnection | undefined;
    const received: FederationProtocolEnvelope[] = [];
    server = new FederationGatewayWebSocketServer({
      gatewayInstanceId: "gateway_one",
      gatewayPrivateKeyPem: gatewayKeyPair.privateKeyPem,
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      host: "127.0.0.1",
      port: 0,
      store,
      maxFrameBytes: 64 * 1024,
      noiseStatic: gatewayNoise,
      onConnection: (connection) => {
        gatewayConnection = connection;
      },
    });
    const { url } = await server.start();
    const _client = await connectFederationClient({
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
      onEnvelope: (envelope) => received.push(envelope),
    });
    await expect.poll(() => gatewayConnection).toBeDefined();
    const envelope = (id: string, payload: unknown): FederationProtocolEnvelope => ({
      id,
      kind: "request",
      method: "backend.listThreads",
      params: payload,
      protocolVersion: 1,
      sourceInstanceId: "gateway_one",
      targetInstanceId: "client_one",
      createdAt: 1_000,
    });

    expect(() => gatewayConnection?.sendEnvelope(
      envelope("request-too-large", { blob: "x".repeat(128 * 1024) }),
    )).toThrow(/exceeds.*frame.*limit/i);
    gatewayConnection?.sendEnvelope(
      envelope("request-small", { note: "small" }),
    );
    await expect.poll(() => received.length, { timeout: 5_000 }).toBe(1);
    expect(received[0]?.id).toBe("request-small");
  });

  it("terminates the client side when a gateway stops answering keepalive probes", async () => {
    const clientKeyPair = generateFederationIdentityKeyPair();
    const nonce = "challenge:keepalive";
    // A protocol-correct but frozen gateway: it completes auth with real
    // signatures, then never answers pings (autoPong off) and never speaks
    // again — the client's own probes must detect the dead direction.
    rawServer = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      autoPong: false,
    });
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
        const sessionId = "federation-session:frozen";
        const capabilities = ["remote_window"] as const;
        socket.send(JSON.stringify({
          kind: "auth.accepted",
          gatewayInstanceId: "gateway_one",
          sessionId,
          protocolVersion: 1,
          nonce,
          capabilities,
          signatureBase64: signFederationMessage({
            privateKeyPem: gatewayKeyPair.privateKeyPem,
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

    let closeCount = 0;
    await connectFederationClient({
      url,
      mode: "reconnect",
      gatewayInstanceId: "gateway_one",
      gatewayPublicKeyPem: gatewayKeyPair.publicKeyPem,
      peerInstanceId: "client_one",
      privateKeyPem: clientKeyPair.privateKeyPem,
      publicKeyPem: clientKeyPair.publicKeyPem,
      capabilities: ["remote_window"],
      keepaliveIntervalMs: 50,
      onClose: () => {
        closeCount += 1;
      },
    });
    await expect.poll(() => closeCount, { timeout: 5_000 }).toBe(1);
  });

  it("expires only stale active sessions from the registry", () => {
    const registry = new FederationSessionRegistry();
    registry.openSession({
      sessionId: "session-stale",
      peerId: "peer_stale",
      connectedAt: 1_000,
      capabilities: [],
    });
    registry.openSession({
      sessionId: "session-live",
      peerId: "peer_live",
      connectedAt: 1_000,
      capabilities: [],
    });
    registry.heartbeat("session-live", 10_000);

    const expired = registry.expireStaleSessions({
      now: 10_500,
      heartbeatTimeoutMs: 5_000,
    });

    expect(expired.map((session) => session.sessionId)).toEqual([
      "session-stale",
    ]);
    expect(registry.getSession("session-stale")).toMatchObject({
      status: "closed",
      closeReason: "timeout",
    });
    expect(registry.getSession("session-live")?.status).toBe("active");
  });
});

describe("federation send backpressure", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for the WebSocket buffer to drain below the high-water mark", async () => {
    const socket = {
      bufferedAmount: FEDERATION_SEND_BUFFER_HIGH_WATER_BYTES + 1,
      readyState: WebSocket.OPEN,
    };
    let resolved = false;
    const waiting = waitForFederationSendCapacity(socket).then(() => {
      resolved = true;
    });

    await Promise.resolve();
    expect(resolved).toBe(false);
    socket.bufferedAmount = FEDERATION_SEND_BUFFER_HIGH_WATER_BYTES;
    await vi.advanceTimersByTimeAsync(5);
    await waiting;
    expect(resolved).toBe(true);
  });
});

/**
 * Congestion forgiveness on the keepalive watchdog, driven with a fake
 * socket: ws sends control frames in FIFO order, so a large data backlog (a
 * remote-PTY output burst on a slow link) parks our own ping behind it. A
 * missed pong while that backlog is demonstrably draining must not read as
 * death — but a stalled or empty queue must.
 */
describe("federation keepalive congestion forgiveness", () => {
  class FakeKeepaliveSocket implements FederationKeepaliveSocket {
    readyState = WebSocket.OPEN;
    bufferedAmount = 0;
    pings = 0;
    private pongListeners: (() => void)[] = [];

    ping(): void {
      this.pings += 1;
    }

    on(_event: "pong", listener: () => void): void {
      this.pongListeners.push(listener);
    }

    once(_event: "close", _listener: () => void): void {
      // The fake never closes; dispose() is exercised via onDead.
    }

    emitPong(): void {
      for (const listener of this.pongListeners) {
        listener();
      }
    }
  }

  function createHarness() {
    const socket = new FakeKeepaliveSocket();
    let deadCount = 0;
    const keepalive = new FederationSocketKeepalive(socket, {
      intervalMs: 1_000,
      onDead: () => {
        deadCount += 1;
      },
    });
    return { socket, keepalive, isDead: () => deadCount > 0 };
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("declares death after a missed pong with an empty send queue", () => {
    const { socket, isDead } = createHarness();
    vi.advanceTimersByTime(1_000);
    expect(socket.pings).toBe(1);
    expect(isDead()).toBe(false);
    // No pong, nothing queued: the probe reached the wire and went
    // unanswered.
    vi.advanceTimersByTime(1_000);
    expect(isDead()).toBe(true);
  });

  it("forgives missed pongs while the send queue is draining, then recovers on pong", () => {
    const { socket, keepalive, isDead } = createHarness();
    // A burst is queued ahead of the probe.
    socket.bufferedAmount = 1_000_000;
    vi.advanceTimersByTime(1_000);
    expect(socket.pings).toBe(1);

    // Slow link: bytes keep moving every interval, pong still stuck behind
    // the backlog. Each draining tick is forgiven.
    for (const remaining of [800_000, 500_000, 200_000]) {
      socket.bufferedAmount = remaining;
      vi.advanceTimersByTime(1_000);
      expect(isDead()).toBe(false);
    }

    // Backlog flushed, probe finally delivered, pong comes back: alive.
    socket.bufferedAmount = 0;
    socket.emitPong();
    vi.advanceTimersByTime(1_000);
    expect(isDead()).toBe(false);
    expect(socket.pings).toBeGreaterThanOrEqual(2);
    keepalive.dispose();
  });

  it("declares death when the queue stalls without draining", () => {
    const { socket, isDead } = createHarness();
    socket.bufferedAmount = 1_000_000;
    vi.advanceTimersByTime(1_000);
    expect(socket.pings).toBe(1);
    // Identical backlog a full interval later: not one byte moved. A dead
    // link with a queued burst looks exactly like this once the kernel
    // buffer fills — forgiving it would reintroduce the forever-orphan.
    vi.advanceTimersByTime(1_000);
    expect(isDead()).toBe(true);
  });

  it("grants one interval for the pong after the queue fully drains, then declares death", () => {
    const { socket, isDead } = createHarness();
    socket.bufferedAmount = 500_000;
    vi.advanceTimersByTime(1_000);
    // Draining tick: forgiven.
    socket.bufferedAmount = 100_000;
    vi.advanceTimersByTime(1_000);
    expect(isDead()).toBe(false);
    // The burst ended, so the probe was the LAST frame out — delivered the
    // instant the queue hit zero, pong one RTT behind. The drain-to-zero
    // tick showed maximal progress and must be forgiven, or a slow link
    // gets killed at the finish line of every burst-then-quiet command.
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(1_000);
    expect(isDead()).toBe(false);
    // A further full interval of silence with an empty queue: dead.
    vi.advanceTimersByTime(1_000);
    expect(isDead()).toBe(true);
  });

  it("recovers when the pong lands inside the post-drain interval", () => {
    const { socket, keepalive, isDead } = createHarness();
    socket.bufferedAmount = 500_000;
    vi.advanceTimersByTime(1_000);
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(1_000);
    expect(isDead()).toBe(false);
    // The RTT-delayed pong arrives before the next tick: alive, probing
    // resumes normally.
    socket.emitPong();
    vi.advanceTimersByTime(1_000);
    expect(isDead()).toBe(false);
    expect(socket.pings).toBeGreaterThanOrEqual(2);
    keepalive.dispose();
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
