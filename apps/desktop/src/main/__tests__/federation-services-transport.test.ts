import { afterEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { FederationCapability } from "@pwragent/shared";
import { FederationServices, registerFederationServices, SERVICE_METHOD_CAPABILITIES } from "../federation/federation-services";
import { FederationServiceForwarder } from "../federation/federation-service-forwarder";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";
import { FederationGatewayWebSocketServer, connectFederationClient } from "../federation/federation-transport";
import { FederationStore } from "../federation/federation-store";
import { generateFederationIdentityKeyPair } from "../federation/federation-identity";
import { generateNoiseStaticKeyPair } from "../federation/federation-noise";
import { createFederationEnrollmentInvite } from "../federation/federation-enrollment";
import { openInMemoryStateDb } from "./sqlite-test-utils";
import { serviceNotification } from "./helpers/federation-service-link";
import { setFederationTrafficCapture, snapshotFederationTrafficHistory } from "../federation/federation-traffic-capture";

vi.mock("../log", () => ({ getMainLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { setFederationTrafficCapture(false); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

for (const streams of [1, 2] as const) it(`carries HTTP and WS on v${streams} streams through two signed, Noise-encrypted clients and a real gateway; metadata capture excludes payloads`, async () => {
  const db = openInMemoryStateDb();
  cleanups.push(() => db.close());
  const store = new FederationStore(db);
  const keys = generateFederationIdentityKeyPair();
  const noise = generateNoiseStaticKeyPair();
  const capabilities: FederationCapability[] = ["gateway_relay", "service_forward_v1", "service_forward_v2", "transport_brotli"];
  const gateway = new FederationRouter({ localInstanceId: "gateway", methodCapabilities: SERVICE_METHOD_CAPABILITIES });
  const owner = new FederationRouter({ localInstanceId: "owner", trustedRelayPeerId: "gateway", methodCapabilities: SERVICE_METHOD_CAPABILITIES });
  const service = new FederationServices({ instanceId: "owner", allowForwarding: () => true, threadExists: async () => true });
  cleanups.push(() => service.dispose());
  const clients = new Map<string, Awaited<ReturnType<typeof connectFederationClient>>>();
  registerFederationServices(owner, service, {
    notify: (peerId, method, params) => clients.get("owner")!.sendEnvelopeWithBackpressure!(serviceNotification("owner", peerId, method, params)),
  });
  const forwarder = new FederationServiceForwarder();
  cleanups.push(() => forwarder.dispose());
  const server = new FederationGatewayWebSocketServer({
    gatewayInstanceId: "gateway", gatewayPrivateKeyPem: keys.privateKeyPem, gatewayPublicKeyPem: keys.publicKeyPem,
    host: "127.0.0.1", port: 0, store, noiseStatic: noise, compressionEnabled: true,
    onConnection: (connection) => gateway.registerConnection(connection),
    onDisconnect: (connection) => { gateway.unregisterConnection(connection.peerId); service.disconnect(connection.peerId); },
    onEnvelope: (envelope, connection) => { void gateway.routeEnvelope({ envelope, sourcePeerId: connection.peerId }); },
  });
  const { url } = await server.start();
  cleanups.push(() => server.stop());
  const rpc = new FederationRpcEndpoint({ localInstanceId: "viewer", remoteInstanceId: "owner",
    sendEnvelope: (envelope) => clients.get("viewer")!.sendEnvelope(envelope),
    sendNotification: (envelope) => clients.get("viewer")!.sendEnvelopeWithBackpressure!(envelope) });
  cleanups.push(() => rpc.rejectAll(new Error("Fixture stopped")));
  for (const peerId of ["owner", "viewer"]) {
    const identity = generateFederationIdentityKeyPair();
    const invite = createFederationEnrollmentInvite({ store, token: `fixture-${peerId}`, gatewayInstanceId: "gateway",
      generatedAt: Date.now(), expiresAt: Date.now() + 60_000 });
    const client = await connectFederationClient({
      url, mode: "enroll", gatewayInstanceId: "gateway", gatewayPublicKeyPem: keys.publicKeyPem,
      privateKeyPem: identity.privateKeyPem, publicKeyPem: identity.publicKeyPem, peerInstanceId: peerId,
      role: "client", capabilities, inviteToken: invite.token, noiseStatic: generateNoiseStaticKeyPair(), gatewayNoisePublicKey: noise.publicKeyRaw,
      onEnvelope: (envelope) => {
        if (peerId === "owner") void owner.routeEnvelope({ envelope, sourcePeerId: "gateway" });
        else if (envelope.kind === "notification") forwarder.receiveNotification(envelope.sourceInstanceId, envelope.method, envelope.params);
        else rpc.receiveEnvelope(envelope);
      },
    });
    clients.set(peerId, client);
    cleanups.push(() => client.close());
    expect(client.capabilities).toContain("service_forward_v1");
  }
  owner.registerConnection({ peerId: "gateway", capabilities, sendEnvelope: (envelope) => clients.get("owner")!.sendEnvelope(envelope) });
  const http = createServer((_request, response) => response.end("private-fixture-body-no-capture"));
  const ws = new WebSocketServer({ server: http });
  ws.on("connection", (socket) => socket.on("message", (data) => socket.send(data)));
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  cleanups.push(() => new Promise<void>((resolve) => { for (const socket of ws.clients) socket.terminate(); ws.close(); http.close(() => resolve()); }));
  const declaration = await service.advertise({ backend: "codex", threadId: "fixture" }, {
    port: (http.address() as AddressInfo).port, name: "Development fixture", protocol: "http",
  });
  setFederationTrafficCapture(true);
  const forward = await forwarder.connect(7, declaration, rpc, { streams });
  expect(await (await fetch(forward.url!)).text()).toBe("private-fixture-body-no-capture");
  const socket = new WebSocket(forward.url!.replace("http:", "ws:"));
  cleanups.push(() => socket.terminate());
  await once(socket, "open");
  const message = once(socket, "message");
  socket.send("private-fixture-websocket-message");
  expect(String((await message)[0])).toBe("private-fixture-websocket-message");
  const history = snapshotFederationTrafficHistory();
  expect(history).not.toContain("private-fixture-body-no-capture");
  expect(history).not.toContain(Buffer.from("private-fixture-body-no-capture").toString("base64"));
  expect(history).not.toContain("private-fixture-websocket-message");
  expect(history).toContain(streams === 2 ? "services.v2.data" : "services.v1.exchange");
  if (streams === 2) expect(history).not.toContain("services.v1.exchange");
  const closed = once(socket, "close");
  forwarder.disconnectPeer("owner");
  await closed;
  expect(forwarder.list(7, "owner", declaration)).toEqual([]);
  await expect(fetch(forward.url!)).rejects.toThrow();
});
